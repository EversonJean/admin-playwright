import type { APIRequestContext, APIResponse, Locator, Page } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import { apiCompleteOnboarding, apiListNotifications } from '../../helpers/api-entities';
import { apiGetPaymentPlan, apiGetPaymentSummary, apiRegisterPayment } from '../../helpers/api-event-flow';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';
import { tenantDayPlus, uniqueSuffix } from '../../helpers/rain-plan';
import {
  DamageCondition,
  DamageReport,
  apiCreateEquipmentType,
  apiCreateEquipmentUnit,
  apiCreateRental,
  apiGetConsumptionReview,
  apiGetDamageReport,
  apiGetEquipmentUnit,
  apiGetRental,
  apiListDamageReports,
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
import { RoleSession, loginAsRole, openSessionPage, setupAcceptedEvent, setupPaidEvent } from '../../helpers/setup-flows';

/**
 * Fluxo: fluxos-completos/18 — Avaria: cobrar do cliente ou assumir o custo
 * (PLANO-PREPARACAO-DE-EQUIPAMENTOS, PE-F)
 * Diagrama: — (o plano é a fonte: §8 itens 1, 4, 5, 7 e 11; decisões 9 e 10)
 *
 * E4: avaria na volta decidida como "cobrar do cliente" cria a parcela nova no
 * plano do evento e muda o status financeiro; "assumir" lança a despesa do
 * evento no conserto; perda de cadeirinha na conferência cobrada do cliente;
 * Manager não cobra.
 *
 * E23: o Financeiro abre a lista e o detalhe da avaria e leva 403 ao consertar,
 * cobrar e assumir pela API; o Manager assume e leva 403 ao cobrar, também pela
 * confirmação da conferência; a avaria de outro tenant dá 404; a cobrança grava
 * a parcela e o ajuste no tenant do evento; o aviso 38 chega aos gestores e
 * abre o detalhe da avaria; o tenant sem o add-on de locação vê "Avarias" no
 * menu (convenção do front: o item aparece e a rota barra), cai na tela de
 * bloqueio ao abri-la e não vê a parte de avarias da aba do evento.
 *
 * O spec afirma o plano; divergência é falha de código, não de asserção.
 */

const DAMAGE_NOTICE = 'DamageReportPendingDecision';
const MAINTENANCE_CATEGORY = 'Manutenção de equipamentos';

/** `R$ 1.234,56`, como o `currency: 'BRL'` do front em pt-BR, com espaços normalizados. */
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

interface FinancialAdjustment {
  id: string;
  eventId: string;
  installmentId: string | null;
  type: string;
  amount: number;
}

async function listAdjustments(api: APIRequestContext, eventId: string): Promise<FinancialAdjustment[]> {
  const res = await api.get(`/api/events/${eventId}/financial-adjustments`);
  await assertOk(res, 'GET /api/events/{id}/financial-adjustments');
  const data = await readJson<FinancialAdjustment[] | { items: FinancialAdjustment[] }>(res);
  return Array.isArray(data) ? data : data.items;
}

interface EventExpenses {
  totalExpenses: number;
  expenses: Array<{ id: string; eventId: string; amount: number; category: string; description: string | null }>;
}

async function getEventExpenses(api: APIRequestContext, eventId: string): Promise<EventExpenses> {
  const res = await api.get(`/api/events/${eventId}/expenses`);
  await assertOk(res, 'GET /api/events/{id}/expenses');
  return readJson<EventExpenses>(res);
}

/**
 * Festa aceita e QUITADA (plano de uma parcela, `Paid`) com uma locação do
 * mesmo cliente e data, de um tipo sem preparação; a volta marca cada unidade
 * com a condição dada, e a inspeção abre uma avaria por unidade. As avarias
 * voltam na ordem das condições.
 */
async function setupPaidEventWithDamagedRental(
  api: APIRequestContext,
  tenantId: string,
  opts: { damaged: DamageCondition[]; activityIds?: string[] },
) {
  enableFeatureFlagDirect(tenantId, 'feature_equipment_rental');
  const date = tenantDayPlus(20);
  const paid = await setupPaidEvent(api, {
    ...(opts.activityIds ? { activityIds: opts.activityIds } : {}),
    budget: { eventDate: date },
  });
  const type = await apiCreateEquipmentType(api, { name: `Pula-pula E2E ${uniqueSuffix()}`, steps: [], requirements: [] });
  const units: Array<{ id: string; assetCode: string }> = [];
  for (let i = 0; i < opts.damaged.length; i++) units.push(await apiCreateEquipmentUnit(api, type.id));
  const draft = await apiCreateRental(api, {
    clientId: paid.clienteId,
    eventId: paid.eventId,
    deliveryDate: date,
    unitIds: units.map((u) => u.id),
  });
  await apiTransitionRental(api, draft.id, 'Reserved');
  const rental = await apiGetRental(api, draft.id);
  const reports = await returnRentalWithDamages(
    api,
    rental.id,
    opts.damaged.map((condition, i) => ({
      rentalItemId: rental.items.find((it) => it.equipmentUnitId === units[i]!.id)!.id,
      condition,
      notes: `Avaria ${i + 1} na volta (E2E)`,
    })),
  );
  expect(reports, 'uma avaria por unidade avariada').toHaveLength(opts.damaged.length);
  return {
    eventId: paid.eventId,
    clientId: paid.clienteId,
    eventTotal: paid.total,
    installmentId: paid.installmentId,
    type,
    units,
    rental,
    reports: units.map((u) => reports.find((r) => r.equipmentUnitId === u.id)!) as DamageReport[],
  };
}

/** Clica no aviso pelo sino e espera o detalhe da avaria (refaz o caminho se a página fria não trocar a URL). */
async function openNoticeFromBell(page: Page, notificationId: string, damageReportId: string): Promise<void> {
  await expect(async () => {
    await page.goto('/app');
    await page.getByTestId('notification-bell').click({ timeout: 10_000 });
    const open = page.getByTestId(`notification-open-${notificationId}`);
    await expect(open).toBeVisible({ timeout: 15_000 });
    await open.click({ timeout: 5_000 });
    await expect(page).toHaveURL(new RegExp(`/app/rentals/damage-reports/${damageReportId}`), { timeout: 20_000 });
  }).toPass({ timeout: 90_000 });
}

test.describe('Fluxo completo 18 — Avaria: cobrar do cliente ou assumir o custo', () => {
  test('@flow E4: charging the damage creates a new installment and changes the financial status; absorbing books the event expense at the repair; the reusable chair lost at the review is charged to the client; the Manager cannot charge', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(420_000);
    await apiCompleteOnboarding(authApi);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_stock');
    const material = await setupReusableMaterialActivity(authApi, { unitCost: 25 });
    const s = await setupPaidEventWithDamagedRental(authApi, tenant.tenantId, {
      damaged: ['Damaged', 'Unusable'],
      activityIds: [material.activityId],
    });
    const [toCharge, toAbsorb] = s.reports as [DamageReport, DamageReport];
    for (const r of s.reports) {
      expect(r.resolution, 'avaria nasce sem decisão').toBe('Pending');
      expect(r.isOpen).toBe(true);
      expect(r.eventId).toBe(s.eventId);
    }

    const summaryBefore = await apiGetPaymentSummary(authApi, s.eventId);
    expect(summaryBefore.financialStatus, 'festa quitada antes da avaria').toBe('Paid');
    const planBefore = (await apiGetPaymentPlan(authApi, s.eventId))!;
    expect(planBefore.installments).toHaveLength(1);
    const expectedBefore = planBefore.installments.reduce((acc, i) => acc + i.expectedAmount, 0);

    // §8 item 4 / front 10 — "Cobrar do cliente" pela tela do detalhe.
    const due = tenantDayPlus(25);
    await authPage.goto(`/app/rentals/damage-reports/${toCharge.id}`);
    await expect(authPage.getByTestId('damage-report-resolve')).toBeVisible({ timeout: 20_000 });
    await authPage.getByTestId('damage-report-resolve').click();
    await expect(authPage.getByTestId('damage-resolution-title')).toBeVisible();
    await authPage.getByTestId('damage-resolution-charge').locator('label').click();
    await expect(
      authPage.getByTestId('damage-resolution-financial-warning'),
      'aviso de que a parcela nova muda o status financeiro',
    ).toBeVisible();
    await authPage.getByTestId('damage-resolution-amount').fill('180');
    await authPage.getByTestId('damage-resolution-due-on').fill(due);
    await authPage.getByTestId('damage-resolution-reason').fill('Lona rasgada por mau uso (E2E)');
    const resolved = authPage.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().includes(`/api/damage-reports/${toCharge.id}/resolve`),
    );
    await authPage.getByTestId('damage-resolution-submit').click();
    expect((await resolved).ok(), 'resolve ChargeClient').toBe(true);
    await expect(authPage.getByTestId('damage-resolution-title')).toHaveCount(0, { timeout: 20_000 });
    await expectMoney(authPage.getByTestId('damage-report-charge-amount'), 180, 'valor cobrado no detalhe');

    const charged = await apiGetDamageReport(authApi, toCharge.id);
    expect(charged.resolution).toBe('ChargedToClient');
    expect(charged.chargeMode, 'evento com plano: cobrança pelo plano').toBe('PaymentPlan');
    expect(charged.chargeAmount).toBe(180);
    expect(charged.financialAdjustmentId, 'ajuste de trilha').toBeTruthy();

    // A parcela nova no plano do evento, e o ajuste `Increase` só como trilha.
    const planAfterCharge = (await apiGetPaymentPlan(authApi, s.eventId))!;
    expect(planAfterCharge.installments).toHaveLength(2);
    const damageInstallment = planAfterCharge.installments.find((i) => i.id !== s.installmentId)!;
    expect(damageInstallment.label).toBe(`Cobrança de avaria — ${s.type.name} ${toCharge.assetCode}`);
    expect(damageInstallment.expectedAmount).toBe(180);
    expect(damageInstallment.dueDate.slice(0, 10)).toBe(due);
    expect(
      planAfterCharge.installments.reduce((acc, i) => acc + i.expectedAmount, 0),
      'o valor entra uma vez só no esperado',
    ).toBeCloseTo(expectedBefore + 180, 2);
    const adjustments = await listAdjustments(authApi, s.eventId);
    const trail = adjustments.find((a) => a.id === charged.financialAdjustmentId);
    expect(trail, 'o ajuste da cobrança no evento').toBeTruthy();
    expect(trail!.type).toBe('Increase');
    expect(trail!.installmentId, 'o ajuste aponta a parcela nova').toBe(damageInstallment.id);
    expect(trail!.amount).toBe(180);

    // Decisão 9 do plano: o devido inclui a receita extra cobrada (`Increase`).
    const summaryAfterCharge = await apiGetPaymentSummary(authApi, s.eventId);
    expect(summaryAfterCharge.financialStatus, 'a parcela nova muda o status financeiro').toBe('PartiallyPaid');
    expect(summaryAfterCharge.balance, 'saldo a receber = a cobrança').toBeCloseTo(180, 2);

    // §8 item 4 — a parcela cobrada se recebe: o pagamento regular dela, numa
    // festa já quitada, entra (a guarda de excedente mede o mesmo devido) e
    // devolve o status a "Quitado".
    const damagePayment = await apiRegisterPayment(authApi, s.eventId, {
      amount: 180,
      method: 'Pix',
      note: 'Pagamento da avaria (E2E)',
      installmentId: damageInstallment.id,
    });
    expect(damagePayment.regularAmount, 'a parcela da avaria abate a dívida').toBeCloseTo(180, 2);
    expect(damagePayment.extraAmount).toBe(0);
    const summaryAfterDamagePaid = await apiGetPaymentSummary(authApi, s.eventId);
    expect(summaryAfterDamagePaid.financialStatus, 'avaria paga').toBe('Paid');
    expect(summaryAfterDamagePaid.balance).toBeCloseTo(0, 2);

    const sessions: RoleSession[] = [];
    try {
      // §8 item 4 — o Manager não cobra (só Owner/Admin têm FinancialAdjustments.Manage).
      const manager = await loginAsRole(tenant.tenantId, 'Manager');
      sessions.push(manager);
      const managerCharge = await resolveDamageReport(manager.api, toAbsorb.id, {
        resolution: 'ChargeClient',
        amount: 300,
        reason: 'Gerente tentando cobrar (E2E)',
      });
      expect(managerCharge.status(), 'Manager cobrando a avaria').toBe(403);
      expect(await apiErrorCodes(managerCharge)).toContain('DamageReport.ChargeForbidden');
      expect((await apiGetDamageReport(authApi, toAbsorb.id)).resolution).toBe('Pending');
      expect((await apiGetPaymentPlan(authApi, s.eventId))!.installments, 'nenhuma parcela nova').toHaveLength(2);

      // §8 item 4 (decisão 10) — "assumir" sem custo ainda: a despesa nasce no conserto.
      await assertOk(
        await resolveDamageReport(authApi, toAbsorb.id, { resolution: 'Absorb', reason: 'Desgaste natural (E2E)' }),
        'resolve Absorb',
      );
      const absorbed = await apiGetDamageReport(authApi, toAbsorb.id);
      expect(absorbed.resolution).toBe('AbsorbedByCompany');
      expect(absorbed.expenseId, 'sem custo conhecido, ainda sem despesa').toBeNull();
      expect(
        (await getEventExpenses(authApi, s.eventId)).expenses.filter((e) => e.category === MAINTENANCE_CATEGORY),
      ).toHaveLength(0);

      // §8 item 3 — o conserto: corretiva aberta (unidade em manutenção) e concluída com o custo real.
      await assertOk(await startDamageRepair(authApi, toAbsorb.id), 'start-repair');
      expect((await apiGetDamageReport(authApi, toAbsorb.id)).status).toBe('UnderRepair');
      expect((await apiGetEquipmentUnit(authApi, toAbsorb.equipmentUnitId)).status).toBe('InMaintenance');
      await assertOk(await markDamageRepaired(authApi, toAbsorb.id, 120), 'repaired');
      const repaired = await apiGetDamageReport(authApi, toAbsorb.id);
      expect(repaired.status).toBe('Repaired');
      expect(repaired.isOpen).toBe(false);
      expect(repaired.actualRepairCost).toBe(120);
      expect(repaired.expenseId, 'o conserto lança a despesa do "assumir"').toBeTruthy();
      const expenses = await getEventExpenses(authApi, s.eventId);
      const expense = expenses.expenses.find((e) => e.id === repaired.expenseId);
      expect(expense, 'a despesa é do evento').toBeTruthy();
      expect(expense!.eventId).toBe(s.eventId);
      expect(expense!.amount, 'pelo custo real do conserto').toBe(120);
      expect(expense!.category).toBe(MAINTENANCE_CATEGORY);
      expect((await apiGetEquipmentUnit(authApi, toAbsorb.equipmentUnitId)).hasOpenDamage, 'o selo some').toBe(false);

      // §8 item 7 — a cadeirinha perdida na festa, cobrada na conferência.
      const { recordId } = await completeEventWithMaterialLoss(authApi, tenant.tenantId, s.eventId, {
        productId: material.productId,
        extra: 1,
      });
      const pending = (await apiGetConsumptionReview(authApi, s.eventId)).find((r) => r.id === recordId)!;
      expect(pending.status).toBe('PendingConfirmation');
      expect(pending.variance, 'uma cadeirinha a mais que o previsto').toBe(1);
      expect(pending.suggestedLossChargeAmount, 'sugestão: sobra × custo efetivo').toBeCloseTo(25, 2);

      // O Manager confirma a conferência, mas não cobra por ela (403, nada gravado).
      const managerConfirm = await confirmConsumptionReview(manager.api, s.eventId, [
        { recordId, lossResolution: 'ChargedToClient' },
      ]);
      expect(managerConfirm.status(), 'Manager cobrando a perda pela conferência').toBe(403);
      expect(await apiErrorCodes(managerConfirm)).toContain('Stock.LossChargeForbidden');
      const stillPending = (await apiGetConsumptionReview(authApi, s.eventId)).find((r) => r.id === recordId)!;
      expect(stillPending.status).toBe('PendingConfirmation');
      expect(stillPending.lossResolution).toBeNull();
      expect((await apiGetPaymentPlan(authApi, s.eventId))!.installments).toHaveLength(2);

      await assertOk(
        await confirmConsumptionReview(authApi, s.eventId, [{ recordId, lossResolution: 'ChargedToClient' }]),
        'confirm com a perda cobrada',
      );
      const lossRecord = (await apiGetConsumptionReview(authApi, s.eventId)).find((r) => r.id === recordId)!;
      expect(lossRecord.status).toBe('Confirmed');
      expect(lossRecord.lossResolution).toBe('ChargedToClient');
      expect(lossRecord.lossChargeAmount, 'sem valor no pedido, vale o sugerido').toBeCloseTo(25, 2);
      expect(lossRecord.lossFinancialAdjustmentId).toBeTruthy();

      const planAfterLoss = (await apiGetPaymentPlan(authApi, s.eventId))!;
      expect(planAfterLoss.installments).toHaveLength(3);
      const lossInstallment = planAfterLoss.installments.find(
        (i) => i.id !== s.installmentId && i.id !== damageInstallment.id,
      )!;
      expect(lossInstallment.label).toMatch(
        new RegExp(`^Reposição de material — ${material.productName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} × 1([.,]0+)?$`),
      );
      expect(lossInstallment.expectedAmount).toBeCloseTo(25, 2);
      const lossTrail = (await listAdjustments(authApi, s.eventId)).find(
        (a) => a.id === lossRecord.lossFinancialAdjustmentId,
      );
      expect(lossTrail?.type).toBe('Increase');
      expect(lossTrail?.installmentId).toBe(lossInstallment.id);
      const summaryAfterLoss = await apiGetPaymentSummary(authApi, s.eventId);
      expect(summaryAfterLoss.financialStatus).toBe('PartiallyPaid');
      // A avaria (180) já foi paga acima: sobra a perda, contada uma vez só.
      expect(summaryAfterLoss.balance, 'só a perda em aberto, uma vez').toBeCloseTo(25, 2);
    } finally {
      for (const session of sessions) await session.api.dispose();
    }
  });

  test('@flow E23: the 38 notice reaches the managers and opens the damage; Financial reads list and detail and gets 403 repairing, charging and absorbing; another tenant gets 404; the Manager gets 403 charging and absorbs; the charge lands in the event tenant', async ({
    authApi,
    authPage,
    browser,
    tenant,
  }) => {
    test.setTimeout(360_000);
    await apiCompleteOnboarding(authApi);
    const sessions: RoleSession[] = [];
    try {
      // Os usuários de verdade existem ANTES da avaria: o aviso 38 sai na criação.
      const manager = await loginAsRole(tenant.tenantId, 'Manager');
      sessions.push(manager);
      const financial = await loginAsRole(tenant.tenantId, 'Financial');
      sessions.push(financial);

      const s = await setupPaidEventWithDamagedRental(authApi, tenant.tenantId, { damaged: ['Damaged', 'Damaged'] });
      const [damage, chargedByOwner] = s.reports as [DamageReport, DamageReport];

      // §8 item 5 — o aviso 38 aos gestores, com o contexto da avaria.
      for (const [who, api] of [
        ['Dono', authApi],
        ['Manager', manager.api],
      ] as const) {
        const notice = (await apiListNotifications(api)).find(
          (n) => n.type === DAMAGE_NOTICE && n.contextEntityId === damage.id,
        );
        expect(notice, `aviso 38 para o ${who}`).toBeTruthy();
        expect(notice!.contextEntityType).toBe('DamageReport');
      }
      const ownerNotice = (await apiListNotifications(authApi)).find(
        (n) => n.type === DAMAGE_NOTICE && n.contextEntityId === damage.id,
      )!;
      await openNoticeFromBell(authPage, ownerNotice.id, damage.id);
      await expect(authPage.getByTestId('damage-report-description')).toContainText('Avaria 1 na volta (E2E)', {
        timeout: 20_000,
      });

      // §8 item 1 — o Financeiro lê a lista e o detalhe…
      const financialList = await apiListDamageReports(financial.api, { eventId: s.eventId });
      expect(financialList.items.map((r) => r.id).sort()).toEqual([damage.id, chargedByOwner.id].sort());
      expect((await financial.api.get(`/api/damage-reports/${damage.id}`)).status()).toBe(200);

      // …e leva 403 ao consertar, cobrar e assumir; nada muda.
      const financialAttempts: Array<[string, () => Promise<APIResponse>]> = [
        ['start-repair', () => startDamageRepair(financial.api, damage.id)],
        ['repaired', () => markDamageRepaired(financial.api, damage.id, 50)],
        ['write-off', () => writeOffDamageReport(financial.api, damage.id, { replacementCost: 900, retireUnit: true })],
        [
          'resolve ChargeClient',
          () => resolveDamageReport(financial.api, damage.id, { resolution: 'ChargeClient', amount: 100, reason: 'E2E' }),
        ],
        ['resolve Absorb', () => resolveDamageReport(financial.api, damage.id, { resolution: 'Absorb', reason: 'E2E' })],
      ];
      for (const [what, attempt] of financialAttempts) {
        expect((await attempt()).status(), `Financeiro: ${what}`).toBe(403);
      }
      const untouched = await apiGetDamageReport(authApi, damage.id);
      expect(untouched.status).toBe('Reported');
      expect(untouched.resolution).toBe('Pending');

      // A tela do Financeiro: lista e detalhe, sem conserto nem decisão.
      const financialView = await openSessionPage(browser, financial.tokens);
      try {
        await financialView.page.goto('/app/rentals/damage-reports');
        await expect(financialView.page.getByTestId(`damage-report-open-${damage.id}`)).toBeVisible({ timeout: 20_000 });
        await financialView.page.getByTestId(`damage-report-open-${damage.id}`).click();
        await expect(financialView.page).toHaveURL(new RegExp(`/app/rentals/damage-reports/${damage.id}`));
        await expect(financialView.page.getByTestId('damage-report-description')).toBeVisible({ timeout: 20_000 });
        await expect(financialView.page.getByTestId('damage-report-decision')).toBeVisible();
        await expect(financialView.page.getByTestId('damage-report-resolve')).toHaveCount(0);
        await expect(financialView.page.getByTestId('damage-report-start-repair')).toHaveCount(0);
        await expect(financialView.page.getByTestId('damage-report-edit')).toHaveCount(0);
      } finally {
        await financialView.context.close();
      }

      // Isolamento: a avaria de outro tenant dá 404, e nada muda.
      const other = await signupNewTenant();
      enableFeatureFlagDirect(other.tenantId, 'feature_equipment_rental');
      const otherAdmin = await createBearerApiContext(other.accessToken);
      try {
        expect((await otherAdmin.get(`/api/damage-reports/${damage.id}`)).status(), 'GET de outro tenant').toBe(404);
        const crossResolve = await resolveDamageReport(otherAdmin, damage.id, { resolution: 'Absorb', reason: 'E2E' });
        expect(crossResolve.status(), 'resolve de outro tenant').toBe(404);
        expect((await startDamageRepair(otherAdmin, damage.id)).status(), 'start-repair de outro tenant').toBe(404);
        expect((await apiListDamageReports(otherAdmin, { eventId: s.eventId })).items).toHaveLength(0);
        expect((await apiGetDamageReport(authApi, damage.id)).resolution).toBe('Pending');

        // A cobrança grava a parcela e o ajuste no tenant do evento: o dono vê, o outro não.
        await assertOk(
          await resolveDamageReport(authApi, chargedByOwner.id, {
            resolution: 'ChargeClient',
            amount: 90,
            reason: 'Haste entortada (E2E)',
          }),
          'resolve ChargeClient (dono)',
        );
        const charged = await apiGetDamageReport(authApi, chargedByOwner.id);
        const plan = (await apiGetPaymentPlan(authApi, s.eventId))!;
        const newInstallment = plan.installments.find((i) => i.id !== s.installmentId);
        expect(newInstallment?.expectedAmount, 'a parcela no plano do evento').toBe(90);
        const trail = (await listAdjustments(authApi, s.eventId)).find((a) => a.id === charged.financialAdjustmentId);
        expect(trail?.eventId, 'o ajuste no evento do tenant').toBe(s.eventId);
        expect(trail?.installmentId).toBe(newInstallment?.id);
        expect((await otherAdmin.get(`/api/events/${s.eventId}/payment-plan`)).status(), 'plano visto de fora').toBe(404);
        expect(
          [403, 404],
          'ajustes vistos de fora',
        ).toContain((await otherAdmin.get(`/api/events/${s.eventId}/financial-adjustments`)).status());
      } finally {
        await otherAdmin.dispose();
      }

      // §8 item 4 — o Manager leva 403 ao cobrar e assume (a parte decisiva, pela API).
      const managerCharge = await resolveDamageReport(manager.api, damage.id, {
        resolution: 'ChargeClient',
        amount: 100,
        reason: 'Gerente tentando cobrar (E2E)',
      });
      expect(managerCharge.status(), 'Manager cobrando').toBe(403);
      expect(await apiErrorCodes(managerCharge)).toContain('DamageReport.ChargeForbidden');
      expect((await apiGetPaymentPlan(authApi, s.eventId))!.installments, 'nenhuma parcela a mais').toHaveLength(2);
      const managerAbsorb = await resolveDamageReport(manager.api, damage.id, {
        resolution: 'Absorb',
        reason: 'Desgaste natural (E2E)',
      });
      expect(managerAbsorb.status(), 'Manager assumindo').toBe(200);
      const absorbed = await apiGetDamageReport(authApi, damage.id);
      expect(absorbed.resolution).toBe('AbsorbedByCompany');
      expect(absorbed.resolvedByUserId, 'quem decidiu fica gravado').toBeTruthy();
    } finally {
      for (const session of sessions) await session.api.dispose();
    }
  });

  test('@flow E23: the Manager screen offers "Assumir o custo" and keeps "Cobrar do cliente" disabled with the reason', async ({
    authApi,
    browser,
    tenant,
  }) => {
    test.setTimeout(240_000);
    await apiCompleteOnboarding(authApi);
    const s = await setupPaidEventWithDamagedRental(authApi, tenant.tenantId, { damaged: ['Damaged'] });
    const [damage] = s.reports as [DamageReport];
    const manager = await loginAsRole(tenant.tenantId, 'Manager');
    try {
      const view = await openSessionPage(browser, manager.tokens);
      try {
        // [ALERTA] Lote B: as telas de locação ficam bloqueadas para o Manager
        // quando o `entitlements-boot` depende de `GET /api/billing/entitlements`
        // (exige `billing.read`). A parte decisiva (403 ao cobrar, 200 ao
        // assumir) está no teste anterior, pela API.
        await view.page.goto(`/app/rentals/damage-reports/${damage.id}`);
        await expect(view.page.getByTestId('damage-report-resolve')).toBeVisible({ timeout: 20_000 });
        await view.page.getByTestId('damage-report-resolve').click();
        await expect(view.page.getByTestId('damage-resolution-title')).toBeVisible();
        await expect(view.page.getByTestId('damage-resolution-charge').getByRole('radio')).toBeDisabled();
        await expect(view.page.getByTestId('damage-resolution-charge-blocked')).toBeVisible();
        await expect(view.page.getByTestId('damage-resolution-absorb').getByRole('radio')).toBeEnabled();
      } finally {
        await view.context.close();
      }
    } finally {
      await manager.api.dispose();
    }
  });

  test('@flow E23: a tenant without the rental add-on sees "Avarias" in the menu but the route blocks, and the event tab has no damages part', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(180_000);
    await apiCompleteOnboarding(authApi);
    // Só o estoque: a aba "Avarias e perdas" existe pela parte das perdas.
    enableFeatureFlagDirect(tenant.tenantId, 'feature_stock');
    const { eventId } = await setupAcceptedEvent(authApi, { budget: { eventDate: tenantDayPlus(20) } });

    await authPage.goto(`/app/events/${eventId}`);
    await authPage.getByRole('tab', { name: 'Avarias e perdas', exact: true }).click({ timeout: 20_000 });
    await expect(authPage.getByTestId('damages-losses-losses')).toBeVisible({ timeout: 20_000 });
    await expect(authPage.getByTestId('damages-losses-damages'), 'sem a parte de avarias').toHaveCount(0);

    // §8 front 10 — o plano pedia esconder "Avarias" sem o add-on; vale a
    // convenção do front (`src/app/core/CLAUDE.md`): o item aparece no menu e
    // quem barra é a rota, pelo add-on (decidido na correção do e2e do plano).
    await expect(authPage.getByTestId('tenant-name')).toBeVisible();
    await expect(
      authPage.getByTestId('nav-sub-/app/rentals/damage-reports'),
      'item "Avarias" no menu (a rota é que barra)',
    ).toHaveCount(1);

    // A rota barra pelo add-on.
    await authPage.goto('/app/rentals/damage-reports');
    await expect(authPage).toHaveURL(/\/app\/billing\/blocked/, { timeout: 20_000 });
    await expect(authPage.getByTestId('damage-reports-totals')).toHaveCount(0);
  });
});
