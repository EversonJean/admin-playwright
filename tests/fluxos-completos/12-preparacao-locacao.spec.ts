import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { setupAcceptedEvent } from '../../helpers/setup-flows';
import { apiErrorCodes, assertOk, readJson } from '../../helpers/response';
import {
  RENTAL_PREPARATION_KEY,
  apiCreateEquipmentType,
  apiCreateEquipmentUnit,
  apiCreateRental,
  apiGetEventChecklist,
  apiGetRental,
  apiGetRentalPreparation,
  apiTransitionRental,
  completePreparationCheck,
  preparationChecks,
  rentalPreparationItem,
  setupReservedRental,
  transitionRental,
} from '../../helpers/rental-preparation';
import { tenantDayPlus } from '../../helpers/rain-plan';

/**
 * Fluxo: 12 — Preparação da locação de festa (PLANO-PREPARACAO-DE-EQUIPAMENTOS, PE-B)
 * Diagrama: — (o plano é a fonte: §4 itens 1, 7 e 9, decisões 16 e 19)
 *
 * E1: reservar uma locação ligada a uma festa cria a preparação por unidade com
 * os passos e os requisitos do tipo, e o item "Preparar os brinquedos" no
 * checklist do evento; despachar com item obrigatório pendente é recusado;
 * concluir a preparação marca o item do evento sozinho.
 */
test.describe('Fluxo 12 — Preparação da locação de festa', () => {
  test('@flow E1: reserving a party rental creates the per-unit preparation from the type steps and requirements and the "Preparar os brinquedos" event item; dispatch with a mandatory item pending is refused; finishing the preparation checks the event item by itself', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(240_000);
    const { eventId, clienteId } = await setupAcceptedEvent(authApi, { budget: { eventDate: tenantDayPlus(20) } });

    // §4 item 1: os passos viram itens na ordem do cadastro; cada requisito vira
    // "Levar: {nome}" (Packing quando é de transporte, Accessories nos demais),
    // com o obrigatório dele.
    const { rental, unit } = await setupReservedRental(authApi, tenant.tenantId, {
      eventId,
      clientId: clienteId,
      deliveryDate: tenantDayPlus(20),
      requirements: [
        { name: 'Extensão', category: 'Power', isMandatory: true },
        { name: 'Lona de chão', category: 'Transport', isMandatory: false },
      ],
    });
    expect(rental.status).toBe('Reserved');

    const prep = await apiGetRentalPreparation(authApi, rental.id);
    expect(prep.isMaterialized, 'a reserva grava a preparação').toBe(true);
    expect(prep.status).toBe('Pending');
    expect(prep.requiresMaintenance, 'há passo de preparação: liga a manutenção').toBe(true);
    expect(prep.units).toHaveLength(1);
    expect(prep.units[0]!.rentalItemId).toBe(rental.items[0]!.id);
    expect(prep.units[0]!.assetCode).toBe(unit.assetCode);

    const checks = preparationChecks(prep);
    const steps = checks.filter((c) => c.source === 'PreparationStep');
    expect(steps.map((c) => [c.title, c.category, c.isMandatory])).toEqual([
      ['Higienizar a lona', 'Cleaning', true],
      ['Testar o soprador', 'FunctionalTest', true],
      ['Conferir as costuras', 'Safety', false],
    ]);
    const bring = checks.filter((c) => c.source === 'SetupRequirement');
    expect(bring.map((c) => [c.title, c.category, c.isMandatory]).sort()).toEqual(
      [
        ['Levar: Extensão', 'Accessories', true],
        ['Levar: Lona de chão', 'Packing', false],
      ].sort(),
    );
    expect(checks.every((c) => c.status === 'Pending')).toBe(true);

    // §4 item 9: um item de sistema por evento, com o número da locação na
    // descrição e o título de quem tem brinquedo a higienizar.
    const item = await rentalPreparationItem(authApi, eventId);
    expect(item, 'o item "Preparar os brinquedos" nasce no checklist do evento').toBeTruthy();
    expect(item!.title).toBe('Preparar e higienizar os brinquedos locados');
    expect(item!.description ?? '').toContain(rental.rentalNumber);
    expect(item!.isDone).toBe(false);

    // Decisão 16: locação de tipo sem passo nem requisito não ganha preparação,
    // não trava e não entra no item do evento.
    const plainType = await apiCreateEquipmentType(authApi, { name: `Caixa de som E2E ${Date.now()}` });
    const plainUnit = await apiCreateEquipmentUnit(authApi, plainType.id);
    const plain = await apiCreateRental(authApi, {
      clientId: clienteId,
      eventId,
      deliveryDate: tenantDayPlus(20),
      unitIds: [plainUnit.id],
    });
    await apiTransitionRental(authApi, plain.id, 'Reserved');
    const plainPrep = await apiGetRentalPreparation(authApi, plain.id);
    expect(plainPrep.isMaterialized, 'sem passo nem requisito: nada gravado').toBe(false);
    expect(plainPrep.units, 'sem passo nem requisito: nada a preparar').toHaveLength(0);
    const itemsAfterPlain = (await apiGetEventChecklist(authApi, eventId)).filter(
      (i) => i.systemKey === RENTAL_PREPARATION_KEY,
    );
    expect(itemsAfterPlain, 'um item por evento').toHaveLength(1);
    expect(itemsAfterPlain[0]!.description ?? '').not.toContain(plain.rentalNumber);

    // §4 item 7: com obrigatório pendente, a saída é recusada.
    await apiTransitionRental(authApi, rental.id, 'Confirmed', 'Preparing');
    const blocked = await transitionRental(authApi, rental.id, 'Dispatched');
    expect(blocked.status()).toBe(409);
    expect(await apiErrorCodes(blocked)).toContain('Rental.PreparationPending');
    expect((await apiGetRental(authApi, rental.id)).status).toBe('Preparing');

    // Concluir os obrigatórios fecha a preparação (o opcional pode ficar) e o
    // item do evento se marca sozinho (§4 itens 6 e 9).
    for (const check of checks.filter((c) => c.isMandatory)) {
      await assertOk(await completePreparationCheck(authApi, rental.id, check.id, 'Done'), `complete ${check.title}`);
    }
    const done = await apiGetRentalPreparation(authApi, rental.id);
    expect(done.status).toBe('Done');
    expect(done.pendingMandatoryCount).toBe(0);
    expect((await rentalPreparationItem(authApi, eventId))!.isDone, 'o item do evento fecha sozinho').toBe(true);

    // §4 item 7: a inspeção de saída grava "checklist concluído" a partir da
    // preparação e ignora o valor do corpo; com ela, a locação sai.
    const inspection = await authApi.post(`/api/rentals/${rental.id}/inspections`, {
      data: { rentalItemId: rental.items[0]!.id, type: 'Outbound', condition: 'Perfect', checklistCompleted: false },
    });
    await assertOk(inspection, 'POST inspection Outbound');
    const outbound = (await apiGetRental(authApi, rental.id)).inspections.find((i) => i.type === 'Outbound');
    expect(outbound?.checklistCompleted, 'derivado da preparação concluída').toBe(true);

    await assertOk(await transitionRental(authApi, rental.id, 'Dispatched'), 'transition → Dispatched');
    const dispatched = await readJson<{ status: string }>(
      await authApi.get(`/api/rentals/${rental.id}`),
    );
    expect(dispatched.status).toBe('Dispatched');
  });
});
