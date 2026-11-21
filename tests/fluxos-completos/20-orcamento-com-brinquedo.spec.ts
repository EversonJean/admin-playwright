import type { APIRequestContext } from '@playwright/test';
import { randomUUID } from 'crypto';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCompleteOnboarding, apiCreateActivity, apiCreateClient, apiListNotifications, apiSetSettingParameter } from '../../helpers/api-entities';
import {
  apiAcceptPublicBudget,
  apiCreateBudget,
  apiGetPublicBudget,
  apiPatchEvent,
  apiSendBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
  publicAcceptBody,
} from '../../helpers/api-event-flow';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';
import { pdfContains } from '../../helpers/pdf-text';
import { tenantDayPlus, uniqueSuffix } from '../../helpers/rain-plan';
import {
  INFLATABLE_STEPS,
  RENTAL_PREPARATION_KEY,
  RENTAL_TRANSPORT_KEY,
  Rental,
  apiCreateEquipmentType,
  apiCreateEquipmentUnit,
  apiGetEventChecklist,
  apiGetRentalPreparation,
  apiListAvailableUnits,
} from '../../helpers/rental-preparation';
import { apiErrorCodes, assertOk, readJson, unwrapList } from '../../helpers/response';
import { apiCreateActiveContractTemplate } from '../../helpers/setup-flows';
import { fakeAddress, fakeCpf } from '../../helpers/test-data';

/**
 * Fluxo: fluxos-completos/20 — Orçamento com brinquedo e a locação da festa
 * Diagrama: docs/fluxos/completo-20-orcamento-com-brinquedo.mmd
 * Plano: docs/implementar/PLANO-CICLO-COMPLETO-DOS-BRINQUEDOS.md §3 (CB-A) e §4 (CB-B)
 *
 * E1: orçamento com 2 camas elásticas mostra a disponibilidade da data, aparece
 * na página pública com a caução e na minuta (`locacao.itens`); tenant sem o
 * add-on não vê a seção e a API recusa (§3 itens 1, 3, 5 e 7).
 *
 * E2: o cliente aceita pelo link público e a festa nasce com a locação
 * Reservada, as unidades escolhidas, a preparação e os itens "Preparar" e
 * "Planejar o transporte" no checklist do evento; com uma unidade a menos, a
 * locação nasce Rascunho e o gestor recebe o aviso de falta; cancelar o evento
 * cancela a locação; remarcar move a entrega (§4 itens 2 a 7).
 *
 * O spec afirma o plano; divergência é falha de código, não de asserção.
 */

/** O que o spec lê do `RentalDto` além do `Rental` do helper (Etapa 326). */
type EventRental = Rental & {
  budgetId: string | null;
  deliveryDate: string;
  pickupDate: string;
  origin: 'Manual' | 'EventAcceptance';
  eventShortages: Array<{ equipmentTypeId: string; equipmentTypeName: string; required: number; allocated: number; missing: number }>;
};

interface RentalListItem {
  id: string;
  eventId: string | null;
  status: string;
  origin: string;
}

/** As locações de um evento (`GET /api/rentals?eventId=`), como o painel do evento lê. */
async function rentalsOfEvent(api: APIRequestContext, eventId: string): Promise<RentalListItem[]> {
  const res = await api.get(`/api/rentals?eventId=${eventId}&pageSize=50`);
  await assertOk(res, 'GET /api/rentals?eventId=');
  return (await unwrapList<RentalListItem>(res)).filter((r) => r.eventId === eventId);
}

async function getEventRental(api: APIRequestContext, rentalId: string): Promise<EventRental> {
  const res = await api.get(`/api/rentals/${rentalId}`);
  await assertOk(res, 'GET /api/rentals/{id}');
  return readJson<EventRental>(res);
}

/**
 * Dois tipos: 3 camas com caução de R$ 300 e passos de preparação; 1 piscina.
 * Os nomes não têm "ti", "ff", "fi" nem "fl": a fonte do PDF troca esses pares
 * por ligaduras que o extrator de texto não devolve ("Cama elas ca"), e o
 * sufixo é só de dígitos pelo mesmo motivo.
 */
async function setupEquipment(api: APIRequestContext, tenantId: string) {
  enableFeatureFlagDirect(tenantId, 'feature_equipment_rental');
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const bed = await apiCreateEquipmentType(api, {
    name: `Cama de saltar E2E ${suffix}`,
    depositAmount: 300,
    steps: INFLATABLE_STEPS,
  });
  const pool = await apiCreateEquipmentType(api, { name: `Piscina de bolinhas E2E ${suffix}` });
  const bedUnits = [];
  for (let i = 0; i < 3; i++) bedUnits.push(await apiCreateEquipmentUnit(api, bed.id));
  const poolUnit = await apiCreateEquipmentUnit(api, pool.id);
  return { bed, pool, bedUnits, poolUnit };
}

/** Orçamento ENVIADO com as linhas de equipamento e o endereço estruturado da festa. */
async function sentEquipmentBudget(
  api: APIRequestContext,
  input: { eventDate: string; lines: Array<{ equipmentTypeId: string; quantity: number }>; eventCategoryId?: string },
) {
  const client = await apiCreateClient(api);
  const activity = await apiCreateActivity(api);
  const budget = await apiCreateBudget(api, {
    clientId: client.id,
    activityIds: [activity.id],
    eventDate: input.eventDate,
    address: fakeAddress(),
    equipmentLines: input.lines,
    ...(input.eventCategoryId ? { eventCategoryId: input.eventCategoryId } : {}),
  });
  const sent = await apiSendBudget(api, budget.id);
  return { budgetId: budget.id, clientId: client.id, token: extractTokenFromPublicUrl(sent.publicUrl) };
}

/** Aceite pelo link público, mantendo o endereço do orçamento (`address: null`). */
async function acceptByLink(token: string): Promise<string> {
  const publicApi = await createPublicApiContext();
  try {
    return (await apiAcceptPublicBudget(publicApi, token, { ...publicAcceptBody(), address: null })).eventId;
  } finally {
    await publicApi.dispose();
  }
}

test.describe('Fluxo completo 20 — Orçamento com brinquedo e a locação da festa', () => {
  test('@crud E1: the budget form shows the availability of the date per line, with the deposit outside the total, and the shortage only warns', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(180_000);
    await apiCompleteOnboarding(authApi);
    const { bed, pool } = await setupEquipment(authApi, tenant.tenantId);
    const eventDate = tenantDayPlus(30);
    const client = await apiCreateClient(authApi);
    const activity = await apiCreateActivity(authApi);
    const budget = await apiCreateBudget(authApi, {
      clientId: client.id,
      activityIds: [activity.id],
      eventDate,
      address: fakeAddress(),
      equipmentLines: [
        { equipmentTypeId: bed.id, quantity: 2 },
        { equipmentTypeId: pool.id, quantity: 2 },
      ],
    });

    // §3 item 7: o GET available é a fonte da disponibilidade da linha.
    const available = await apiListAvailableUnits(authApi, { equipmentTypeId: bed.id, date: eventDate, quantity: 2 });
    expect(available.availableCount, '3 camas livres na data').toBe(3);

    await authPage.goto(`/app/budgets/${budget.id}`);
    await expect(authPage.getByTestId('budget-form-page')).toBeVisible({ timeout: 30_000 });
    const section = authPage.getByTestId('budget-equipment-section');
    await expect(section, 'seção "Equipamentos para locação" com o add-on').toBeVisible({ timeout: 30_000 });

    const bedRow = section.locator('[data-testid^="budget-equipment-row-"]').filter({ hasText: bed.name });
    await expect(bedRow.locator('[data-testid^="budget-equipment-price-"]')).toContainText('por unidade (diária com montagem)');
    await expect(bedRow.locator('[data-testid^="budget-equipment-deposit-"]')).toContainText(
      'por unidade, devolvida (fora do total)',
    );
    await expect(bedRow.locator('[data-testid^="budget-equipment-availability-"]')).toContainText('3 livres nessa data', {
      timeout: 20_000,
    });

    // Decisão 2: pedir mais do que há livre só alerta.
    const poolRow = section.locator('[data-testid^="budget-equipment-row-"]').filter({ hasText: pool.name });
    await expect(poolRow.locator('[data-testid^="budget-equipment-shortage-"]')).toContainText(
      'Só 1 livre nessa data: no aceite, a locação nasce em rascunho',
      { timeout: 20_000 },
    );

    // O orçamento não reserva unidade.
    const stillFree = await apiListAvailableUnits(authApi, { equipmentTypeId: bed.id, date: eventDate, quantity: 2 });
    expect(stillFree.availableCount, 'o orçamento não reserva').toBe(3);
  });

  test('@flow E1: the sent budget shows the equipment on the public page and the PDF with the deposit, outside "Atividades avulsas", and the draft contract renders locacao.itens', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(180_000);
    const { bed } = await setupEquipment(authApi, tenant.tenantId);

    // Minuta: chave do tenant ligada e modelo ativo, default da categoria do orçamento.
    await apiSetSettingParameter(authApi, 'CONTRACT_AT_ACCEPTANCE', 'true');
    const templateId = await apiCreateActiveContractTemplate(authApi, {
      bodyHtml: '<p>Locacao: {locacao.itens}. Caucao: {locacao.caucao}.</p>',
      bodyPlain: 'Locacao: {locacao.itens}. Caucao: {locacao.caucao}.',
    });
    const categoryRes = await authApi.post('/api/event-categories', {
      data: { name: `Categoria minuta ${uniqueSuffix()}`, group: 'Festa' },
    });
    await assertOk(categoryRes, 'POST /api/event-categories');
    const categoryId = (await readJson<{ id: string }>(categoryRes)).id;
    await assertOk(
      await authApi.put(`/api/contract-templates/${templateId}/default-categories`, { data: { categoryIds: [categoryId] } }),
      'PUT default-categories',
    );

    const { token } = await sentEquipmentBudget(authApi, {
      eventDate: tenantDayPlus(30),
      lines: [{ equipmentTypeId: bed.id, quantity: 2 }],
      eventCategoryId: categoryId,
    });

    const publicApi = await createPublicApiContext();
    try {
      // §3 item 5: a linha sai de `Items`/`ItemsTotal` e vai só para `EquipmentLines`, com a caução por unidade.
      const page = (await apiGetPublicBudget(publicApi, token)) as unknown as {
        items: Array<Record<string, unknown>>;
        equipmentLines: Array<{ description: string; quantity: number; unitDeposit: number | null; total: number }> | null;
        contractPreviewAvailable: boolean;
      };
      expect(page.equipmentLines, 'a página pública traz a linha do equipamento').toHaveLength(1);
      expect(page.equipmentLines![0]!.description).toBe(bed.name);
      expect(page.equipmentLines![0]!.quantity).toBe(2);
      expect(page.equipmentLines![0]!.unitDeposit, 'caução por unidade').toBe(300);
      expect(JSON.stringify(page.items), 'o brinquedo fora das atividades').not.toContain(bed.name);

      const pdf = await publicApi.get(`/api/public/budgets/${token}/pdf`);
      await assertOk(pdf, 'GET /api/public/budgets/{token}/pdf');
      const pdfBytes = await pdf.body();
      expect(pdfContains(pdfBytes, 'Locação de equipamentos'), 'PDF com a seção "Locação de equipamentos"').toBe(true);
      expect(pdfContains(pdfBytes, bed.name), 'PDF com o tipo').toBe(true);

      // §3 item 5: `locacao.itens` na minuta ("2x Cama elástica").
      expect(page.contractPreviewAvailable, 'minuta disponível').toBe(true);
      const preview = await publicApi.post(`/api/public/budgets/${token}/contract-preview`, {
        data: {
          clientName: `Cliente Minuta ${uniqueSuffix()}`,
          clientDocument: fakeCpf(),
          clientAddress: publicAcceptBody().clientAddress,
        },
      });
      await assertOk(preview, 'POST /api/public/budgets/{token}/contract-preview');
      expect(pdfContains(await preview.body(), `2x ${bed.name}`), 'minuta com locacao.itens').toBe(true);
    } finally {
      await publicApi.dispose();
    }
  });

  test('@crud E1: a tenant without the add-on does not see the section and the API refuses an equipment line', async ({
    authApi,
    authPage,
  }) => {
    test.setTimeout(120_000);
    await apiCompleteOnboarding(authApi);
    const client = await apiCreateClient(authApi);
    const activity = await apiCreateActivity(authApi);

    const res = await authApi.post('/api/budgets', {
      data: {
        clientId: client.id,
        eventDate: tenantDayPlus(30),
        eventStartTime: '14:00',
        eventEndTime: '18:00',
        eventLocation: 'Salão de festas E2E, Curitiba',
        childrenCount: 15,
        validUntil: tenantDayPlus(14),
        address: fakeAddress(),
        teamSize: 2,
        teamPricePerCollaborator: 200,
        displacementFee: 0,
        items: [{ activityId: activity.id, quantity: 1 }],
        equipmentLines: [{ equipmentTypeId: randomUUID(), quantity: 1 }],
      },
    });
    expect(res.status(), 'linha de equipamento sem o add-on').toBe(400);
    expect(await apiErrorCodes(res)).toContain('Budget.EquipmentRequiresAddOn');

    await authPage.goto('/app/budgets/quick');
    await expect(authPage.getByTestId('budget-form-page')).toBeVisible({ timeout: 30_000 });
    await expect(authPage.getByTestId('budget-form-add-item')).toBeVisible({ timeout: 30_000 });
    await expect(authPage.getByTestId('budget-equipment-section'), 'seção escondida sem o add-on').toHaveCount(0);
  });

  test('@flow E2: the public acceptance creates the party rental Reserved with the chosen units, the preparation and the checklist items; rescheduling moves the delivery; canceling cancels it', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(240_000);
    const { bed, bedUnits } = await setupEquipment(authApi, tenant.tenantId);
    const eventDate = tenantDayPlus(30);
    const { budgetId, clientId, token } = await sentEquipmentBudget(authApi, {
      eventDate,
      lines: [{ equipmentTypeId: bed.id, quantity: 2 }],
    });

    const eventId = await acceptByLink(token);

    // §4 itens 2 a 4: uma locação do aceite, Reservada, com 2 das 3 camas.
    const [listed] = await rentalsOfEvent(authApi, eventId);
    expect(listed, 'a festa nasce com a locação').toBeTruthy();
    expect(listed!.origin).toBe('EventAcceptance');
    const rental = await getEventRental(authApi, listed!.id);
    expect(rental.status).toBe('Reserved');
    expect(rental.origin).toBe('EventAcceptance');
    expect(rental.budgetId, 'orçamento de origem').toBe(budgetId);
    expect(rental.clientId).toBe(clientId);
    expect(rental.items, 'as 2 unidades da linha').toHaveLength(2);
    const bedIds = new Set(bedUnits.map((u) => u.id));
    expect(rental.items.every((i) => bedIds.has(i.equipmentUnitId)), 'unidades do tipo da linha').toBe(true);
    expect(rental.eventShortages, 'sem falta').toHaveLength(0);
    expect(rental.deliveryDate, 'entrega no dia da festa (início − montagem − adiantamento)').toBe(eventDate);

    // A preparação e os dois itens de sistema do checklist do evento.
    const preparation = await apiGetRentalPreparation(authApi, rental.id);
    expect(preparation.isMaterialized, 'a preparação nasce na reserva').toBe(true);
    const keys = (await apiGetEventChecklist(authApi, eventId)).map((i) => i.systemKey);
    expect(keys, '"Preparar" no checklist do evento').toContain(RENTAL_PREPARATION_KEY);
    expect(keys, '"Planejar o transporte" no checklist do evento').toContain(RENTAL_TRANSPORT_KEY);

    // §4 item 6: remarcar move entrega e retirada pelo mesmo delta.
    const newDate = tenantDayPlus(32);
    await apiPatchEvent(authApi, eventId, { eventDate: newDate });
    const moved = await getEventRental(authApi, rental.id);
    expect(moved.deliveryDate, 'a entrega andou com a festa').toBe(newDate);
    expect(moved.pickupDate, 'a retirada andou com a festa').toBe(newDate);
    expect(moved.status).toBe('Reserved');

    // §4 item 6: cancelar o evento cancela a locação.
    await assertOk(
      await authApi.post(`/api/events/${eventId}/cancel`, { data: { reason: 'Cliente desistiu (E2E)' } }),
      'POST /api/events/{id}/cancel',
    );
    expect((await getEventRental(authApi, rental.id)).status, 'cancelada junto com a festa').toBe('Canceled');

    // Reativar a festa cria outra locação; a cancelada fica.
    await assertOk(
      await authApi.post(`/api/events/${eventId}/reactivate`, { data: { reason: 'Cliente voltou (E2E)' } }),
      'POST /api/events/{id}/reactivate',
    );
    const after = await rentalsOfEvent(authApi, eventId);
    const alive = after.filter((r) => r.status !== 'Canceled');
    expect(alive, 'uma locação viva nova').toHaveLength(1);
    expect(alive[0]!.id).not.toBe(rental.id);
    expect(after.find((r) => r.id === rental.id)?.status, 'a cancelada continua cancelada').toBe('Canceled');
  });

  test('@flow E2: with one unit less the party rental is born Draft with what it found and the managers get the shortage notice', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(180_000);
    const { bed, pool, poolUnit } = await setupEquipment(authApi, tenant.tenantId);
    const { token } = await sentEquipmentBudget(authApi, {
      eventDate: tenantDayPlus(40),
      lines: [
        { equipmentTypeId: bed.id, quantity: 1 },
        { equipmentTypeId: pool.id, quantity: 2 },
      ],
    });

    const eventId = await acceptByLink(token);
    expect(eventId, 'a falta não trava a venda').toBeTruthy();

    const [listed] = await rentalsOfEvent(authApi, eventId);
    expect(listed, 'a locação nasce mesmo com falta').toBeTruthy();
    const rental = await getEventRental(authApi, listed!.id);
    expect(rental.status, 'falta = Rascunho').toBe('Draft');
    expect(rental.items, 'a cama e a única piscina').toHaveLength(2);
    expect(rental.items.map((i) => i.equipmentUnitId)).toContain(poolUnit.id);
    expect(rental.eventShortages).toHaveLength(1);
    expect(rental.eventShortages[0]).toMatchObject({ equipmentTypeId: pool.id, required: 2, allocated: 1, missing: 1 });

    // §4 item 4: aviso 40 aos gestores, sobre a locação.
    const notices = (await apiListNotifications(authApi)).filter(
      (n) => n.type === 'RentalFromEventAttention' && n.contextEntityId === rental.id,
    );
    expect(notices, 'aviso de falta ao gestor').toHaveLength(1);
    expect(notices[0]!.message).toContain(pool.name);
    expect(notices[0]!.message).toContain(rental.rentalNumber);
  });
});
