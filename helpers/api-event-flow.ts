import { APIRequestContext, request as playwrightRequest } from '@playwright/test';
import { CreatedEntity } from './api-entities';

/**
 * Primitivas de API para o fluxo de evento (orçamento → aceite → evento →
 * escalação → pagamento → fechamento). Usado pelos specs de
 * `tests/fluxos-completos/`.
 *
 * Convenção: cada função recebe `authApi` (Bearer setado) e devolve o `data`
 * desempacotado da Result envelope. Falhas lançam erro com status + body.
 */

async function expectOk(
  res: { ok: () => boolean; status: () => number; text: () => Promise<string> },
  op: string,
) {
  if (!res.ok()) {
    throw new Error(`${op} falhou (${res.status()}): ${await res.text()}`);
  }
}

function unwrap<T = unknown>(body: { data?: T } | T): T {
  return (body as { data?: T }).data ?? (body as T);
}

// ───────────────────────────── Budget ─────────────────────────────

export interface CreateBudgetInput {
  clientId: string;
  activityIds: string[]; // 1+ atividade(s) cobradas por quantidade
  eventDate?: string; // ISO date (YYYY-MM-DD); default = hoje + 30
  startTime?: string; // HH:mm
  endTime?: string;
  childrenCount?: number;
  validUntilDate?: string; // default = hoje + 14
}

function todayPlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function apiCreateBudget(
  api: APIRequestContext,
  input: CreateBudgetInput,
): Promise<CreatedEntity> {
  const body = {
    clientId: input.clientId,
    eventDate: input.eventDate ?? todayPlus(30),
    eventStartTime: input.startTime ?? '14:00',
    eventEndTime: input.endTime ?? '18:00',
    eventLocation: 'Salão de festas E2E, Curitiba',
    childrenCount: input.childrenCount ?? 15,
    validUntil: input.validUntilDate ?? todayPlus(14),
    teamSize: 2,
    teamPricePerCollaborator: 200,
    displacementFee: 0,
    items: input.activityIds.map((id) => ({ activityId: id, quantity: 1 })),
  };
  const res = await api.post('/api/budgets', { data: body });
  await expectOk(res, 'apiCreateBudget');
  return unwrap(await res.json());
}

export interface BudgetSendResult {
  budgetId: string;
  publicUrl: string;
  pdfDownloadUrl: string;
  expiresAt: string;
}

export async function apiSendBudget(
  api: APIRequestContext,
  budgetId: string,
): Promise<BudgetSendResult> {
  const res = await api.post(`/api/budgets/${budgetId}/send`);
  await expectOk(res, 'apiSendBudget');
  return unwrap(await res.json()) as BudgetSendResult;
}

/** Extrai o `token` raw da `PublicUrl` devolvida pelo /send. */
export function extractTokenFromPublicUrl(publicUrl: string): string {
  const marker = '/budgets/';
  const idx = publicUrl.indexOf(marker);
  if (idx < 0) {
    throw new Error(`PublicUrl não contém /budgets/: ${publicUrl}`);
  }
  return publicUrl.substring(idx + marker.length);
}

export async function apiCancelBudget(
  api: APIRequestContext,
  budgetId: string,
): Promise<void> {
  const res = await api.post(`/api/budgets/${budgetId}/cancel`);
  await expectOk(res, 'apiCancelBudget');
}

/** Reabre o orçamento como Draft (versionamento — Etapa 38). */
export async function apiRestartBudgetAsDraft(
  api: APIRequestContext,
  budgetId: string,
): Promise<void> {
  const res = await api.post(`/api/budgets/${budgetId}/restart-as-draft`);
  await expectOk(res, 'apiRestartBudgetAsDraft');
}

export async function apiGetBudget(
  api: APIRequestContext,
  budgetId: string,
): Promise<CreatedEntity> {
  const res = await api.get(`/api/budgets/${budgetId}`);
  await expectOk(res, 'apiGetBudget');
  return unwrap(await res.json());
}

export async function apiListBudgetVersions(
  api: APIRequestContext,
  budgetId: string,
): Promise<CreatedEntity[]> {
  const res = await api.get(`/api/budgets/${budgetId}/versions`);
  await expectOk(res, 'apiListBudgetVersions');
  const data = unwrap<CreatedEntity[] | { items?: CreatedEntity[] }>(await res.json());
  return Array.isArray(data) ? data : data.items ?? [];
}

// ───────────────────────── Public budget (anônimo) ─────────────────────────

/** Cria um APIRequestContext SEM Authorization (simula cliente público). */
export async function createPublicApiContext(): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL: process.env.BACK_URL ?? 'https://localhost:1501',
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { 'Content-Type': 'application/json' },
  });
}

export async function apiGetPublicBudget(
  publicApi: APIRequestContext,
  token: string,
): Promise<CreatedEntity & { eventId?: string | null; status: string }> {
  const res = await publicApi.get(`/api/public/budgets/${token}`);
  await expectOk(res, 'apiGetPublicBudget');
  return unwrap(await res.json());
}

export async function apiAcceptPublicBudget(
  publicApi: APIRequestContext,
  token: string,
): Promise<CreatedEntity & { eventId: string; status: string }> {
  const res = await publicApi.post(`/api/public/budgets/${token}/accept`);
  await expectOk(res, 'apiAcceptPublicBudget');
  return unwrap(await res.json()) as CreatedEntity & { eventId: string; status: string };
}

/** Tenta aceitar — não lança em status 4xx; usado em cenários negativos. */
export async function apiTryAcceptPublicBudget(
  publicApi: APIRequestContext,
  token: string,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await publicApi.post(`/api/public/budgets/${token}/accept`);
  return { ok: res.ok(), status: res.status(), body: await res.json().catch(() => null) };
}

// ───────────────────────────── Event ─────────────────────────────

export async function apiGetEvent(
  api: APIRequestContext,
  eventId: string,
): Promise<CreatedEntity & { collaborators?: Array<{ collaboratorId: string }> }> {
  const res = await api.get(`/api/events/${eventId}`);
  await expectOk(res, 'apiGetEvent');
  return unwrap(await res.json());
}

export async function apiAssignCollaborator(
  api: APIRequestContext,
  eventId: string,
  collaboratorId: string,
  opts: { isLeader?: boolean; overrideReason?: string } = {},
): Promise<CreatedEntity> {
  const res = await api.post(`/api/events/${eventId}/collaborators`, {
    data: {
      collaboratorId,
      isLeader: opts.isLeader ?? false,
      overrideReason: opts.overrideReason,
    },
  });
  await expectOk(res, 'apiAssignCollaborator');
  return unwrap(await res.json());
}

export async function apiConfirmCollaborator(
  api: APIRequestContext,
  eventId: string,
  collaboratorId: string,
): Promise<void> {
  const res = await api.post(
    `/api/events/${eventId}/collaborators/${collaboratorId}/confirm`,
  );
  await expectOk(res, 'apiConfirmCollaborator');
}

export async function apiStartEvent(api: APIRequestContext, eventId: string): Promise<void> {
  const res = await api.post(`/api/events/${eventId}/start`);
  await expectOk(res, 'apiStartEvent');
}

export async function apiCompleteEvent(
  api: APIRequestContext,
  eventId: string,
): Promise<void> {
  const res = await api.post(`/api/events/${eventId}/complete`);
  await expectOk(res, 'apiCompleteEvent');
}

// ───────────────────────────── Payment ─────────────────────────────

export interface PaymentSummary {
  eventId: string;
  eventTotal: number;
  totalPaid: number;
  balance: number;
  financialStatus: string;
  entries: Array<{ id: string; amount: number; method: string; paidAt: string }>;
}

export async function apiGetPaymentSummary(
  api: APIRequestContext,
  eventId: string,
): Promise<PaymentSummary> {
  const res = await api.get(`/api/events/${eventId}/payments`);
  await expectOk(res, 'apiGetPaymentSummary');
  return unwrap(await res.json()) as PaymentSummary;
}

export type PaymentMethod = 'Pix' | 'Cash' | 'Transfer' | 'Card' | 'Other';

export async function apiRegisterPayment(
  api: APIRequestContext,
  eventId: string,
  payload: {
    amount: number;
    method: PaymentMethod;
    paidAt?: string;
    note?: string;
    installmentId?: string;
  },
): Promise<CreatedEntity> {
  const res = await api.post(`/api/events/${eventId}/payments`, {
    data: {
      paidAt: payload.paidAt ?? todayPlus(0),
      amount: payload.amount,
      method: payload.method,
      note: payload.note ?? null,
      installmentId: payload.installmentId ?? null,
    },
  });
  await expectOk(res, 'apiRegisterPayment');
  return unwrap(await res.json());
}

// ──────────────────────── Payment plan (parcelas) ────────────────────────

export interface EventInstallment {
  id: string;
  order: number;
  label: string;
  expectedAmount: number;
  paidAmount: number;
  balance: number;
  dueDate: string;
  status: string;
}

export interface EventPaymentPlan {
  id: string;
  eventId: string;
  installments: EventInstallment[];
}

export async function apiCreatePaymentPlan(
  api: APIRequestContext,
  eventId: string,
  installments: Array<{
    order: number;
    label: string;
    expectedAmount: number;
    dueDate: string;
  }>,
): Promise<EventPaymentPlan> {
  const res = await api.post(`/api/events/${eventId}/payment-plan`, {
    data: { templateId: null, installments },
  });
  await expectOk(res, 'apiCreatePaymentPlan');
  return unwrap(await res.json()) as EventPaymentPlan;
}

export async function apiGetPaymentPlan(
  api: APIRequestContext,
  eventId: string,
): Promise<EventPaymentPlan | null> {
  const res = await api.get(`/api/events/${eventId}/payment-plan`);
  if (res.status() === 404) {
    return null;
  }
  await expectOk(res, 'apiGetPaymentPlan');
  return unwrap(await res.json()) as EventPaymentPlan;
}

export async function apiRecomputePaymentPlan(
  api: APIRequestContext,
  eventId: string,
): Promise<void> {
  const res = await api.post(`/api/events/${eventId}/payment-plan/recompute`);
  await expectOk(res, 'apiRecomputePaymentPlan');
}

/**
 * Lista de pendências. Back devolve `{ items: PagedList, totalPendingBalance }`
 * onde `PagedList` é `{ items: T[], total, page, pageSize }`. Helper retorna
 * só a página corrente já desempacotada pra uso direto.
 */
export async function apiListPendingPayments(
  api: APIRequestContext,
): Promise<{ items: Array<{ eventId: string; balance: number }>; totalPendingBalance: number }> {
  const res = await api.get('/api/events/pending-payments');
  await expectOk(res, 'apiListPendingPayments');
  const body = unwrap<{
    items: { items: Array<{ eventId: string; balance: number }> };
    totalPendingBalance: number;
  }>(await res.json());
  return {
    items: body.items?.items ?? [],
    totalPendingBalance: body.totalPendingBalance ?? 0,
  };
}
