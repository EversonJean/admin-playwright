import { APIRequestContext, APIResponse } from '@playwright/test';
import { CreatedEntity, apiCreateActivity, apiCreateClient } from './api-entities';
import { CreateBudgetInput, apiCreateBudget, apiGetEvent, apiPatchEvent } from './api-event-flow';
import { tenantDayPlus } from './rain-plan';
import { assertOk, readJson } from './response';
import { fakeCnpj } from './test-data';

/**
 * Pré-condições e leituras dos specs do evento comunitário
 * (`docs/implementados/PLANO-EVENTO-COMUNITARIO.md`, Etapas 247 a 249):
 * `tests/5-orcamento/5.8` e `tests/fluxos-completos/11`.
 *
 * A ação comunitária nasce do orçamento em modo `Community`, confirmada pelo
 * `POST /api/budgets/{id}/confirm-community` (sem envio): o evento é comercial,
 * com o preço de tabela como valor de referência (`subtotal`) e total zero.
 */

export type ChargeMode = 'Charged' | 'Community';

/** Valor como o `CurrencyPipe` pt-BR mostra, sem o "R$" (o espaço dele é não separável). */
export function brl(value: number): string {
  return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

/** Primeiro e último dia (YYYY-MM-DD) do mês de `isoDay`. */
export function monthRange(isoDay: string): { from: string; to: string } {
  const [year, month] = isoDay.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  return { from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, '0')}` };
}

/** Hoje no fuso do tenant (America/Sao_Paulo). */
export function tenantToday(): string {
  return tenantDayPlus(0);
}

function uid(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** A escola, a ONG ou a associação beneficiada: cliente PJ com nome e e-mail únicos. */
export async function apiCreateSchoolClient(
  api: APIRequestContext,
  name = `Escola Municipal ${uid()}`,
): Promise<CreatedEntity & { name: string; email: string }> {
  const email = `escola-${uid()}@e2e.test`;
  const client = await apiCreateClient(api, { type: 'PJ', name, email, document: fakeCnpj() });
  return { ...client, name, email };
}

/** `AcceptBudgetResultDto`. */
export interface AcceptBudgetResult {
  anchorEventId: string | null;
  seriesId: string | null;
  eventsCreated: number;
}

export function apiTryConfirmCommunity(api: APIRequestContext, budgetId: string): Promise<APIResponse> {
  return api.post(`/api/budgets/${budgetId}/confirm-community`);
}

export async function apiConfirmCommunity(api: APIRequestContext, budgetId: string): Promise<AcceptBudgetResult> {
  const res = await apiTryConfirmCommunity(api, budgetId);
  await assertOk(res, 'POST /api/budgets/{id}/confirm-community');
  return readJson<AcceptBudgetResult>(res);
}

/** O que o spec lê do `BudgetDto`. */
export interface BudgetView {
  id: string;
  status: string;
  chargeMode: ChargeMode;
  itemsTotal: number;
  teamCost: number;
  displacementFee: number;
  subtotal: number;
  discountApplied: number;
  total: number;
  costEstimate: { totalCost: number; marginAmount: number; isComplete: boolean } | null;
}

export async function apiGetBudgetView(api: APIRequestContext, budgetId: string): Promise<BudgetView> {
  const res = await api.get(`/api/budgets/${budgetId}`);
  await assertOk(res, 'GET /api/budgets/{id}');
  return readJson<BudgetView>(res);
}

/** O que o spec lê do `EventDetailDto`. */
export interface EventView {
  id: string;
  status: string;
  chargeMode: ChargeMode;
  childrenCount: number;
  subtotal: number;
  discountApplied: number;
  total: number;
  pricingItems: Array<{
    id: string;
    description: string;
    quantity: number;
    unitPrice: number;
    discountAmount: number;
    additionalAmount: number;
    totalPrice: number;
  }>;
}

export async function apiGetEventView(api: APIRequestContext, eventId: string): Promise<EventView> {
  return (await apiGetEvent(api, eventId)) as unknown as EventView;
}

export interface CommunityEvent {
  eventId: string;
  budgetId: string;
  clientId: string;
  clientName: string;
  activityId: string;
  /** Valor de referência: o `subtotal` do evento (preço de tabela). */
  referenceValue: number;
}

/**
 * Ação comunitária confirmada: escola (ou o cliente dado), atividade (ou as
 * dadas), orçamento `Community` e `confirm-community`. O orçamento nasce numa
 * data com validade possível (`opts.budget.eventDate`, default daqui a 10 dias);
 * `opts.eventDate` move a ação depois da confirmação (`PATCH /api/events/{id}`),
 * que é o caminho para uma ação de hoje (ver `tests/CLAUDE.md`, "Festa de hoje").
 */
export async function setupCommunityEvent(
  api: APIRequestContext,
  opts: {
    clientId?: string;
    clientName?: string;
    activityIds?: string[];
    budget?: Partial<Omit<CreateBudgetInput, 'clientId' | 'activityIds' | 'chargeMode'>>;
    eventDate?: string;
  } = {},
): Promise<CommunityEvent> {
  const client = opts.clientId
    ? { id: opts.clientId, name: opts.clientName ?? '' }
    : await apiCreateSchoolClient(api, opts.clientName);
  const activityIds = opts.activityIds ?? [(await apiCreateActivity(api, { status: 'Active' })).id];
  const budget = await apiCreateBudget(api, {
    eventDate: tenantDayPlus(10),
    ...opts.budget,
    clientId: client.id,
    activityIds,
    chargeMode: 'Community',
  });
  const confirmed = await apiConfirmCommunity(api, budget.id);
  if (!confirmed.anchorEventId) throw new Error('confirm-community sem anchorEventId');
  const eventId = confirmed.anchorEventId;
  if (opts.eventDate) await apiPatchEvent(api, eventId, { eventDate: opts.eventDate });
  const ev = await apiGetEventView(api, eventId);
  return {
    eventId,
    budgetId: budget.id,
    clientId: client.id,
    clientName: client.name,
    activityId: activityIds[0]!,
    referenceValue: ev.subtotal,
  };
}

// ─────────────────────────── custo ───────────────────────────
// Cachê (`apiCreateCommission`), despesa do evento e nível de colaborador são
// entidades genéricas: moram em `helpers/api-entities.ts`.

export interface CostBreakdown {
  team: number;
  expenses: number;
  material: number;
  displacement: number;
  tax: number;
}

/** O que o spec lê do `GET /api/events/{id}/profitability`. */
export interface Profitability {
  realRevenue: number;
  realCostTotal: number;
  frozenMarginPercent: number | null;
  realMarginPercent: number | null;
  realMarginAmount: number | null;
  excessSuggestion: unknown;
  communityCost: {
    referenceValue: number;
    estimatedCost: number;
    realCost: number;
    breakdown: CostBreakdown;
  } | null;
}

export async function apiGetProfitability(api: APIRequestContext, eventId: string): Promise<Profitability> {
  const res = await api.get(`/api/events/${eventId}/profitability`);
  await assertOk(res, 'GET /api/events/{id}/profitability');
  return readJson<Profitability>(res);
}

// ─────────────────────────── relatório e painel ───────────────────────────

export interface EventReportRow {
  eventId: string;
  clientName: string | null;
  total: number;
  financialStatus: string | null;
  chargeMode: ChargeMode;
  referenceValue: number | null;
  realCost: number | null;
}

export interface EventReportSummary {
  totalEvents: number;
  totalRevenue: number;
  averageTicket: number | null;
  averageMarginPercent: number | null;
  community: {
    count: number;
    referenceValueTotal: number;
    realCostTotal: number;
    breakdown: CostBreakdown;
  } | null;
}

export interface EventReportQuery {
  fromDate: string;
  toDate: string;
  chargeMode?: ChargeMode;
  statusFilter?: string;
  financialStatus?: string;
}

function reportQueryString(query: EventReportQuery): string {
  const params = new URLSearchParams({ fromDate: query.fromDate, toDate: query.toDate, pageSize: '200' });
  if (query.chargeMode) params.set('chargeMode', query.chargeMode);
  if (query.statusFilter) params.set('statusFilter', query.statusFilter);
  if (query.financialStatus) params.set('financialStatus', query.financialStatus);
  return params.toString();
}

/** `GET /api/reports/events` — linhas da página (até 200) e o resumo. */
export async function apiEventReport(
  api: APIRequestContext,
  query: EventReportQuery,
): Promise<{ rows: EventReportRow[]; summary: EventReportSummary }> {
  const res = await api.get(`/api/reports/events?${reportQueryString(query)}`);
  await assertOk(res, 'GET /api/reports/events');
  const dto = await readJson<{ items: { items: EventReportRow[] }; summary: EventReportSummary }>(res);
  return { rows: dto.items.items, summary: dto.summary };
}

/** `GET /api/reports/events/export` — o arquivo cru. */
export async function apiExportEventReport(
  api: APIRequestContext,
  query: EventReportQuery,
  format: 'Csv' | 'Excel',
): Promise<Buffer> {
  const params = new URLSearchParams({ fromDate: query.fromDate, toDate: query.toDate, format });
  if (query.chargeMode) params.set('chargeMode', query.chargeMode);
  if (query.statusFilter) params.set('statusFilter', query.statusFilter);
  const res = await api.get(`/api/reports/events/export?${params.toString()}`);
  await assertOk(res, `GET /api/reports/events/export (${format})`);
  return res.body();
}

/** O que o spec lê do `FinancialDashboardDto`. */
export interface FinancialDashboard {
  revenueThisMonth: number;
  receivedThisMonth: number;
  totalPendingReceivables: number;
  community: {
    year: number;
    month: number;
    count: number;
    referenceValueTotal: number;
    realCostTotal: number;
  } | null;
}

export async function apiFinancialDashboard(api: APIRequestContext): Promise<FinancialDashboard> {
  const res = await api.get('/api/dashboard/financial?months=6');
  await assertOk(res, 'GET /api/dashboard/financial');
  return readJson<FinancialDashboard>(res);
}

/** Status que o card do painel e o link "Ver no relatório" usam: sem cancelados. */
export const LIVE_EVENT_STATUSES = 'Scheduled,InProgress,Completed';
