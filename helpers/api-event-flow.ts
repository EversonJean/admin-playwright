import { APIRequestContext, APIResponse, request as playwrightRequest } from '@playwright/test';
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
  /** Data de término (multi-dia/vira-noite). Omitida = mesmo dia. */
  eventEndDate?: string;
  startTime?: string; // HH:mm
  endTime?: string;
  childrenCount?: number;
  validUntilDate?: string; // default = hoje + 14
  /** Local do evento; default fixo. Distinto por orçamento quando o teste lê a linha da lista. */
  eventLocation?: string;
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
    // Omitida no payload = evento de um dia (retrocompat do contrato).
    ...(input.eventEndDate ? { eventEndDate: input.eventEndDate } : {}),
    eventStartTime: input.startTime ?? '14:00',
    eventEndTime: input.endTime ?? '18:00',
    eventLocation: input.eventLocation ?? 'Salão de festas E2E, Curitiba',
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

/**
 * Etapa 188 — o aceite exige corpo: a residência do cliente é obrigatória, e o
 * endereço do evento também quando o ORÇAMENTO não tem um estruturado (que é o
 * caso de todo orçamento criado por `apiCreateBudget`).
 *
 * `data` permite ao teste mandar outro corpo — inclusive um incompleto, para
 * provar a recusa.
 */
export function publicAcceptBody(): Record<string, unknown> {
  return {
    address: {
      zipCode: '80010-000',
      street: 'Rua XV de Novembro',
      number: '1000',
      complement: null,
      neighborhood: 'Centro',
      city: 'Curitiba',
      state: 'PR',
    },
    clientAddress: {
      zipCode: '80000-000',
      street: 'Rua das Flores',
      number: '123',
      complement: null,
      neighborhood: 'Centro',
      city: 'Curitiba',
      state: 'PR',
    },
  };
}

export async function apiAcceptPublicBudget(
  publicApi: APIRequestContext,
  token: string,
  data: Record<string, unknown> = publicAcceptBody(),
): Promise<CreatedEntity & { eventId: string; status: string }> {
  const res = await publicApi.post(`/api/public/budgets/${token}/accept`, { data });
  await expectOk(res, 'apiAcceptPublicBudget');
  return unwrap(await res.json()) as CreatedEntity & { eventId: string; status: string };
}

/**
 * Tenta aceitar — não lança em status 4xx; usado em cenários negativos.
 *
 * `data` omitido = corpo VAZIO, que desde a Etapa 188 é recusado com
 * `PublicBudget.ClientAddressRequired` quando o token é válido. Em cenário de
 * token inválido o corpo nem é olhado (404 vem antes).
 */
export async function apiTryAcceptPublicBudget(
  publicApi: APIRequestContext,
  token: string,
  data?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const res = await publicApi.post(
    `/api/public/budgets/${token}/accept`,
    data === undefined ? {} : { data },
  );
  return { ok: res.ok(), status: res.status(), body: await res.json().catch(() => null) };
}

// ───────────────────────────── Event ─────────────────────────────

/**
 * POST /api/events/public — evento aberto ao público (Etapa 150). Exige o
 * entitlement `feature_ticketing` no tenant (`enableFeatureFlagDirect`).
 * Nasce `Scheduled` e usa a máquina de estados completa (Start -> Complete).
 */
export async function apiCreatePublicEvent(
  api: APIRequestContext,
  input: { title?: string; eventDate?: string; startTime?: string; endTime?: string } = {},
): Promise<CreatedEntity & { kind: string; status: string }> {
  const res = await api.post('/api/events/public', {
    data: {
      title: input.title ?? `Evento público E2E ${Date.now()}`,
      eventDate: input.eventDate ?? todayPlus(7),
      startTime: input.startTime ?? '10:00',
      endTime: input.endTime ?? '16:00',
      location: 'Praça E2E, Curitiba',
    },
  });
  await expectOk(res, 'apiCreatePublicEvent');
  return unwrap(await res.json());
}

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

/** Etapa 160 — natureza do lançamento. */
export type PaymentEntryKind = 'Regular' | 'Tip' | 'EquipmentReplacement';

export interface PaymentSummary {
  eventId: string;
  eventTotal: number;
  totalPaid: number;
  balance: number;
  financialStatus: string;
  entries: Array<{
    id: string;
    amount: number;
    method: string;
    paidAt: string;
    kind: PaymentEntryKind;
  }>;
  /** Σ gorjetas + reposições, líquido de estorno (Etapa 160). */
  totalExtras: number;
}

export async function apiGetPaymentSummary(
  api: APIRequestContext,
  eventId: string,
): Promise<PaymentSummary> {
  const res = await api.get(`/api/events/${eventId}/payments`);
  await expectOk(res, 'apiGetPaymentSummary');
  return unwrap(await res.json()) as PaymentSummary;
}

/** Etapa 198 — `Credit` paga com o saldo de um crédito do cliente (`creditBalanceId`). */
export type PaymentMethod = 'Pix' | 'Cash' | 'Transfer' | 'Card' | 'Other' | 'Credit';

/**
 * Etapa 160 — o POST devolve a LISTA de lançamentos criados: um valor acima do
 * saldo, com `extraKind`, gera regular + extra no mesmo commit.
 */
export interface RegisterPaymentResult {
  entries: Array<{ id: string; amount: number; kind: PaymentEntryKind }>;
  regularAmount: number;
  extraAmount: number;
}

export async function apiRegisterPayment(
  api: APIRequestContext,
  eventId: string,
  payload: {
    amount: number;
    method: PaymentMethod;
    paidAt?: string;
    note?: string;
    installmentId?: string;
    /** Natureza do dinheiro que NÃO abate a dívida (Etapa 160/163). */
    extraKind?: Exclude<PaymentEntryKind, 'Regular'>;
    /**
     * Etapa 163 — `false` (default) classifica só o EXCEDENTE; `true` marca o
     * valor INTEIRO como extra, deixando a dívida intocada.
     */
    entireAmountIsExtra?: boolean;
    /** Etapa 198 — obrigatório com `method: 'Credit'`, proibido nas outras formas. */
    creditBalanceId?: string;
  },
): Promise<RegisterPaymentResult> {
  const res = await api.post(`/api/events/${eventId}/payments`, {
    data: registerPaymentBody(payload),
  });
  await expectOk(res, 'apiRegisterPayment');
  return unwrap(await res.json()) as RegisterPaymentResult;
}

/**
 * Corpo do `POST /api/events/{id}/payments` com os defaults do
 * `apiRegisterPayment` — para o cenário negativo mandar o mesmo corpo por
 * outro contexto (portal, outro tenant) e ler o status sem lançar.
 */
export function registerPaymentBody(payload: {
  amount: number;
  method: PaymentMethod;
  paidAt?: string;
  note?: string;
  installmentId?: string;
  extraKind?: Exclude<PaymentEntryKind, 'Regular'>;
  entireAmountIsExtra?: boolean;
  creditBalanceId?: string;
}): Record<string, unknown> {
  return {
    paidAt: payload.paidAt ?? todayPlus(0),
    amount: payload.amount,
    method: payload.method,
    note: payload.note ?? null,
    installmentId: payload.installmentId ?? null,
    extraKind: payload.extraKind ?? null,
    entireAmountIsExtra: payload.entireAmountIsExtra ?? false,
    creditBalanceId: payload.creditBalanceId ?? null,
  };
}

// ──────────────────────── Devoluções (FinancialAdjustments) ────────────────────────

/** POST .../financial-adjustments/reversal — anula um lançamento inteiro. */
export async function apiReversePaymentEntry(
  api: APIRequestContext,
  eventId: string,
  paymentEntryId: string,
  reason = 'Estorno E2E',
): Promise<void> {
  const res = await api.post(`/api/events/${eventId}/financial-adjustments/reversal`, {
    data: { paymentEntryId, reason, notes: null },
  });
  await expectOk(res, 'apiReversePaymentEntry');
}

/** POST .../financial-adjustments/refund — devolução (parcial ou total) sobre uma parcela. */
export async function apiRefundInstallment(
  api: APIRequestContext,
  eventId: string,
  installmentId: string,
  amount: number,
  reason = 'Reembolso E2E',
): Promise<void> {
  const res = await api.post(`/api/events/${eventId}/financial-adjustments/refund`, {
    data: { installmentId, amount, reason, notes: null },
  });
  await expectOk(res, 'apiRefundInstallment');
}

// ──────────────────────── Crédito do cliente (Etapa 198) ────────────────────────

/** Espelha `CreditBalanceDto` do back. `expiresAt` é `yyyy-MM-dd` ou null (sem validade). */
export interface CreditBalanceItem {
  id: string;
  clientId: string;
  originEventId: string;
  originAdjustmentId: string;
  originalAmount: number;
  usedAmount: number;
  balance: number;
  status: string;
  expiresAt: string | null;
}

/**
 * POST .../financial-adjustments/credit — devolve ao cliente, como crédito, um
 * valor já pago na parcela. Sem `expiresAt`, a validade sai do parâmetro
 * `CREDIT_DEFAULT_DUE_DAYS` do tenant. Devolve a resposta crua: o teto
 * (`CreditBalance.MaxBalanceExceeded`) é cenário de teste, não de setup.
 */
export async function apiTryIssueCredit(
  api: APIRequestContext,
  eventId: string,
  input: { installmentId: string; amount: number; expiresAt?: string; reason?: string },
): Promise<APIResponse> {
  return api.post(`/api/events/${eventId}/financial-adjustments/credit`, {
    data: {
      installmentId: input.installmentId,
      amount: input.amount,
      reason: input.reason ?? 'Crédito E2E',
      notes: null,
      expiresAt: input.expiresAt ?? null,
    },
  });
}

/** Igual ao `apiTryIssueCredit`, mas lança se o back recusar. */
export async function apiIssueCredit(
  api: APIRequestContext,
  eventId: string,
  input: { installmentId: string; amount: number; expiresAt?: string; reason?: string },
): Promise<CreatedEntity> {
  const res = await apiTryIssueCredit(api, eventId, input);
  await expectOk(res, 'apiIssueCredit');
  return unwrap(await res.json());
}

/** GET /api/clients/{clientId}/credit-balances — `usableOnly` é a lista da forma "Crédito". */
export async function apiListClientCredits(
  api: APIRequestContext,
  clientId: string,
  usableOnly = false,
): Promise<CreditBalanceItem[]> {
  const res = await api.get(
    `/api/clients/${clientId}/credit-balances${usableOnly ? '?usableOnly=true' : ''}`,
  );
  await expectOk(res, 'apiListClientCredits');
  const data = unwrap<CreditBalanceItem[] | { items?: CreditBalanceItem[] }>(await res.json());
  return Array.isArray(data) ? data : data.items ?? [];
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
 *
 * `clientId` usa o filtro da própria tela: enquanto a SEG-G item 0
 * (PLANO-SEGURANCA) não sai, a lista traz eventos de todos os tenants do banco
 * E2E, e o evento do teste não cabe na primeira página.
 */
export async function apiListPendingPayments(
  api: APIRequestContext,
  filter: { clientId?: string } = {},
): Promise<{ items: Array<{ eventId: string; balance: number }>; totalPendingBalance: number }> {
  const query = filter.clientId ? `?clientId=${encodeURIComponent(filter.clientId)}` : '';
  const res = await api.get(`/api/events/pending-payments${query}`);
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
