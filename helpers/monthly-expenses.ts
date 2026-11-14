import { APIRequestContext, APIResponse, Locator, Page, Route, expect } from '@playwright/test';

import { readZipEntries } from './binary-files';
import { setupAcceptedEvent } from './setup-flows';
import { AdditionalCostLineInput } from './api-event-flow';
import {
  DamageCondition,
  DamageReport,
  apiCreateEquipmentType,
  apiCreateEquipmentUnit,
  apiCreateRental,
  apiGetRental,
  apiTransitionRental,
  returnRentalWithDamages,
} from './rental-preparation';
import { assertOk, readJson } from './response';
import { uniqueSuffix } from './rain-plan';
import { isoDate, tenantToday } from './week-staffing';

/**
 * Pré-condições, leituras e tela do relatório "Despesas do mês"
 * (`docs/implementar/PLANO-CUSTOS-REPASSADOS-E-DESPESAS-DO-MES.md`, fatias B e C):
 * `GET /api/reports/expenses`, `/trend` e `/export`, e a tela
 * `/app/finance/reports/expenses`. Usado pelos `tests/fluxos-completos/25` e `26`.
 */

// ─────────────────────────── datas e meses ───────────────────────────

/** `yyyy-MM` do mês do tenant deslocado de `offset` meses. */
export function tenantMonth(offset = 0): string {
  const today = tenantToday();
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + offset, 1));
  return isoDate(d).slice(0, 7);
}

/** `yyyy-MM-dd` do dia `day` do mês dado. */
export function dayOf(month: string, day: number): string {
  return `${month}-${String(day).padStart(2, '0')}`;
}

/** Último dia do mês dado (`yyyy-MM-dd`). */
export function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return isoDate(new Date(Date.UTC(y, m, 0)));
}

// ─────────────────────────── dinheiro e texto ───────────────────────────

/** `R$ 1.234,56`, como o `currency: 'BRL'` do front em pt-BR, com espaços normalizados. */
export function brl(value: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })
    .format(value)
    .replace(/\s+/g, ' ');
}

export function norm(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export async function expectMoney(locator: Locator, value: number, message: string): Promise<void> {
  await expect(locator, message).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => norm(await locator.innerText()), { message }).toContain(brl(value));
}

// ─────────────────────────── contratos lidos ───────────────────────────

export interface MonthlyExpenseRow {
  eventId: string;
  eventDate: string;
  title: string | null;
  clientName: string | null;
  status: string;
  chargeMode: string;
  expenses: number;
  passedThrough: number;
  companyCovered: number;
  plannedAbsorbed: number;
  plannedUnresolvedCount: number;
  flags: string[];
}

export interface MonthlyExpenseDamageRow {
  eventId: string;
  eventDate: string;
  title: string | null;
  clientName: string | null;
  damagesCharged: number;
  damagesAbsorbed: number;
  lossesCharged: number;
  lossesAbsorbed: number;
  damagesPendingCostCount: number;
  lossesWithoutCostCount: number;
}

/** `MonthlyExpenseReportDto` (Etapas 322 e 323). */
export interface MonthlyExpenseReport {
  month: string;
  summary: {
    realCost: number;
    eventExpenses: number;
    companyExpenses: number;
    passedThrough: number;
    companyCovered: number;
    recoveredPercent: number | null;
    plannedAbsorbed: number;
    plannedUnresolvedCount: number;
    /** `recoveredPercent` do mês anterior vem do back, arredondado a 1 casa (nulo sem custo real). */
    previousMonth: { realCost: number; passedThrough: number; companyCovered: number; recoveredPercent: number | null };
  };
  events: MonthlyExpenseRow[];
  categories: Array<{ category: string; eventAmount: number; companyAmount: number; total: number }>;
  alerts: { completedWithoutExpenseCount: number; passThroughWithoutExpenseCount: number };
  damagesAndLosses: {
    chargedToClient: number;
    absorbedByCompany: number;
    damagesCharged: number;
    damagesAbsorbed: number;
    lossesCharged: number;
    lossesAbsorbed: number;
    damagesPendingCostCount: number;
    lossesWithoutCostCount: number;
    standaloneCharged: number;
    standaloneAbsorbed: number;
    rentalsEnabled: boolean;
    events: MonthlyExpenseDamageRow[];
  };
}

/** `MonthlyExpenseTrendDto` (Etapa 323): do mês mais antigo para o mais novo. */
export interface MonthlyExpenseTrend {
  months: Array<{ month: string; realCost: number; passedThrough: number; companyCovered: number }>;
}

// ─────────────────────────── pré-condições pela API ───────────────────────────

/** Festa comercial aceita pelo cliente no dia dado, com as linhas de custo adicional do orçamento. */
export async function acceptedParty(
  api: APIRequestContext,
  eventDate: string,
  lines: AdditionalCostLineInput[] = [],
): Promise<string> {
  const { eventId } = await setupAcceptedEvent(api, {
    budget: { eventDate, ...(lines.length > 0 ? { additionalCostLines: lines } : {}) },
  });
  return eventId;
}

export async function addEventExpense(
  api: APIRequestContext,
  eventId: string,
  amount: number,
  category: string,
  date: string,
): Promise<void> {
  const res = await api.post(`/api/events/${eventId}/expenses`, {
    data: { amount, category, date, description: `Despesa ${category} (E2E)` },
  });
  await assertOk(res, 'POST /api/events/{id}/expenses');
}

export async function addCompanyExpense(api: APIRequestContext, amount: number, category: string, date: string): Promise<void> {
  const res = await api.post('/api/expenses', {
    data: { amount, category, date, description: `Despesa da empresa ${category} (E2E)` },
  });
  await assertOk(res, 'POST /api/expenses');
}

/**
 * Locação de um tipo sem preparação, com uma unidade por condição dada, levada
 * de `Reserved` até a volta: a inspeção abre uma avaria por unidade. `eventId`
 * nulo = locação avulsa. As avarias voltam na ordem das condições, ainda
 * `Pending` (exige `feature_equipment_rental` ligado).
 */
export async function damagedRental(
  api: APIRequestContext,
  input: { clientId: string; eventId: string | null; deliveryDate: string; damaged: DamageCondition[] },
): Promise<DamageReport[]> {
  const type = await apiCreateEquipmentType(api, { name: `Pula-pula E2E ${uniqueSuffix()}`, steps: [], requirements: [] });
  const units: Array<{ id: string }> = [];
  for (let i = 0; i < input.damaged.length; i++) units.push(await apiCreateEquipmentUnit(api, type.id));
  const draft = await apiCreateRental(api, {
    clientId: input.clientId,
    eventId: input.eventId,
    deliveryDate: input.deliveryDate,
    unitIds: units.map((u) => u.id),
  });
  await apiTransitionRental(api, draft.id, 'Reserved');
  const rental = await apiGetRental(api, draft.id);
  const reports = await returnRentalWithDamages(
    api,
    rental.id,
    input.damaged.map((condition, i) => ({
      rentalItemId: rental.items.find((it) => it.equipmentUnitId === units[i]!.id)!.id,
      condition,
      notes: `Avaria ${i + 1} na volta (E2E)`,
    })),
  );
  expect(reports, 'uma avaria por unidade avariada').toHaveLength(input.damaged.length);
  return units.map((u) => reports.find((r) => r.equipmentUnitId === u.id)!) as DamageReport[];
}

// ─────────────────────────── leituras ───────────────────────────

export async function monthlyReport(api: APIRequestContext, month: string): Promise<MonthlyExpenseReport> {
  const res = await api.get(`/api/reports/expenses?month=${month}`);
  await assertOk(res, 'GET /api/reports/expenses');
  return readJson<MonthlyExpenseReport>(res);
}

export function getMonthlyTrend(api: APIRequestContext, month: string, months: number | string = 6): Promise<APIResponse> {
  return api.get(`/api/reports/expenses/trend?month=${month}&months=${months}`);
}

export async function monthlyTrend(api: APIRequestContext, month: string, months = 6): Promise<MonthlyExpenseTrend> {
  const res = await getMonthlyTrend(api, month, months);
  await assertOk(res, 'GET /api/reports/expenses/trend');
  return readJson<MonthlyExpenseTrend>(res);
}

export function getMonthlyExport(api: APIRequestContext, month: string, format: 'Csv' | 'Excel' | 'Pdf'): Promise<APIResponse> {
  return api.get(`/api/reports/expenses/export?month=${month}&format=${format}`);
}

// ─────────────────────────── tela ───────────────────────────

/**
 * A tela recebe a lista de permissions do usuário SEM os códigos dados (molde
 * do E12 do `fluxos-completos/11`). O back continua decidindo pelo papel real.
 * Desfazer com `page.unroute('**\/api/me/permissions')`.
 */
export async function withoutPermissions(page: Page, codes: string[]): Promise<void> {
  await page.route('**/api/me/permissions', async (route: Route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { data?: { permissions: string[] }; permissions?: string[] };
    const holder = body.data ?? body;
    holder.permissions = (holder.permissions ?? []).filter((p) => !codes.includes(p));
    await route.fulfill({ response, json: body });
  });
}

export async function openMonthlyReport(page: Page, month: string): Promise<void> {
  await page.goto(`/app/finance/reports/expenses?month=${month}`);
  await expect(page.getByTestId('monthly-expenses-kpis'), 'o relatório carrega').toBeVisible({ timeout: 30_000 });
}

// ─────────────────────────── arquivos exportados ───────────────────────────

function xmlDecode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

/** Textos de todos os `<t>` de um trecho (string compartilhada ou inline, com runs). */
function textRuns(xml: string): string {
  return xmlDecode([...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => m[1]).join(''));
}

/** Nomes das abas da planilha, na ordem do `workbook.xml`. */
export function xlsxSheetNames(xlsx: Buffer): string[] {
  const workbook = readZipEntries(xlsx).get('xl/workbook.xml')?.toString('utf8') ?? '';
  return [...workbook.matchAll(/<(?:\w+:)?sheet\s[^>]*>/g)].map((m) => xmlDecode(/\sname="([^"]*)"/.exec(m[0])?.[1] ?? ''));
}

/** Células de uma aba da planilha pelo nome da aba: referência (`A1`) -> texto. */
export function xlsxSheet(xlsx: Buffer, sheetName: string): Map<string, string> {
  const entries = readZipEntries(xlsx);
  const read = (name: string) => entries.get(name)?.toString('utf8') ?? '';
  const workbook = read('xl/workbook.xml');
  const sheetTag = [...workbook.matchAll(/<(?:\w+:)?sheet\s[^>]*>/g)]
    .map((m) => m[0])
    .find((tag) => xmlDecode(/\sname="([^"]*)"/.exec(tag)?.[1] ?? '') === sheetName);
  expect(sheetTag, `aba "${sheetName}" na planilha`).toBeTruthy();
  const relId = /\s\w+:id="([^"]+)"/.exec(sheetTag!)![1];
  const relTag = [...read('xl/_rels/workbook.xml.rels').matchAll(/<(?:\w+:)?Relationship\s[^>]*>/g)]
    .map((m) => m[0])
    .find((tag) => tag.includes(`Id="${relId}"`))!;
  const target = /Target="([^"]+)"/.exec(relTag)![1]!;
  const sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target}`;

  const shared = [...read('xl/sharedStrings.xml').matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) =>
    textRuns(m[1]!),
  );
  const cells = new Map<string, string>();
  for (const m of read(sheetPath).matchAll(/<(?:\w+:)?c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
    const attrs = m[1]!;
    const inner = m[2] ?? '';
    const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
    if (!ref) continue;
    const type = /\bt="(\w+)"/.exec(attrs)?.[1];
    const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1];
    if (type === 's') cells.set(ref, shared[Number(v)] ?? '');
    else if (type === 'inlineStr') cells.set(ref, textRuns(inner));
    else cells.set(ref, xmlDecode(v ?? ''));
  }
  return cells;
}

/** Valor da coluna B na linha cuja coluna A tem o rótulo dado. */
export function valueByLabel(cells: Map<string, string>, label: string): string | undefined {
  for (const [ref, text] of cells) {
    const m = /^A(\d+)$/.exec(ref);
    if (m && text === label) return cells.get(`B${m[1]}`);
  }
  return undefined;
}

/** Linhas de uma aba: número da linha -> (coluna -> texto). */
export function xlsxRows(cells: Map<string, string>): Map<number, Map<string, string>> {
  const rows = new Map<number, Map<string, string>>();
  for (const [ref, text] of cells) {
    const m = /^([A-Z]+)(\d+)$/.exec(ref)!;
    const row = Number(m[2]);
    if (!rows.has(row)) rows.set(row, new Map());
    rows.get(row)!.set(m[1]!, text);
  }
  return rows;
}

/**
 * CSV com vírgula, aspas dobradas e quebra `\r\n` ou `\n` (o `CsvHelper` do
 * back, `InvariantCulture`). Tira o BOM. Devolve as linhas não vazias.
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}
