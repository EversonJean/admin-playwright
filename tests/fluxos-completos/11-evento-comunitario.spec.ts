import { APIRequestContext, Page } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { twoTenantsTest } from '../../fixtures/two-tenants.fixture';
import {
  apiCompleteOnboarding,
  apiCreateActivity,
  apiCreateCollaborator,
  apiCreateCollaboratorLevel,
  apiCreateCommission,
  apiCreateEventCategory,
  apiCreateEventExpense,
  apiCreateProduct,
  apiTryCreateCommission,
} from '../../helpers/api-entities';
import {
  apiAssignCollaborator,
  apiCompleteEvent,
  apiConfirmCollaborator,
  apiGetPaymentPlan,
  apiGetPaymentSummary,
  apiListPendingPayments,
  apiPatchEvent,
  apiStartEvent,
  registerPaymentBody,
} from '../../helpers/api-event-flow';
import { parseCsv, readXlsxRows } from '../../helpers/binary-files';
import {
  LIVE_EVENT_STATUSES,
  apiCreateSchoolClient,
  apiEventReport,
  apiExportEventReport,
  apiFinancialDashboard,
  apiGetBudgetView,
  apiGetEventView,
  apiGetProfitability,
  brl,
  monthRange,
  setupCommunityEvent,
  tenantToday,
} from '../../helpers/community-event';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';
import { fakeEmail } from '../../helpers/fake-providers';
import { apiGetReadiness, tenantDayPlus } from '../../helpers/rain-plan';
import { apiErrorCodes, assertOk } from '../../helpers/response';
import { loginPortalCollaborator, openSessionPage, setupAcceptedEvent, setupPaidEvent } from '../../helpers/setup-flows';
import { stripUiPermissions } from '../../helpers/ui';

/**
 * Fluxo completo 11 — Evento comunitário: a ação sem cobrança, com o custo apurado
 * Plano: docs/implementados/PLANO-EVENTO-COMUNITARIO.md §3 (EC-A, Etapa 247),
 * §4 (EC-B, Etapa 248) e §5 (EC-C, Etapa 249). Registro e2e: E1, E5, E6, E12,
 * E13, E16, E17 e E18.
 *
 *   E1.  Orçamento para uma escola pela tela: a categoria do grupo "Comunitário"
 *        liga o modo; "Confirmar ação" sem envio; o evento nasce "Comunitário",
 *        sem parcelas e sem cobrança.
 *   E5.  "Sem cobrança"; pagamento e plano recusados; cachê de valor fixo aceito
 *        e no Portal do recreador.
 *   E12. Financeiro só com o valor de referência; ajustes e excedente recusados;
 *        "Cachê da equipe" sem percentual; prontidão sem "Sinal pago"; sem
 *        `eventpayments.read` o valor de referência continua.
 *   E13. Dinheiro de ponta a ponta: total zero por construção (§4 back 6).
 *   E6.  Custo da ação (equipe paga, despesa, material baixado) e o relatório do mês.
 *   E16. Sem `pricing.viewmargin`: sem "Custo da ação" e sem o card do painel;
 *        o KPI do relatório continua.
 *   E17. O card do painel e o relatório filtrado dão o mesmo número.
 *   E18. Relatório e export com pago e comunitário; isolamento entre tenants.
 *
 * Papel customizado (E12 sem `eventpayments.read`, E16 sem `pricing.viewmargin`):
 * os perfis são fixos e o mapa papel -> permissions é global no back; nenhum
 * perfil padrão lê eventos sem essas duas. A tela é vista com a permission
 * retirada da lista que o front recebe (`stripUiPermissions`, molde do 17.6).
 * A parte de API do E16 (403 no `profitability`, bloco `null` no painel) não tem
 * usuário real possível no e2e: fica no teste de Api do back.
 *
 * Sem diagrama `.mmd`: verificação de plano.
 */

const FIN_STATUS_NOT_CHARGED = 'NotCharged';

/** A ação comunitária de hoje (o painel e o relatório contam o mês corrente). */
function communityToday(api: APIRequestContext, opts: Parameters<typeof setupCommunityEvent>[1] = {}) {
  return setupCommunityEvent(api, { ...opts, eventDate: tenantToday() });
}

function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

/** Decimal como o export CSV o escreve (`F2` pt-BR: vírgula, sem milhar). */
function csvDecimal(value: number): string {
  return value.toFixed(2).replace('.', ',');
}

async function openEvent(page: Page, eventId: string): Promise<void> {
  await page.goto(`/app/events/${eventId}`);
  await expect(page.getByTestId('event-detail-title')).toBeVisible({ timeout: 20_000 });
}

/** Inicia e conclui a ação (a conclusão baixa o material); exige o líder confirmado. */
async function runAction(api: APIRequestContext, eventId: string): Promise<void> {
  await apiStartEvent(api, eventId);
  await apiCompleteEvent(api, eventId);
}

/** Recreador escalado como líder e confirmado. */
async function assignLeader(api: APIRequestContext, eventId: string): Promise<string> {
  const collaborator = await apiCreateCollaborator(api);
  await apiAssignCollaborator(api, eventId, collaborator.id, { isLeader: true });
  await apiConfirmCollaborator(api, eventId, collaborator.id);
  return collaborator.id;
}

test.describe('Fluxo 11 — community event', () => {
  // ───────────────────────────── EC-A (Etapa 247) ─────────────────────────────

  // E1 — §3 front 1, 2 e 3; back 5.
  test('E1 @crud the manager builds a community budget for a school (the Comunitário category turns the mode on) and confirms the action without sending; the event is born "Comunitário", without installments and without charge', async ({
    authApi,
    authPage,
  }) => {
    test.setTimeout(180_000);
    await apiCompleteOnboarding(authApi);
    const school = await apiCreateSchoolClient(authApi);
    const activity = await apiCreateActivity(authApi, { status: 'Active' });
    const category = await apiCreateEventCategory(authApi, 'Comunitario');

    await authPage.goto('/app/budgets/quick');
    await expect(authPage.getByTestId('budget-form-clientId')).toBeVisible({ timeout: 20_000 });
    await authPage.getByTestId('budget-form-clientId').click();
    await authPage.getByRole('option', { name: school.name }).click();
    await authPage.getByTestId('budget-form-eventDate').fill(tenantDayPlus(30));
    await authPage.getByTestId('budget-form-eventStartTime').fill('09:00');
    await authPage.getByTestId('budget-form-eventEndTime').fill('12:00');
    await authPage.getByTestId('budget-form-childrenCount').fill('25');
    await authPage.getByTestId('budget-form-eventLocation').fill(`Pátio da ${school.name}`);
    await authPage.getByTestId('budget-form-add-item').click();
    await authPage.getByTestId('budget-form-item-activity-0').click();
    await authPage.getByRole('option', { name: activity.name }).click();

    // A categoria do grupo "Comunitário" liga o modo, uma vez, com o aviso.
    await authPage.getByTestId('budget-form-eventCategoryId').click();
    await authPage.getByTestId(`budget-form-category-option-${category.id}`).click();
    await expect(authPage.getByTestId('budget-form-isCommunity').getByRole('switch')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await expect(authPage.getByTestId('budget-form-community-suggested')).toContainText('Sugerido pela categoria');
    // Ligado: sem desconto nem forma de pagamento; o resumo é "valor de referência · cobrado R$ 0,00".
    await expect(authPage.getByTestId('budget-form-discountKind')).toHaveCount(0);
    await expect(authPage.getByTestId('budget-form-payment-terms')).toHaveCount(0);
    await expect(authPage.getByTestId('budget-summary-reference-value')).toBeVisible();
    await expect(authPage.getByTestId('budget-summary-total')).toContainText(brl(0), { timeout: 15_000 });

    const created = authPage.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/api\/budgets$/.test(new URL(r.url()).pathname),
    );
    await authPage.getByTestId('budget-form-save').click();
    const createdRes = await created;
    expect(createdRes.ok(), 'o rascunho foi gravado').toBe(true);
    const budgetId = ((await createdRes.json()) as { data: { id: string } }).data.id;

    const budget = await apiGetBudgetView(authApi, budgetId);
    expect(budget.chargeMode).toBe('Community');
    expect(budget.status).toBe('Draft');
    expect(budget.subtotal, 'valor de referência').toBeGreaterThan(0);
    expect(budget.discountApplied).toBeCloseTo(budget.subtotal, 2);
    expect(budget.total).toBe(0);

    // Detalhe do orçamento comunitário: "Confirmar ação", e não "Fechar orçamento".
    await authPage.goto(`/app/budgets/${budgetId}`);
    await expect(authPage.getByTestId('budget-form-confirm-community')).toBeVisible({ timeout: 20_000 });
    await expect(authPage.getByTestId('budget-form-accept')).toHaveCount(0);
    await expect(authPage.getByTestId('budget-summary-reference-value')).toContainText(brl(budget.subtotal));
    await authPage.getByTestId('budget-form-confirm-community').click();
    await authPage.getByTestId('confirm-ok').click();
    await authPage.waitForURL(/\/app\/events\/[0-9a-f-]+(\?|$)/i, { timeout: 20_000 });
    const eventId = /\/app\/events\/([0-9a-f-]+)/i.exec(authPage.url())![1]!;

    await expect(authPage.getByTestId('event-detail-community')).toContainText('Comunitário', { timeout: 20_000 });

    const ev = await apiGetEventView(authApi, eventId);
    expect(ev.chargeMode).toBe('Community');
    expect(ev.total).toBe(0);
    expect(ev.subtotal, 'o evento guarda o valor de referência').toBeCloseTo(budget.subtotal, 2);
    expect((await apiGetBudgetView(authApi, budgetId)).status).toBe('Accepted');

    // Sem parcelas e sem cobrança agendada.
    expect(await apiGetPaymentPlan(authApi, eventId), 'sem plano de parcelas').toBeNull();
    const pending = await apiListPendingPayments(authApi, { clientId: school.id });
    expect(pending.items.map((p) => p.eventId)).not.toContain(eventId);

    // Confirmada sem envio: nada chegou à escola.
    expect(await fakeEmail.emails({ to: school.email }), 'nenhum e-mail ao cliente').toHaveLength(0);
  });

  // ───────────────────────────── EC-B (Etapa 248) ─────────────────────────────

  // E5 — §4 back 1, 3 e 4; front 2.
  test('E5 @flow a community event shows "Sem cobrança"; payment and payment plan are refused; a fixed fee for the recreator is accepted and shows in his Portal', async ({
    authApi,
    authPage,
    browser,
    tenant,
  }) => {
    test.setTimeout(180_000);
    const action = await setupCommunityEvent(authApi);

    await apiCompleteOnboarding(authApi);
    await openEvent(authPage, action.eventId);
    await expect(authPage.getByTestId('event-detail-financial-not-charged')).toHaveText(/Sem cobrança/);
    await expect(authPage.getByTestId('event-detail-payment-plan-status')).toHaveCount(0);
    expect((await apiGetPaymentSummary(authApi, action.eventId)).financialStatus).toBe(FIN_STATUS_NOT_CHARGED);

    const payment = await authApi.post(`/api/events/${action.eventId}/payments`, {
      data: registerPaymentBody({ amount: 100, method: 'Pix' }),
    });
    expect(payment.status(), 'registrar pagamento').toBe(409);
    expect(await apiErrorCodes(payment)).toContain('Event.NotChargeable');

    const plan = await authApi.post(`/api/events/${action.eventId}/payment-plan`, {
      data: {
        templateId: null,
        installments: [{ order: 1, label: 'Parcela única', expectedAmount: 100, dueDate: tenantDayPlus(5) }],
      },
    });
    expect(plan.status(), 'criar plano').toBe(409);
    expect(await apiErrorCodes(plan)).toContain('Event.NotChargeable');

    expect(await apiGetPaymentPlan(authApi, action.eventId)).toBeNull();
    expect((await apiGetPaymentSummary(authApi, action.eventId)).entries).toHaveLength(0);

    // O cachê do recreador: valor fixo, como em qualquer festa.
    const recreatorId = await assignLeader(authApi, action.eventId);
    const fee = await apiCreateCommission(authApi, action.eventId, {
      collaboratorId: recreatorId,
      kind: 'FixedAmount',
      value: 180,
      notes: 'Cachê da ação na escola',
    });

    const portal = await loginPortalCollaborator(tenant.tenantId, recreatorId);
    try {
      const res = await portal.api.get('/api/portal/my-commissions');
      await assertOk(res, 'GET /api/portal/my-commissions');
      const mine = ((await res.json()) as { data: { commissions: Array<{ id: string; eventId: string; amount: number }> } })
        .data.commissions;
      const line = mine.find((c) => c.id === fee.id);
      expect(line, 'o cachê aparece no Portal do recreador').toBeTruthy();
      expect(line!.eventId).toBe(action.eventId);
      expect(line!.amount).toBe(180);

      const view = await openSessionPage(browser, portal.tokens);
      try {
        await view.page.goto('/portal/my-commissions');
        // A tela abre no mês corrente e a ação nasce daqui a 10 dias
        // (`setupCommunityEvent`): nos últimos dias do mês ela cai no seguinte.
        // O período cobre os dois meses.
        await view.page.getByTestId('my-commissions-filter-from').fill(monthRange(tenantToday()).from);
        await view.page.getByTestId('my-commissions-filter-to').fill(monthRange(tenantDayPlus(10)).to);
        await view.page.getByTestId('my-commissions-filter-btn').click();
        const item = view.page.getByTestId(`my-commissions-item-${fee.id}`);
        await expect(item).toBeVisible({ timeout: 20_000 });
        await expect(item).toContainText(brl(180));
      } finally {
        await view.context.close();
      }
    } finally {
      await portal.api.dispose();
    }
  });

  // E12 — §4 back 1, 4 e 5; front 1, 3 e 4.
  test('E12 @flow the Financeiro tab shows only the reference value; every financial adjustment and the excess charge are refused; the "Cachê da equipe" tab offers no percentage and the API refuses it; readiness has no "Sinal pago"', async ({
    authApi,
    authPage,
  }) => {
    test.setTimeout(180_000);
    const action = await setupCommunityEvent(authApi);
    const recreatorId = await assignLeader(authApi, action.eventId);

    await apiCompleteOnboarding(authApi);
    await openEvent(authPage, action.eventId);
    await authPage.getByRole('tab', { name: 'Financeiro', exact: true }).click();
    await expect(authPage.getByTestId('event-detail-community-finance')).toContainText(
      'Evento comunitário: sem cobrança.',
    );
    await expect(authPage.getByTestId('event-detail-community-reference')).toContainText(brl(action.referenceValue));
    for (const absent of [
      'event-detail-payment-plan',
      'event-detail-no-payment-plan',
      'event-detail-payments',
      'event-detail-payments-register',
      'event-detail-adjustments',
    ]) {
      await expect(authPage.getByTestId(absent), `${absent} some no comunitário`).toHaveCount(0);
    }

    // As portas de cobrança, chamadas direto: todas "sem cobrança".
    const anyId = '00000000-0000-0000-0000-000000000001';
    const adjustments: Array<[string, Record<string, unknown>]> = [
      ['reversal', { paymentEntryId: anyId, reason: 'Estorno E2E', notes: null }],
      ['refund', { installmentId: anyId, amount: 10, reason: 'Reembolso E2E', notes: null }],
      ['discount', { installmentId: anyId, amount: 10, reason: 'Desconto E2E', notes: null }],
      ['writeoff', { installmentId: anyId, reason: 'Baixa E2E', notes: null }],
      ['credit', { installmentId: anyId, amount: 10, reason: 'Crédito E2E', notes: null, expiresAt: null }],
      ['increase', { installmentId: anyId, amount: 10, reason: 'Acréscimo E2E', notes: null }],
      [
        'renegotiation',
        {
          installmentId: anyId,
          reason: 'Renegociação E2E',
          notes: null,
          newInstallments: [{ order: 1, label: 'Nova', expectedAmount: 10, dueDate: tenantDayPlus(5) }],
        },
      ],
    ];
    for (const [kind, body] of adjustments) {
      const res = await authApi.post(`/api/events/${action.eventId}/financial-adjustments/${kind}`, { data: body });
      expect(res.status(), `ajuste ${kind}`).toBe(409);
      expect(await apiErrorCodes(res), `ajuste ${kind}`).toContain('Event.NotChargeable');
    }
    const excess = await authApi.post(`/api/events/${action.eventId}/excess-charge`, {
      data: { confirmed: true, notes: null },
    });
    expect(excess.status(), 'cobrança de excedente').toBe(409);
    expect(await apiErrorCodes(excess)).toContain('Event.NotChargeable');

    // "Cachê da equipe": percentual desabilitado na tela e recusado na API.
    await expect(authPage.getByRole('tab', { name: 'Comissões', exact: true })).toHaveCount(0);
    await authPage.getByRole('tab', { name: 'Cachê da equipe', exact: true }).click();
    await authPage.getByTestId('commission-tab-btn-new').click();
    await expect(authPage.getByTestId('commission-tab-form-kind-community-hint')).toContainText(
      'Sem receita: use valor fixo',
    );
    await authPage.getByTestId('commission-tab-form-kind').click();
    await expect(authPage.getByTestId('commission-tab-form-kind-percentage')).toHaveAttribute('aria-disabled', 'true');
    await authPage.keyboard.press('Escape');

    const percentage = await apiTryCreateCommission(authApi, action.eventId, {
      collaboratorId: recreatorId,
      kind: 'Percentage',
      value: 10,
    });
    expect(percentage.status(), 'comissão percentual ao criar').toBeGreaterThanOrEqual(400);
    expect(percentage.status()).toBeLessThan(500);
    expect(await apiErrorCodes(percentage)).toContain('Commission.PercentageOnCommunityEvent');

    const fixed = await apiCreateCommission(authApi, action.eventId, {
      collaboratorId: recreatorId,
      kind: 'FixedAmount',
      value: 150,
    });
    const toPercentage = await authApi.put(`/api/events/${action.eventId}/commissions/${fixed.id}`, {
      data: { kind: 'Percentage', value: 10, notes: null },
    });
    expect(toPercentage.status(), 'editar para percentual').toBeGreaterThanOrEqual(400);
    expect(toPercentage.status()).toBeLessThan(500);
    expect(await apiErrorCodes(toPercentage)).toContain('Commission.PercentageOnCommunityEvent');

    // Prontidão sem "Sinal pago"; o pago continua com ele (controle).
    const readiness = await apiGetReadiness(authApi, action.eventId);
    expect(readiness.map((r) => r.key)).not.toContain('deposit_paid');
    expect(readiness.map((r) => r.key), 'o contrato continua valendo').toContain('contract_formalized');
    const paid = await setupAcceptedEvent(authApi);
    expect((await apiGetReadiness(authApi, paid.eventId)).map((r) => r.key)).toContain('deposit_paid');
  });

  // E12 — §4 front 1 (o card não depende de `eventpayments.read`).
  test('E12 @flow without eventpayments.read the Financeiro tab still shows the reference value', async ({
    authApi,
    authPage,
  }) => {
    const action = await setupCommunityEvent(authApi);

    await apiCompleteOnboarding(authApi);
    await stripUiPermissions(authPage, ['eventpayments.read']);
    await openEvent(authPage, action.eventId);
    await authPage.getByRole('tab', { name: 'Financeiro', exact: true }).click();
    await expect(authPage.getByTestId('event-detail-community-reference')).toContainText(brl(action.referenceValue));
    // O chip do resumo de pagamentos é o único que depende da permission.
    await expect(authPage.getByTestId('event-detail-payments-status')).toHaveCount(0);
    await expect(authPage.getByTestId('event-detail-financial-not-charged')).toHaveText(/Sem cobrança/);
  });

  // E13 — §4 back 6.
  test('E13 @flow money end to end: the confirmed community event has zero item sum and the reference price; adding an item with a surcharge, lowering the children count and repricing keep the total at zero; the event never enters "A receber"', async ({
    authApi,
  }) => {
    test.setTimeout(180_000);
    const action = await setupCommunityEvent(authApi, { budget: { childrenCount: 20 } });
    const budget = await apiGetBudgetView(authApi, action.budgetId);

    const itemsTotal = (ev: Awaited<ReturnType<typeof apiGetEventView>>) => sum(ev.pricingItems.map((i) => i.totalPrice));

    let ev = await apiGetEventView(authApi, action.eventId);
    expect(ev.chargeMode).toBe('Community');
    expect(ev.subtotal, 'o preço de referência vem do orçamento').toBeCloseTo(budget.subtotal, 2);
    expect(ev.total).toBe(0);
    expect(ev.pricingItems.length).toBeGreaterThan(0);
    expect(itemsTotal(ev), 'Σ itens = 0').toBeCloseTo(0, 2);
    for (const item of ev.pricingItems) expect(item.unitPrice, `${item.description}: preço de tabela`).toBeGreaterThan(0);

    // A linha com acréscimo. O orçamento não recebe acréscimo por linha
    // (`BudgetPricingItemInputDto` é atividade + quantidade): o acréscimo entra
    // no item do evento, que é o caminho do `AdditionalAmount`.
    const added = await authApi.post(`/api/events/${action.eventId}/pricing-items`, {
      data: {
        sourceType: 'Custom',
        sourceId: null,
        description: 'Pipoca para a turma',
        quantity: 2,
        unit: 'un',
        unitPrice: 50,
        discountAmount: 0,
        additionalAmount: 30,
        notes: null,
      },
    });
    await assertOk(added, 'POST /api/events/{id}/pricing-items');
    ev = await apiGetEventView(authApi, action.eventId);
    const popcorn = ev.pricingItems.find((i) => i.description === 'Pipoca para a turma');
    expect(popcorn, 'o item adicionado').toBeTruthy();
    expect(popcorn!.unitPrice, 'preço de referência preservado').toBe(50);
    expect(popcorn!.totalPrice, 'o acréscimo também não é cobrado').toBe(0);
    expect(ev.total).toBe(0);
    expect(itemsTotal(ev)).toBeCloseTo(0, 2);

    // Menos crianças e o novo aceite (reprecificar).
    await apiPatchEvent(authApi, action.eventId, { childrenCount: 12 });
    ev = await apiGetEventView(authApi, action.eventId);
    expect(ev.childrenCount).toBe(12);
    expect(ev.total).toBe(0);
    const reprice = await authApi.post(`/api/events/${action.eventId}/reprice`, {
      data: { clientAcceptanceConfirmed: true, notes: null },
    });
    await assertOk(reprice, 'POST /api/events/{id}/reprice');
    ev = await apiGetEventView(authApi, action.eventId);
    expect(ev.total, 'reprecificar mantém o total zero').toBe(0);
    expect(itemsTotal(ev)).toBeCloseTo(0, 2);
    expect(ev.pricingItems.find((i) => i.description === 'Pipoca para a turma')?.unitPrice).toBe(50);
    expect(ev.subtotal, 'o valor de referência é agregado congelado (§4 back 6)').toBeCloseTo(budget.subtotal, 2);

    // Fora do "A receber".
    const pending = await apiListPendingPayments(authApi, { clientId: action.clientId });
    expect(pending.items.map((p) => p.eventId)).not.toContain(action.eventId);
    expect((await apiGetPaymentSummary(authApi, action.eventId)).financialStatus).toBe(FIN_STATUS_NOT_CHARGED);
  });

  // ───────────────────────────── EC-C (Etapa 249) ─────────────────────────────

  // E6 — §5 back 1 e 3; front 1 e 2.
  test('E6 @flow with paid team, a transport expense and consumed material, "Custo da ação" shows the sum and the reference value; the month report shows the community investment and the average ticket does not change', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(300_000);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_stock');
    await apiCreateCollaboratorLevel(authApi, 150);
    const today = tenantToday();
    const month = monthRange(today);

    // Uma festa paga no mês: a base do ticket médio.
    await setupAcceptedEvent(authApi, { budget: { eventDate: today } });
    const before = (await apiEventReport(authApi, { fromDate: month.from, toDate: month.to })).summary;
    expect(before.averageTicket, 'ticket médio da festa paga (pré-condição)').not.toBeNull();

    // Material que a atividade consome por criança, com estoque comprado.
    const product = await apiCreateProduct(authApi, { unitCost: 2.5 });
    await assertOk(
      await authApi.post('/api/stock/movements', {
        data: { productId: product.id, type: 'Purchase', quantity: 100, unitCost: 2.5, supplierName: 'Fornecedor E2E' },
      }),
      'POST /api/stock/movements',
    );
    const activity = await apiCreateActivity(authApi, {
      status: 'Active',
      activityProducts: [{ productId: product.id, qtyPerChild: 1, isChecklistOnly: false }],
    });
    const action = await communityToday(authApi, { activityIds: [activity.id], budget: { childrenCount: 10 } });

    // Equipe paga (cachê fixo, quitado), transporte e a ação realizada.
    const recreatorId = await assignLeader(authApi, action.eventId);
    const fee = await apiCreateCommission(authApi, action.eventId, {
      collaboratorId: recreatorId,
      kind: 'FixedAmount',
      value: 200,
    });
    await assertOk(
      await authApi.post(`/api/events/${action.eventId}/commissions/${fee.id}/mark-paid`),
      'POST commission mark-paid',
    );
    await apiCreateEventExpense(authApi, action.eventId, {
      amount: 85,
      category: 'Transporte',
      date: today,
      description: 'Van até a escola',
    });
    await runAction(authApi, action.eventId);

    const profitability = await apiGetProfitability(authApi, action.eventId);
    const cost = profitability.communityCost;
    expect(cost, 'bloco "custo da ação"').not.toBeNull();
    expect(cost!.referenceValue).toBeCloseTo(action.referenceValue, 2);
    expect(cost!.breakdown.team, 'equipe = o cachê acordado').toBeCloseTo(200, 2);
    expect(cost!.breakdown.expenses, 'despesa de transporte').toBeCloseTo(85, 2);
    expect(cost!.breakdown.material, 'material baixado').toBeGreaterThan(0);
    expect(cost!.realCost, 'o custo real é a soma da quebra').toBeCloseTo(
      sum(Object.values(cost!.breakdown)),
      2,
    );
    expect(profitability.realMarginPercent, 'sem margem').toBeNull();
    expect(profitability.realMarginAmount).toBeNull();
    expect(profitability.excessSuggestion).toBeNull();

    // O relatório do mês: o investimento comunitário e o ticket médio igual.
    const after = (await apiEventReport(authApi, { fromDate: month.from, toDate: month.to })).summary;
    expect(after.totalEvents).toBe(before.totalEvents + 1);
    expect(after.averageTicket, 'o ticket médio não muda').toBeCloseTo(before.averageTicket!, 2);
    expect(after.community?.count).toBe(1);
    expect(after.community!.referenceValueTotal).toBeCloseTo(action.referenceValue, 2);
    expect(after.community!.breakdown.team).toBeCloseTo(200, 2);
    expect(after.community!.breakdown.expenses).toBeCloseTo(85, 2);
    expect(after.community!.realCostTotal).toBeGreaterThan(0);

    // A tela: a aba "Custo da ação" e o KPI do relatório.
    await apiCompleteOnboarding(authApi);
    await openEvent(authPage, action.eventId);
    await expect(authPage.getByRole('tab', { name: 'Rentabilidade', exact: true })).toHaveCount(0);
    await authPage.getByRole('tab', { name: 'Custo da ação', exact: true }).click();
    await expect(authPage.getByTestId('profitability-community-reference')).toContainText(brl(cost!.referenceValue));
    await expect(authPage.getByTestId('profitability-community-real')).toContainText(brl(cost!.realCost));
    const breakdown = authPage.getByTestId('profitability-community-breakdown');
    await expect(breakdown).toContainText(brl(85));
    await expect(breakdown).toContainText(brl(200));

    await authPage.goto(`/app/finance/reports?fromDate=${month.from}&toDate=${month.to}`);
    await expect(authPage.getByTestId('summary-community')).toBeVisible({ timeout: 20_000 });
    await expect(authPage.getByTestId('summary-community-realCost')).toContainText(
      brl(after.community!.realCostTotal),
    );
    await expect(authPage.getByTestId('summary-community-referenceValue')).toContainText(brl(action.referenceValue));
    await expect(authPage.getByTestId('summary-averageTicket')).toContainText(brl(before.averageTicket!));
    await expect(authPage.getByTestId('summary-averageTicket-note')).toHaveText('(eventos pagos)');
  });

  // E16 — §5 "Testes", Api sem `pricing.viewmargin`; front 1 e 3.
  test('E16 @flow without pricing.viewmargin the community detail has no "Custo da ação" tab and the financial dashboard has no community card; the report still shows the community KPI', async ({
    authApi,
    authPage,
  }) => {
    test.setTimeout(180_000);
    await apiCreateCollaboratorLevel(authApi, 150);
    const month = monthRange(tenantToday());
    const action = await communityToday(authApi);

    // Controle com quem vê margem: o custo e o card existem para este tenant.
    expect((await apiGetProfitability(authApi, action.eventId)).communityCost).not.toBeNull();
    expect((await apiFinancialDashboard(authApi)).community?.count).toBe(1);

    await apiCompleteOnboarding(authApi);
    await stripUiPermissions(authPage, ['pricing.viewmargin']);

    await openEvent(authPage, action.eventId);
    await expect(authPage.getByTestId('event-detail-community')).toBeVisible();
    await expect(authPage.getByRole('tab', { name: 'Financeiro', exact: true })).toBeVisible();
    await expect(authPage.getByRole('tab', { name: 'Custo da ação', exact: true })).toHaveCount(0);
    await expect(authPage.getByRole('tab', { name: 'Rentabilidade', exact: true })).toHaveCount(0);

    await authPage.goto('/app/dashboard/financial');
    await expect(authPage.getByTestId('financial-kpi-cards')).toBeVisible({ timeout: 20_000 });
    await expect(authPage.getByTestId('financial-community-card')).toHaveCount(0);

    // O relatório segue a regra da margem média: o bloco sai para `reports.read`.
    await authPage.goto(`/app/finance/reports?fromDate=${month.from}&toDate=${month.to}`);
    await expect(authPage.getByTestId('summary-community')).toBeVisible({ timeout: 20_000 });
    await expect(authPage.getByTestId('summary-community-count')).toContainText('1');
    await expect(authPage.getByTestId('summary-averageMarginPercent')).toBeVisible();
  });

  // E17 — §5 back 3 e 4; front 3.
  test('E17 @flow the dashboard card "Ações comunitárias no mês" has the same count and real cost as the month report; "Ver no relatório" opens the report already filtered with the same number; a canceled action does not count; the month revenue does not change', async ({
    authApi,
    authPage,
  }) => {
    test.setTimeout(240_000);
    await apiCreateCollaboratorLevel(authApi, 150);
    const today = tenantToday();
    const month = monthRange(today);

    // Receita do mês: uma festa paga e quitada hoje.
    await setupPaidEvent(authApi, { budget: { eventDate: today } });
    const before = await apiFinancialDashboard(authApi);
    expect(before.revenueThisMonth, 'receita do mês (pré-condição)').toBeGreaterThan(0);

    const action = await communityToday(authApi);
    await apiCreateEventExpense(authApi, action.eventId, { amount: 70, category: 'Lanche', date: today });
    const canceled = await communityToday(authApi);
    await assertOk(
      await authApi.post(`/api/events/${canceled.eventId}/cancel`, { data: { reason: 'Chuva forte' } }),
      'POST /api/events/{id}/cancel',
    );

    const after = await apiFinancialDashboard(authApi);
    expect(after.revenueThisMonth, 'a receita do mês não muda').toBeCloseTo(before.revenueThisMonth, 2);
    expect(after.receivedThisMonth).toBeCloseTo(before.receivedThisMonth, 2);
    const card = after.community;
    expect(card, 'bloco comunitário para quem vê margem').not.toBeNull();
    expect(`${card!.year}-${String(card!.month).padStart(2, '0')}`).toBe(today.slice(0, 7));
    expect(card!.count, 'a ação cancelada não entra').toBe(1);
    expect(card!.referenceValueTotal).toBeCloseTo(action.referenceValue, 2);

    const report = (
      await apiEventReport(authApi, {
        fromDate: month.from,
        toDate: month.to,
        chargeMode: 'Community',
        statusFilter: LIVE_EVENT_STATUSES,
      })
    ).summary;
    expect(report.community?.count, 'mesma quantidade').toBe(card!.count);
    expect(report.community!.realCostTotal, 'mesmo custo real').toBeCloseTo(card!.realCostTotal, 2);
    expect(report.community!.referenceValueTotal).toBeCloseTo(card!.referenceValueTotal, 2);

    // A tela: o card e o link para o relatório filtrado.
    await apiCompleteOnboarding(authApi);
    await authPage.goto('/app/dashboard/financial');
    const communityCard = authPage.getByTestId('financial-community-card');
    await expect(communityCard).toBeVisible({ timeout: 20_000 });
    await expect(authPage.getByTestId('financial-community-count')).toContainText('1');
    await expect(authPage.getByTestId('financial-community-real-cost')).toContainText(brl(card!.realCostTotal));
    await expect(authPage.getByTestId('kpi-revenue-month')).toContainText(brl(before.revenueThisMonth));

    await authPage.getByTestId('financial-community-report-link').click();
    await authPage.waitForURL(/\/app\/finance\/reports\?/, { timeout: 20_000 });
    const params = new URL(authPage.url()).searchParams;
    expect(params.get('chargeMode')).toBe('Community');
    expect(params.get('fromDate')).toBe(month.from);
    expect(params.get('toDate')).toBe(month.to);
    expect((params.get('statusFilter') ?? '').split(',').sort()).toEqual(LIVE_EVENT_STATUSES.split(',').sort());

    await expect(authPage.getByTestId('summary-community-count')).toContainText('1', { timeout: 20_000 });
    await expect(authPage.getByTestId('summary-community-realCost')).toContainText(brl(card!.realCostTotal));
    await expect(authPage.getByTestId(`reports-row-community-${action.eventId}`)).toBeVisible();
    await expect(authPage.getByTestId(`reports-row-community-${canceled.eventId}`)).toHaveCount(0);
  });

  // E18 — §5 back 2; front 2.
  test('E18 @flow the event report with a paid and a community event: "Sem plano" does not bring the community one, its row says "Sem cobrança" with reference value and cost, and the CSV and Excel exports carry the new columns, empty on the paid event', async ({
    authApi,
    authPage,
  }) => {
    test.setTimeout(240_000);
    await apiCreateCollaboratorLevel(authApi, 150);
    const today = tenantToday();
    const month = monthRange(today);

    // Festa paga sem plano (o tenant novo não tem modelo de parcelas padrão).
    const paid = await setupAcceptedEvent(authApi, { budget: { eventDate: today } });
    const action = await communityToday(authApi);
    await apiCreateEventExpense(authApi, action.eventId, { amount: 40, category: 'Material', date: today });

    const { rows } = await apiEventReport(authApi, { fromDate: month.from, toDate: month.to });
    const paidRow = rows.find((r) => r.eventId === paid.eventId);
    const communityRow = rows.find((r) => r.eventId === action.eventId);
    expect(paidRow, 'linha da festa paga').toBeTruthy();
    expect(communityRow, 'linha da ação').toBeTruthy();
    expect(communityRow!.chargeMode).toBe('Community');
    expect(communityRow!.financialStatus).toBe(FIN_STATUS_NOT_CHARGED);
    expect(communityRow!.total).toBe(0);
    expect(communityRow!.referenceValue).toBeCloseTo(action.referenceValue, 2);
    expect(communityRow!.realCost, 'custo da ação na linha').not.toBeNull();
    expect(communityRow!.realCost!).toBeGreaterThan(0);
    expect(paidRow!.chargeMode).toBe('Charged');
    expect(paidRow!.financialStatus, 'pago sem plano (pré-condição)').toBeNull();
    expect(paidRow!.referenceValue).toBeNull();
    expect(paidRow!.realCost).toBeNull();

    // "Sem plano" traz a paga e não a comunitária.
    const noPlan = await apiEventReport(authApi, { fromDate: month.from, toDate: month.to, financialStatus: 'NoPlan' });
    const noPlanIds = noPlan.rows.map((r) => r.eventId);
    expect(noPlanIds).toContain(paid.eventId);
    expect(noPlanIds).not.toContain(action.eventId);

    // CSV: colunas novas (nome de propriedade, como as outras do CSV), vazias no pago.
    const period = { fromDate: month.from, toDate: month.to };
    const csv = parseCsv((await apiExportEventReport(authApi, period, 'Csv')).toString('utf8'));
    const header = csv[0]!;
    const col = (name: string) => {
      const index = header.indexOf(name);
      expect(index, `coluna ${name} no CSV`).toBeGreaterThanOrEqual(0);
      return index;
    };
    const [chargeCol, referenceCol, costCol, clientCol] = [
      col('Cobranca'),
      col('ValorReferencia'),
      col('CustoReal'),
      col('Cliente'),
    ];
    const csvPaid = csv.find((r) => r[clientCol] === paidRow!.clientName);
    const csvCommunity = csv.find((r) => r[clientCol] === communityRow!.clientName);
    expect(csvPaid, 'linha paga no CSV').toBeTruthy();
    expect(csvCommunity, 'linha comunitária no CSV').toBeTruthy();
    expect(csvPaid![chargeCol]).toBe('Charged');
    expect(csvPaid![referenceCol], 'valor de referência vazio no pago').toBe('');
    expect(csvPaid![costCol], 'custo real vazio no pago').toBe('');
    expect(csvCommunity![chargeCol]).toBe('Community');
    expect(csvCommunity![referenceCol]).toBe(csvDecimal(communityRow!.referenceValue!));
    expect(csvCommunity![costCol]).toBe(csvDecimal(communityRow!.realCost!));

    // Excel: os rótulos do plano, vazios no pago.
    const sheet = readXlsxRows(await apiExportEventReport(authApi, period, 'Excel'));
    const xHeader = sheet[0]!;
    const xCol = (name: string) => {
      const index = xHeader.indexOf(name);
      expect(index, `coluna "${name}" no Excel`).toBeGreaterThanOrEqual(0);
      return index;
    };
    const [xCharge, xReference, xCost, xClient] = [
      xCol('Cobrança'),
      xCol('Valor de Referência'),
      xCol('Custo Real'),
      xCol('Cliente'),
    ];
    const xPaid = sheet.find((r) => r[xClient] === paidRow!.clientName);
    const xCommunity = sheet.find((r) => r[xClient] === communityRow!.clientName);
    expect(xPaid, 'linha paga no Excel').toBeTruthy();
    expect(xCommunity, 'linha comunitária no Excel').toBeTruthy();
    expect(xPaid![xReference] ?? '', 'valor de referência vazio no pago').toBe('');
    expect(xPaid![xCost] ?? '', 'custo real vazio no pago').toBe('');
    expect(xCommunity![xCharge]).toBe('Community');
    expect(Number(xCommunity![xReference])).toBeCloseTo(communityRow!.referenceValue!, 2);
    expect(Number(xCommunity![xCost])).toBeCloseTo(communityRow!.realCost!, 2);

    // A tela: a linha diz "Sem cobrança" com a referência e o custo.
    await apiCompleteOnboarding(authApi);
    await authPage.goto(`/app/finance/reports?fromDate=${month.from}&toDate=${month.to}`);
    const chip = authPage.getByTestId(`reports-row-community-${action.eventId}`);
    await expect(chip).toBeVisible({ timeout: 20_000 });
    const row = authPage.locator('tr', { has: chip });
    await expect(row).toContainText('Sem cobrança');
    await expect(authPage.getByTestId(`reports-row-reference-${action.eventId}`)).toContainText(
      brl(communityRow!.referenceValue!),
    );
    await expect(authPage.getByTestId(`reports-row-cost-${action.eventId}`)).toContainText(
      brl(communityRow!.realCost!),
    );

    await authPage.goto(`/app/finance/reports?fromDate=${month.from}&toDate=${month.to}&financialStatus=NoPlan`);
    await expect(authPage.getByTestId('reports-table')).toContainText(paidRow!.clientName!, { timeout: 20_000 });
    await expect(authPage.getByTestId(`reports-row-community-${action.eventId}`)).toHaveCount(0);
  });
});

twoTenantsTest.describe('Fluxo 11 — community event: tenant isolation', () => {
  // E18 — "ação de outro tenant nunca aparece".
  twoTenantsTest('E18 @flow a community action of another tenant never shows in the report, its summary or its export', async ({
    apiA,
    apiB,
    tenantA,
    tenantB,
  }) => {
    twoTenantsTest.setTimeout(180_000);
    expect(tenantB.tenantId, 'dois tenants distintos').not.toBe(tenantA.tenantId);
    const month = monthRange(tenantToday());

    const actionB = await communityToday(apiB);
    await apiCreateEventExpense(apiB, actionB.eventId, { amount: 55, category: 'Transporte', date: tenantToday() });
    const paidA = await setupAcceptedEvent(apiA, { budget: { eventDate: tenantToday() } });

    const all = await apiEventReport(apiA, { fromDate: month.from, toDate: month.to });
    expect(all.rows.map((r) => r.eventId)).toContain(paidA.eventId);
    expect(all.rows.map((r) => r.eventId)).not.toContain(actionB.eventId);
    expect(all.summary.community, 'nenhum comunitário no tenant A').toBeNull();

    const community = await apiEventReport(apiA, { fromDate: month.from, toDate: month.to, chargeMode: 'Community' });
    expect(community.rows).toHaveLength(0);

    const csv = (await apiExportEventReport(apiA, { fromDate: month.from, toDate: month.to }, 'Csv')).toString('utf8');
    expect(csv).not.toContain(actionB.clientName);

    // B continua vendo a própria ação.
    const own = await apiEventReport(apiB, { fromDate: month.from, toDate: month.to, chargeMode: 'Community' });
    expect(own.rows.map((r) => r.eventId)).toEqual([actionB.eventId]);
  });
});
