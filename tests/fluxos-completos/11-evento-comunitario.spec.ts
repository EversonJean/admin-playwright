import { APIRequestContext, APIResponse, Locator, Page, Route } from '@playwright/test';

import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import {
  apiCompleteOnboarding,
  apiCreateActivity,
  apiCreateClient,
  apiCreateCollaborator,
  apiCreateCollaboratorLevel,
  apiCreateEventCategory,
  apiCreateProduct,
} from '../../helpers/api-entities';
import {
  apiAssignCollaborator,
  apiCompleteEvent,
  apiConfirmCollaborator,
  apiConfirmCommunityBudget,
  apiCreateBudget,
  apiGetBudget,
  apiGetPaymentPlan,
  apiGetPaymentSummary,
  apiListPendingPayments,
  apiPatchEvent,
  apiStartEvent,
  registerPaymentBody,
} from '../../helpers/api-event-flow';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';
import { apiGetReadiness, setupConfirmedPortalCollaborator } from '../../helpers/rain-plan';
import { apiErrorCodes, assertOk, readJson } from '../../helpers/response';
import { loginAsRole, setupAcceptedEvent } from '../../helpers/setup-flows';
import { isoDate, tenantToday } from '../../helpers/week-staffing';

/**
 * Fluxo: fluxos-completos/11 — Evento comunitário: ação sem cobrança, com o custo apurado
 * Diagrama: — (cenários E1, E5, E6, E10 e E12 do registro e2e de
 * `docs/implementar/PLANO-EVENTO-COMUNITARIO.md`)
 *
 * Fonte do comportamento: PLANO-EVENTO-COMUNITARIO §2.3 (códigos e status),
 * §3 (EC-A, modo comunitário e confirmação da ação), §4 (EC-B, guardas
 * financeiras e cachê) e §5 (EC-C, custo da ação, relatório e painel). O spec
 * afirma o plano; divergência é falha de código, não de asserção.
 *
 * [DECISAO] "Role customizada" não existe no produto: os papéis são o enum fixo
 * e a matriz é código (`Permissions.ForRole`; `Domain/Auth/Role.cs`: "custom
 * roles por tenant ficam pra futuro"). Nenhum papel do tenant tem
 * `dashboard.read` e `reports.read` sem `pricing.viewmargin`. A TELA do E12
 * recebe a lista de permissions sem `pricing.viewmargin` (molde do E62 do
 * `17.6`); a parte do BACK com usuário real sem a permission fica em
 * `test.fixme` com o motivo, e está coberta pelos testes de Api do back.
 */

const DAY_MS = 86_400_000;

/** Dia do calendário do tenant (São Paulo) deslocado de `days`. */
function tenantDay(days = 0): string {
  return isoDate(new Date(tenantToday().getTime() + days * DAY_MS));
}

/** Primeiro e último dia do mês corrente do tenant. */
function tenantMonth(): { from: string; to: string } {
  const today = tenantToday();
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const last = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  return { from: isoDate(first), to: isoDate(last) };
}

function uid(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** `R$ 1.234,56`, como o `currency: 'BRL'` do front em pt-BR. */
function brl(value: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

/** Espaços normalizados (o pipe e o `Intl` usam espaço não separável). */
function norm(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** O texto do elemento traz o valor em reais. */
async function expectMoney(locator: Locator, value: number, message?: string): Promise<void> {
  await expect(locator, message).toBeVisible();
  await expect
    .poll(async () => norm(await locator.innerText()), { message: message ?? `valor ${brl(value)}` })
    .toContain(norm(brl(value)));
}

/** Aba do detalhe pelo rótulo (o `data-testid` do `<mat-tab>` não chega ao cabeçalho). */
function tab(page: Page, name: string): Locator {
  return page.getByRole('tab', { name, exact: true });
}

/**
 * A tela recebe a lista de permissions do usuário SEM os códigos dados (molde
 * do E62 do `17.6`): é o "usuário de role customizada" que a matriz fixa de
 * papéis não oferece. O back continua decidindo pelo papel real.
 */
async function withoutPermissions(page: Page, codes: string[]): Promise<void> {
  await page.route('**/api/me/permissions', async (route: Route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { data?: { permissions: string[] }; permissions?: string[] };
    const holder = body.data ?? body;
    holder.permissions = (holder.permissions ?? []).filter((p) => !codes.includes(p));
    await route.fulfill({ response, json: body });
  });
}

/** Orçamento comunitário (Draft) confirmado como ação pelo gestor, pela API. */
async function setupCommunityAction(
  api: APIRequestContext,
  opts: {
    clientId?: string;
    activityIds?: string[];
    eventDate?: string;
    childrenCount?: number;
    eventCategoryId?: string;
  } = {},
): Promise<{ budgetId: string; eventId: string; clientId: string }> {
  const clientId = opts.clientId ?? (await apiCreateClient(api, { name: `Escola E2E ${uid()}` })).id;
  const activityIds = opts.activityIds ?? [(await apiCreateActivity(api)).id];
  const budget = await apiCreateBudget(api, {
    clientId,
    activityIds,
    eventDate: opts.eventDate ?? tenantDay(10),
    childrenCount: opts.childrenCount ?? 10,
    chargeMode: 'Community',
    ...(opts.eventCategoryId ? { eventCategoryId: opts.eventCategoryId } : {}),
  });
  const confirmed = await apiConfirmCommunityBudget(api, budget.id);
  return { budgetId: budget.id, eventId: confirmed.anchorEventId, clientId };
}

interface EventDetail {
  id: string;
  chargeMode: string;
  total: number;
  subtotal: number;
  childrenCount: number;
}

async function getEvent(api: APIRequestContext, eventId: string): Promise<EventDetail> {
  const res = await api.get(`/api/events/${eventId}`);
  await assertOk(res, 'GET /api/events/{id}');
  return readJson<EventDetail>(res);
}

/** Líder escalado e confirmado, festa iniciada e concluída pela máquina de estados. */
async function completeWithLeader(api: APIRequestContext, eventId: string, leaderId?: string): Promise<void> {
  if (!leaderId) {
    const leader = await apiCreateCollaborator(api);
    await apiAssignCollaborator(api, eventId, leader.id, { isLeader: true });
    await apiConfirmCollaborator(api, eventId, leader.id);
  }
  await apiStartEvent(api, eventId);
  await apiCompleteEvent(api, eventId);
}

async function postCommission(
  api: APIRequestContext,
  eventId: string,
  body: { collaboratorId: string; kind: 'FixedAmount' | 'Percentage' | 'Bonus'; value: number; notes?: string },
): Promise<APIResponse> {
  return api.post(`/api/events/${eventId}/commissions`, {
    data: { collaboratorId: body.collaboratorId, kind: body.kind, value: body.value, notes: body.notes ?? null },
  });
}

async function addEventExpense(api: APIRequestContext, eventId: string, amount: number, category: string): Promise<void> {
  await assertOk(
    await api.post(`/api/events/${eventId}/expenses`, {
      data: { amount, category, date: tenantDay(0), description: `${category} E2E` },
    }),
    'POST /api/events/{id}/expenses',
  );
}

interface CommunityCostLine {
  category: string | number;
  label: string;
  estimated: number | null;
  real: number;
  isEstimate: boolean;
}

interface Profitability {
  frozenMarginAmount: number | null;
  frozenMarginPercent: number | null;
  realMarginAmount: number | null;
  realMarginPercent: number | null;
  childrenVariance: number | null;
  excessSuggestion: unknown | null;
  communityCost: {
    referenceValue: number;
    estimatedCost: number | null;
    realCost: number;
    lines: CommunityCostLine[];
    isPartial: boolean;
  } | null;
}

async function getProfitability(api: APIRequestContext, eventId: string): Promise<Profitability> {
  const res = await api.get(`/api/events/${eventId}/profitability`);
  await assertOk(res, 'GET /api/events/{id}/profitability');
  return readJson<Profitability>(res);
}

/** Linha do custo da ação pela categoria (o enum viaja como nome; o número fica de reserva). */
function costLine(lines: CommunityCostLine[], name: 'Team' | 'Expenses' | 'Material' | 'Displacement' | 'Other'): CommunityCostLine {
  const number = { Team: 1, Expenses: 2, Material: 3, Displacement: 4, Other: 5 }[name];
  const line = lines.find((l) => l.category === name || l.category === number);
  expect(line, `linha ${name} do custo da ação`).toBeTruthy();
  return line!;
}

interface CommunitySummary {
  count: number;
  referenceValueTotal: number;
  realCostTotal: number;
}

interface EventReport {
  items: { items: Array<{ eventId: string; chargeMode: string; referenceValue: number | null; realCost: number | null; total: number }> };
  summary: {
    totalEvents: number;
    averageTicket: number | null;
    averageMarginPercent: number | null;
    community: CommunitySummary | null;
  };
}

async function getReport(
  api: APIRequestContext,
  query: { fromDate: string; toDate: string; chargeMode?: 'Charged' | 'Community' },
): Promise<EventReport> {
  const params = new URLSearchParams({ fromDate: query.fromDate, toDate: query.toDate, pageSize: '200' });
  if (query.chargeMode) params.set('chargeMode', query.chargeMode);
  const res = await api.get(`/api/reports/events?${params.toString()}`);
  await assertOk(res, 'GET /api/reports/events');
  return readJson<EventReport>(res);
}

async function getFinancialDashboard(api: APIRequestContext): Promise<{ communityThisMonth: CommunitySummary | null }> {
  const res = await api.get('/api/dashboard/financial');
  await assertOk(res, 'GET /api/dashboard/financial');
  return readJson<{ communityThisMonth: CommunitySummary | null }>(res);
}

/** Uma linha de CSV (vírgula, aspas duplas com "" de escape), como o CsvHelper grava. */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

// ════════════════════════════════════════════════════════════════════════════

test.describe('Fluxo completo 11 — Evento comunitário (sem cobrança, com o custo apurado)', () => {
  test('E1 @flow "Nova ação comunitária" e a categoria do grupo Comunitário ligam o modo; "Confirmar ação" cria o evento sem parcelas, com o chip e nos filtros da lista e do calendário', async ({
    authPage,
    authApi,
  }) => {
    test.setTimeout(240_000);
    await apiCompleteOnboarding(authApi);
    const category = await apiCreateEventCategory(authApi, { group: 'Comunitario', name: `Escola pública E2E ${uid()}` });
    const toggle = authPage.getByTestId('budget-form-isCommunity').getByRole('switch');

    // §3 front 4 — o atalho da lista de eventos abre o orçamento já no modo.
    await authPage.goto('/app/events/list');
    await authPage.getByTestId('events-list-new-community').click();
    await authPage.waitForURL(/\/app\/budgets\/quick\?community=1/);
    await expect(toggle, 'atalho: toggle ligado').toHaveAttribute('aria-checked', 'true');
    await expect(authPage.getByTestId('budget-form-community-hint')).toBeVisible();

    // §3 front 2 — orçamento montado sem o atalho: a categoria do grupo
    // Comunitário liga o toggle, com o aviso.
    await authPage.goto('/app/budgets/quick');
    await expect(toggle, 'orçamento novo nasce cobrado').toHaveAttribute('aria-checked', 'false');
    await authPage.getByTestId('budget-form-eventCategoryId').click();
    await authPage.getByTestId(`budget-form-category-option-${category.id}`).click();
    await expect(toggle, 'categoria comunitária liga o modo').toHaveAttribute('aria-checked', 'true');
    await expect(authPage.getByTestId('budget-form-community-suggested')).toContainText('Sugerido pela categoria');

    // Pré-condição: um evento PAGO, controle dos filtros, e o orçamento
    // comunitário da escola em rascunho.
    const paid = await setupAcceptedEvent(authApi);
    const school = await apiCreateClient(authApi, { name: `Escola Municipal E2E ${uid()}` });
    const activity = await apiCreateActivity(authApi);
    const budget = await apiCreateBudget(authApi, {
      clientId: school.id,
      activityIds: [activity.id],
      eventDate: tenantDay(3),
      chargeMode: 'Community',
      eventCategoryId: category.id,
    });

    // §3 item 5 / front 3 — "Confirmar ação" sem enviar, e a tela cai no evento.
    await authPage.goto(`/app/budgets/${budget.id}`);
    await expect(authPage.getByTestId('budget-form-accept'), 'comunitário não tem "Fechar orçamento"').toHaveCount(0);
    const confirmResponse = authPage.waitForResponse(
      (r) => r.request().method() === 'POST' && /\/api\/budgets\/[0-9a-f-]+\/confirm-community$/i.test(r.url()),
    );
    await authPage.getByTestId('budget-form-confirm-community').click();
    await authPage.getByTestId('confirm-community-confirm').click();
    const confirmed = await confirmResponse;
    expect(confirmed.ok(), 'confirm-community').toBe(true);
    const eventId = ((await confirmed.json()) as { data?: { anchorEventId?: string } }).data?.anchorEventId;
    expect(eventId, 'a confirmação devolve o evento').toBeTruthy();
    await authPage.waitForURL(new RegExp(`/app/events/${eventId}`));
    await expect(authPage.getByTestId('event-detail-community')).toHaveText(/Comunitário/);

    // O orçamento virou ação confirmada sem passar por "Enviado".
    const after = (await apiGetBudget(authApi, budget.id)) as unknown as { status: string; chargeMode: string };
    expect(after.status).toBe('Accepted');
    expect(after.chargeMode).toBe('Community');

    // Sem parcelas e sem cobrança agendada.
    const ev = await getEvent(authApi, eventId!);
    expect(ev.chargeMode).toBe('Community');
    expect(ev.total, 'total do evento comunitário').toBe(0);
    expect(await apiGetPaymentPlan(authApi, eventId!), 'evento comunitário nasce sem plano').toBeNull();
    const summary = await apiGetPaymentSummary(authApi, eventId!);
    expect(summary.financialStatus).toBe('NotCharged');
    const pending = await apiListPendingPayments(authApi, { clientId: school.id });
    expect(pending.items.map((p) => p.eventId), 'nada a receber da escola').not.toContain(eventId);

    // §3 item 8 / front 4 — filtro "Cobrança: comunitários" na lista de eventos.
    await authPage.goto('/app/events/list');
    await expect(authPage.getByTestId(`events-list-detail-${paid.eventId}`), 'sem filtro, o pago aparece').toBeVisible();
    await expect(authPage.getByTestId(`events-list-community-${eventId}`), 'chip na linha').toBeVisible();
    await authPage.getByTestId('events-list-filter-chargeMode').click();
    await authPage.getByRole('option', { name: 'Comunitários', exact: true }).click();
    await expect(authPage.getByTestId(`events-list-community-${eventId}`)).toBeVisible();
    await expect(authPage.getByTestId(`events-list-detail-${paid.eventId}`), 'o filtro tira o pago').toHaveCount(0);

    // E no calendário: a API filtra por `chargeMode` e a tela recorta.
    const calendar = await authApi.get(
      `/api/events/calendar?from=${tenantDay(-1)}&to=${tenantDay(45)}&chargeMode=Community`,
    );
    await assertOk(calendar, 'GET /api/events/calendar?chargeMode=Community');
    const calendarIds = (await readJson<Array<{ id: string }>>(calendar)).map((e) => e.id);
    expect(calendarIds).toContain(eventId);
    expect(calendarIds).not.toContain(paid.eventId);

    await authPage.goto('/app/schedule/calendar');
    await authPage.getByTestId('calendar-filter-chargeMode').click();
    await authPage.getByRole('option', { name: 'Comunitários', exact: true }).click();
    await expect(authPage.getByTestId(`calendar-upcoming-community-${eventId}`)).toBeVisible();
  });

  test('E5 @flow aba Financeiro com valor de referência e "Sem cobrança"; pagamento e plano dão 409 Event.NotChargeable ao Dono e ao Financeiro; cachê fixo aceito e no Portal do recreador, percentual desabilitado', async ({
    authPage,
    authApi,
    tenant,
  }) => {
    test.setTimeout(240_000);
    await apiCompleteOnboarding(authApi);
    const { eventId } = await setupCommunityAction(authApi);
    const ev = await getEvent(authApi, eventId);
    expect(ev.subtotal, 'valor de referência do evento').toBeGreaterThan(0);

    // §4 back 1 e §2.3 — as portas de cobrança recusam com 409, não 403.
    const due = tenantDay(20);
    const financial = await loginAsRole(tenant.tenantId, 'Financial');
    try {
      for (const [who, api] of [['Dono', authApi], ['Financeiro', financial.api]] as const) {
        const pay = await api.post(`/api/events/${eventId}/payments`, {
          data: registerPaymentBody({ amount: 100, method: 'Pix' }),
        });
        expect(pay.status(), `${who}: registrar pagamento`).toBe(409);
        expect(await apiErrorCodes(pay)).toContain('Event.NotChargeable');

        const plan = await api.post(`/api/events/${eventId}/payment-plan`, {
          data: {
            templateId: null,
            installments: [{ order: 1, label: 'Parcela única', expectedAmount: 100, dueDate: due }],
          },
        });
        expect(plan.status(), `${who}: criar plano`).toBe(409);
        expect(await apiErrorCodes(plan)).toContain('Event.NotChargeable');
      }
    } finally {
      await financial.api.dispose();
    }
    expect((await apiGetPaymentSummary(authApi, eventId)).financialStatus).toBe('NotCharged');
    expect(await apiGetPaymentPlan(authApi, eventId)).toBeNull();

    // O recreador do Portal, escalado e confirmado.
    const recreatorName = `Recreador E2E ${uid()}`;
    const { collaboratorId, portal } = await setupConfirmedPortalCollaborator(authApi, tenant.tenantId, eventId, {
      name: recreatorName,
    });
    try {
      // §4 front 1 e 2 — aba Financeiro: card do comunitário, sem plano,
      // pagamento nem ajuste; o cabeçalho não diz "Sem plano financeiro".
      await authPage.goto(`/app/events/${eventId}`);
      await expect(authPage.getByTestId('event-detail-community')).toBeVisible();
      await expect(authPage.getByTestId('event-detail-payment-plan-status')).toHaveCount(0);
      await expect(authPage.getByText('Sem plano financeiro')).toHaveCount(0);

      await tab(authPage, 'Financeiro').click();
      await expect(authPage.getByTestId('event-detail-community-finance')).toContainText('sem cobrança');
      await expectMoney(authPage.getByTestId('event-detail-community-reference'), ev.subtotal, 'valor de referência');
      await expect(authPage.getByTestId('event-detail-payments-status')).toHaveText(/Sem cobrança/);
      await expect(authPage.getByTestId('event-detail-payment-plan')).toHaveCount(0);
      await expect(authPage.getByTestId('event-detail-payments')).toHaveCount(0);
      await expect(authPage.getByTestId('event-detail-adjustments')).toHaveCount(0);
      await expect(authPage.getByTestId('setup-pain-hint')).toHaveCount(0);

      // §4 front 3 — aba "Cachê da equipe": percentual desabilitado; o valor
      // fixo é aceito.
      await tab(authPage, 'Cachê da equipe').click();
      await authPage.getByTestId('commission-tab-btn-new').click();
      await authPage.getByTestId('commission-tab-form-collaborator').click();
      await authPage.getByRole('option', { name: recreatorName }).click();
      await authPage.getByTestId('commission-tab-form-kind').click();
      await expect(authPage.getByTestId('commission-tab-form-kind-percentage')).toHaveAttribute('aria-disabled', 'true');
      await authPage.getByRole('option', { name: 'Valor fixo (R$)' }).click();
      await expect(authPage.getByTestId('commission-tab-form-community-hint')).toContainText('Sem receita');
      await authPage.getByTestId('commission-tab-form-value').fill('180');
      const created = authPage.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/api\/events\/[0-9a-f-]+\/commissions$/i.test(r.url()),
      );
      await authPage.getByTestId('commission-tab-form-submit').click();
      const createdRes = await created;
      expect(createdRes.ok(), 'cachê fixo aceito').toBe(true);
      await expect(authPage.getByTestId('commission-tab-table')).toContainText(recreatorName);

      // §2.3 — o percentual é recusado pelo back (a tela só o desabilita).
      const percentage = await postCommission(authApi, eventId, { collaboratorId, kind: 'Percentage', value: 10 });
      expect(percentage.status(), 'comissão percentual em evento comunitário').toBe(400);
      expect(await apiErrorCodes(percentage)).toContain('Commission.PercentageOnCommunityEvent');

      // E o cachê aparece no Portal do recreador.
      const mine = await portal.api.get(`/api/portal/my-commissions?from=${tenantDay(-1)}&to=${tenantDay(60)}`);
      await assertOk(mine, 'GET /api/portal/my-commissions');
      const commissions = (await readJson<{ commissions: Array<{ eventId: string; kind: string; amount: number }> }>(mine))
        .commissions;
      const cache = commissions.find((c) => c.eventId === eventId);
      expect(cache, 'o cachê da ação no Portal do recreador').toBeTruthy();
      expect(cache!.kind).toBe('FixedAmount');
      expect(cache!.amount).toBe(180);
    } finally {
      await portal.api.dispose();
    }
  });

  test('E10 @flow item novo, item editado e excedente de crianças: total segue zero, sem card de excedente, "cobrar excedente" 409 e nenhum plano; a prontidão não pede sinal', async ({
    authPage,
    authApi,
  }) => {
    test.setTimeout(240_000);
    await apiCompleteOnboarding(authApi);
    const { eventId } = await setupCommunityAction(authApi, { childrenCount: 10 });
    expect((await getEvent(authApi, eventId)).total).toBe(0);

    // §4 back 6 — item novo: o domínio aplica o desconto do modo e o total fica zero.
    const added = await authApi.post(`/api/events/${eventId}/pricing-items`, {
      data: {
        sourceType: 'Custom',
        sourceId: null,
        description: 'Pintura facial E2E',
        quantity: 1,
        unit: 'un',
        unitPrice: 150,
        discountAmount: 0,
        additionalAmount: 0,
        notes: null,
      },
    });
    await assertOk(added, 'POST pricing item');
    const addedId = (await readJson<{ id: string }>(added)).id;
    expect((await getEvent(authApi, eventId)).total, 'total depois do item novo').toBe(0);

    interface PricingItem {
      id: string;
      sourceType: string;
      sourceId: string | null;
      description: string;
      quantity: number;
      unit: string | null;
      unitPrice: number;
      discountAmount: number;
      additionalAmount: number;
      totalPrice: number;
      notes: string | null;
    }
    const listItems = async (): Promise<PricingItem[]> => {
      const res = await authApi.get(`/api/events/${eventId}/pricing-items`);
      await assertOk(res, 'GET pricing items');
      const data = await readJson<PricingItem[] | { items: PricingItem[] }>(res);
      return Array.isArray(data) ? data : data.items;
    };
    const item = (await listItems()).find((i) => i.id === addedId)!;
    expect(item.unitPrice, 'o preço de tabela fica como referência').toBe(150);
    expect(item.totalPrice).toBe(0);

    // Item editado com o desconto que a tela devolve (o PUT manda o item como veio).
    const edited = await authApi.put(`/api/events/${eventId}/pricing-items/${addedId}`, {
      data: {
        sourceType: item.sourceType,
        sourceId: item.sourceId,
        description: item.description,
        quantity: 2,
        unit: item.unit,
        unitPrice: item.unitPrice,
        discountAmount: item.discountAmount,
        additionalAmount: item.additionalAmount,
        notes: item.notes,
      },
    });
    await assertOk(edited, 'PUT pricing item');
    expect((await getEvent(authApi, eventId)).total, 'total depois do item editado').toBe(0);
    const editedItem = (await listItems()).find((i) => i.id === addedId)!;
    expect(editedItem.unitPrice).toBe(150);
    expect(editedItem.totalPrice).toBe(0);
    for (const i of await listItems()) expect(i.totalPrice, `linha ${i.description}`).toBe(0);
    expect(await apiGetPaymentPlan(authApi, eventId)).toBeNull();

    // §4 back 5 — a prontidão do comunitário não tem o requisito de sinal; o
    // evento pago tem (controle).
    const readiness = await apiGetReadiness(authApi, eventId);
    expect(readiness.map((r) => r.key)).not.toContain('deposit_paid');
    const paid = await setupAcceptedEvent(authApi);
    const paidReadiness = await apiGetReadiness(authApi, paid.eventId);
    expect(paidReadiness.map((r) => r.key)).toContain('deposit_paid');

    // §4 back 1 — excedente: a sugestão some e cobrar é recusado com 409.
    await completeWithLeader(authApi, eventId);
    await assertOk(
      await authApi.post(`/api/events/${eventId}/actual-children`, { data: { actualChildrenCount: 15 } }),
      'POST actual-children',
    );
    const profitability = await getProfitability(authApi, eventId);
    expect(profitability.childrenVariance).toBe(5);
    expect(profitability.excessSuggestion, 'sem sugestão de cobrança no comunitário').toBeNull();

    const charge = await authApi.post(`/api/events/${eventId}/excess-charge`, { data: { confirmed: true, notes: null } });
    expect(charge.status(), 'cobrar excedente').toBe(409);
    expect(await apiErrorCodes(charge)).toContain('Event.NotChargeable');
    expect(await apiGetPaymentPlan(authApi, eventId), 'nenhum plano nasce').toBeNull();
    expect((await getEvent(authApi, eventId)).total).toBe(0);

    // O card de excedente some da aba (que no comunitário é "Custo da ação").
    await authPage.goto(`/app/events/${eventId}`);
    await tab(authPage, 'Custo da ação').click();
    await expect(authPage.getByTestId('profitability-variance')).toContainText('5 criança(s) além do contratado');
    await expect(authPage.getByTestId('profitability-excess-card')).toHaveCount(0);
    await expect(authPage.getByTestId('profitability-charge-excess')).toHaveCount(0);
  });

  test('E6 @flow custo da ação (cachê + bônus, transporte, conferência acima do previsto) igual na aba, no relatório e no painel; a cancelada fica de fora; ticket e margem médios só dos pagos; filtro, export e o link do painel', async ({
    authPage,
    authApi,
    tenant,
  }) => {
    test.setTimeout(360_000);
    await apiCompleteOnboarding(authApi);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_stock');
    const today = tenantDay(0);
    const month = tenantMonth();

    // Um evento PAGO no mês (antes do nível de colaborador: sem custo de equipe
    // conhecido, a trava de margem não age no envio).
    const paid = await setupAcceptedEvent(authApi, { budget: { eventDate: today } });
    const paidTotal = (await apiGetPaymentSummary(authApi, paid.eventId)).eventTotal;
    expect(paidTotal).toBeGreaterThan(0);

    // Custo estimado conhecido: um nível (equipe de 2 × 120) e o material.
    await apiCreateCollaboratorLevel(authApi, { baseValue: 120 });
    const unitCost = 10;
    const product = await apiCreateProduct(authApi, { name: `Tinta E2E ${uid()}`, unitCost });
    await assertOk(
      await authApi.post('/api/stock/movements', {
        data: { productId: product.id, type: 'Purchase', quantity: 100, unitCost, supplierName: 'Fornecedor E2E' },
      }),
      'POST /api/stock/movements (compra)',
    );
    const activity = await apiCreateActivity(authApi, {
      activityProducts: [{ productId: product.id, qtyPerChild: 1, isChecklistOnly: false }],
    });

    // A ação do mês e uma segunda, cancelada, com despesa própria.
    const action = await setupCommunityAction(authApi, { activityIds: [activity.id], childrenCount: 10 });
    await apiPatchEvent(authApi, action.eventId, { eventDate: today });
    const cancelled = await setupCommunityAction(authApi);
    await apiPatchEvent(authApi, cancelled.eventId, { eventDate: today });
    await addEventExpense(authApi, cancelled.eventId, 500, 'Transporte');
    await assertOk(
      await authApi.post(`/api/events/${cancelled.eventId}/cancel`, { data: { reason: 'Escola remarcou (E2E)' } }),
      'POST cancel (segunda ação)',
    );

    // Equipe: o recreador do Portal lidera; cachê combinado 150 + bônus 50.
    const { collaboratorId, portal } = await setupConfirmedPortalCollaborator(authApi, tenant.tenantId, action.eventId);
    try {
      await assertOk(
        await postCommission(authApi, action.eventId, { collaboratorId, kind: 'FixedAmount', value: 150 }),
        'POST cachê fixo',
      );
      await assertOk(
        await postCommission(authApi, action.eventId, {
          collaboratorId,
          kind: 'Bonus',
          value: 50,
          notes: 'Ficou além do horário (E2E)',
        }),
        'POST bônus',
      );
      await addEventExpense(authApi, action.eventId, 80, 'Transporte');
      await completeWithLeader(authApi, action.eventId, collaboratorId);

      // Conferência de consumo: o recreador lança 3 a mais e o gestor confirma.
      const review = await portal.api.get(`/api/portal/my-events/${action.eventId}/material-consumption`);
      await assertOk(review, 'GET material-consumption (portal)');
      const records = (await readJson<{ records: Array<{ id: string; productId: string; predictedQuantity: number }> }>(review))
        .records;
      const record = records.find((r) => r.productId === product.id);
      expect(record, 'registro de consumo do produto').toBeTruthy();
      await assertOk(
        await portal.api.post(`/api/portal/my-events/${action.eventId}/material-consumption`, {
          data: { lines: [{ recordId: record!.id, actualQuantity: record!.predictedQuantity + 3, reason: 'Usou mais tinta (E2E)' }] },
        }),
        'POST material-consumption (portal)',
      );
      await assertOk(
        await authApi.post(`/api/stock/consumption-reviews/${action.eventId}/confirm`, { data: { corrections: [] } }),
        'POST consumption-reviews confirm',
      );
    } finally {
      await portal.api.dispose();
    }

    // §5 back 1 — o custo da ação: referência, estimado × real, a soma, sem margem.
    const ev = await getEvent(authApi, action.eventId);
    const profitability = await getProfitability(authApi, action.eventId);
    expect(profitability.frozenMarginAmount, 'sem margem congelada').toBeNull();
    expect(profitability.frozenMarginPercent).toBeNull();
    expect(profitability.realMarginAmount, 'sem margem real').toBeNull();
    expect(profitability.realMarginPercent).toBeNull();
    const cc = profitability.communityCost;
    expect(cc, 'bloco do custo da ação').toBeTruthy();
    expect(cc!.referenceValue).toBeCloseTo(ev.subtotal, 2);

    const team = costLine(cc!.lines, 'Team');
    expect(team.estimated, 'equipe estimada: 2 × 120').toBeCloseTo(240, 2);
    expect(team.real, 'equipe = combinado + bônus').toBeCloseTo(200, 2);
    expect(team.isEstimate).toBe(false);
    const expenses = costLine(cc!.lines, 'Expenses');
    expect(expenses.real, 'despesa de transporte').toBeCloseTo(80, 2);
    const material = costLine(cc!.lines, 'Material');
    expect(material.estimated, 'material estimado').not.toBeNull();
    expect(material.real - (material.estimated ?? 0), 'material = estimado + variação (3 × 10)').toBeCloseTo(3 * unitCost, 2);
    expect(material.isEstimate).toBe(false);
    const sum = cc!.lines.reduce((acc, l) => acc + l.real, 0);
    expect(cc!.realCost, 'o custo real é a soma das linhas').toBeCloseTo(sum, 2);

    // A aba "Custo da ação" mostra os mesmos números, sem a ponte de margem.
    await authPage.goto(`/app/events/${action.eventId}`);
    await tab(authPage, 'Custo da ação').click();
    await expectMoney(authPage.getByTestId('profitability-community-reference'), cc!.referenceValue, 'referência na aba');
    if (cc!.estimatedCost !== null) {
      await expectMoney(authPage.getByTestId('profitability-community-estimated'), cc!.estimatedCost, 'estimado na aba');
    }
    await expectMoney(authPage.getByTestId('profitability-community-real'), cc!.realCost, 'real na aba');
    await expectMoney(
      authPage.locator(`[data-testid="profitability-community-line-${team.category}"]`),
      team.real,
      'linha da equipe',
    );
    await expect(authPage.getByTestId('profitability-bridge'), 'sem a ponte de margem').toHaveCount(0);

    // §5 back 2 e 3 — a mesma conta no relatório do mês, sem a cancelada.
    const all = await getReport(authApi, { fromDate: month.from, toDate: month.to });
    const row = all.items.items.find((r) => r.eventId === action.eventId);
    expect(row, 'a ação na lista do relatório').toBeTruthy();
    expect(row!.chargeMode).toBe('Community');
    expect(row!.referenceValue ?? 0).toBeCloseTo(cc!.referenceValue, 2);
    expect(row!.realCost ?? 0, 'custo real da linha = o da aba').toBeCloseTo(cc!.realCost, 2);
    expect(all.summary.community, 'bloco comunitário do resumo').toBeTruthy();
    expect(all.summary.community!.count, 'a cancelada fica de fora').toBe(1);
    expect(all.summary.community!.realCostTotal, 'KPI de investimento = custo da ação').toBeCloseTo(cc!.realCost, 2);

    // Ticket e margem médios ("eventos pagos") não mudam com a ação.
    const chargedOnly = await getReport(authApi, { fromDate: month.from, toDate: month.to, chargeMode: 'Charged' });
    expect(all.summary.averageTicket, 'ticket médio só do pago').toBeCloseTo(paidTotal, 2);
    expect(all.summary.averageTicket).toBe(chargedOnly.summary.averageTicket);
    expect(all.summary.averageMarginPercent).toBe(chargedOnly.summary.averageMarginPercent);

    // Filtro "Cobrança: Comunitários".
    const communityOnly = await getReport(authApi, { fromDate: month.from, toDate: month.to, chargeMode: 'Community' });
    const ids = communityOnly.items.items.map((r) => r.eventId);
    expect(ids).toContain(action.eventId);
    expect(ids, 'o filtro tira o pago').not.toContain(paid.eventId);
    for (const r of communityOnly.items.items) expect(r.chargeMode).toBe('Community');

    // Export com as colunas novas.
    const csv = await authApi.get(
      `/api/reports/events/export?format=Csv&fromDate=${month.from}&toDate=${month.to}&chargeMode=Community`,
    );
    await assertOk(csv, 'GET export CSV');
    // O CSV usa cabeçalho ASCII em camel (StatusFinanceiro); os rótulos com
    // espaço ("Cobrança", "Valor de Referência", "Custo Real") são do Excel.
    const lines = (await csv.text())
      .replace(/^﻿/, '')
      .split(/\r?\n/)
      .filter((l) => l.trim() !== '');
    const header = parseCsvLine(lines[0] ?? '');
    const colCharge = header.indexOf('Cobranca');
    const colReference = header.indexOf('ValorReferencia');
    const colRealCost = header.indexOf('CustoReal');
    expect(colCharge, 'coluna "Cobranca" no export').toBeGreaterThanOrEqual(0);
    expect(colReference, 'coluna "ValorReferencia" no export').toBeGreaterThanOrEqual(0);
    expect(colRealCost, 'coluna "CustoReal" no export').toBeGreaterThanOrEqual(0);
    const csvRows = lines.slice(1).map(parseCsvLine);
    expect(csvRows.length, 'linhas no export filtrado').toBeGreaterThan(0);
    for (const r of csvRows) expect(r[colCharge], 'export filtrado só com comunitários').toBe('Comunitário');
    const ptBrNumber = (s: string | undefined) => Number((s ?? '').replace(',', '.'));
    const actionRow = csvRows.find((r) => Math.abs(ptBrNumber(r[colRealCost]) - cc!.realCost) < 0.005);
    expect(actionRow, 'linha da ação no export com o custo real da aba').toBeTruthy();
    expect(ptBrNumber(actionRow![colReference]), 'valor de referência no export = o da aba').toBeCloseTo(
      cc!.referenceValue,
      2,
    );

    // §5 back 4 — o card do painel financeiro: quantidade e custo do mês.
    const dashboard = await getFinancialDashboard(authApi);
    expect(dashboard.communityThisMonth, 'bloco do mês para quem vê margem').toBeTruthy();
    expect(dashboard.communityThisMonth!.count).toBe(1);
    expect(dashboard.communityThisMonth!.realCostTotal).toBeCloseTo(cc!.realCost, 2);

    await authPage.goto('/app/dashboard/financial');
    await expectMoney(authPage.getByTestId('kpi-community-real-cost'), cc!.realCost, 'custo no card');
    await expect(authPage.getByTestId('kpi-community-count')).toContainText('1 ação');
    await authPage.getByTestId('kpi-community-report-link').click();
    await authPage.waitForURL(/\/app\/finance\/reports\?.*chargeMode=Community/);
    await expectMoney(authPage.getByTestId('summary-community-realCost'), cc!.realCost, 'o mesmo número no relatório');
    await expect(authPage.getByTestId('summary-community-reference')).toContainText('1 ação');
  });

  test('E12 @flow sem pricing.viewmargin a tela não mostra "Custo da ação" nem o card do painel, e o relatório mostra o investimento; o custo de outro tenant nunca entra no KPI', async ({
    authPage,
    authApi,
  }) => {
    test.setTimeout(240_000);
    await apiCompleteOnboarding(authApi);
    const today = tenantDay(0);
    const month = tenantMonth();

    // A: uma ação do mês, com despesa.
    const mine = await setupCommunityAction(authApi);
    await apiPatchEvent(authApi, mine.eventId, { eventDate: today });
    await addEventExpense(authApi, mine.eventId, 70, 'Lanche');
    const myCost = (await getProfitability(authApi, mine.eventId)).communityCost!.realCost;

    // B: outra empresa, ação do mesmo mês com custo bem maior.
    const other = await signupNewTenant();
    const otherApi = await createBearerApiContext(other.accessToken);
    try {
      const theirs = await setupCommunityAction(otherApi);
      await apiPatchEvent(otherApi, theirs.eventId, { eventDate: today });
      await addEventExpense(otherApi, theirs.eventId, 999, 'Transporte');
    } finally {
      await otherApi.dispose();
    }

    // O KPI de A não soma o custo de B (relatório e painel).
    const report = await getReport(authApi, { fromDate: month.from, toDate: month.to });
    expect(report.summary.community!.count).toBe(1);
    expect(report.summary.community!.realCostTotal, 'só o custo de A').toBeCloseTo(myCost, 2);
    const dashboard = await getFinancialDashboard(authApi);
    expect(dashboard.communityThisMonth!.count).toBe(1);
    expect(dashboard.communityThisMonth!.realCostTotal).toBeCloseTo(myCost, 2);

    // A tela de quem tem `dashboard.read` e `reports.read` sem `pricing.viewmargin`.
    await withoutPermissions(authPage, ['pricing.viewmargin']);

    await authPage.goto(`/app/events/${mine.eventId}`);
    await expect(authPage.getByTestId('event-detail-community')).toBeVisible();
    await expect(tab(authPage, 'Visão geral')).toBeVisible();
    await expect(tab(authPage, 'Custo da ação'), 'sem a aba do custo').toHaveCount(0);
    await expect(tab(authPage, 'Rentabilidade')).toHaveCount(0);

    await authPage.goto('/app/dashboard/financial');
    await expect(authPage.getByTestId('financial-kpi-cards'), 'o painel abre').toBeVisible();
    await expect(authPage.getByTestId('kpi-community-month'), 'sem o card comunitário').toHaveCount(0);

    await authPage.goto(`/app/finance/reports?chargeMode=Community&fromDate=${month.from}&toDate=${month.to}`);
    await expectMoney(authPage.getByTestId('summary-community-realCost'), myCost, 'KPI de investimento com reports.read');
  });

  test.fixme(
    'E12 @flow usuário REAL sem pricing.viewmargin: 403 em /profitability e painel com o bloco comunitário null',
    async () => {
      // Não montável no e2e: nenhum papel do tenant tem `dashboard.read` e
      // `reports.read` sem `pricing.viewmargin` (Owner, Admin, Manager e
      // Financial têm a permission; `Permissions.ForRole`), e "role
      // customizada" não existe no produto (`Domain/Auth/Role.cs`). Os testes
      // de Api do back cobrem com o `IPermissionService` decorado.
    },
  );
});
