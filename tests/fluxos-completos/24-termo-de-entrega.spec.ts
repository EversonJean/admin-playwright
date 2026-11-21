import type { APIRequestContext } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import { apiCreateClient, apiCreateCollaborator } from '../../helpers/api-entities';
import { createPublicApiContext } from '../../helpers/api-event-flow';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';
import { tenantDayPlus, uniqueSuffix } from '../../helpers/rain-plan';
import {
  RentalHandoverTerm,
  apiIssueRentalHandoverTerm,
  apiPutRentalTermTemplate,
} from '../../helpers/rental-handover-term';
import {
  apiCreateEquipmentType,
  apiCreateEquipmentUnit,
  apiCreateRental,
  apiCreateVehicle,
  apiGetDamageReport,
  apiListDamageReports,
  apiPutRentalLogistics,
  apiTransitionRental,
  inspectRentalBatch,
} from '../../helpers/rental-preparation';
import { apiErrorCodes, assertOk, readJson } from '../../helpers/response';
import { RoleSession, loginPortalCollaborator } from '../../helpers/setup-flows';

/**
 * Fluxo: fluxos-completos/24 — Termo de entrega aceito pelo cliente
 * Diagrama: docs/fluxos/completo-24-termo-de-entrega.mmd
 * Plano: docs/implementar/PLANO-CICLO-COMPLETO-DOS-BRINQUEDOS.md §9 (CB-G)
 *
 * E9: o gestor gera o termo, o cliente aceita pelo link público com nome; texto
 * alterado depois é recusado; a equipe colhe o aceite no local pelo Portal; o
 * detalhe da avaria mostra o termo aceito; token de outro tenant dá 404 (§9
 * itens 3 a 6).
 *
 * O spec afirma o plano; divergência é falha de código, não de asserção.
 */

/** Modelo do termo da empresa: só variáveis do catálogo do back (§9 item 2). */
const TERM_TEMPLATE = {
  title: 'Termo de entrega dos brinquedos',
  body:
    'Locação {locacao.numero} · uso em {festa.data}\n\n' +
    'Eu, {cliente.nome}, recebo da {empresa.nome} os brinquedos abaixo, no endereço {entrega.endereco}:\n{itens}\n\n' +
    'Regras de uso:\n{regras}\n\n' +
    'Caução: {caucao}\n\n' +
    'Respondo por dano que não seja desgaste natural.',
};

interface TermSummary {
  pending: (RentalHandoverTerm & { channel: string | null }) | null;
  lastAccepted: (RentalHandoverTerm & { channel: string | null; acceptedViaCollaboratorName: string | null }) | null;
}

async function apiGetTermSummary(api: APIRequestContext, rentalId: string): Promise<TermSummary> {
  const res = await api.get(`/api/rentals/${rentalId}/handover-term`);
  await assertOk(res, 'GET /api/rentals/{id}/handover-term');
  return readJson<TermSummary>(res);
}

/** Tipo com "Regras de uso" e caução, o modelo gravado e uma unidade. */
async function setupTermType(api: APIRequestContext, tenantId: string) {
  enableFeatureFlagDirect(tenantId, 'feature_equipment_rental');
  await apiPutRentalTermTemplate(api, TERM_TEMPLATE);
  const usageRules = `Só com monitor presente. No máximo 8 crianças por vez (E2E ${uniqueSuffix()}).`;
  const type = await apiCreateEquipmentType(api, {
    name: `Castelo inflavel E2E ${uniqueSuffix()}`,
    depositAmount: 300,
    usageRules,
  });
  return { type, usageRules };
}

test.describe('Fluxo completo 24 — Termo de entrega', () => {
  test('@crud E9: the manager issues the term, the client accepts by the public link with the name, a changed text is refused, a superseded link is gone, the damage detail shows the accepted term and another tenant gets 404', async ({
    authApi,
    tenant,
    page,
  }) => {
    test.setTimeout(240_000);
    const { type, usageRules } = await setupTermType(authApi, tenant.tenantId);
    const unit = await apiCreateEquipmentUnit(authApi, type.id);
    const client = await apiCreateClient(authApi);
    const rental = await apiCreateRental(authApi, { clientId: client.id, deliveryDate: tenantDayPlus(5), unitIds: [unit.id] });
    await apiTransitionRental(authApi, rental.id, 'Reserved');

    // §9 item 3: fora de `Confirmed`..`InUse` não emite.
    const early = await authApi.post(`/api/rentals/${rental.id}/handover-term`, { data: {} });
    expect(early.status(), 'emitir com a locação Reservada').toBe(409);
    expect(await apiErrorCodes(early)).toContain('RentalTerm.NotAllowedInStatus');

    await apiTransitionRental(authApi, rental.id, 'Confirmed');
    const first = await apiIssueRentalHandoverTerm(authApi, rental.id);
    expect(first.status).toBe('Pending');
    expect(first.text, 'o texto leva as regras de uso do tipo').toContain(usageRules);
    expect(first.text).toContain(rental.rentalNumber);
    // O GET devolve o MESMO link, sem emitir.
    expect((await apiGetTermSummary(authApi, rental.id)).pending?.publicToken).toBe(first.publicToken);

    // Gerar de novo substitui o pendente: o link antigo deixa de valer (404).
    const term = await apiIssueRentalHandoverTerm(authApi, rental.id);
    expect(term.publicToken).not.toBe(first.publicToken);
    const publicApi = await createPublicApiContext();
    try {
      const superseded = await publicApi.get(`/api/public/rental-terms/${encodeURIComponent(first.publicToken!)}`);
      expect(superseded.status(), 'link substituído').toBe(404);

      // §9 item 4: hash diferente do texto atual = texto mudou depois de o cliente abrir.
      const changed = await publicApi.post(`/api/public/rental-terms/${encodeURIComponent(term.publicToken!)}/accept`, {
        data: { name: 'Maria Souza', document: null, agree: true, textSha256: 'a'.repeat(64) },
      });
      expect(changed.status(), 'texto mudou').toBe(409);
      expect(await apiErrorCodes(changed)).toContain('RentalTerm.TextChanged');

      // O cliente aceita pela página pública, com o nome.
      await page.goto(`/rental-terms/${encodeURIComponent(term.publicToken!)}`);
      await expect(page.getByTestId('public-rental-term-text')).toContainText(usageRules, { timeout: 30_000 });
      await page.getByTestId('public-rental-term-name').fill('Maria Souza');
      await page.getByTestId('public-rental-term-agree').getByRole('checkbox').check();
      await page.getByTestId('public-rental-term-confirm').click();
      await expect(page.getByTestId('public-rental-term-accepted-title')).toContainText('Aceite confirmado', {
        timeout: 20_000,
      });
      await expect(page.getByTestId('public-rental-term-accepted-by')).toContainText('por Maria');

      const accepted = (await apiGetTermSummary(authApi, rental.id)).lastAccepted;
      expect(accepted?.status).toBe('Accepted');
      expect(accepted?.acceptedByName).toBe('Maria Souza');
      expect(accepted?.channel).toBe('PublicLink');

      const twice = await publicApi.post(`/api/public/rental-terms/${encodeURIComponent(term.publicToken!)}/accept`, {
        data: { name: 'Maria Souza', document: null, agree: true, textSha256: term.textSha256 },
      });
      expect(twice.status(), 'aceitar de novo').toBe(409);
      expect(await apiErrorCodes(twice)).toContain('RentalTerm.AlreadyAccepted');
    } finally {
      await publicApi.dispose();
    }

    // §9 item 6: o termo não trava a entrega, e a avaria mostra o termo aceito.
    await apiTransitionRental(authApi, rental.id, 'Preparing');
    await assertOk(await inspectRentalBatch(authApi, rental.id, { type: 'Outbound' }), 'inspeção de saída');
    await apiTransitionRental(authApi, rental.id, 'Dispatched', 'Delivered', 'InUse', 'Returned');
    await assertOk(
      await inspectRentalBatch(authApi, rental.id, {
        type: 'Inbound',
        exceptions: [{ rentalItemId: rental.items[0]!.id, condition: 'Damaged', notes: 'Lona rasgada (E2E)' }],
      }),
      'volta danificada',
    );
    const [report] = (await apiListDamageReports(authApi, { rentalId: rental.id })).items;
    const damage = (await apiGetDamageReport(authApi, report!.id)) as unknown as {
      handoverTermAcceptedAt: string | null;
      handoverTermAcceptedByName: string | null;
    };
    expect(damage.handoverTermAcceptedAt, '"Termo aceito em …" na avaria').not.toBeNull();
    expect(damage.handoverTermAcceptedByName).toBe('Maria Souza');

    // Cross-tenant: o termo da locação não existe para outra empresa, e token inventado dá 404.
    const other = await signupNewTenant();
    enableFeatureFlagDirect(other.tenantId, 'feature_equipment_rental');
    const otherApi = await createBearerApiContext(other.accessToken);
    try {
      expect((await otherApi.get(`/api/rentals/${rental.id}/handover-term`)).status(), 'termo de outra empresa').toBe(404);
      expect(
        (await otherApi.get(`/api/public/rental-terms/${encodeURIComponent(`nao-existe-${uniqueSuffix()}`)}`)).status(),
        'token que não é de nenhuma empresa',
      ).toBe(404);
    } finally {
      await otherApi.dispose();
    }
  });

  test('@flow E9: the delivery crew collects the acceptance on site through the Portal; without a term the Portal asks the office; a collaborator outside the delivery gets 404', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(240_000);
    const { type } = await setupTermType(authApi, tenant.tenantId);
    const today = tenantDayPlus(0);
    const driver = await apiCreateCollaborator(authApi);
    const outsider = await apiCreateCollaborator(authApi);
    const vehicle = await apiCreateVehicle(authApi);

    /** Locação de hoje, já em trânsito, com o motorista da entrega (o recorte do Portal). */
    async function dispatchedToday(): Promise<{ id: string }> {
      const unit = await apiCreateEquipmentUnit(authApi, type.id);
      const client = await apiCreateClient(authApi);
      const rental = await apiCreateRental(authApi, { clientId: client.id, deliveryDate: today, unitIds: [unit.id] });
      await apiTransitionRental(authApi, rental.id, 'Reserved', 'Confirmed', 'Preparing');
      await assertOk(await inspectRentalBatch(authApi, rental.id, { type: 'Outbound' }), 'inspeção de saída');
      await apiPutRentalLogistics(authApi, rental.id, [
        {
          kind: 'Delivery',
          vehicleId: vehicle.id,
          departureDate: today,
          departureTime: '07:00:00',
          loadingMinutes: 30,
          crew: [{ collaboratorId: driver.id, isDriver: true }],
        },
      ]);
      await apiTransitionRental(authApi, rental.id, 'Dispatched');
      return rental;
    }

    const withTerm = await dispatchedToday();
    const term = await apiIssueRentalHandoverTerm(authApi, withTerm.id);
    const withoutTerm = await dispatchedToday();

    const sessions: RoleSession[] = [];
    try {
      const portal = await loginPortalCollaborator(tenant.tenantId, driver.id);
      sessions.push(portal);
      const stranger = await loginPortalCollaborator(tenant.tenantId, outsider.id);
      sessions.push(stranger);

      // §9 item 5: o detalhe da entrega leva o termo pendente, sem o token.
      const detailRes = await portal.api.get(`/api/portal/rental-deliveries/${withTerm.id}`);
      await assertOk(detailRes, 'GET /api/portal/rental-deliveries/{id}');
      const detail = await readJson<{ handoverTerm: { text: string; textSha256: string; status: string } | null }>(detailRes);
      expect(detail.handoverTerm?.status).toBe('Pending');
      expect(detail.handoverTerm?.textSha256).toBe(term.textSha256);
      expect(JSON.stringify(detail), 'o Portal não recebe o token do link').not.toContain(term.publicToken!);

      // Fora da entrega: 404, nada aceito.
      const foreign = await stranger.api.post(`/api/portal/rental-deliveries/${withTerm.id}/handover-term/accept`, {
        data: { clientName: 'João Pereira', agree: true, textSha256: term.textSha256 },
      });
      expect(foreign.status(), 'colaborador fora da entrega').toBe(404);
      expect((await apiGetTermSummary(authApi, withTerm.id)).lastAccepted, 'nada aceito').toBeNull();

      // "Cliente aceitar agora", no aparelho da equipe.
      await assertOk(
        await portal.api.post(`/api/portal/rental-deliveries/${withTerm.id}/handover-term/accept`, {
          data: { clientName: 'João Pereira', agree: true, textSha256: term.textSha256 },
        }),
        'aceite no local',
      );
      const accepted = (await apiGetTermSummary(authApi, withTerm.id)).lastAccepted;
      expect(accepted?.status).toBe('Accepted');
      expect(accepted?.acceptedByName).toBe('João Pereira');
      expect(accepted?.channel, 'aceito no local').toBe('OnSite');
      expect(accepted?.acceptedViaCollaboratorName, 'quem colheu').toBeTruthy();

      // Sem termo gerado, a equipe não emite: "Peça ao escritório para gerar o termo".
      const notIssued = await portal.api.post(`/api/portal/rental-deliveries/${withoutTerm.id}/handover-term/accept`, {
        data: { clientName: 'João Pereira', agree: true, textSha256: term.textSha256 },
      });
      expect(notIssued.status(), 'sem termo pendente').toBe(409);
      expect(await apiErrorCodes(notIssued)).toContain('RentalTerm.NotIssued');
    } finally {
      for (const s of sessions) await s.api.dispose();
    }
  });
});
