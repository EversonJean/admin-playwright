import type { APIRequestContext } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { PreparationStepInput, apiCreateCollaborator } from '../../helpers/api-entities';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';
import { tenantDayPlus, uniqueSuffix } from '../../helpers/rain-plan';
import {
  apiCreateEquipmentType,
  apiCreateEquipmentUnit,
  apiCreateRental,
  apiCreateVehicle,
  apiGetEventChecklist,
  apiGetRental,
  apiGetRentalPreparation,
  apiPutRentalLogistics,
  apiTransitionRental,
  inspectRentalBatch,
  preparationChecks,
  transitionRental,
  uploadPortalRentalPhoto,
} from '../../helpers/rental-preparation';
import { apiErrorCodes, assertOk, readJson, unwrapList } from '../../helpers/response';
import { RoleSession, loginPortalCollaborator, setupAcceptedEvent } from '../../helpers/setup-flows';

/**
 * Fluxo: fluxos-completos/23 — Montagem e segurança no local
 * Diagrama: docs/fluxos/completo-23-montagem-no-local.mmd
 * Plano: docs/implementar/PLANO-CICLO-COMPLETO-DOS-BRINQUEDOS.md §8 (CB-F)
 *
 * E7: a saída cria a montagem; o motorista da entrega marca os passos e a foto
 * da ancoragem no Portal e conclui; o item "Conferir a montagem" fica feito no
 * checklist do evento; colaborador fora da entrega dá 404; o passo do local não
 * trava a saída (§8 itens 1, 2, 5 e 6).
 *
 * O spec afirma o plano; divergência é falha de código, não de asserção.
 */

/** Chave do item de sistema da montagem no checklist do evento (§8 item 6). */
const RENTAL_SETUP_KEY = 'rental.setup';

const ANCHOR = 'Ancorar com estacas ou sacos de areia';

/** Um passo "antes de sair do depósito" (opcional) e quatro "na montagem, no local". */
const ON_SITE_SETUP_STEPS: PreparationStepInput[] = [
  { title: 'Higienizar a lona', category: 'Cleaning', isMandatory: false },
  { title: ANCHOR, category: 'Safety', isMandatory: true, requiresPhoto: true, stage: 'OnSite' },
  { title: 'Soprador em piso seco, com extensão aterrada', category: 'Safety', isMandatory: true, stage: 'OnSite' },
  { title: 'Área livre de 2 m em volta', category: 'Safety', isMandatory: true, stage: 'OnSite' },
  { title: 'Explicar as regras e o limite de crianças ao responsável', category: 'Safety', isMandatory: false, stage: 'OnSite' },
];

interface SetupCheck {
  id: string;
  rentalItemId: string;
  title: string;
  isMandatory: boolean;
  requiresPhoto: boolean;
  status: string;
  photos: Array<{ id: string }>;
}

interface RentalSetup {
  id: string;
  rentalId: string;
  status: string;
  completedAt: string | null;
  completedByName: string | null;
  checks: SetupCheck[];
}

async function apiGetRentalSetup(api: APIRequestContext, rentalId: string): Promise<RentalSetup> {
  const res = await api.get(`/api/rentals/${rentalId}/setup`);
  await assertOk(res, 'GET /api/rentals/{id}/setup');
  return readJson<RentalSetup>(res);
}

test.describe('Fluxo completo 23 — Montagem no local', () => {
  test('@flow E7: the on-site steps do not hold the dispatch; the dispatch creates the setup; the delivery driver marks the steps and the anchoring photo in the Portal and completes; the event item is done; a collaborator outside the delivery gets 404', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(240_000);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_equipment_rental');
    // O Portal só mostra a entrega de ontem a amanhã: a festa e a entrega são de hoje.
    const today = tenantDayPlus(0);
    const { eventId, clienteId } = await setupAcceptedEvent(authApi, { budget: { eventDate: today } });
    const type = await apiCreateEquipmentType(authApi, {
      name: `Castelo inflavel E2E ${uniqueSuffix()}`,
      steps: ON_SITE_SETUP_STEPS,
    });
    const unit = await apiCreateEquipmentUnit(authApi, type.id);
    const rental = await apiCreateRental(authApi, { clientId: clienteId, eventId, deliveryDate: today, unitIds: [unit.id] });
    await apiTransitionRental(authApi, rental.id, 'Reserved', 'Confirmed', 'Preparing');

    // §8 item 1 (regressão): o passo do local não vira item da preparação.
    const prepTitles = preparationChecks(await apiGetRentalPreparation(authApi, rental.id)).map((c) => c.title);
    expect(prepTitles, 'a preparação leva só o passo de antes da saída').toEqual(['Higienizar a lona']);
    expect(prepTitles).not.toContain(ANCHOR);

    const driver = await apiCreateCollaborator(authApi);
    const pickupDriver = await apiCreateCollaborator(authApi);
    const vehicle = await apiCreateVehicle(authApi);
    await apiPutRentalLogistics(authApi, rental.id, [
      {
        kind: 'Delivery',
        vehicleId: vehicle.id,
        departureDate: today,
        departureTime: '07:00:00',
        loadingMinutes: 30,
        crew: [{ collaboratorId: driver.id, isDriver: true }],
      },
      {
        kind: 'Pickup',
        vehicleId: vehicle.id,
        departureDate: today,
        departureTime: '18:30:00',
        loadingMinutes: 15,
        crew: [{ collaboratorId: pickupDriver.id, isDriver: true }],
      },
    ]);
    await assertOk(await inspectRentalBatch(authApi, rental.id, { type: 'Outbound' }), 'inspeção de saída');

    // Decisão 14: a saída não espera nada do local; ela cria a montagem com os passos `OnSite`.
    await assertOk(await transitionRental(authApi, rental.id, 'Dispatched'), 'saída com os passos do local pendentes');
    const setup = await apiGetRentalSetup(authApi, rental.id);
    expect(setup.status, 'montagem aberta').toBe('Pending');
    expect(setup.checks.map((c) => c.title).sort()).toEqual(
      ON_SITE_SETUP_STEPS.filter((s) => s.stage === 'OnSite').map((s) => s.title).sort(),
    );
    expect(setup.checks.find((c) => c.title === ANCHOR)!.requiresPhoto).toBe(true);

    // §8 item 6: o item "Conferir a montagem dos brinquedos no local" nasce aberto no evento.
    const setupItem = (await apiGetEventChecklist(authApi, eventId)).find((i) => i.systemKey === RENTAL_SETUP_KEY);
    expect(setupItem, 'item da montagem no checklist do evento').toBeTruthy();
    expect(setupItem!.isDone).toBe(false);

    const sessions: RoleSession[] = [];
    try {
      const portal = await loginPortalCollaborator(tenant.tenantId, driver.id);
      sessions.push(portal);
      const outsider = await loginPortalCollaborator(tenant.tenantId, pickupDriver.id);
      sessions.push(outsider);

      // §8 item 5: "Minhas entregas" do motorista da entrega.
      const listRes = await portal.api.get('/api/portal/rental-deliveries');
      await assertOk(listRes, 'GET /api/portal/rental-deliveries');
      expect((await unwrapList<{ rentalId: string }>(listRes)).map((d) => d.rentalId)).toContain(rental.id);

      // Fora da perna de entrega (só na retirada): 404 `RentalSetup.NotFound`, e a entrega não aparece.
      const outsiderDetail = await outsider.api.get(`/api/portal/rental-deliveries/${rental.id}`);
      expect(outsiderDetail.status(), 'colaborador fora da entrega').toBe(404);
      expect(await apiErrorCodes(outsiderDetail)).toContain('RentalSetup.NotFound');
      const outsiderList = await outsider.api.get('/api/portal/rental-deliveries');
      await assertOk(outsiderList, 'GET /api/portal/rental-deliveries (fora da entrega)');
      expect((await unwrapList<{ rentalId: string }>(outsiderList)).map((d) => d.rentalId)).not.toContain(rental.id);
      const anchorId = setup.checks.find((c) => c.title === ANCHOR)!.id;
      const outsiderPhoto = await uploadPortalRentalPhoto(outsider.api, 'rental-deliveries', rental.id, anchorId);
      expect(outsiderPhoto.status(), 'foto de quem não é da entrega').toBe(404);

      const detailRes = await portal.api.get(`/api/portal/rental-deliveries/${rental.id}`);
      await assertOk(detailRes, 'GET /api/portal/rental-deliveries/{id}');
      const detail = await readJson<{ rentalId: string; setup: RentalSetup | null }>(detailRes);
      expect(detail.setup, 'a montagem no detalhe da entrega').not.toBeNull();
      expect(JSON.stringify(detail), 'o Portal não leva valores').not.toMatch(/"totalPrice"|"unitPrice"/);

      // §8 item 4: concluir com obrigatório pendente é recusado.
      const early = await portal.api.post(`/api/portal/rental-deliveries/${rental.id}/setup/complete`);
      expect(early.status(), 'concluir com obrigatório pendente').toBe(409);
      expect(await apiErrorCodes(early)).toContain('RentalSetup.ChecksPending');

      // §8 item 4: o passo que exige foto não fica feito sem a foto dele.
      const anchorWithoutPhoto = await portal.api.post(
        `/api/portal/rental-deliveries/${rental.id}/setup/checks/${anchorId}/complete`,
        { data: { status: 'Done', notes: null } },
      );
      expect(anchorWithoutPhoto.ok(), '"Feito" na ancoragem sem foto').toBe(false);
      expect(await apiErrorCodes(anchorWithoutPhoto)).toContain('RentalSetup.PhotoRequired');

      // A foto da ancoragem e os três obrigatórios, pelo Portal.
      const photo = await uploadPortalRentalPhoto(portal.api, 'rental-deliveries', rental.id, anchorId);
      await assertOk(photo, 'POST /api/portal/rental-deliveries/{id}/photos');
      expect((await readJson<{ context: string; targetId: string }>(photo)).context).toBe('Setup');
      for (const check of setup.checks.filter((c) => c.isMandatory)) {
        await assertOk(
          await portal.api.post(`/api/portal/rental-deliveries/${rental.id}/setup/checks/${check.id}/complete`, {
            data: { status: 'Done', notes: null },
          }),
          `marcar "${check.title}"`,
        );
      }
      await assertOk(
        await portal.api.post(`/api/portal/rental-deliveries/${rental.id}/setup/complete`),
        'concluir a montagem',
      );

      const done = await apiGetRentalSetup(authApi, rental.id);
      expect(done.status, 'montagem concluída').toBe('Done');
      expect(done.completedAt).not.toBeNull();
      expect(done.completedByName, 'quem concluiu').toBeTruthy();
      expect(done.checks.find((c) => c.id === anchorId)!.photos, 'a foto da ancoragem no item').toHaveLength(1);

      const doneItem = (await apiGetEventChecklist(authApi, eventId)).find((i) => i.systemKey === RENTAL_SETUP_KEY);
      expect(doneItem!.isDone, '"Conferir a montagem" feito no checklist do evento').toBe(true);
      expect((await apiGetRental(authApi, rental.id)).status, 'a montagem não move a locação').toBe('Dispatched');
    } finally {
      for (const s of sessions) await s.api.dispose();
    }
  });
});
