import { readFileSync } from 'node:fs';
import { Download, Page } from '@playwright/test';

import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import { apiCompleteOnboarding, apiCreateClient } from '../../helpers/api-entities';
import { apiCreatePublicEvent, setupCommunityEvent } from '../../helpers/api-event-flow';
import { disableFeatureFlagDirect, enableFeatureFlagDirect } from '../../helpers/db-helper';
import {
  MonthlyExpenseReport,
  MonthlyExpenseTrend,
  acceptedParty,
  addCompanyExpense,
  addEventExpense,
  brl,
  damagedRental,
  dayOf,
  expectMoney,
  getMonthlyExport,
  getMonthlyTrend,
  monthlyReport,
  monthlyTrend,
  openMonthlyReport,
  parseCsv,
  tenantMonth,
  valueByLabel,
  withoutPermissions,
  xlsxRows,
  xlsxSheet,
  xlsxSheetNames,
} from '../../helpers/monthly-expenses';
import { tenantDayPlus } from '../../helpers/rain-plan';
import {
  completeEventWithMaterialLoss,
  confirmConsumptionReview,
  markDamageRepaired,
  resolveDamageReport,
  setupReusableMaterialActivity,
  startDamageRepair,
} from '../../helpers/rental-preparation';
import { apiErrorCodes, assertOk } from '../../helpers/response';
import { setupAcceptedEvent, setupPaidEvent, setupPortalUser } from '../../helpers/setup-flows';

/**
 * Fluxo: fluxos-completos/26 — "Despesas do mês": avarias e perdas, tendência de 6 meses e exportação
 * Diagrama: — (cenários E8 e E18 a E22 do registro e2e de
 * `docs/implementar/PLANO-CUSTOS-REPASSADOS-E-DESPESAS-DO-MES.md`)
 *
 * Fonte do comportamento: o plano, §2 (definições; R5 avarias e perdas fora da
 * fórmula, R6 competência, D5) e §5 (fatia C: bloco "Avarias e perdas", Back 1
 * a 3 e Front 1; tendência, Back 4 e Front 2; exportação, Back 5 e Front 3). O
 * spec afirma o plano; divergência é falha de código, não de asserção.
 *
 * Os cenários usam o mês SEGUINTE ao corrente do tenant (`TARGET`), como o
 * `fluxos-completos/25`: cada teste tem tenant próprio, então o mês só tem o
 * que o teste criou, e a festa nasce pelo orçamento sem mover data. A decisão
 * de avaria acontece HOJE (mês corrente, `CURRENT`): a avaria da festa do
 * `TARGET` é, por construção, "decidida em outro mês" (R6, §5 Back 1).
 *
 * [DECISAO] "Tenant sem `feature_equipment_rental`" (E21): avaria só nasce com o
 * add-on ligado (as rotas de locação exigem o add-on), então o cenário cria a
 * avaria com o add-on e o desliga em seguida (`disableFeatureFlagDirect`); o
 * `RentalsEnabled` é lido a cada chamada do relatório (`IEntitlementService`,
 * sem cache).
 */

/** O mês dos cenários: o seguinte ao corrente do tenant. */
const TARGET = () => tenantMonth(1);
/** O mês corrente do tenant: onde cai a decisão de avaria feita hoje. */
const CURRENT = () => tenantMonth(0);

/** Os `n` meses que terminam em `tenantMonth(lastOffset)`, do mais antigo ao mais novo. */
function windowEndingAt(lastOffset: number, n = 6): string[] {
  return Array.from({ length: n }, (_, i) => tenantMonth(lastOffset - (n - 1) + i));
}

/** A linha da tabela acessível do gráfico: Custo real, Custeado, Repassado (nesta ordem). */
async function expectTrendRow(
  page: Page,
  month: string,
  values: { realCost: number; companyCovered: number; passedThrough: number },
): Promise<void> {
  const row = page.getByTestId(`trend-table-row-${month}`);
  const cells = row.locator('td');
  await expect(cells, `três números no mês ${month}`).toHaveCount(3, { timeout: 30_000 });
  await expect(cells.nth(0), `custo real de ${month}`).toHaveText(brl(values.realCost));
  await expect(cells.nth(1), `custeado de ${month}`).toHaveText(brl(values.companyCovered));
  await expect(cells.nth(2), `repassado de ${month}`).toHaveText(brl(values.passedThrough));
}

async function downloadBuffer(page: Page, testId: string): Promise<{ file: Download; content: Buffer }> {
  const download = page.waitForEvent('download');
  await page.getByTestId(testId).click();
  const file = await download;
  return { file, content: readFileSync((await file.path())!) };
}

function dmOf(report: MonthlyExpenseReport) {
  return report.damagesAndLosses;
}

test.describe('Fluxo completo 26 — "Despesas do mês": avarias e perdas, tendência e exportação', () => {
  test.beforeEach(async ({ authApi }) => {
    await apiCompleteOnboarding(authApi);
  });

  // ─── E18 — tendência de 6 meses ───

  test.describe('E18 — tendência de 6 meses (§5 Back 4, Front 2)', () => {
    test('@flow E18: the chart shows the 6 months ending at the selected month, with the same totals as each month report; a month without data shows zero; changing the month changes the series; months out of 1..12 answers 400 Reports.InvalidTrendMonths', async ({
      authApi,
      authPage,
    }) => {
      test.setTimeout(300_000);
      const month = TARGET();

      // TARGET: festa com repasse 50 e despesa 200, empresa 100 -> 300 / 50 / 250.
      const party = await acceptedParty(authApi, dayOf(month, 10), [
        { name: 'Presente E2E', amount: 50, passThroughToClient: true },
      ]);
      await addEventExpense(authApi, party, 200, 'Transporte', dayOf(month, 10));
      await addCompanyExpense(authApi, 100, 'Aluguel', dayOf(month, 5));
      // Meses passados só com despesa da empresa; -4, -2 e o corrente ficam sem nada.
      await addCompanyExpense(authApi, 120, 'Contador', dayOf(tenantMonth(-1), 15));
      await addCompanyExpense(authApi, 80, 'Software', dayOf(tenantMonth(-3), 20));

      const expected: Record<string, { realCost: number; passedThrough: number; companyCovered: number }> = {
        [tenantMonth(-5)]: { realCost: 0, passedThrough: 0, companyCovered: 0 },
        [tenantMonth(-4)]: { realCost: 0, passedThrough: 0, companyCovered: 0 },
        [tenantMonth(-3)]: { realCost: 80, passedThrough: 0, companyCovered: 80 },
        [tenantMonth(-2)]: { realCost: 0, passedThrough: 0, companyCovered: 0 },
        [tenantMonth(-1)]: { realCost: 120, passedThrough: 0, companyCovered: 120 },
        [tenantMonth(0)]: { realCost: 0, passedThrough: 0, companyCovered: 0 },
        [tenantMonth(1)]: { realCost: 300, passedThrough: 50, companyCovered: 250 },
      };

      // §5 Back 4 — os 6 meses que terminam em `month`, do mais antigo ao mais novo, nenhum ausente.
      const window = windowEndingAt(1);
      const trend: MonthlyExpenseTrend = await monthlyTrend(authApi, month, 6);
      expect(trend.months.map((p) => p.month), 'os 6 meses que terminam no mês pedido').toEqual(window);
      for (const point of trend.months) {
        const want = expected[point.month]!;
        expect(point.realCost, `custo real de ${point.month}`).toBeCloseTo(want.realCost, 2);
        expect(point.passedThrough, `repassado de ${point.month}`).toBeCloseTo(want.passedThrough, 2);
        expect(point.companyCovered, `custeado de ${point.month}`).toBeCloseTo(want.companyCovered, 2);
        // Os mesmos totais do relatório de cada mês (mesma composição).
        const report = await monthlyReport(authApi, point.month);
        expect(point.realCost, `tendência = relatório em ${point.month}`).toBeCloseTo(report.summary.realCost, 2);
        expect(point.passedThrough).toBeCloseTo(report.summary.passedThrough, 2);
        expect(point.companyCovered).toBeCloseTo(report.summary.companyCovered, 2);
      }

      // Trocar o mês troca a série: terminando no corrente, o TARGET sai e o -5 entra.
      const previousWindow = windowEndingAt(0);
      const shifted = await monthlyTrend(authApi, CURRENT(), 6);
      expect(shifted.months.map((p) => p.month)).toEqual(previousWindow);
      for (const point of shifted.months) {
        expect(point.realCost, `custo real de ${point.month} na série anterior`).toBeCloseTo(expected[point.month]!.realCost, 2);
      }

      // `months` fora de 1 a 12.
      for (const months of [0, 13]) {
        const res = await getMonthlyTrend(authApi, month, months);
        expect(res.status(), `months=${months}`).toBe(400);
        expect(await apiErrorCodes(res)).toContain('Reports.InvalidTrendMonths');
      }
      expect((await monthlyTrend(authApi, month, 1)).months.map((p) => p.month), 'months=1').toEqual([month]);
      expect((await monthlyTrend(authApi, month, 12)).months.map((p) => p.month), 'months=12').toEqual(windowEndingAt(1, 12));

      // §5 Front 2 — o gráfico segue o mês do seletor.
      await openMonthlyReport(authPage, month);
      const chart = authPage.getByTestId('monthly-expenses-trend');
      await expect(chart).toBeVisible();
      await expect(chart.getByTestId('trend-plot')).toBeVisible({ timeout: 30_000 });
      await expect(chart.locator('[data-testid^="trend-column-"]'), 'seis colunas').toHaveCount(6);
      for (const m of window) {
        await expect(chart.getByTestId(`trend-column-${m}`), `coluna de ${m}, mesmo zerada`).toHaveCount(1);
        await expectTrendRow(authPage, m, expected[m]!);
      }

      await authPage.getByTestId('monthly-expenses-prev').click();
      await expect(authPage).toHaveURL(new RegExp(`month=${CURRENT()}`), { timeout: 30_000 });
      await expect(chart.getByTestId(`trend-column-${tenantMonth(-5)}`), 'o mês que entra').toHaveCount(1, { timeout: 30_000 });
      await expect(chart.getByTestId(`trend-column-${month}`), 'o mês que sai').toHaveCount(0);
      await expect(chart.locator('[data-testid^="trend-column-"]')).toHaveCount(6);
      for (const m of previousWindow) await expectTrendRow(authPage, m, expected[m]!);
    });
  });

  // ─── E19 — exportação ───

  test.describe('E19 — exportação (§5 Back 5, Front 3)', () => {
    test('@flow E19: the month CSV escapes the =1+1 event title and keeps the negative as a number; the Excel brings "Eventos", "Categorias", "Avarias e perdas" and "Resumo" with the same numbers as the screen KPIs; a user without reports.read gets 403 on the export', async ({
      authApi,
      authPage,
      tenant,
    }) => {
      test.setTimeout(300_000);
      enableFeatureFlagDirect(tenant.tenantId, 'feature_ticketing');
      const month = TARGET();

      // Evento público com o título que vira fórmula numa planilha.
      const publicEvent = await apiCreatePublicEvent(authApi, { title: '=1+1', eventDate: dayOf(month, 8) });
      await addEventExpense(authApi, publicEvent.id, 40, 'Lanche', dayOf(month, 8));
      // R7 — repasse 100 maior que a despesa 30: custeado -70.
      const negative = await acceptedParty(authApi, dayOf(month, 12), [
        { name: 'Presente E2E', amount: 100, passThroughToClient: true },
      ]);
      await addEventExpense(authApi, negative, 30, 'Transporte', dayOf(month, 12));
      await addCompanyExpense(authApi, 200, 'Aluguel', dayOf(month, 5));

      const report = await monthlyReport(authApi, month);
      expect(report.summary.realCost).toBeCloseTo(270, 2);
      expect(report.summary.passedThrough).toBeCloseTo(100, 2);
      expect(report.summary.companyCovered).toBeCloseTo(170, 2);
      expect(report.summary.recoveredPercent).toBeCloseTo(37, 0);
      const negativeRow = report.events.find((e) => e.eventId === negative);
      expect(negativeRow?.companyCovered, 'custeado negativo, como é').toBeCloseTo(-70, 2);

      await openMonthlyReport(authPage, month);
      await expectMoney(authPage.getByTestId('kpi-realCost-value'), 270, 'Custo real do mês');
      await expectMoney(authPage.getByTestId('kpi-passedThrough-value'), 100, 'Repassado ao cliente');
      await expectMoney(authPage.getByTestId('kpi-companyCovered-value'), 170, 'Custeado pela empresa');
      await expect(authPage.getByTestId('kpi-recoveredPercent-value')).toHaveText('37,0%');
      await expect(authPage.getByTestId('monthly-expenses-export')).toBeVisible();

      // CSV — uma linha por evento, título escapado, negativo ainda número.
      const csv = await downloadBuffer(authPage, 'monthly-expenses-export-csv');
      expect(csv.file.suggestedFilename()).toMatch(/\.csv$/);
      const csvText = csv.content.toString('utf8');
      const rows = parseCsv(csvText);
      const header = rows[0]!;
      const eventCol = header.indexOf('Evento');
      const coveredCol = header.indexOf('Custeado');
      expect(eventCol, 'coluna Evento no CSV').toBeGreaterThanOrEqual(0);
      expect(coveredCol, 'coluna Custeado no CSV').toBeGreaterThanOrEqual(0);
      expect(rows.length - 1, 'uma linha por evento').toBe(report.events.length);
      const titles = rows.slice(1).map((r) => r[eventCol]);
      expect(titles, 'o título sai escapado').toContain("'=1+1");
      expect(titles, 'nunca como fórmula').not.toContain('=1+1');
      const covered = rows.slice(1).map((r) => r[coveredCol]);
      expect(covered, 'o negativo sai como número, sem apóstrofo').toContain('-70,00');
      expect(csvText).not.toContain("'-70");

      // Excel — as quatro abas, e o "Resumo" com os números dos KPIs da tela.
      const xlsx = await downloadBuffer(authPage, 'monthly-expenses-export-excel');
      expect(xlsx.file.suggestedFilename()).toMatch(/\.xlsx$/);
      expect(xlsxSheetNames(xlsx.content)).toEqual(['Eventos', 'Categorias', 'Avarias e perdas', 'Resumo']);

      const summary = xlsxSheet(xlsx.content, 'Resumo');
      expect(Number(valueByLabel(summary, 'Custo real')), 'Resumo = KPI Custo real').toBeCloseTo(270, 2);
      expect(Number(valueByLabel(summary, 'Repassado ao cliente')), 'Resumo = KPI Repassado').toBeCloseTo(100, 2);
      expect(Number(valueByLabel(summary, 'Custeado pela empresa')), 'Resumo = KPI Custeado').toBeCloseTo(170, 2);
      expect(Number(valueByLabel(summary, 'Recuperado (%)')), 'Resumo = KPI % recuperado').toBeCloseTo(
        report.summary.recoveredPercent!,
        1,
      );
      expect(Number(valueByLabel(summary, 'Despesas de evento'))).toBeCloseTo(report.summary.eventExpenses, 2);
      expect(Number(valueByLabel(summary, 'Despesas da empresa'))).toBeCloseTo(report.summary.companyExpenses, 2);

      const events = xlsxRows(xlsxSheet(xlsx.content, 'Eventos'));
      const eventsHeader = events.get(1)!;
      expect(eventsHeader.get('H'), 'cabeçalho Custeado na coluna H').toBe('Custeado');
      const eventRows = [...events.entries()].filter(([n]) => n > 1).map(([, r]) => r);
      expect(eventRows, 'uma linha por evento').toHaveLength(report.events.length);
      expect(eventRows.map((r) => Number(r.get('H'))), 'o negativo na aba Eventos').toContain(-70);

      const categories = xlsxRows(xlsxSheet(xlsx.content, 'Categorias'));
      for (const c of report.categories) {
        const line = [...categories.values()].find((r) => r.get('A') === c.category);
        expect(line, `categoria ${c.category} na aba`).toBeTruthy();
        expect(Number(line!.get('D')), `total de ${c.category}`).toBeCloseTo(c.total, 2);
      }

      const damages = xlsxSheet(xlsx.content, 'Avarias e perdas');
      expect(Number(valueByLabel(damages, 'Cobrado do cliente (avarias + perdas)'))).toBeCloseTo(
        dmOf(report).chargedToClient,
        2,
      );
      expect(Number(valueByLabel(damages, 'Assumido pela empresa (avarias + perdas)'))).toBeCloseTo(
        dmOf(report).absorbedByCompany,
        2,
      );

      // PDF — o mesmo mês, A4.
      const pdf = await downloadBuffer(authPage, 'monthly-expenses-export-pdf');
      expect(pdf.file.suggestedFilename()).toMatch(/\.pdf$/);
      expect(pdf.content.subarray(0, 4).toString('latin1')).toBe('%PDF');

      // O mesmo export pela API, e o 403 com um usuário real sem `reports.read`.
      const apiCsv = await getMonthlyExport(authApi, month, 'Csv');
      await assertOk(apiCsv, 'GET /api/reports/expenses/export?format=Csv');
      expect(apiCsv.headers()['content-type']).toContain('text/csv');
      const portal = await setupPortalUser(authApi, tenant.tenantId);
      try {
        for (const format of ['Csv', 'Excel', 'Pdf'] as const) {
          const denied = await getMonthlyExport(portal.portalApi, month, format);
          expect(denied.status(), `export ${format} sem reports.read`).toBe(403);
          expect(await apiErrorCodes(denied)).toContain('Auth.PermissionDenied');
        }
      } finally {
        await portal.portalApi.dispose();
      }
    });
  });

  // ─── E20 — regras do bloco "Avarias e perdas" ───

  test.describe('E20 — regras do bloco "Avarias e perdas" (§5 Back 1 a 3, R5)', () => {
    test('@flow E20: a party damage decided in another month shows in the party month; a standalone rental damage decided in the month enters only the total, without a row; an absorbed damage without cost shows "custo a apurar", never R$ 0,00; reusable losses charged and absorbed at the post-party review show in the block; none of it changes the real cost nor the company-covered', async ({
      authApi,
      authPage,
      tenant,
    }) => {
      test.setTimeout(720_000);
      enableFeatureFlagDirect(tenant.tenantId, 'feature_equipment_rental');
      enableFeatureFlagDirect(tenant.tenantId, 'feature_stock');
      const month = TARGET();
      const current = CURRENT();
      const chargedMaterial = await setupReusableMaterialActivity(authApi, { unitCost: 25 });
      const absorbedMaterial = await setupReusableMaterialActivity(authApi, { unitCost: 40 });

      // Festa 1 (TARGET): duas avarias de locação e a perda de 1 cadeirinha (cobrada).
      const p1Date = dayOf(month, 10);
      const p1 = await setupPaidEvent(authApi, { activityIds: [chargedMaterial.activityId], budget: { eventDate: p1Date } });
      await addEventExpense(authApi, p1.eventId, 50, 'Lanche', p1Date);
      const [toCharge, toAbsorb] = await damagedRental(authApi, {
        clientId: p1.clienteId,
        eventId: p1.eventId,
        deliveryDate: p1Date,
        damaged: ['Damaged', 'Damaged'],
      });
      const chargedLoss = await completeEventWithMaterialLoss(authApi, tenant.tenantId, p1.eventId, {
        productId: chargedMaterial.productId,
        extra: 1,
      });

      // Festa 2 (TARGET): a perda de 2 unidades a 40 (assumida).
      const p2Date = dayOf(month, 20);
      const { eventId: p2 } = await setupAcceptedEvent(authApi, {
        activityIds: [absorbedMaterial.activityId],
        budget: { eventDate: p2Date },
      });
      await addEventExpense(authApi, p2, 30, 'Transporte', p2Date);
      const absorbedLoss = await completeEventWithMaterialLoss(authApi, tenant.tenantId, p2, {
        productId: absorbedMaterial.productId,
        extra: 2,
      });

      // Locação avulsa (sem evento), devolvida com avaria.
      const standaloneClient = await apiCreateClient(authApi);
      const [standalone] = await damagedRental(authApi, {
        clientId: standaloneClient.id,
        eventId: null,
        deliveryDate: tenantDayPlus(2),
        damaged: ['Damaged'],
      });

      // Antes das decisões: avaria `Pending` e perda não confirmada ficam fora (§5 Back 1 e 2).
      const before = await monthlyReport(authApi, month);
      expect(before.summary.eventExpenses, 'só as despesas lançadas').toBeCloseTo(80, 2);
      expect(dmOf(before).chargedToClient, 'Pending fica fora').toBe(0);
      expect(dmOf(before).damagesPendingCostCount).toBe(0);

      // As decisões, todas hoje (mês corrente).
      await assertOk(
        await resolveDamageReport(authApi, toCharge!.id, {
          resolution: 'ChargeClient',
          amount: 180,
          dueOn: tenantDayPlus(25),
          reason: 'Mau uso (E2E)',
        }),
        'resolve ChargeClient (festa)',
      );
      await assertOk(
        await resolveDamageReport(authApi, toAbsorb!.id, { resolution: 'Absorb', reason: 'Desgaste (E2E)' }),
        'resolve Absorb sem custo (festa)',
      );
      await assertOk(
        await confirmConsumptionReview(authApi, p1.eventId, [{ recordId: chargedLoss.recordId, lossResolution: 'ChargedToClient' }]),
        'conferência: perda cobrada',
      );
      await assertOk(
        await confirmConsumptionReview(authApi, p2, [{ recordId: absorbedLoss.recordId, lossResolution: 'Absorbed' }]),
        'conferência: perda assumida',
      );
      await assertOk(
        await resolveDamageReport(authApi, standalone!.id, { resolution: 'ChargeClient', amount: 70, reason: 'Avulsa (E2E)' }),
        'resolve ChargeClient (avulsa)',
      );

      // O mês da festa: as avarias decididas hoje entram aqui, pela competência do evento.
      const report = await monthlyReport(authApi, month);
      const d = dmOf(report);
      expect(d.damagesCharged, 'avaria da festa no mês da festa').toBeCloseTo(180, 2);
      expect(d.lossesCharged, 'perda cobrada: 1 x 25').toBeCloseTo(25, 2);
      expect(d.chargedToClient, 'avarias + perdas').toBeCloseTo(205, 2);
      expect(d.damagesAbsorbed, 'assumida sem custo não soma').toBeCloseTo(0, 2);
      expect(d.damagesPendingCostCount, 'assumida sem custo: a apurar').toBe(1);
      expect(d.lossesAbsorbed, 'perda assumida pelo custo de estoque: 2 x 40').toBeCloseTo(80, 2);
      expect(d.lossesWithoutCostCount).toBe(0);
      expect(d.absorbedByCompany).toBeCloseTo(80, 2);
      expect(d.standaloneCharged, 'a avulsa foi decidida em outro mês').toBeCloseTo(0, 2);
      expect(d.events.map((e) => e.eventId).sort()).toEqual([p1.eventId, p2].sort());
      const row1 = d.events.find((e) => e.eventId === p1.eventId)!;
      expect(row1.damagesCharged).toBeCloseTo(180, 2);
      expect(row1.damagesAbsorbed).toBeCloseTo(0, 2);
      expect(row1.damagesPendingCostCount).toBe(1);
      expect(row1.lossesCharged).toBeCloseTo(25, 2);
      const row2 = d.events.find((e) => e.eventId === p2)!;
      expect(row2.lossesAbsorbed).toBeCloseTo(80, 2);

      // R5 — nada disso muda o custo real nem o custeado.
      expect(report.summary.realCost, 'custo real igual ao de antes das decisões').toBeCloseTo(before.summary.realCost, 2);
      expect(report.summary.companyCovered, 'custeado igual ao de antes').toBeCloseTo(before.summary.companyCovered, 2);
      expect(report.summary.realCost).toBeCloseTo(80, 2);

      // O mês corrente: a avulsa entra pelo `ResolvedAt`, só no total; a avaria da festa não.
      const now = await monthlyReport(authApi, current);
      const dn = dmOf(now);
      expect(dn.damagesCharged, 'só a avulsa').toBeCloseTo(70, 2);
      expect(dn.standaloneCharged).toBeCloseTo(70, 2);
      expect(dn.chargedToClient).toBeCloseTo(70, 2);
      expect(dn.events, 'avulsa sem linha').toHaveLength(0);
      expect(now.summary.realCost, 'a avulsa também fica fora do custo real').toBeCloseTo(0, 2);

      // §5 Front 1 — o bloco do mês da festa.
      await openMonthlyReport(authPage, month);
      await expectMoney(authPage.getByTestId('kpi-realCost-value'), 80, 'custo real sem avarias nem perdas');
      await expectMoney(authPage.getByTestId('kpi-companyCovered-value'), 80, 'custeado sem avarias nem perdas');
      const block = authPage.getByTestId('monthly-expenses-damages');
      await expect(block).toBeVisible();
      await expectMoney(block.getByTestId('damages-charged-total'), 205, 'cobrado do cliente');
      await expectMoney(block.getByTestId('damages-absorbed-total'), 80, 'assumido pela empresa');
      await expect(block.getByTestId('damages-absorbed-split'), 'avaria sem custo é texto').toContainText('Avarias custo a apurar');
      await expect(block.getByTestId('damages-pending')).toContainText('1 avaria com custo a apurar');
      const absorbedCell = block.getByTestId(`damages-absorbed-${p1.eventId}`);
      await expect(absorbedCell).toContainText('1 avaria com custo a apurar');
      await expect(absorbedCell, 'nunca R$ 0,00').not.toContainText('R$');
      await expectMoney(block.getByTestId(`losses-absorbed-${p2}`), 80, 'perda assumida na linha da festa 2');
      await expect(block.getByTestId(`damages-row-${p1.eventId}`)).toBeVisible();
      await expect(block.getByTestId(`damages-row-${p2}`)).toBeVisible();
      await expect(block.getByTestId('damages-standalone'), 'a avulsa não é deste mês').toHaveCount(0);

      // O mês corrente: a avulsa só no total, sem linha.
      await openMonthlyReport(authPage, current);
      const currentBlock = authPage.getByTestId('monthly-expenses-damages');
      await expectMoney(currentBlock.getByTestId('damages-charged-total'), 70, 'a avulsa no total');
      await expect(currentBlock.getByTestId('damages-standalone')).toContainText(brl(70));
      await expect(currentBlock.getByTestId('damages-table'), 'sem linha').toHaveCount(0);
    });
  });

  // ─── E8 — avaria de evento comunitário ───

  test.describe('E8 — avaria em ação comunitária (R1, §5 Back 1)', () => {
    test('@flow E8: a damage on a community action shows under "assumido pela empresa" and never under "cobrado": first as "custo a apurar", then with the repair cost; the screen block shows the same numbers', async ({
      authApi,
      authPage,
      tenant,
    }) => {
      test.setTimeout(420_000);
      enableFeatureFlagDirect(tenant.tenantId, 'feature_equipment_rental');
      const month = TARGET();
      const date = dayOf(month, 14);
      const action = await setupCommunityEvent(authApi, { eventDate: date });
      // A volta abre a avaria já assumida (sem cliente para cobrar, `fluxos-completos/19`).
      const [damage] = await damagedRental(authApi, {
        clientId: action.clientId,
        eventId: action.eventId,
        deliveryDate: date,
        damaged: ['Damaged'],
      });
      expect(damage!.eventChargeMode).toBe('Community');
      expect(damage!.resolution, 'nasce assumida').toBe('AbsorbedByCompany');

      // Sem custo ainda: assumida "a apurar", nada cobrado.
      const pending = dmOf(await monthlyReport(authApi, month));
      expect(pending.chargedToClient, 'nunca cobrado').toBe(0);
      expect(pending.damagesCharged).toBe(0);
      expect(pending.damagesAbsorbed, 'sem custo, não soma').toBeCloseTo(0, 2);
      expect(pending.damagesPendingCostCount, 'assumida com custo a apurar').toBe(1);
      const pendingRow = pending.events.find((e) => e.eventId === action.eventId);
      expect(pendingRow, 'a linha da ação no bloco').toBeTruthy();
      expect(pendingRow!.damagesCharged).toBe(0);
      expect(pendingRow!.damagesPendingCostCount).toBe(1);

      await openMonthlyReport(authPage, month);
      const block = authPage.getByTestId('monthly-expenses-damages');
      await expect(block).toBeVisible();
      await expectMoney(block.getByTestId('damages-charged-total'), 0, 'nada cobrado do cliente');
      await expect(block.getByTestId('damages-absorbed-total')).toContainText('Custo a apurar');
      await expect(block.getByTestId('damages-pending')).toContainText('1 avaria com custo a apurar');
      await expect(block.getByTestId(`damages-absorbed-${action.eventId}`)).toContainText('1 avaria com custo a apurar');

      // O conserto lança a despesa da ação: o custo passa a "assumido pela empresa".
      await assertOk(await startDamageRepair(authApi, damage!.id), 'start-repair');
      await assertOk(await markDamageRepaired(authApi, damage!.id, 150), 'repaired');
      const report = await monthlyReport(authApi, month);
      const d = dmOf(report);
      expect(d.damagesAbsorbed, 'o conserto assumido').toBeCloseTo(150, 2);
      expect(d.absorbedByCompany).toBeCloseTo(150, 2);
      expect(d.damagesPendingCostCount).toBe(0);
      expect(d.chargedToClient, 'continua nunca cobrado').toBe(0);
      expect(d.damagesCharged).toBe(0);
      const row = d.events.find((e) => e.eventId === action.eventId)!;
      expect(row.damagesAbsorbed).toBeCloseTo(150, 2);
      expect(row.damagesCharged).toBe(0);
      // R5 — a assumida já é despesa do evento, no custo real.
      expect(report.summary.eventExpenses, 'o conserto como despesa da ação').toBeCloseTo(150, 2);

      await openMonthlyReport(authPage, month);
      await expectMoney(block.getByTestId('damages-absorbed-total'), 150, 'assumido pela empresa');
      await expectMoney(block.getByTestId('damages-charged-total'), 0, 'cobrado do cliente zero');
      await expectMoney(block.getByTestId(`damages-absorbed-${action.eventId}`), 150, 'a linha da ação');
      await expect(block.getByTestId('damages-pending'), 'nada mais a apurar').toHaveCount(0);
    });
  });

  // ─── E21 — link para a lista de avarias ───

  test.describe('E21 — link "Ver avarias do evento" (§5 Front 1)', () => {
    test('@flow E21: with rentals.read and the rental add-on, "Ver avarias do evento" opens the damage list filtered by the event (?eventId=); without rentals.read, or in a tenant without feature_equipment_rental, the block shows without the link', async ({
      authApi,
      authPage,
      tenant,
    }) => {
      test.setTimeout(420_000);
      enableFeatureFlagDirect(tenant.tenantId, 'feature_equipment_rental');
      const month = TARGET();
      const date = dayOf(month, 12);
      const paid = await setupPaidEvent(authApi, { budget: { eventDate: date } });
      const [damage] = await damagedRental(authApi, {
        clientId: paid.clienteId,
        eventId: paid.eventId,
        deliveryDate: date,
        damaged: ['Damaged'],
      });
      await assertOk(
        await resolveDamageReport(authApi, damage!.id, {
          resolution: 'ChargeClient',
          amount: 150,
          dueOn: tenantDayPlus(25),
          reason: 'Mau uso (E2E)',
        }),
        'resolve ChargeClient',
      );
      expect(dmOf(await monthlyReport(authApi, month)).rentalsEnabled, 'add-on ligado').toBe(true);

      // Com `rentals.read` e o add-on: o link leva à lista filtrada pelo evento.
      await openMonthlyReport(authPage, month);
      const link = authPage.getByTestId(`damages-link-${paid.eventId}`);
      await expect(link).toBeVisible({ timeout: 30_000 });
      await expect(link).toContainText('Ver avarias do evento');
      await link.click();
      await expect(authPage).toHaveURL(new RegExp(`/app/rentals/damage-reports\\?(?:.*&)?eventId=${paid.eventId}(?:&|$)`), {
        timeout: 30_000,
      });
      await expect(authPage.getByTestId('damage-reports-list-page')).toBeVisible({ timeout: 30_000 });
      await expect(authPage.getByTestId('damage-reports-scope'), 'o recorte do evento').toBeVisible();
      await expect(authPage.getByTestId(`damage-report-open-${damage!.id}`), 'a avaria do evento na lista').toBeVisible({
        timeout: 30_000,
      });

      // Sem `rentals.read`: o bloco aparece, o link não.
      await withoutPermissions(authPage, ['rentals.read']);
      await openMonthlyReport(authPage, month);
      await expect(authPage.getByTestId(`damages-row-${paid.eventId}`)).toBeVisible({ timeout: 30_000 });
      await expect(authPage.getByTestId(`damages-link-${paid.eventId}`), 'sem rentals.read, sem link').toHaveCount(0);
      await authPage.unroute('**/api/me/permissions');

      // Tenant sem o add-on: o bloco aparece, o link não.
      disableFeatureFlagDirect(tenant.tenantId, 'feature_equipment_rental');
      expect(dmOf(await monthlyReport(authApi, month)).rentalsEnabled, 'add-on desligado').toBe(false);
      await openMonthlyReport(authPage, month);
      await expect(authPage.getByTestId('monthly-expenses-damages')).toBeVisible();
      await expect(authPage.getByTestId(`damages-row-${paid.eventId}`)).toBeVisible({ timeout: 30_000 });
      await expectMoney(authPage.getByTestId('damages-charged-total'), 150, 'o bloco continua com o número');
      await expect(authPage.getByTestId(`damages-link-${paid.eventId}`), 'sem o add-on, sem link').toHaveCount(0);
    });
  });

  // ─── E22 — isolamento ───

  test.describe('E22 — isolamento do bloco e da tendência', () => {
    test('@flow E22: damages, losses and expenses of another tenant never enter the "Avarias e perdas" block nor the trend', async ({
      authApi,
      authPage,
      tenant,
    }) => {
      test.setTimeout(720_000);
      const month = TARGET();
      const before = tenantMonth(-1);

      // Tenant A: uma avaria cobrada na festa, despesa da festa e da empresa.
      enableFeatureFlagDirect(tenant.tenantId, 'feature_equipment_rental');
      const mineDate = dayOf(month, 10);
      const mine = await setupPaidEvent(authApi, { budget: { eventDate: mineDate } });
      await addEventExpense(authApi, mine.eventId, 50, 'Lanche', mineDate);
      await addCompanyExpense(authApi, 60, 'Contador', dayOf(before, 10));
      const [mineDamage] = await damagedRental(authApi, {
        clientId: mine.clienteId,
        eventId: mine.eventId,
        deliveryDate: mineDate,
        damaged: ['Damaged'],
      });
      await assertOk(
        await resolveDamageReport(authApi, mineDamage!.id, {
          resolution: 'ChargeClient',
          amount: 180,
          dueOn: tenantDayPlus(25),
          reason: 'Mau uso A (E2E)',
        }),
        'resolve A',
      );

      // Tenant B, no mesmo mês: avaria, perda e despesas.
      const other = await signupNewTenant();
      const otherApi = await createBearerApiContext(other.accessToken);
      let theirs = '';
      try {
        enableFeatureFlagDirect(other.tenantId, 'feature_equipment_rental');
        enableFeatureFlagDirect(other.tenantId, 'feature_stock');
        const material = await setupReusableMaterialActivity(otherApi, { unitCost: 25 });
        const theirsDate = dayOf(month, 10);
        const paid = await setupPaidEvent(otherApi, { activityIds: [material.activityId], budget: { eventDate: theirsDate } });
        theirs = paid.eventId;
        await addEventExpense(otherApi, theirs, 999, 'Transporte', theirsDate);
        await addCompanyExpense(otherApi, 777, 'Aluguel', dayOf(before, 10));
        const [theirDamage] = await damagedRental(otherApi, {
          clientId: paid.clienteId,
          eventId: theirs,
          deliveryDate: theirsDate,
          damaged: ['Damaged'],
        });
        await assertOk(
          await resolveDamageReport(otherApi, theirDamage!.id, {
            resolution: 'ChargeClient',
            amount: 333,
            dueOn: tenantDayPlus(25),
            reason: 'Mau uso B (E2E)',
          }),
          'resolve B',
        );
        const loss = await completeEventWithMaterialLoss(otherApi, other.tenantId, theirs, {
          productId: material.productId,
          extra: 1,
        });
        await assertOk(
          await confirmConsumptionReview(otherApi, theirs, [{ recordId: loss.recordId, lossResolution: 'ChargedToClient' }]),
          'conferência B: perda cobrada',
        );

        // B vê o dele: prova que o dado existe no mesmo mês.
        const theirsReport = await monthlyReport(otherApi, month);
        expect(dmOf(theirsReport).damagesCharged).toBeCloseTo(333, 2);
        expect(dmOf(theirsReport).lossesCharged).toBeCloseTo(25, 2);
        expect(theirsReport.summary.eventExpenses).toBeGreaterThanOrEqual(999);
        const theirsTrend = await monthlyTrend(otherApi, month, 6);
        expect(theirsTrend.months.find((p) => p.month === before)!.realCost).toBeCloseTo(777, 2);
      } finally {
        await otherApi.dispose();
      }

      // A só com o que é dele: bloco...
      const report = await monthlyReport(authApi, month);
      const d = dmOf(report);
      expect(d.events.map((e) => e.eventId), 'nenhuma linha de B').toEqual([mine.eventId]);
      expect(d.damagesCharged, 'só a avaria de A').toBeCloseTo(180, 2);
      expect(d.chargedToClient).toBeCloseTo(180, 2);
      expect(d.lossesCharged, 'nenhuma perda de B').toBeCloseTo(0, 2);
      expect(d.lossesAbsorbed).toBeCloseTo(0, 2);
      expect(d.standaloneCharged).toBeCloseTo(0, 2);

      // ...e tendência.
      const trend = await monthlyTrend(authApi, month, 6);
      expect(trend.months.find((p) => p.month === month)!.realCost, 'despesa de B fora da tendência').toBeCloseTo(50, 2);
      expect(trend.months.find((p) => p.month === before)!.realCost, 'despesa da empresa de B fora').toBeCloseTo(60, 2);
      for (const p of trend.months.filter((x) => x.month !== month && x.month !== before)) {
        expect(p.realCost, `nada em ${p.month}`).toBe(0);
      }

      await openMonthlyReport(authPage, month);
      const block = authPage.getByTestId('monthly-expenses-damages');
      await expectMoney(block.getByTestId('damages-charged-total'), 180, 'cobrado só de A');
      await expect(block.getByTestId(`damages-row-${mine.eventId}`)).toBeVisible();
      await expect(block.getByTestId(`damages-row-${theirs}`), 'nenhuma linha de B').toHaveCount(0);
      await expectTrendRow(authPage, month, { realCost: 50, companyCovered: 50, passedThrough: 0 });
      await expectTrendRow(authPage, before, { realCost: 60, companyCovered: 60, passedThrough: 0 });
    });
  });
});
