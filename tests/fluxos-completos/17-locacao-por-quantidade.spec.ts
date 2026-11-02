import type { APIRequestContext } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import { PreparationStepInput, apiCompleteOnboarding, apiCreateClient } from '../../helpers/api-entities';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';
import { tenantDayPlus, uniqueSuffix } from '../../helpers/rain-plan';
import {
  apiCreateEquipmentType,
  apiCreateEquipmentUnit,
  apiCreateEquipmentUnitBatch,
  apiCreateRental,
  apiGetEquipmentUnit,
  apiGetRental,
  apiGetRentalPreparation,
  apiListAvailableUnits,
  apiListRentalDamageReports,
  apiTransitionRental,
  completePreparationCheck,
  createEquipmentUnitBatch,
  inspectRentalBatch,
  openRentalPreparationTab,
  preparationChecks,
  swapRentalItemUnit,
} from '../../helpers/rental-preparation';
import { apiErrorCodes, assertOk } from '../../helpers/response';
import { RoleSession, loginAsRole, openSessionPage } from '../../helpers/setup-flows';

/**
 * Fluxo: 17 — Locação por quantidade (PLANO-PREPARACAO-DE-EQUIPAMENTOS, PE-E)
 * Diagrama: — (o plano é a fonte: §7 itens 1, 2, 4 e 5; decisões 8 e 17)
 *
 * E7: 20 cadeirinhas em lote numa locação; volta com 19 OK e 1 avariada abre 1
 * avaria; trocar unidade reprovada na preparação refaz os itens; troca depois
 * de despachado recusada.
 *
 * E21: o Financeiro não vê "Cadastrar em lote" nem "Trocar por outra unidade"
 * e o `batch` e o `swap` pela API dão 403, enquanto o Manager troca; a unidade
 * de outro tenant na troca dá 404 e as duas unidades ficam como estavam; o
 * "Adicionar por quantidade" não escolhe a unidade com avaria aberta.
 */

/** Um passo obrigatório por cadeira: a preparação nasce com um item por unidade. */
const CHAIR_STEPS: PreparationStepInput[] = [{ title: 'Higienizar o assento', category: 'Cleaning', isMandatory: true }];

/** O único item (obrigatório) da preparação de um item da locação. */
async function checkOf(api: APIRequestContext, rentalId: string, rentalItemId: string) {
  const prep = await apiGetRentalPreparation(api, rentalId);
  return prep.units.find((u) => u.rentalItemId === rentalItemId)!;
}

/**
 * Locação avulsa de uma unidade levada até a volta com avaria (inspeção de volta
 * `Damaged`) e concluída: a unidade fica livre com avaria aberta (decisão 17).
 */
async function returnWithDamage(api: APIRequestContext, unitId: string, date: string): Promise<void> {
  const client = await apiCreateClient(api);
  const rental = await apiCreateRental(api, { clientId: client.id, deliveryDate: date, unitIds: [unitId] });
  await apiTransitionRental(api, rental.id, 'Reserved', 'Confirmed', 'Preparing');
  const [check] = preparationChecks(await apiGetRentalPreparation(api, rental.id));
  await assertOk(await completePreparationCheck(api, rental.id, check!.id, 'Done'), 'complete');
  await assertOk(await inspectRentalBatch(api, rental.id, { type: 'Outbound' }), 'outbound');
  await apiTransitionRental(api, rental.id, 'Dispatched', 'Delivered', 'InUse', 'Returned');
  const item = rental.items[0]!;
  await assertOk(
    await inspectRentalBatch(api, rental.id, {
      type: 'Inbound',
      exceptions: [{ rentalItemId: item.id, condition: 'Damaged', notes: 'Assento rachado' }],
    }),
    'inbound',
  );
  await apiTransitionRental(api, rental.id, 'Completed');
}

test.describe('Fluxo 17 — Locação por quantidade', () => {
  test('@flow E7: 20 chairs registered in a batch go into one rental; swapping the unit that failed preparation redoes its items; the swap is refused after the outbound inspection and after dispatch; the return with 19 OK and 1 damaged opens 1 damage report', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(300_000);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_equipment_rental');
    const date = tenantDayPlus(20);
    const type = await apiCreateEquipmentType(authApi, { name: `Cadeira infantil E2E ${uniqueSuffix()}`, steps: CHAIR_STEPS });

    // §7 item 1: 22 de uma vez (20 para a festa e 2 de reserva), CAD-01 a CAD-22.
    const prefix = `CAD${uniqueSuffix()}-`.toUpperCase();
    const units = await apiCreateEquipmentUnitBatch(authApi, {
      equipmentTypeId: type.id,
      quantity: 22,
      assetCodePrefix: prefix,
    });
    expect(units).toHaveLength(22);
    const codes = units.map((u) => u.assetCode).sort();
    expect(codes[0]).toBe(`${prefix}01`);
    expect(codes[21]).toBe(`${prefix}22`);
    expect(units.every((u) => u.status === 'Available')).toBe(true);

    // Patrimônio repetido: 409 com a lista, nada gravado.
    const repeated = await createEquipmentUnitBatch(authApi, {
      equipmentTypeId: type.id,
      quantity: 3,
      assetCodePrefix: prefix,
      startNumber: 21,
    });
    expect(repeated.status()).toBe(409);
    expect(await apiErrorCodes(repeated)).toContain('EquipmentUnit.AssetCodeAlreadyExists');
    expect((await apiListAvailableUnits(authApi, { equipmentTypeId: type.id, date, quantity: 30 })).availableCount).toBe(
      22,
    );

    // §7 itens 2 e 3: "Adicionar por quantidade" pega 20 livres, e a locação as agrupa por tipo.
    const available = await apiListAvailableUnits(authApi, { equipmentTypeId: type.id, date, quantity: 20 });
    expect(available.requested).toBe(20);
    expect(available.availableCount).toBe(22);
    expect(available.units).toHaveLength(20);
    const client = await apiCreateClient(authApi);
    const draft = await apiCreateRental(authApi, {
      clientId: client.id,
      deliveryDate: date,
      unitIds: available.units.map((u) => u.id),
    });
    await apiTransitionRental(authApi, draft.id, 'Reserved');
    const rental = await apiGetRental(authApi, draft.id);
    expect(rental.items).toHaveLength(20);
    expect(rental.itemGroups?.map((g) => [g.equipmentTypeId, g.quantity])).toEqual([[type.id, 20]]);
    expect((await apiGetRentalPreparation(authApi, rental.id)).units).toHaveLength(20);

    // §7 item 5: a unidade reprovada na preparação é trocada por uma livre do
    // mesmo tipo; os itens dela saem, os da nova entram pendentes, e o status
    // das duas unidades acompanha.
    const failedItem = rental.items[0]!;
    const failedCheck = (await checkOf(authApi, rental.id, failedItem.id)).checks[0]!;
    await assertOk(
      await completePreparationCheck(authApi, rental.id, failedCheck.id, 'Failed', 'Assento quebrado'),
      'check Failed',
    );
    const spare = units.find((u) => !rental.items.some((i) => i.equipmentUnitId === u.id))!;
    await assertOk(await swapRentalItemUnit(authApi, rental.id, failedItem.id, spare.id), 'swap');

    const swappedUnit = await checkOf(authApi, rental.id, failedItem.id);
    expect(swappedUnit.assetCode).toBe(spare.assetCode);
    expect(swappedUnit.checks.map((c) => c.id)).not.toContain(failedCheck.id);
    expect(swappedUnit.checks.map((c) => [c.title, c.status])).toEqual([['Higienizar o assento', 'Pending']]);
    expect((await apiGetEquipmentUnit(authApi, failedItem.equipmentUnitId)).status, 'a antiga volta à agenda').toBe(
      'Available',
    );
    expect((await apiGetEquipmentUnit(authApi, spare.id)).status, 'a nova fica reservada').toBe('Reserved');
    const afterSwap = await apiGetRental(authApi, rental.id);
    expect(afterSwap.items.find((i) => i.id === failedItem.id)!.equipmentUnitId).toBe(spare.id);

    // Preparação concluída e a saída inspecionada: a troca é recusada.
    for (const check of preparationChecks(await apiGetRentalPreparation(authApi, rental.id))) {
      await assertOk(await completePreparationCheck(authApi, rental.id, check.id, 'Done'), `complete ${check.id}`);
    }
    await apiTransitionRental(authApi, rental.id, 'Confirmed', 'Preparing');
    await assertOk(await inspectRentalBatch(authApi, rental.id, { type: 'Outbound' }), 'outbound batch');
    const otherSpare = units.find(
      (u) => u.id !== spare.id && !rental.items.some((i) => i.equipmentUnitId === u.id),
    )!;
    const afterInspection = await swapRentalItemUnit(authApi, rental.id, rental.items[1]!.id, otherSpare.id);
    expect(afterInspection.status(), 'troca com inspeção de saída').toBe(409);
    expect(await apiErrorCodes(afterInspection)).toContain('Rental.SwapAfterInspection');

    await apiTransitionRental(authApi, rental.id, 'Dispatched');
    const afterDispatch = await swapRentalItemUnit(authApi, rental.id, rental.items[1]!.id, otherSpare.id);
    expect(afterDispatch.status(), 'troca depois de despachado').toBe(409);
    expect(await apiErrorCodes(afterDispatch)).toContain('Rental.SwapNotAllowedInStatus');
    expect((await apiGetEquipmentUnit(authApi, otherSpare.id)).status, 'a reserva intocada').toBe('Available');

    // §7 item 4: volta com 19 OK e 1 avariada — uma inspeção por item, uma avaria só.
    await apiTransitionRental(authApi, rental.id, 'Delivered', 'InUse', 'Returned');
    const damagedItem = rental.items[5]!;
    await assertOk(
      await inspectRentalBatch(authApi, rental.id, {
        type: 'Inbound',
        defaultCondition: 'Perfect',
        exceptions: [{ rentalItemId: damagedItem.id, condition: 'Damaged', notes: 'Perna torta' }],
      }),
      'inbound batch',
    );
    const returned = await apiGetRental(authApi, rental.id);
    expect(returned.inspections.filter((i) => i.type === 'Inbound')).toHaveLength(20);
    const damages = await apiListRentalDamageReports(authApi, rental.id);
    expect(damages, 'uma avaria, da cadeira avariada').toHaveLength(1);
    expect(damages[0]!.rentalItemId).toBe(damagedItem.id);
    expect(damages[0]!.isOpen).toBe(true);

    // Atômico: repetir a inspeção de volta recusa o lote inteiro.
    const again = await inspectRentalBatch(authApi, rental.id, { type: 'Inbound' });
    expect(again.status()).toBe(409);
    expect(await apiErrorCodes(again)).toContain('Inspection.AlreadyRegistered');
    expect(await apiListRentalDamageReports(authApi, rental.id)).toHaveLength(1);
  });

  test('@flow E21: Financial sees neither "Cadastrar em lote" nor "Trocar por outra unidade" and gets 403 on batch and swap while the Manager swaps; another tenant unit in the swap gives 404 and both units stay; pick by quantity skips the unit with an open damage report', async ({
    authApi,
    authPage,
    browser,
    tenant,
  }) => {
    test.setTimeout(300_000);
    await apiCompleteOnboarding(authApi);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_equipment_rental');
    const date = tenantDayPlus(20);
    const type = await apiCreateEquipmentType(authApi, { name: `Cadeira infantil E2E ${uniqueSuffix()}`, steps: CHAIR_STEPS });
    const [u1, u2, u3, u4] = await apiCreateEquipmentUnitBatch(authApi, {
      equipmentTypeId: type.id,
      quantity: 4,
      assetCodePrefix: `CAD${uniqueSuffix()}-`.toUpperCase(),
    });

    // A quarta volta de outra locação com avaria, que fica aberta.
    await returnWithDamage(authApi, u4!.id, tenantDayPlus(10));
    expect((await apiGetEquipmentUnit(authApi, u4!.id)).hasOpenDamage).toBe(true);

    // §7 item 2 (decisão 17): a escolha por quantidade pula a unidade com avaria aberta.
    const available = await apiListAvailableUnits(authApi, { equipmentTypeId: type.id, date, quantity: 4 });
    expect(available.units.map((u) => u.id).sort()).toEqual([u1!.id, u2!.id, u3!.id].sort());
    expect(available.availableCount).toBe(3);
    expect(available.withOpenDamageCount).toBe(1);

    const client = await apiCreateClient(authApi);
    const draft = await apiCreateRental(authApi, { clientId: client.id, deliveryDate: date, unitIds: [u1!.id, u2!.id] });
    await apiTransitionRental(authApi, draft.id, 'Reserved');
    const rental = await apiGetRental(authApi, draft.id);
    const item1 = rental.items.find((i) => i.equipmentUnitId === u1!.id)!;
    const item2 = rental.items.find((i) => i.equipmentUnitId === u2!.id)!;
    const failed = (await checkOf(authApi, rental.id, item1.id)).checks[0]!;
    await assertOk(await completePreparationCheck(authApi, rental.id, failed.id, 'Failed', 'Assento quebrado'), 'Failed');

    // O gestor vê "Cadastrar em lote" (controle do seletor).
    await authPage.goto('/app/rentals/equipment-units');
    await expect(authPage.getByTestId(`equipment-unit-schedule-${u1!.id}`)).toBeVisible({ timeout: 20_000 });
    await expect(authPage.getByTestId('equipment-units-batch')).toBeVisible();

    const sessions: RoleSession[] = [];
    try {
      // Financeiro de verdade: sem `EquipmentUnits.Create` nem `Rentals.Update`.
      const financial = await loginAsRole(tenant.tenantId, 'Financial');
      sessions.push(financial);
      const batch = await createEquipmentUnitBatch(financial.api, {
        equipmentTypeId: type.id,
        quantity: 2,
        assetCodePrefix: `FIN${uniqueSuffix()}-`.toUpperCase(),
      });
      expect(batch.status(), 'Financial não cadastra lote').toBe(403);
      const swap = await swapRentalItemUnit(financial.api, rental.id, item1.id, u3!.id);
      expect(swap.status(), 'Financial não troca unidade').toBe(403);

      const financialView = await openSessionPage(browser, financial.tokens);
      try {
        await financialView.page.goto('/app/rentals/equipment-units');
        await expect(financialView.page.getByTestId(`equipment-unit-schedule-${u1!.id}`)).toBeVisible({
          timeout: 20_000,
        });
        await expect(financialView.page.getByTestId('equipment-units-batch')).toHaveCount(0);

        await openRentalPreparationTab(financialView.page, rental.id);
        // Uma linha de sugestão por ação ("trocar" e "abrir manutenção"): a da troca está lá, sem o botão.
        await expect(
          financialView.page.getByTestId(`rental-preparation-check-suggestion-${failed.id}`).filter({ hasText: 'Sugestão' }).first(),
        ).toBeVisible();
        await expect(financialView.page.getByTestId(`rental-preparation-check-swap-${failed.id}`)).toHaveCount(0);
      } finally {
        await financialView.context.close();
      }

      // Isolamento: unidade de outro tenant na troca dá 404 e nada muda.
      const other = await signupNewTenant();
      enableFeatureFlagDirect(other.tenantId, 'feature_equipment_rental');
      const otherAdmin = await createBearerApiContext(other.accessToken);
      try {
        const foreignType = await apiCreateEquipmentType(otherAdmin, { steps: CHAIR_STEPS });
        const foreignUnit = await apiCreateEquipmentUnit(otherAdmin, foreignType.id);
        const cross = await swapRentalItemUnit(authApi, rental.id, item2.id, foreignUnit.id);
        expect(cross.status(), 'unidade de outro tenant').toBe(404);
        expect(await apiErrorCodes(cross)).toContain('EquipmentUnit.NotFound');
        expect((await apiGetRental(authApi, rental.id)).items.find((i) => i.id === item2.id)!.equipmentUnitId).toBe(
          u2!.id,
        );
        expect((await apiGetEquipmentUnit(authApi, u2!.id)).status).toBe('Reserved');
        expect((await apiGetEquipmentUnit(otherAdmin, foreignUnit.id)).status).toBe('Available');
      } finally {
        await otherAdmin.dispose();
      }

      // O Manager troca pela tela; o diálogo não oferece a unidade com avaria aberta.
      const manager = await loginAsRole(tenant.tenantId, 'Manager');
      sessions.push(manager);
      const managerView = await openSessionPage(browser, manager.tokens);
      try {
        await openRentalPreparationTab(managerView.page, rental.id);
        await managerView.page.getByTestId(`rental-preparation-check-swap-${failed.id}`).click();
        await expect(managerView.page.getByTestId('swap-unit-title')).toBeVisible();
        await expect(managerView.page.getByTestId(`swap-unit-option-${u3!.id}`)).toBeVisible({ timeout: 20_000 });
        await expect(managerView.page.getByTestId(`swap-unit-option-${u4!.id}`)).toHaveCount(0);
        await expect(managerView.page.getByTestId('swap-unit-damaged')).toContainText('1 unidade');
        // O host do `mat-radio-button` ocupa a linha inteira do grupo: o clique no
        // centro dele cai no vazio e não marca nada. Clica no rótulo, como o 18.
        await managerView.page.getByTestId(`swap-unit-option-${u3!.id}`).locator('label').click();
        await managerView.page.getByTestId('swap-unit-submit').click();
        await expect(managerView.page.getByTestId('swap-unit-title')).toHaveCount(0, { timeout: 20_000 });
      } finally {
        await managerView.context.close();
      }

      const swapped = await apiGetRental(authApi, rental.id);
      expect(swapped.items.find((i) => i.id === item1.id)!.equipmentUnitId, 'o Manager trocou').toBe(u3!.id);
      expect((await apiGetEquipmentUnit(authApi, u1!.id)).status).toBe('Available');
      expect((await apiGetEquipmentUnit(authApi, u3!.id)).status).toBe('Reserved');
      expect((await checkOf(authApi, rental.id, item1.id)).checks.map((c) => c.status)).toEqual(['Pending']);
    } finally {
      for (const s of sessions) await s.api.dispose();
    }
  });
});
