import { readFileSync } from 'node:fs';
import { APIRequestContext, APIResponse, Locator, Page } from '@playwright/test';

import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import { apiCompleteOnboarding, apiCreateCollaborator } from '../../helpers/api-entities';
import {
  apiAssignCollaborator,
  apiCompleteEvent,
  apiConfirmCollaborator,
  apiStartEvent,
  setupCommunityEvent,
} from '../../helpers/api-event-flow';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';
import {
  MonthlyExpenseReport,
  MonthlyExpenseRow,
  acceptedParty,
  addCompanyExpense,
  addEventExpense,
  damagedRental,
  dayOf,
  expectMoney,
  lastDayOf,
  monthlyReport,
  openMonthlyReport,
  tenantMonth,
  valueByLabel,
  withoutPermissions,
  xlsxSheet,
} from '../../helpers/monthly-expenses';
import { tenantDayPlus, uniqueSuffix } from '../../helpers/rain-plan';
import {
  apiGetDamageReport,
  markDamageRepaired,
  resolveDamageReport,
  startDamageRepair,
} from '../../helpers/rental-preparation';
import { apiErrorCodes, assertOk, readJson } from '../../helpers/response';
import { setupPaidEvent, setupPortalUser } from '../../helpers/setup-flows';

/**
 * Fluxo: fluxos-completos/25 — Custos repassados no evento e relatório "Despesas do mês"
 * Diagrama: — (cenários E1, E2, E3, E4, E5, E7 (caso novo), E9, E10, E12, E13,
 * E14, E15 e E16 do registro e2e de `docs/implementar/PLANO-CUSTOS-REPASSADOS-E-DESPESAS-DO-MES.md`)
 *
 * Fonte do comportamento: o plano, §2 (definições; R1 comunitário, R2 cancelado,
 * R5 avarias fora da fórmula, R6 competência, R9 concluída sem despesa), §3
 * (fatia A: card "Custos do evento" e a faixa da aba Despesas, A2), §4 (fatia B:
 * `GET /api/reports/expenses`, tela `/app/finance/reports/expenses`, KPIs,
 * filtro rápido, alertas, deep links), §5 (fatia C: bloco "Avarias e perdas" e
 * exportação) e as decisões D3, D4, D5, D7 e D8. O spec afirma o plano;
 * divergência é falha de código, não de asserção.
 *
 * Os cenários usam o mês SEGUINTE ao corrente do tenant (`TARGET`): cada teste
 * tem tenant próprio, então o mês só tem o que o teste criou, e a festa nasce
 * pelo orçamento sem mover data. O mês anterior a ele é o corrente.
 *
 * [DECISAO] "Usuário sem a permission de verdade" (E2, E14): nenhum papel do
 * tenant (Owner, Admin, Manager, Financial) fica sem `pricing.viewmargin` ou
 * `reports.read` (D3; `Permissions.ForRole`), e "role customizada" não existe
 * (`Domain/Auth/Role.cs`). O 403 do BACK é provado com o usuário real do Portal
 * do colaborador (`setupPortalUser`), que não tem nenhuma das duas; a TELA
 * recebe a lista de permissions do gestor sem o código (molde do E12 do
 * `fluxos-completos/11`), porque o usuário do Portal não abre o app do tenant.
 */

/** O mês dos cenários: o seguinte ao corrente do tenant. */
const TARGET = () => tenantMonth(1);
/** O mês anterior ao `TARGET`: o corrente. */
const PREVIOUS = () => tenantMonth(0);

/** Aba do detalhe pelo rótulo (o `data-testid` do `<mat-tab>` não chega ao cabeçalho). */
function tab(page: Page, name: string): Locator {
  return page.getByRole('tab', { name, exact: true });
}

// ─────────────────────────── contratos lidos ───────────────────────────

interface EventAdditionalCosts {
  eventId: string;
  chargeMode: string;
  isCanceled: boolean;
  passThroughTotal: number;
  absorbedTotal: number;
  unresolvedCount: number;
  lines: Array<{
    name: string;
    kind: string;
    amount: number | null;
    passThroughToClient: boolean;
    effectivePassThrough: boolean;
  }>;
}

interface EventExpenseSummary {
  totalExpenses: number;
  passThroughTotal: number;
  companyCoveredTotal: number;
}

// ─────────────────────────── pré-condições pela API ───────────────────────────

async function cancelEvent(api: APIRequestContext, eventId: string): Promise<void> {
  await assertOk(await api.post(`/api/events/${eventId}/cancel`, { data: { reason: 'Cancelada pelo cliente (E2E)' } }), 'cancel');
}

/** Líder escalado e confirmado, festa iniciada e concluída pela máquina de estados. */
async function completeWithLeader(api: APIRequestContext, eventId: string): Promise<void> {
  const leader = await apiCreateCollaborator(api);
  await apiAssignCollaborator(api, eventId, leader.id, { isLeader: true });
  await apiConfirmCollaborator(api, eventId, leader.id);
  await apiStartEvent(api, eventId);
  await apiCompleteEvent(api, eventId);
}

/** "Bloqueio de agenda" concluído direto (registro operacional: Scheduled -> Completed). */
async function completedScheduleBlock(api: APIRequestContext, eventDate: string): Promise<string> {
  const res = await api.post('/api/events/operational', {
    data: { kind: 'ScheduleBlock', eventDate, startTime: '08:00', endTime: '12:00', location: 'Manutenção E2E', childrenCount: 0 },
  });
  await assertOk(res, 'POST /api/events/operational');
  const id = (await readJson<{ id: string }>(res)).id;
  await apiCompleteEvent(api, id);
  return id;
}

function getAdditionalCosts(api: APIRequestContext, eventId: string): Promise<APIResponse> {
  return api.get(`/api/events/${eventId}/additional-costs`);
}

async function additionalCosts(api: APIRequestContext, eventId: string): Promise<EventAdditionalCosts> {
  const res = await getAdditionalCosts(api, eventId);
  await assertOk(res, 'GET /api/events/{id}/additional-costs');
  return readJson<EventAdditionalCosts>(res);
}

async function expenseSummary(api: APIRequestContext, eventId: string): Promise<EventExpenseSummary> {
  const res = await api.get(`/api/events/${eventId}/expenses`);
  await assertOk(res, 'GET /api/events/{id}/expenses');
  return readJson<EventExpenseSummary>(res);
}

function rowOf(report: MonthlyExpenseReport, eventId: string): MonthlyExpenseRow {
  const row = report.events.find((e) => e.eventId === eventId);
  expect(row, `linha do evento ${eventId} no relatório`).toBeTruthy();
  return row!;
}

// ─────────────────────────── tela ───────────────────────────

/** O card "Custos do evento" da Visão geral, depois de carregado. */
async function openEventCostsCard(page: Page, eventId: string): Promise<Locator> {
  await page.goto(`/app/events/${eventId}`);
  await expect(page.getByTestId('event-detail-title')).toBeVisible({ timeout: 30_000 });
  const card = page.getByTestId('event-costs-card');
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.getByTestId('event-costs-loading')).toHaveCount(0, { timeout: 30_000 });
  return card;
}

/** A linha do card pelo nome (a ordem da lista é do back). */
function costLine(card: Locator, name: string): Locator {
  return card.getByTestId('event-costs-lines').locator('li', { hasText: name });
}

function lineChip(line: Locator): Locator {
  return line.locator('[data-testid^="event-costs-line-chip-"]');
}

function lineNote(line: Locator): Locator {
  return line.locator('[data-testid^="event-costs-line-note-"]');
}

/** A aba Despesas do detalhe, com a faixa de resumo carregada. */
async function openExpensesTab(page: Page, eventId: string): Promise<void> {
  await page.goto(`/app/events/${eventId}`);
  await tab(page, 'Despesas').click({ timeout: 30_000 });
  await expect(page.getByTestId('expense-tab-summary')).toBeVisible({ timeout: 30_000 });
}

/** Abre o grupo do menu lateral (molde do `7.4`): o submenu fechado continua no DOM. */
async function openNavGroup(page: Page, group: string, witnessRoute: string): Promise<void> {
  const groupItem = page.getByTestId(`nav-group-${group}`);
  if (!/\bopen\b/.test((await groupItem.getAttribute('class')) ?? '')) {
    await page.getByTestId(`nav-group-toggle-${group}`).click();
  }
  await expect(groupItem).toHaveClass(/\bopen\b/);
  await expect(groupItem.getByTestId(`nav-sub-${witnessRoute}`)).toBeVisible();
}

// ═════════════════════════════ cenários ═════════════════════════════

test.describe('Fluxo completo 25 — Custos repassados no evento e "Despesas do mês"', () => {
  test.beforeEach(async ({ authApi }) => {
    await apiCompleteOnboarding(authApi);
  });

  // ─── Fatia A ───

  test.describe('E1 — card "Custos do evento" e faixa da aba Despesas', () => {
    test('@flow E1: an accepted budget with one pass-through line and one absorbed line shows both with the right chip, and the Expenses tab subtracts the pass-through from the company-covered total', async ({
      authApi,
      authPage,
    }) => {
      test.setTimeout(240_000);
      const passed = `Presente da aniversariante E2E ${uniqueSuffix()}`;
      const absorbed = `Manutenção de materiais E2E ${uniqueSuffix()}`;
      const eventId = await acceptedParty(authApi, dayOf(TARGET(), 10), [
        { name: passed, amount: 50, passThroughToClient: true },
        { name: absorbed, amount: 40, passThroughToClient: false },
      ]);
      await addEventExpense(authApi, eventId, 200, 'Transporte', dayOf(TARGET(), 10));

      // §3 Back 2 — o endpoint com a marca gravada e a efetiva.
      const costs = await additionalCosts(authApi, eventId);
      expect(costs.isCanceled).toBe(false);
      expect(costs.passThroughTotal).toBeCloseTo(50, 2);
      expect(costs.absorbedTotal).toBeCloseTo(40, 2);
      expect(costs.lines).toHaveLength(2);
      const passedLine = costs.lines.find((l) => l.name === passed)!;
      const absorbedLine = costs.lines.find((l) => l.name === absorbed)!;
      expect(passedLine.effectivePassThrough).toBe(true);
      expect(absorbedLine.effectivePassThrough).toBe(false);

      // §3 Front 1 — o card na Visão geral.
      const card = await openEventCostsCard(authPage, eventId);
      await expectMoney(card.getByTestId('event-costs-pass-through'), 50, 'Repassado ao cliente');
      await expect(card.getByTestId('event-costs-pass-through')).toContainText('1 item');
      await expectMoney(card.getByTestId('event-costs-company'), 40, 'Por conta da empresa');
      await expect(lineChip(costLine(card, passed))).toHaveText('Repassado ao cliente');
      await expect(lineChip(costLine(card, absorbed))).toHaveText('Por conta da empresa');
      await expect(card.getByTestId('event-costs-help')).toContainText(
        'Repassado = já embutido no total cobrado; na proposta o cliente vê só o total.',
      );
      await expect(card.getByTestId('event-costs-all-company'), 'há linha repassada').toHaveCount(0);

      // §3 Back 3 / Front 2 — a aba Despesas desconta o repasse do custeado.
      const summary = await expenseSummary(authApi, eventId);
      expect(summary.totalExpenses).toBeCloseTo(200, 2);
      expect(summary.passThroughTotal).toBeCloseTo(50, 2);
      expect(summary.companyCoveredTotal).toBeCloseTo(150, 2);
      await openExpensesTab(authPage, eventId);
      await expectMoney(authPage.getByTestId('expense-tab-coverage-expenses'), 200, 'Despesas lançadas');
      await expectMoney(authPage.getByTestId('expense-tab-coverage-pass-through'), 50, 'Repassado ao cliente');
      await expectMoney(authPage.getByTestId('expense-tab-coverage-company'), 150, 'Custeado pela empresa');
      await expect(authPage.getByTestId('expense-tab-pass-through-warning'), 'repasse menor que o lançado').toHaveCount(0);
    });
  });

  test.describe('E2 — card e endpoint atrás de pricing.viewmargin', () => {
    test('@flow E2: without pricing.viewmargin the screen hides the card, and a real user without the permission gets 403 from the endpoint', async ({
      authApi,
      authPage,
      tenant,
    }) => {
      test.setTimeout(240_000);
      const eventId = await acceptedParty(authApi, dayOf(TARGET(), 10), [
        { name: `Presente E2E ${uniqueSuffix()}`, amount: 50, passThroughToClient: true },
      ]);

      // Controle: o gestor com a permission vê o card.
      await openEventCostsCard(authPage, eventId);

      // D4 — a tela de quem não tem `pricing.viewmargin`.
      await withoutPermissions(authPage, ['pricing.viewmargin']);
      await authPage.goto(`/app/events/${eventId}`);
      await expect(authPage.getByTestId('event-detail-title')).toBeVisible({ timeout: 30_000 });
      await expect(tab(authPage, 'Visão geral')).toBeVisible();
      await expect(authPage.getByTestId('event-costs-card'), 'sem o card').toHaveCount(0);
      await expect(authPage.getByTestId('event-costs-panel')).toHaveCount(0);

      // §3 Back 2 — o endpoint com um usuário real sem a permission.
      const portal = await setupPortalUser(authApi, tenant.tenantId);
      try {
        const denied = await getAdditionalCosts(portal.portalApi, eventId);
        expect(denied.status(), 'GET additional-costs sem pricing.viewmargin').toBe(403);
        expect(await apiErrorCodes(denied)).toContain('Auth.PermissionDenied');
      } finally {
        await portal.portalApi.dispose();
      }
    });
  });

  test.describe('E9 — isolamento dos custos do evento (A2)', () => {
    test('@flow E9: the event of another tenant answers 404 Event.NotFound, and none of its lines reach the card or the Expenses tab summary', async ({
      authApi,
      authPage,
    }) => {
      test.setTimeout(300_000);
      const mineName = `Presente A E2E ${uniqueSuffix()}`;
      const mine = await acceptedParty(authApi, dayOf(TARGET(), 10), [{ name: mineName, amount: 50, passThroughToClient: true }]);
      await addEventExpense(authApi, mine, 100, 'Lanche', dayOf(TARGET(), 10));

      const theirsName = `Presente B E2E ${uniqueSuffix()}`;
      const other = await signupNewTenant();
      const otherApi = await createBearerApiContext(other.accessToken);
      let theirs = '';
      try {
        theirs = await acceptedParty(otherApi, dayOf(TARGET(), 10), [{ name: theirsName, amount: 999, passThroughToClient: true }]);
        await addEventExpense(otherApi, theirs, 777, 'Transporte', dayOf(TARGET(), 10));
      } finally {
        await otherApi.dispose();
      }

      // A2 — o evento de B pela sessão de A.
      const cross = await getAdditionalCosts(authApi, theirs);
      expect(cross.status(), 'additional-costs de outro tenant').toBe(404);
      expect(await apiErrorCodes(cross)).toContain('Event.NotFound');

      // O evento de A só com o que é dele.
      const costs = await additionalCosts(authApi, mine);
      expect(costs.lines.map((l) => l.name)).toEqual([mineName]);
      expect(costs.passThroughTotal).toBeCloseTo(50, 2);
      const summary = await expenseSummary(authApi, mine);
      expect(summary.passThroughTotal).toBeCloseTo(50, 2);
      expect(summary.totalExpenses).toBeCloseTo(100, 2);

      const card = await openEventCostsCard(authPage, mine);
      await expect(card.getByTestId('event-costs-lines').locator('li')).toHaveCount(1);
      await expect(card, 'nenhuma linha de B').not.toContainText(theirsName);
      await expectMoney(card.getByTestId('event-costs-pass-through'), 50, 'repasse só de A');

      await openExpensesTab(authPage, mine);
      await expectMoney(authPage.getByTestId('expense-tab-coverage-pass-through'), 50, 'repasse só de A na faixa');
      await expectMoney(authPage.getByTestId('expense-tab-coverage-expenses'), 100, 'despesas só de A na faixa');
    });
  });

  test.describe('E10 — evento cancelado com linha repassada (R2)', () => {
    test('@flow E10: canceling the event with a pass-through line shows "Evento cancelado: o repasse não foi cobrado", moves the line to "Por conta da empresa", and the Expenses tab shows zero passed through and everything booked as company-covered', async ({
      authApi,
      authPage,
    }) => {
      test.setTimeout(240_000);
      const name = `Presente E2E ${uniqueSuffix()}`;
      const eventId = await acceptedParty(authApi, dayOf(TARGET(), 12), [{ name, amount: 50, passThroughToClient: true }]);
      await addEventExpense(authApi, eventId, 120, 'Transporte', dayOf(TARGET(), 12));
      await cancelEvent(authApi, eventId);

      const costs = await additionalCosts(authApi, eventId);
      expect(costs.isCanceled).toBe(true);
      expect(costs.passThroughTotal, 'R2: repasse zero').toBeCloseTo(0, 2);
      expect(costs.absorbedTotal).toBeCloseTo(50, 2);
      expect(costs.lines[0]!.passThroughToClient, 'a marca gravada fica').toBe(true);
      expect(costs.lines[0]!.effectivePassThrough, 'a marca efetiva cai').toBe(false);

      const card = await openEventCostsCard(authPage, eventId);
      await expect(card.getByTestId('event-costs-canceled')).toHaveText('Evento cancelado: o repasse não foi cobrado');
      await expect(lineChip(costLine(card, name))).toHaveText('Por conta da empresa');
      await expectMoney(card.getByTestId('event-costs-company'), 50, 'a linha em "Por conta da empresa"');
      await expectMoney(card.getByTestId('event-costs-pass-through'), 0, 'nada repassado');

      const summary = await expenseSummary(authApi, eventId);
      expect(summary.passThroughTotal).toBeCloseTo(0, 2);
      expect(summary.companyCoveredTotal).toBeCloseTo(120, 2);
      await openExpensesTab(authPage, eventId);
      await expectMoney(authPage.getByTestId('expense-tab-coverage-pass-through'), 0, 'repassado zero');
      await expectMoney(authPage.getByTestId('expense-tab-coverage-company'), 120, 'todo o lançado como custeado');
    });
  });

  test.describe('E3 — ação comunitária com linha marcada "repassar" (R1)', () => {
    test('@flow E3: on a community action the line marked "repassar" in the budget is not passed through: the card says every cost is the company\'s, the line chip is "Por conta da empresa" with the note "Marcado no orçamento, ignorado na ação comunitária"', async ({
      authApi,
      authPage,
    }) => {
      test.setTimeout(240_000);
      const marked = `Brinde E2E ${uniqueSuffix()}`;
      const { eventId } = await setupCommunityEvent(authApi, {
        eventDate: dayOf(TARGET(), 12),
        additionalCostLines: [{ name: marked, amount: 30, passThroughToClient: true }],
      });

      // §3 Back 2 — a marca gravada fica; a efetiva cai (R1).
      const costs = await additionalCosts(authApi, eventId);
      expect(costs.chargeMode).toBe('Community');
      expect(costs.isCanceled).toBe(false);
      expect(costs.passThroughTotal, 'R1: nada repassado').toBeCloseTo(0, 2);
      expect(costs.absorbedTotal, 'a linha marcada fica por conta da empresa').toBeCloseTo(30, 2);
      expect(costs.lines).toHaveLength(1);
      expect(costs.lines[0]!.passThroughToClient, 'a marca do orçamento fica gravada').toBe(true);
      expect(costs.lines[0]!.effectivePassThrough, 'a marca efetiva cai na ação comunitária').toBe(false);

      // §3 Front 1 — o card da Visão geral.
      const card = await openEventCostsCard(authPage, eventId);
      await expect(card.getByTestId('event-costs-community')).toHaveText('Ação comunitária: todos os custos são da empresa');
      const line = costLine(card, marked);
      await expect(lineChip(line)).toHaveText('Por conta da empresa');
      await expect(lineNote(line)).toHaveText('Marcado no orçamento, ignorado na ação comunitária');
      await expectMoney(card.getByTestId('event-costs-company'), 30, 'a linha marcada em "Por conta da empresa"');
      await expectMoney(card.getByTestId('event-costs-pass-through'), 0, 'nada repassado');
      await expect(card.getByTestId('event-costs-canceled'), 'não é cancelamento').toHaveCount(0);
    });
  });

  // ─── Fatia B ───

  test.describe('E4 — os quatro KPIs do mês', () => {
    test('@flow E4: event expense + company expense + pass-through in the month: the four KPIs add up, and the party without pass-through shows under "Só por conta da empresa"', async ({
      authApi,
      authPage,
    }) => {
      test.setTimeout(300_000);
      const month = TARGET();
      const withPassThrough = await acceptedParty(authApi, dayOf(month, 10), [
        { name: `Presente E2E ${uniqueSuffix()}`, amount: 50, passThroughToClient: true },
        { name: `Manutenção E2E ${uniqueSuffix()}`, amount: 40, passThroughToClient: false },
      ]);
      await addEventExpense(authApi, withPassThrough, 200, 'Transporte', dayOf(month, 10));
      const companyOnly = await acceptedParty(authApi, dayOf(month, 15));
      await addEventExpense(authApi, companyOnly, 80, 'Lanche', dayOf(month, 15));
      await addCompanyExpense(authApi, 300, 'Aluguel', dayOf(month, 5));

      // §2 — custo real 580 (festas 280 + empresa 300), repasse 50, custeado 530, 8,6% recuperado.
      const report = await monthlyReport(authApi, month);
      expect(report.month).toBe(month);
      expect(report.summary.realCost).toBeCloseTo(580, 2);
      expect(report.summary.eventExpenses).toBeCloseTo(280, 2);
      expect(report.summary.companyExpenses).toBeCloseTo(300, 2);
      expect(report.summary.passedThrough).toBeCloseTo(50, 2);
      expect(report.summary.companyCovered).toBeCloseTo(530, 2);
      expect(report.summary.recoveredPercent).toBeCloseTo(8.6, 1);
      expect(report.summary.plannedAbsorbed, 'previsto absorvido informativo').toBeCloseTo(40, 2);
      const a = rowOf(report, withPassThrough);
      expect(a.expenses).toBeCloseTo(200, 2);
      expect(a.passedThrough).toBeCloseTo(50, 2);
      expect(a.companyCovered).toBeCloseTo(150, 2);
      const b = rowOf(report, companyOnly);
      expect(b.passedThrough).toBe(0);
      expect(b.companyCovered).toBeCloseTo(80, 2);

      await openMonthlyReport(authPage, month);
      await expectMoney(authPage.getByTestId('kpi-realCost-value'), 580, 'Custo real do mês');
      await expectMoney(authPage.getByTestId('kpi-passedThrough-value'), 50, 'Repassado ao cliente');
      await expectMoney(authPage.getByTestId('kpi-companyCovered-value'), 530, 'Custeado pela empresa');
      await expect(authPage.getByTestId('kpi-recoveredPercent-value')).toHaveText('8,6%');
      await expect(authPage.getByTestId('kpi-realCost-variation'), 'sem base no mês anterior').toContainText('—');

      // Filtro rápido "Só por conta da empresa".
      await expect(authPage.getByTestId(`row-${withPassThrough}`)).toBeVisible();
      await authPage.getByTestId('quick-filter-companyOnly').click();
      await expect(authPage.getByTestId(`row-${companyOnly}`)).toBeVisible();
      await expect(authPage.getByTestId(`row-${withPassThrough}`), 'a festa com repasse sai do filtro').toHaveCount(0);
    });
  });

  test.describe('E5 — isolamento do relatório', () => {
    test('@flow E5: expenses and events of another tenant never enter the report', async ({ authApi, authPage }) => {
      test.setTimeout(300_000);
      const month = TARGET();
      const mine = await acceptedParty(authApi, dayOf(month, 10), [
        { name: `Presente E2E ${uniqueSuffix()}`, amount: 30, passThroughToClient: true },
      ]);
      await addEventExpense(authApi, mine, 100, 'Lanche', dayOf(month, 10));
      await addCompanyExpense(authApi, 200, 'Aluguel', dayOf(month, 5));

      const other = await signupNewTenant();
      const otherApi = await createBearerApiContext(other.accessToken);
      let theirs = '';
      try {
        theirs = await acceptedParty(otherApi, dayOf(month, 10), [
          { name: `Presente B E2E ${uniqueSuffix()}`, amount: 500, passThroughToClient: true },
        ]);
        await addEventExpense(otherApi, theirs, 999, 'Transporte', dayOf(month, 10));
        await addCompanyExpense(otherApi, 777, 'Aluguel', dayOf(month, 5));
        // B vê o dele: prova que o dado existe no mesmo mês.
        expect((await monthlyReport(otherApi, month)).summary.realCost).toBeCloseTo(999 + 777, 2);
      } finally {
        await otherApi.dispose();
      }

      const report = await monthlyReport(authApi, month);
      expect(report.events.map((e) => e.eventId)).toEqual([mine]);
      expect(report.summary.realCost, 'só o custo de A').toBeCloseTo(300, 2);
      expect(report.summary.companyExpenses).toBeCloseTo(200, 2);
      expect(report.summary.passedThrough, 'só o repasse de A').toBeCloseTo(30, 2);

      await openMonthlyReport(authPage, month);
      await expectMoney(authPage.getByTestId('kpi-realCost-value'), 300, 'KPI só com A');
      await expect(authPage.getByTestId(`row-${mine}`)).toBeVisible();
      await expect(authPage.getByTestId(`row-${theirs}`), 'nenhuma linha de B').toHaveCount(0);
    });
  });

  test.describe('E12 — ação comunitária e evento cancelado no mês (R1, R2, D7, D8)', () => {
    test('@flow E12: community action and canceled event: their expenses enter the real cost, the pass-through is zero even with the line marked in the budget, and the rows show "Comunitário" and "Cancelado"', async ({
      authApi,
      authPage,
    }) => {
      test.setTimeout(300_000);
      const month = TARGET();
      const { eventId: community } = await setupCommunityEvent(authApi, {
        eventDate: dayOf(month, 12),
        additionalCostLines: [{ name: `Brinde E2E ${uniqueSuffix()}`, amount: 30, passThroughToClient: true }],
      });
      await addEventExpense(authApi, community, 70, 'Lanche', dayOf(month, 12));
      const canceled = await acceptedParty(authApi, dayOf(month, 14), [
        { name: `Presente E2E ${uniqueSuffix()}`, amount: 50, passThroughToClient: true },
      ]);
      await addEventExpense(authApi, canceled, 90, 'Transporte', dayOf(month, 14));
      await cancelEvent(authApi, canceled);

      const report = await monthlyReport(authApi, month);
      expect(report.summary.realCost, 'as despesas dos dois contam').toBeCloseTo(160, 2);
      expect(report.summary.eventExpenses).toBeCloseTo(160, 2);
      expect(report.summary.passedThrough, 'repasse zero com a marca gravada').toBeCloseTo(0, 2);
      expect(report.summary.companyCovered).toBeCloseTo(160, 2);

      const c = rowOf(report, community);
      expect(c.chargeMode).toBe('Community');
      expect(c.flags).toContain('Community');
      expect(c.expenses).toBeCloseTo(70, 2);
      expect(c.passedThrough).toBe(0);
      expect(c.plannedAbsorbed, 'R1: a linha marcada entra no previsto absorvido').toBeCloseTo(30, 2);
      const x = rowOf(report, canceled);
      expect(x.status).toBe('Canceled');
      expect(x.flags).toContain('Canceled');
      expect(x.expenses).toBeCloseTo(90, 2);
      expect(x.passedThrough).toBe(0);
      expect(x.companyCovered).toBeCloseTo(90, 2);

      await openMonthlyReport(authPage, month);
      await expect(authPage.getByTestId(`row-community-${community}`)).toHaveText('Comunitário');
      await expect(authPage.getByTestId(`row-canceled-${canceled}`)).toHaveText('Cancelado');
      await expectMoney(authPage.getByTestId('kpi-realCost-value'), 160, 'custo real com os dois');
      await expectMoney(authPage.getByTestId('kpi-passedThrough-value'), 0, 'repasse zero');
    });
  });

  test.describe('E13 — competência (R6, D5)', () => {
    test('@flow E13: an event expense dated in another month enters the month of the party; a company expense enters by its own date; the previous month carries the variation', async ({
      authApi,
      authPage,
    }) => {
      test.setTimeout(300_000);
      const month = TARGET();
      const previous = PREVIOUS();

      // A festa do mês, com a despesa lançada no mês anterior.
      const party = await acceptedParty(authApi, dayOf(month, 15));
      await addEventExpense(authApi, party, 100, 'Transporte', dayOf(previous, 1));
      // Empresa: uma no mês, outra no anterior.
      await addCompanyExpense(authApi, 300, 'Aluguel', dayOf(month, 5));
      await addCompanyExpense(authApi, 40, 'Contador', dayOf(previous, 2));
      // A festa do mês anterior (hoje), com despesa lançada no mês seguinte.
      const previousParty = await acceptedParty(authApi, tenantDayPlus(0));
      await addEventExpense(authApi, previousParty, 60, 'Lanche', dayOf(month, 3));

      const report = await monthlyReport(authApi, month);
      expect(report.summary.eventExpenses, 'a despesa segue o mês da festa').toBeCloseTo(100, 2);
      expect(report.summary.companyExpenses, 'a da empresa segue a própria data').toBeCloseTo(300, 2);
      expect(report.summary.realCost).toBeCloseTo(400, 2);
      expect(report.events.map((e) => e.eventId), 'só a festa do mês').toEqual([party]);
      expect(report.summary.previousMonth.realCost, 'mês anterior: 60 da festa + 40 da empresa').toBeCloseTo(100, 2);
      expect(report.summary.previousMonth.recoveredPercent, '% recuperado do mês anterior vem do back').toBe(0);

      const before = await monthlyReport(authApi, previous);
      expect(before.summary.eventExpenses, 'a despesa da festa do mês anterior fica nele').toBeCloseTo(60, 2);
      expect(before.summary.companyExpenses).toBeCloseTo(40, 2);
      expect(before.events.map((e) => e.eventId)).toEqual([previousParty]);

      // A variação contra o mês anterior: 400 contra 100 = +300%, com o sinal da direção.
      await openMonthlyReport(authPage, month);
      await expectMoney(authPage.getByTestId('kpi-realCost-value'), 400, 'custo real do mês');
      await expect(authPage.getByTestId('kpi-realCost-variation')).toContainText('+300,0%');
      // % recuperado 0 contra 0 do mês anterior (o do back): estável, sem sinal.
      const recoveredVariation = authPage.getByTestId('kpi-recoveredPercent-variation');
      await expect(recoveredVariation).toContainText('0,0 p.p.');
      await expect(recoveredVariation, 'estável não leva sinal').not.toContainText(/[+-]0,0 p\.p\./);
      await expectMoney(authPage.getByTestId('money-flow-event-expenses'), 100, 'festas');
      await expectMoney(authPage.getByTestId('money-flow-company-expenses'), 300, 'custo fixo da empresa');
    });
  });

  test.describe('E14 — permissão de verdade (D3) e mês fora da faixa', () => {
    test('@flow E14: without reports.read there is no "Despesas do mês" in the Financeiro menu, the route is barred and the API answers 403; a month out of range answers 400 Reports.InvalidMonth', async ({
      authApi,
      authPage,
      tenant,
    }) => {
      test.setTimeout(240_000);
      const route = '/app/finance/reports/expenses';
      const witness = '/app/finance/company-expenses';

      // Controle: o gestor vê o item.
      await authPage.goto('/app');
      await expect(authPage.getByTestId('home-page')).toBeVisible({ timeout: 30_000 });
      await openNavGroup(authPage, 'Financeiro', witness);
      await expect(authPage.getByTestId('nav-group-Financeiro').getByTestId(`nav-sub-${route}`)).toHaveText(/Despesas do mês/);

      // A tela de quem não tem `reports.read`.
      await withoutPermissions(authPage, ['reports.read']);
      await authPage.goto('/app');
      await expect(authPage.getByTestId('home-page')).toBeVisible({ timeout: 30_000 });
      await openNavGroup(authPage, 'Financeiro', witness);
      await expect(
        authPage.getByTestId('nav-group-Financeiro').getByTestId(`nav-sub-${route}`),
        'sem o item no menu Financeiro',
      ).toHaveCount(0);
      await authPage.goto(`${route}?month=${TARGET()}`);
      await expect(authPage).toHaveURL(/\/auth\/403/, { timeout: 30_000 });
      await expect(authPage.getByTestId('monthly-expenses-page')).toHaveCount(0);

      // O back, com um usuário real sem a permission.
      const portal = await setupPortalUser(authApi, tenant.tenantId);
      try {
        const denied = await portal.portalApi.get(`/api/reports/expenses?month=${TARGET()}`);
        expect(denied.status(), 'GET /api/reports/expenses sem reports.read').toBe(403);
        expect(await apiErrorCodes(denied)).toContain('Auth.PermissionDenied');
      } finally {
        await portal.portalApi.dispose();
      }

      // §4 Back 3 — fora de 2000-01 até 12 meses à frente.
      for (const month of ['1999-12', tenantMonth(13)]) {
        const res = await authApi.get(`/api/reports/expenses?month=${month}`);
        expect(res.status(), `month=${month}`).toBe(400);
        expect(await apiErrorCodes(res)).toContain('Reports.InvalidMonth');
      }
      // O limite de 12 meses à frente ainda vale.
      await assertOk(await authApi.get(`/api/reports/expenses?month=${tenantMonth(12)}`), 'month=+12');
    });
  });

  test.describe('E15 — do relatório para os módulos vizinhos', () => {
    test('@flow E15: the event name opens the detail on the Expenses tab (?tab=expenses), and the "Custo fixo da empresa" card opens "Despesas da empresa" filtered to the month (?from=&to=) with the same total', async ({
      authApi,
      authPage,
    }) => {
      test.setTimeout(300_000);
      const month = TARGET();
      const eventId = await acceptedParty(authApi, dayOf(month, 10));
      await addEventExpense(authApi, eventId, 75, 'Lanche', dayOf(month, 10));
      await addCompanyExpense(authApi, 300, 'Aluguel', dayOf(month, 5));
      await addCompanyExpense(authApi, 120, 'Contador', lastDayOf(month));
      // Fora do mês: não pode entrar no total da lista filtrada.
      await addCompanyExpense(authApi, 999, 'Software', dayOf(PREVIOUS(), 1));

      const report = await monthlyReport(authApi, month);
      expect(report.summary.companyExpenses).toBeCloseTo(420, 2);

      // O nome do evento abre a aba Despesas.
      await openMonthlyReport(authPage, month);
      await authPage.getByTestId(`row-link-${eventId}`).click();
      await expect(authPage).toHaveURL(new RegExp(`/app/events/${eventId}\\?tab=expenses`), { timeout: 30_000 });
      await expect(tab(authPage, 'Despesas')).toHaveAttribute('aria-selected', 'true', { timeout: 30_000 });
      await expectMoney(authPage.getByTestId('expense-tab-total-expenses'), 75, 'a aba Despesas aberta');

      // O card do custo fixo abre a lista da empresa no mês, com o mesmo total.
      await openMonthlyReport(authPage, month);
      await expectMoney(authPage.getByTestId('monthly-expenses-company-total'), 420, 'custo fixo no relatório');
      await authPage.getByTestId('monthly-expenses-company-link').click();
      await expect(authPage).toHaveURL(/\/app\/finance\/company-expenses\?/, { timeout: 30_000 });
      const url = new URL(authPage.url());
      expect(url.searchParams.get('from')).toBe(dayOf(month, 1));
      expect(url.searchParams.get('to')).toBe(lastDayOf(month));
      await expectMoney(authPage.getByTestId('company-expenses-kpi-total'), 420, 'o mesmo total na lista filtrada');
    });
  });

  test.describe('E16 — festa concluída sem despesa (R9)', () => {
    test('@flow E16: a completed commercial party without any expense raises the "festas concluídas sem despesa" alert, the completed schedule block without expense does not, and the alert leads to the filtered table', async ({
      authApi,
      authPage,
    }) => {
      test.setTimeout(300_000);
      const month = TARGET();
      const completed = await acceptedParty(authApi, dayOf(month, 8));
      await completeWithLeader(authApi, completed);
      await completedScheduleBlock(authApi, dayOf(month, 9));
      const withExpense = await acceptedParty(authApi, dayOf(month, 11));
      await addEventExpense(authApi, withExpense, 90, 'Lanche', dayOf(month, 11));

      const report = await monthlyReport(authApi, month);
      expect(report.alerts.completedWithoutExpenseCount, 'só a festa comercial; o bloqueio não').toBe(1);
      expect(rowOf(report, completed).flags).toContain('CompletedWithoutExpense');

      await openMonthlyReport(authPage, month);
      const alert = authPage.getByTestId('alert-completedWithoutExpense');
      await expect(alert).toContainText('1 festa concluída sem nenhuma despesa lançada');
      await expect(authPage.getByTestId(`row-${withExpense}`)).toBeVisible();
      await alert.click();
      await expect(authPage.getByTestId('quick-filter-alert-chip')).toBeVisible();
      await expect(authPage.getByTestId(`row-${completed}`)).toBeVisible();
      await expect(authPage.getByTestId(`row-no-expense-alert-${completed}`)).toBeVisible();
      await expect(authPage.getByTestId(`row-${withExpense}`), 'a tabela filtrada pelo alerta').toHaveCount(0);
    });
  });

  // ─── Fatia C ───

  test.describe('E7 — avaria cobrada e assumida no relatório e na exportação', () => {
    test('@flow E7: a damage charged to the client shows under "cobrado do cliente", the absorbed one as an expense, and the export brings both', async ({
      authApi,
      authPage,
      tenant,
    }) => {
      test.setTimeout(420_000);
      enableFeatureFlagDirect(tenant.tenantId, 'feature_equipment_rental');
      const month = TARGET();
      const date = dayOf(month, 15);
      const paid = await setupPaidEvent(authApi, { budget: { eventDate: date } });
      // Despesa comum no mesmo mês: o relatório nunca está vazio por causa do cenário.
      await addEventExpense(authApi, paid.eventId, 50, 'Lanche', date);

      // Duas unidades avariadas na volta: uma será cobrada, a outra assumida.
      const [toCharge, toAbsorb] = await damagedRental(authApi, {
        clientId: paid.clienteId,
        eventId: paid.eventId,
        deliveryDate: date,
        damaged: ['Damaged', 'Damaged'],
      });

      await assertOk(
        await resolveDamageReport(authApi, toCharge!.id, {
          resolution: 'ChargeClient',
          amount: 180,
          dueOn: tenantDayPlus(25),
          reason: 'Mau uso (E2E)',
        }),
        'resolve ChargeClient',
      );
      await assertOk(await resolveDamageReport(authApi, toAbsorb!.id, { resolution: 'Absorb', reason: 'Desgaste (E2E)' }), 'resolve Absorb');
      await assertOk(await startDamageRepair(authApi, toAbsorb!.id), 'start-repair');
      await assertOk(await markDamageRepaired(authApi, toAbsorb!.id, 120), 'repaired');
      expect((await apiGetDamageReport(authApi, toAbsorb!.id)).expenseId, 'o conserto lança a despesa').toBeTruthy();

      // R5 — a assumida já é despesa do evento (no custo real); a cobrada fica só no bloco.
      const report = await monthlyReport(authApi, month);
      expect(report.summary.eventExpenses, 'lanche 50 + conserto 120').toBeCloseTo(170, 2);
      expect(report.summary.realCost).toBeCloseTo(170, 2);
      const d = report.damagesAndLosses;
      expect(d.damagesCharged).toBeCloseTo(180, 2);
      expect(d.chargedToClient).toBeCloseTo(180, 2);
      expect(d.damagesAbsorbed).toBeCloseTo(120, 2);
      expect(d.absorbedByCompany).toBeCloseTo(120, 2);
      expect(d.damagesPendingCostCount).toBe(0);
      const damageRow = d.events.find((e) => e.eventId === paid.eventId);
      expect(damageRow, 'a linha do evento no bloco').toBeTruthy();
      expect(damageRow!.damagesCharged).toBeCloseTo(180, 2);
      expect(damageRow!.damagesAbsorbed).toBeCloseTo(120, 2);

      // §5 Front 1 — o bloco "Avarias e perdas".
      await openMonthlyReport(authPage, month);
      await expectMoney(authPage.getByTestId('kpi-realCost-value'), 170, 'a assumida no custo real');
      await expect(authPage.getByTestId('monthly-expenses-damages')).toBeVisible();
      await expectMoney(authPage.getByTestId('damages-charged-total'), 180, 'cobrado do cliente');
      await expectMoney(authPage.getByTestId('damages-absorbed-total'), 120, 'assumido pela empresa');
      await expect(authPage.getByTestId(`damages-row-${paid.eventId}`)).toBeVisible();

      // §5 Back 5 / Front 3 — "Exportar" em Excel: a aba "Avarias e perdas" traz as duas.
      // A primeira planilha do processo paga a partida a frio do ClosedXML (as
      // fontes do `AdjustToContents`): medido em 2026-11-21, 6 s na máquina
      // ociosa e 0,3 s na segunda; com a suíte inteira e outro clone na fila
      // passava dos 15 s do padrão. É o único export deste spec.
      const download = authPage.waitForEvent('download', { timeout: 60_000 });
      await authPage.getByTestId('monthly-expenses-export-excel').click();
      const file = await download;
      expect(file.suggestedFilename()).toMatch(/\.xlsx$/);
      const cells = xlsxSheet(readFileSync((await file.path())!), 'Avarias e perdas');
      expect(Number(valueByLabel(cells, 'Cobrado do cliente (avarias + perdas)'))).toBeCloseTo(180, 2);
      expect(Number(valueByLabel(cells, 'Avarias cobradas'))).toBeCloseTo(180, 2);
      expect(Number(valueByLabel(cells, 'Avarias assumidas (já no custo real, como despesa)'))).toBeCloseTo(120, 2);
      expect(Number(valueByLabel(cells, 'Assumido pela empresa (avarias + perdas)'))).toBeCloseTo(120, 2);
      // A linha do evento, logo abaixo do cabeçalho "Data | Evento | Cliente | Avarias cobradas | Avarias assumidas".
      const headerRow = [...cells].find(([ref, text]) => /^A\d+$/.test(ref) && text === 'Data')?.[0].slice(1);
      expect(headerRow, 'cabeçalho da lista por evento').toBeTruthy();
      const eventRow = Number(headerRow) + 1;
      expect(cells.get(`D${headerRow}`)).toBe('Avarias cobradas');
      expect(Number(cells.get(`D${eventRow}`)), 'avaria cobrada na linha do evento').toBeCloseTo(180, 2);
      expect(Number(cells.get(`E${eventRow}`)), 'avaria assumida na linha do evento').toBeCloseTo(120, 2);
    });
  });
});
