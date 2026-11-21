import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import { PreparationStepInput, apiCreateCollaborator } from '../../helpers/api-entities';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';
import { tenantDayPlus, uniqueSuffix } from '../../helpers/rain-plan';
import {
  apiCreateEquipmentType,
  apiCreateEquipmentUnit,
  apiCreateRental,
  apiGetDamageReport,
  apiGetRental,
  apiGetRentalPreparation,
  apiListDamageReports,
  apiListRentalPhotos,
  apiTransitionRental,
  apiUploadRentalPhoto,
  inspectRentalBatch,
  preparationChecks,
  resolveDamageReport,
  scheduleRentalPreparation,
  setupReservedRental,
  uploadPortalRentalPhoto,
} from '../../helpers/rental-preparation';
import { apiErrorCodes, assertOk, readJson } from '../../helpers/response';
import { RoleSession, loginPortalCollaborator, setupPaidEvent } from '../../helpers/setup-flows';

/**
 * Fluxo: fluxos-completos/22 — Fotos como prova
 * Diagrama: docs/fluxos/completo-22-fotos-como-prova.mmd
 * Plano: docs/implementar/PLANO-CICLO-COMPLETO-DOS-BRINQUEDOS.md §7 (CB-E)
 *
 * E5: volta danificada sem foto é recusada; com foto, abre a avaria; cobrar sem
 * foto é recusado; a foto de outro tenant dá 404; o responsável sobe foto da
 * preparação pelo Portal e outro colaborador não (§7 itens 2 a 4).
 *
 * O spec afirma o plano; divergência é falha de código, não de asserção.
 */

/** Passos do castelo da FC-22: o primeiro exige foto. */
const PHOTO_PROOF_STEPS: PreparationStepInput[] = [
  { title: 'Fotografar a lona inteira', category: 'Safety', isMandatory: true, requiresPhoto: true },
  { title: 'Higienizar a lona', category: 'Cleaning', isMandatory: true },
];

interface PortalPreparation {
  rentalId: string;
  units: Array<{
    rentalItemId: string;
    checks: Array<{ id: string; title: string; requiresPhoto: boolean; status: string; photos: Array<{ id: string }> }>;
  }>;
}

test.describe('Fluxo completo 22 — Fotos como prova', () => {
  test('@flow E5: a damaged return without a photo is refused; with the photo it opens the damage report; charging without a photo is refused; the photo of another tenant gives 404', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(240_000);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_equipment_rental');
    const date = tenantDayPlus(20);
    const paid = await setupPaidEvent(authApi, { budget: { eventDate: date } });
    const type = await apiCreateEquipmentType(authApi, { name: `Cama elastica E2E ${uniqueSuffix()}` });
    const unit = await apiCreateEquipmentUnit(authApi, type.id);
    const draft = await apiCreateRental(authApi, {
      clientId: paid.clienteId,
      eventId: paid.eventId,
      deliveryDate: date,
      unitIds: [unit.id],
    });
    await apiTransitionRental(authApi, draft.id, 'Reserved', 'Confirmed', 'Preparing');
    await assertOk(await inspectRentalBatch(authApi, draft.id, { type: 'Outbound' }), 'inspeção de saída');
    await apiTransitionRental(authApi, draft.id, 'Dispatched', 'Delivered', 'InUse', 'Returned');
    const item = (await apiGetRental(authApi, draft.id)).items[0]!;
    const damaged = { rentalItemId: item.id, condition: 'Damaged' as const, notes: 'Lona rasgada (E2E)' };

    // §7 item 4: volta `Damaged` sem foto `InboundInspection` do item é recusada, sem inspeção nem avaria.
    const noPhoto = await inspectRentalBatch(authApi, draft.id, { type: 'Inbound', exceptions: [damaged], photos: false });
    expect(noPhoto.status(), 'volta danificada sem foto').toBe(400);
    expect(await apiErrorCodes(noPhoto)).toContain('Inspection.PhotoRequired');
    expect((await apiGetRental(authApi, draft.id)).inspections.filter((i) => i.type === 'Inbound')).toHaveLength(0);
    expect((await apiListDamageReports(authApi, { rentalId: draft.id })).items).toHaveLength(0);

    // Com a foto do item enviada antes, a volta é registrada e a avaria abre com a prova.
    const inboundPhoto = await apiUploadRentalPhoto(authApi, draft.id, { context: 'InboundInspection', rentalItemId: item.id });
    await assertOk(
      await inspectRentalBatch(authApi, draft.id, { type: 'Inbound', exceptions: [damaged], photos: false }),
      'volta danificada com foto',
    );
    const [report] = (await apiListDamageReports(authApi, { rentalId: draft.id })).items;
    expect(report, 'a avaria abre').toBeTruthy();
    expect(report!.isOpen).toBe(true);
    const detail = (await apiGetDamageReport(authApi, report!.id)) as unknown as {
      photos: Array<{ id: string; context: string; isLocked: boolean }>;
    };
    expect(detail.photos.map((p) => p.id), 'a foto da inspeção de volta no detalhe da avaria').toContain(inboundPhoto.id);
    const inbound = (await apiListRentalPhotos(authApi, draft.id)).find((p) => p.id === inboundPhoto.id)!;
    expect(inbound.targetId, 'a foto ganha o id da inspeção criada').not.toBeNull();

    // §7 item 4: "Cobrar do cliente" sem nenhuma foto da avaria ou da volta é recusado.
    const removed = await authApi.delete(`/api/rentals/${draft.id}/photos/${inboundPhoto.id}`);
    await assertOk(removed, 'DELETE da foto ainda destravada');
    const chargeWithoutPhoto = await resolveDamageReport(authApi, report!.id, {
      resolution: 'ChargeClient',
      amount: 150,
      reason: 'Lona rasgada (E2E)',
    });
    expect(chargeWithoutPhoto.status(), 'cobrar sem foto').toBe(409);
    expect(await apiErrorCodes(chargeWithoutPhoto)).toContain('DamageReport.ChargeRequiresPhoto');
    expect((await apiGetDamageReport(authApi, report!.id)).resolution, 'nada decidido').toBe('Pending');

    // Com a foto da avaria, cobra; a decisão trava as fotos existentes.
    const damagePhoto = await apiUploadRentalPhoto(authApi, draft.id, { context: 'Damage', targetId: report!.id });
    await assertOk(
      await resolveDamageReport(authApi, report!.id, { resolution: 'ChargeClient', amount: 150, reason: 'Lona rasgada (E2E)' }),
      'cobrar com foto',
    );
    expect((await apiGetDamageReport(authApi, report!.id)).resolution).toBe('ChargedToClient');
    const locked = (await apiListRentalPhotos(authApi, draft.id)).find((p) => p.id === damagePhoto.id)!;
    expect(locked.isLocked, 'prova travada').toBe(true);
    const removeLocked = await authApi.delete(`/api/rentals/${draft.id}/photos/${damagePhoto.id}`);
    expect(removeLocked.status(), 'remover foto travada').toBe(409);
    expect(await apiErrorCodes(removeLocked)).toContain('RentalPhoto.Locked');

    // Cross-tenant: o conteúdo da foto abre no dono e dá 404 no outro tenant.
    const own = await authApi.get(`/api/rentals/${draft.id}/photos/${damagePhoto.id}/content`);
    expect(own.status(), 'o dono baixa a foto').toBe(200);
    const other = await signupNewTenant();
    enableFeatureFlagDirect(other.tenantId, 'feature_equipment_rental');
    const otherApi = await createBearerApiContext(other.accessToken);
    try {
      const foreign = await otherApi.get(`/api/rentals/${draft.id}/photos/${damagePhoto.id}/content`);
      expect(foreign.status(), 'foto de outra empresa').toBe(404);
      const foreignList = await otherApi.get(`/api/rentals/${draft.id}/photos`);
      expect(foreignList.status(), 'fotos de locação de outra empresa').toBe(404);
    } finally {
      await otherApi.dispose();
    }
  });

  test('@flow E5: the responsible collaborator uploads the photo of the preparation item through the Portal and marks it done; another collaborator gets 404', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(180_000);
    const { rental } = await setupReservedRental(authApi, tenant.tenantId, {
      deliveryDate: tenantDayPlus(10),
      steps: PHOTO_PROOF_STEPS,
      typeName: `Castelo inflavel E2E ${uniqueSuffix()}`,
    });
    const responsible = await apiCreateCollaborator(authApi);
    const stranger = await apiCreateCollaborator(authApi);
    await assertOk(
      await scheduleRentalPreparation(authApi, rental.id, {
        date: tenantDayPlus(0),
        responsibleCollaboratorId: responsible.id,
      }),
      'data da preparação com o responsável',
    );

    const sessions: RoleSession[] = [];
    try {
      const portal = await loginPortalCollaborator(tenant.tenantId, responsible.id);
      sessions.push(portal);
      const other = await loginPortalCollaborator(tenant.tenantId, stranger.id);
      sessions.push(other);

      const res = await portal.api.get(`/api/portal/rental-preparations/${rental.id}`);
      await assertOk(res, 'GET /api/portal/rental-preparations/{id}');
      const prep = await readJson<PortalPreparation>(res);
      const check = prep.units.flatMap((u) => u.checks).find((c) => c.title === 'Fotografar a lona inteira')!;
      expect(check, 'o item que exige foto').toBeTruthy();
      expect(check.requiresPhoto).toBe(true);

      // §7 item 4: o item que exige foto não fica feito sem foto dele.
      const doneWithoutPhoto = await portal.api.post(
        `/api/portal/rental-preparations/${rental.id}/checks/${check.id}/complete`,
        { data: { status: 'Done', notes: null } },
      );
      expect(doneWithoutPhoto.ok(), '"Feito" sem foto').toBe(false);
      expect(await apiErrorCodes(doneWithoutPhoto)).toContain('RentalPreparation.PhotoRequired');

      // §7 item 3: outro colaborador recebe o mesmo 404 da preparação.
      const foreign = await uploadPortalRentalPhoto(other.api, 'rental-preparations', rental.id, check.id);
      expect(foreign.status(), 'colaborador que não é o responsável').toBe(404);
      expect(await apiErrorCodes(foreign)).toContain('RentalPreparation.NotFound');

      // O responsável sobe a foto e marca o item.
      const upload = await uploadPortalRentalPhoto(portal.api, 'rental-preparations', rental.id, check.id);
      await assertOk(upload, 'POST /api/portal/rental-preparations/{id}/photos');
      const photo = await readJson<{ id: string; context: string; targetId: string }>(upload);
      expect(photo.context).toBe('Preparation');
      expect(photo.targetId).toBe(check.id);
      await assertOk(
        await portal.api.post(`/api/portal/rental-preparations/${rental.id}/checks/${check.id}/complete`, {
          data: { status: 'Done', notes: null },
        }),
        'complete com foto',
      );

      // O gestor vê o item feito e a foto do colaborador.
      const managerCheck = preparationChecks(await apiGetRentalPreparation(authApi, rental.id)).find((c) => c.id === check.id)!;
      expect(managerCheck.status).toBe('Done');
      const photos = (await apiListRentalPhotos(authApi, rental.id)).filter((p) => p.context === 'Preparation');
      expect(photos.map((p) => p.id)).toContain(photo.id);
      expect(photos.find((p) => p.id === photo.id)!.targetId).toBe(check.id);
      expect(photos.filter((p) => p.targetId === check.id), 'a foto do estranho não entrou').toHaveLength(1);
    } finally {
      for (const s of sessions) await s.api.dispose();
    }
  });
});
