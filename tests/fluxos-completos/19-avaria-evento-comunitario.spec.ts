import type { APIRequestContext, Locator } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCompleteOnboarding, apiListNotifications } from '../../helpers/api-entities';
import { apiGetPaymentPlan, setupCommunityEvent } from '../../helpers/api-event-flow';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';
import { tenantDayPlus, uniqueSuffix } from '../../helpers/rain-plan';
import {
  DamageReport,
  apiCreateEquipmentType,
  apiCreateEquipmentUnit,
  apiCreateRental,
  apiGetConsumptionReview,
  apiGetDamageReport,
  apiGetRental,
  apiTransitionRental,
  completeEventWithMaterialLoss,
  confirmConsumptionReview,
  markDamageRepaired,
  resolveDamageReport,
  returnRentalWithDamages,
  setupReusableMaterialActivity,
  startDamageRepair,
  writeOffDamageReport,
} from '../../helpers/rental-preparation';
import { apiErrorCodes, assertOk, readJson } from '../../helpers/response';

/**
 * Fluxo: fluxos-completos/19 — Avaria e perda em evento comunitário
 * (PLANO-PREPARACAO-DE-EQUIPAMENTOS, PE-I, Etapa 269)
 * Diagrama: — (o plano é a fonte: §11 itens 2 a 6; decisão 18)
 *
 * E13: na ação comunitária, a avaria da inspeção de volta nasce assumida, com o
 * selo "Assumida — evento comunitário" e sem o aviso de decisão aos gestores;
 * "Consertada" com custo lança a despesa do evento, que aparece na aba Despesas
 * (só o total, sem margem) e no custo da ação; a perda de reutilizável na
 * conferência fica assumida sem despesa e entra no custo da ação só pela
 * variação de material (sem contar duas vezes); o `resolve` com "cobrar" e a
 * confirmação da conferência com a perda cobrada pela API dão 409
 * `Event.NotChargeable`, sem nada gravado.
 *
 * O evento nasce pelo `confirm-community` real (`setupCommunityEvent`). O spec
 * afirma o plano; divergência é falha de código, não de asserção.
 */

const DAMAGE_NOTICE = 'DamageReportPendingDecision';
const COMMUNITY_BADGE = 'Assumida — evento comunitário';
const COMMUNITY_NOTE = 'Sem cliente para cobrar: o conserto ou a reposição entra como despesa da ação.';

function brl(value: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
    .format(value)
    .replace(/\s+/g, ' ');
}

async function expectMoney(locator: Locator, value: number, message: string): Promise<void> {
  await expect(locator, message).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => (await locator.innerText()).replace(/\s+/g, ' '), { message })
    .toContain(brl(value));
}

interface EventExpenses {
  totalExpenses: number;
  netMargin: number | null;
  expenses: Array<{ id: string; eventId: string; amount: number; category: string }>;
}

async function getEventExpenses(api: APIRequestContext, eventId: string): Promise<EventExpenses> {
  const res = await api.get(`/api/events/${eventId}/expenses`);
  await assertOk(res, 'GET /api/events/{id}/expenses');
  return readJson<EventExpenses>(res);
}

interface CommunityCostLine {
  category: string | number;
  estimated: number | null;
  real: number;
}

async function getCommunityCost(
  api: APIRequestContext,
  eventId: string,
): Promise<{ realCost: number; lines: CommunityCostLine[] }> {
  const res = await api.get(`/api/events/${eventId}/profitability`);
  await assertOk(res, 'GET /api/events/{id}/profitability');
  const body = await readJson<{ communityCost: { realCost: number; lines: CommunityCostLine[] } | null }>(res);
  expect(body.communityCost, 'bloco do custo da ação').toBeTruthy();
  return body.communityCost!;
}

/** Linha do custo da ação pela categoria (o enum viaja como nome; o número fica de reserva). */
function costLine(lines: CommunityCostLine[], name: 'Expenses' | 'Material'): CommunityCostLine {
  const number = { Expenses: 2, Material: 3 }[name];
  const line = lines.find((l) => l.category === name || l.category === number);
  expect(line, `linha ${name} do custo da ação`).toBeTruthy();
  return line!;
}

test.describe('Fluxo completo 19 — Avaria e perda em evento comunitário', () => {
  test('@flow E13: on a community action the return damage is born absorbed, without the decision notice; the repair and the write-off book event expenses (Expenses tab: total only; action cost); the reusable loss stays absorbed without expense; charging by resolve and by the review gives 409 Event.NotChargeable with nothing recorded', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(420_000);
    await apiCompleteOnboarding(authApi);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_equipment_rental');
    enableFeatureFlagDirect(tenant.tenantId, 'feature_stock');
    const unitCost = 25;
    const material = await setupReusableMaterialActivity(authApi, { unitCost });

    // A ação comunitária pelo `confirm-community` real, com a locação dos brinquedos.
    const date = tenantDayPlus(10);
    const action = await setupCommunityEvent(authApi, { eventDate: date, activityIds: [material.activityId] });
    expect(await apiGetPaymentPlan(authApi, action.eventId), 'ação sem plano de pagamento').toBeNull();
    const type = await apiCreateEquipmentType(authApi, { name: `Pula-pula E2E ${uniqueSuffix()}`, steps: [], requirements: [] });
    const repairUnit = await apiCreateEquipmentUnit(authApi, type.id);
    const lostUnit = await apiCreateEquipmentUnit(authApi, type.id);
    const draft = await apiCreateRental(authApi, {
      clientId: action.clientId,
      eventId: action.eventId,
      deliveryDate: date,
      unitIds: [repairUnit.id, lostUnit.id],
    });
    await apiTransitionRental(authApi, draft.id, 'Reserved');
    const rental = await apiGetRental(authApi, draft.id);
    const itemOf = (unitId: string) => rental.items.find((i) => i.equipmentUnitId === unitId)!.id;

    // §11 item 2 — a inspeção de volta cria as avarias já assumidas.
    const reports = await returnRentalWithDamages(authApi, rental.id, [
      { rentalItemId: itemOf(repairUnit.id), condition: 'Damaged', notes: 'Lona rasgada (E2E)' },
      { rentalItemId: itemOf(lostUnit.id), condition: 'Unusable', notes: 'Soprador queimado (E2E)' },
    ]);
    expect(reports).toHaveLength(2);
    const toRepair = reports.find((r) => r.equipmentUnitId === repairUnit.id) as DamageReport;
    const toWriteOff = reports.find((r) => r.equipmentUnitId === lostUnit.id) as DamageReport;
    for (const r of [toRepair, toWriteOff]) {
      expect(r.eventChargeMode, 'o modo do evento no DTO').toBe('Community');
      expect(r.resolution, 'nasce assumida, sem decisão').toBe('AbsorbedByCompany');
      expect(r.resolvedByUserId, 'ninguém decidiu').toBeNull();
      expect(r.chargeClient).toBe(false);
      expect(r.chargeAmount).toBeNull();
      expect(r.chargeMode).toBeNull();
      expect(r.expenseId, 'sem custo ainda, sem despesa').toBeNull();
      expect(r.isOpen).toBe(true);
    }

    // Sem o aviso 38 de decisão aos gestores.
    const notices = (await apiListNotifications(authApi)).filter(
      (n) => n.type === DAMAGE_NOTICE && [toRepair.id, toWriteOff.id].includes(n.contextEntityId ?? ''),
    );
    expect(notices, 'avaria comunitária não pede decisão').toHaveLength(0);

    // §11 item 6 — o detalhe: o selo, o texto e nenhum diálogo de decisão.
    await authPage.goto(`/app/rentals/damage-reports/${toRepair.id}`);
    await expect(authPage.getByTestId('damage-report-resolution')).toHaveText(COMMUNITY_BADGE, { timeout: 20_000 });
    await expect(authPage.getByTestId('damage-report-community-note')).toHaveText(COMMUNITY_NOTE);
    await expect(authPage.getByTestId('damage-report-resolve'), 'sem "Cobrar do cliente / Assumir o custo"').toHaveCount(0);
    await expect(authPage.getByTestId('damage-report-decision')).toContainText(COMMUNITY_BADGE);

    // §11 item 4 — "cobrar" pela API: 409 `Event.NotChargeable`, nada gravado.
    const charge = await resolveDamageReport(authApi, toRepair.id, {
      resolution: 'ChargeClient',
      amount: 200,
      reason: 'Tentando cobrar a escola (E2E)',
    });
    expect(charge.status(), 'resolve ChargeClient na ação comunitária').toBe(409);
    expect(await apiErrorCodes(charge)).toContain('Event.NotChargeable');
    const afterCharge = await apiGetDamageReport(authApi, toRepair.id);
    expect(afterCharge.resolution).toBe('AbsorbedByCompany');
    expect(afterCharge.financialAdjustmentId).toBeNull();
    expect(afterCharge.chargeAmount).toBeNull();
    expect(await apiGetPaymentPlan(authApi, action.eventId), 'nenhum plano nasce').toBeNull();

    // §11 item 3 — o conserto e a baixa lançam a despesa do evento pelo custo real e o de reposição.
    await assertOk(await startDamageRepair(authApi, toRepair.id), 'start-repair');
    await assertOk(await markDamageRepaired(authApi, toRepair.id, 150), 'repaired');
    await assertOk(
      await writeOffDamageReport(authApi, toWriteOff.id, { replacementCost: 300, retireUnit: true }),
      'write-off',
    );
    const repaired = await apiGetDamageReport(authApi, toRepair.id);
    const writtenOff = await apiGetDamageReport(authApi, toWriteOff.id);
    expect(repaired.expenseId, 'despesa do conserto').toBeTruthy();
    expect(writtenOff.expenseId, 'despesa da reposição').toBeTruthy();
    const expenses = await getEventExpenses(authApi, action.eventId);
    const repairExpense = expenses.expenses.find((e) => e.id === repaired.expenseId);
    const replacementExpense = expenses.expenses.find((e) => e.id === writtenOff.expenseId);
    expect(repairExpense?.eventId, 'a despesa é do evento').toBe(action.eventId);
    expect(repairExpense?.amount).toBe(150);
    expect(replacementExpense?.amount).toBe(300);
    expect(expenses.totalExpenses).toBeCloseTo(450, 2);
    expect(expenses.netMargin, 'sem margem na ação comunitária').toBeNull();

    // A aba Despesas: só o total, sem "Total do Evento" nem "Margem Líquida".
    await authPage.goto(`/app/events/${action.eventId}`);
    await authPage.getByRole('tab', { name: 'Despesas', exact: true }).click({ timeout: 20_000 });
    await expectMoney(authPage.getByTestId('expense-tab-total-expenses'), 450, 'total das despesas na aba');
    await expect(authPage.getByTestId('expense-tab-net-margin'), 'sem margem').toHaveCount(0);
    await expect(authPage.getByTestId('expense-tab-event-total')).toHaveCount(0);
    await expect(authPage.getByTestId('expense-tab-community-note')).toBeVisible();

    // E no custo da ação, pela linha de despesas.
    expect(costLine((await getCommunityCost(authApi, action.eventId)).lines, 'Expenses').real).toBeCloseTo(450, 2);

    // §11 item 5 — a cadeirinha perdida na festa, pela conferência.
    const { recordId } = await completeEventWithMaterialLoss(authApi, tenant.tenantId, action.eventId, {
      productId: material.productId,
      extra: 1,
    });
    const pending = (await apiGetConsumptionReview(authApi, action.eventId)).find((r) => r.id === recordId)!;
    expect(pending.status).toBe('PendingConfirmation');
    expect(pending.variance).toBe(1);

    // Cobrar a perda pela API: 409 `Event.NotChargeable`, nada gravado.
    const chargeLoss = await confirmConsumptionReview(authApi, action.eventId, [
      { recordId, lossResolution: 'ChargedToClient', lossChargeAmount: unitCost },
    ]);
    expect(chargeLoss.status(), 'conferência com a perda cobrada na ação comunitária').toBe(409);
    expect(await apiErrorCodes(chargeLoss)).toContain('Event.NotChargeable');
    const stillPending = (await apiGetConsumptionReview(authApi, action.eventId)).find((r) => r.id === recordId)!;
    expect(stillPending.status, 'a conferência não fechou').toBe('PendingConfirmation');
    expect(stillPending.lossResolution).toBeNull();
    expect(stillPending.lossFinancialAdjustmentId).toBeNull();
    expect(await apiGetPaymentPlan(authApi, action.eventId)).toBeNull();

    // Sem decisão, a perda fica assumida e NÃO vira despesa (decisão 18).
    await assertOk(await confirmConsumptionReview(authApi, action.eventId, []), 'confirm sem cobrança');
    const confirmed = (await apiGetConsumptionReview(authApi, action.eventId)).find((r) => r.id === recordId)!;
    expect(confirmed.status).toBe('Confirmed');
    expect(confirmed.lossResolution).toBe('Absorbed');
    expect(confirmed.lossChargeAmount).toBeNull();
    expect(confirmed.lossFinancialAdjustmentId).toBeNull();
    const expensesAfterLoss = await getEventExpenses(authApi, action.eventId);
    expect(expensesAfterLoss.expenses, 'a perda não lança despesa').toHaveLength(expenses.expenses.length);
    expect(expensesAfterLoss.totalExpenses).toBeCloseTo(450, 2);

    // O custo da ação conta a perda uma vez, pela variação de material.
    const cost = await getCommunityCost(authApi, action.eventId);
    expect(costLine(cost.lines, 'Expenses').real, 'despesas sem a perda').toBeCloseTo(450, 2);
    const materialLine = costLine(cost.lines, 'Material');
    expect(materialLine.real - (materialLine.estimated ?? 0), 'material = estimado + a cadeirinha perdida').toBeCloseTo(
      unitCost,
      2,
    );
    expect(cost.realCost, 'o custo real é a soma das linhas').toBeCloseTo(
      cost.lines.reduce((acc, l) => acc + l.real, 0),
      2,
    );
  });
});
