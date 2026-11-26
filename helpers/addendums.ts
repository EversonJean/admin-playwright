import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';

import {
  createPublicApiContext,
  apiCreatePaymentPlan,
  apiGetPaymentPlan,
  apiGetPaymentSummary,
  apiRegisterPayment,
  EventInstallment,
} from './api-event-flow';
import { assertOk, readJson, unwrapList } from './response';
import { setupDraftContract } from './setup-flows';

/**
 * Pré-condições e chamadas do aditivo de contrato (PLANO-ADITIVOS-COM-APROVACAO,
 * Etapas 285 a 292), para os specs do 9.4, 9.7 a 9.14.
 *
 * Desde a Etapa 287 a mudança da festa (data, local, crianças, pacote, itens,
 * pagamento) se propõe pela própria festa (`POST /api/events/{id}/contract-changes`);
 * o caminho do contrato (`POST /api/contracts/{id}/addendums`) aceita só cláusula
 * e ajuste manual e recusa o resto com 400 `Addendums.ScopeViaEvent`.
 */

/** Linha da lista de aditivos do contrato (`ContractAddendumListItemDto`), no que os specs leem. */
export interface AddendumListItem {
  id: string;
  contractId: string;
  addendumNumber: number;
  reason: string;
  status: string;
  revision: number;
  kind: string;
  effectsStatus: string;
  isLegacyEventAlreadyChanged: boolean;
  financialImpact: number | null;
}

/** Resposta da proposta pela festa (`ContractChangeProposalDto`). */
export interface ContractChangeProposal {
  addendumId: string;
  contractId: string;
  addendumNumber: number;
  status: string;
  revision: number;
  merged: boolean;
  financialImpact: number | null;
  requiresInternalApproval: boolean;
}

/** Operação de cláusula do aditivo (`AddendumClauseOperationDto`). */
export interface ClauseOperation {
  operation: 'Add' | 'Replace' | 'Remove';
  targetClauseId?: string | null;
  clauseVersionId?: string | null;
  freeTitle?: string | null;
  freeBodyHtml?: string | null;
}

/** Cláusula vigente (`EffectiveClauseDto`). */
export interface EffectiveClause {
  clauseId: string;
  clauseVersionId: string | null;
  title: string;
  bodyHtml: string;
  order: number;
  origin: 'Contract' | 'Addendum';
  originAddendumId: string | null;
  originAddendumNumber: number | null;
}

/**
 * Contrato FORMALIZADO por aceite manual de uma festa aceita própria (o molde da
 * massa do 9.7, 9.8 e 9.12): `setupDraftContract` + `POST formalize-manual`. Mais
 * curto que o `setupFormalizedContract`, que passa pela assinatura digital no fake.
 */
export async function setupManuallyFormalizedContract(
  api: APIRequestContext,
  tenantId: string,
): Promise<{ contractId: string; eventId: string; templateId: string; clienteId: string }> {
  const draft = await setupDraftContract(api, tenantId);
  await apiFormalizeContractManually(api, draft.contractId);
  return draft;
}

/**
 * `POST /api/contracts/{id}/formalize-manual` (aceite manual registrado pelo
 * gestor). Separado do `setupManuallyFormalizedContract` para quem monta o plano
 * de pagamento antes de formalizar, como a massa do 9.8.
 */
export async function apiFormalizeContractManually(api: APIRequestContext, contractId: string): Promise<void> {
  await assertOk(
    await api.post(`/api/contracts/${contractId}/formalize-manual`, {
      data: {
        signerName: 'Cliente E2E',
        channel: 'presencial',
        reason: 'Aceite registrado pelo e2e',
        evidenceText: null,
        signerPhone: null,
        signerEmail: null,
      },
    }),
    'POST /api/contracts/{id}/formalize-manual',
  );
}

/**
 * Cláusula do tenant com uma versão ATIVA (biblioteca da empresa, `GET /api/clauses`).
 * Título e corpo únicos por `Date.now()`, para o spec achar o texto no PDF.
 */
export async function apiCreateActiveClause(
  api: APIRequestContext,
  input: { title?: string; bodyText?: string } = {},
): Promise<{ clauseId: string; versionId: string; title: string; bodyText: string }> {
  const stamp = pdfStamp();
  const title = input.title ?? `Clausula biblioteca ${stamp}`;
  const bodyText = input.bodyText ?? `Texto integral da clausula da biblioteca ${stamp}.`;
  const created = await api.post('/api/clauses', {
    data: {
      title,
      category: 'Geral',
      // `ClauseApplicability` é flags e o DTO recebe o número (1 = pessoa física).
      applicableTo: 1,
      isRequired: false,
      suggestedOrder: 50,
      bodyHtml: `<p>${bodyText}</p>`,
      bodyPlain: bodyText,
    },
  });
  await assertOk(created, 'POST /api/clauses');
  const clause = await readJson<{ id: string }>(created);
  const issued = await api.post(`/api/clauses/${clause.id}/versions`, {
    data: { bodyHtml: `<p>${bodyText}</p>`, bodyPlain: bodyText },
  });
  await assertOk(issued, 'POST /api/clauses/{id}/versions');
  const version = await readJson<{ id?: string; versionId?: string }>(issued);
  const versionId = version.id ?? version.versionId;
  if (!versionId) throw new Error('POST /api/clauses/{id}/versions sem id');
  await assertOk(
    await api.post(`/api/clauses/${clause.id}/versions/${versionId}/activate`),
    'activate clause version',
  );
  return { clauseId: clause.id, versionId, title, bodyText };
}

/** `POST /api/contracts/{id}/addendums` só com cláusulas e/ou ajuste manual; devolve a resposta crua. */
export async function apiTryCreateContractAddendum(
  api: APIRequestContext,
  contractId: string,
  body: { reason: string; clauses?: ClauseOperation[]; priceDelta?: number | null; [k: string]: unknown },
): Promise<APIResponse> {
  return api.post(`/api/contracts/${contractId}/addendums`, { data: body });
}

/** Igual ao `apiTryCreateContractAddendum`, mas lança se o back recusar; devolve o id. */
export async function apiCreateContractAddendum(
  api: APIRequestContext,
  contractId: string,
  body: { reason: string; clauses?: ClauseOperation[]; priceDelta?: number | null },
): Promise<{ id: string; addendumNumber: number; revision: number; status: string }> {
  const res = await apiTryCreateContractAddendum(api, contractId, body);
  await assertOk(res, 'POST /api/contracts/{id}/addendums');
  return readJson(res);
}

/** `POST /api/events/{id}/contract-changes`: a proposta pela festa; devolve a resposta crua. */
export async function apiTryProposeContractChange(
  api: APIRequestContext,
  eventId: string,
  reason: string,
  change: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<APIResponse> {
  return api.post(`/api/events/${eventId}/contract-changes`, { data: { reason, change, ...extra } });
}

/** Igual ao `apiTryProposeContractChange`, mas lança se o back recusar. */
export async function apiProposeContractChange(
  api: APIRequestContext,
  eventId: string,
  reason: string,
  change: Record<string, unknown>,
): Promise<ContractChangeProposal> {
  const res = await apiTryProposeContractChange(api, eventId, reason, change);
  await assertOk(res, 'POST /api/events/{id}/contract-changes');
  return readJson<ContractChangeProposal>(res);
}

/** `GET /api/contracts/{id}/addendums`. */
export async function apiListContractAddendums(
  api: APIRequestContext,
  contractId: string,
): Promise<AddendumListItem[]> {
  const res = await api.get(`/api/contracts/${contractId}/addendums`);
  await assertOk(res, 'GET /api/contracts/{id}/addendums');
  return unwrapList<AddendumListItem>(res);
}

/** `GET /api/addendums/{id}`. */
export async function apiGetAddendum(api: APIRequestContext, addendumId: string): Promise<AddendumListItem> {
  const res = await api.get(`/api/addendums/${addendumId}`);
  await assertOk(res, 'GET /api/addendums/{id}');
  return readJson<AddendumListItem>(res);
}

/** `GET /api/addendums/{id}/pdf`: gera (e grava o hash) e devolve os bytes. */
export async function apiAddendumPdf(api: APIRequestContext, addendumId: string): Promise<Buffer> {
  const res = await api.get(`/api/addendums/${addendumId}/pdf`);
  await assertOk(res, 'GET /api/addendums/{id}/pdf');
  return res.body();
}

/** PDF gerado + `POST send` ("Marcar como enviado"). */
export async function apiSendAddendum(api: APIRequestContext, addendumId: string): Promise<void> {
  await apiAddendumPdf(api, addendumId);
  await assertOk(await api.post(`/api/addendums/${addendumId}/send`), 'POST /api/addendums/{id}/send');
}

/** PDF gerado + `POST formalize-manual` do aditivo. */
export async function apiFormalizeAddendumManually(api: APIRequestContext, addendumId: string): Promise<void> {
  await apiAddendumPdf(api, addendumId);
  await assertOk(
    await api.post(`/api/addendums/${addendumId}/formalize-manual`, {
      data: {
        signerName: 'Cliente E2E',
        channel: 'presencial',
        reason: 'Cliente concordou com o aditivo (e2e)',
        evidenceText: null,
        signerPhone: null,
        signerEmail: null,
      },
    }),
    'POST /api/addendums/{id}/formalize-manual',
  );
}

/** `GET /api/contracts/{id}/effective-clauses`. */
export async function apiListEffectiveClauses(
  api: APIRequestContext,
  contractId: string,
): Promise<EffectiveClause[]> {
  const res = await api.get(`/api/contracts/${contractId}/effective-clauses`);
  await assertOk(res, 'GET /api/contracts/{id}/effective-clauses');
  return unwrapList<EffectiveClause>(res);
}

/**
 * Carimbo único para o texto que o spec procura no PDF: só dígitos. Com letras
 * sorteadas (base 36), um par como "fi"/"fl"/"ff" vira um glifo de ligadura no
 * PDF do QuestPDF, e o `pdf-text` não o devolve: o trecho "sumia" de vez em
 * quando (9.4.2, `/e2e-plano` de 2026-11-25).
 */
function pdfStamp(): string {
  return `${Date.now()}${Math.floor(Math.random() * 10_000).toString().padStart(4, '0')}`;
}

/** Uma operação de inclusão em texto livre (título e corpo únicos). */
export function freeTextClause(label: string): { op: ClauseOperation; title: string; bodyText: string } {
  const stamp = pdfStamp();
  const bodyText = `Texto livre ${label} ${stamp}`;
  const title = `Clausula livre ${label} ${stamp}`;
  return {
    op: {
      operation: 'Add',
      targetClauseId: null,
      clauseVersionId: null,
      freeTitle: title,
      freeBodyHtml: `<p>${bodyText} com <strong>negrito</strong>.</p>`,
    },
    title,
    bodyText,
  };
}

/** Estado do aditivo que os specs dos efeitos e da aprovação leem (`ContractAddendumDetailDto`). */
export interface AddendumState extends AddendumListItem {
  effectsError: string | null;
  effectsErrorCode: string | null;
  effectsAppliedAt: string | null;
  requiresInternalApproval: boolean;
  returnNote: string | null;
  approvedAt: string | null;
  approvedByName: string | null;
}

/** `GET /api/addendums/{id}` com os campos de efeitos e de aprovação. */
export async function apiGetAddendumState(api: APIRequestContext, addendumId: string): Promise<AddendumState> {
  return (await apiGetAddendum(api, addendumId)) as AddendumState;
}

/**
 * Espera o outbox entregar a formalização (AD-D): o `effectsStatus` sai de
 * `Pending`. O publicador varre a cada 5 s; o teto cobre a fila do modo leve.
 */
export async function waitForAddendumEffects(
  api: APIRequestContext,
  addendumId: string,
  timeoutMs = 60_000,
): Promise<AddendumState> {
  await expect
    .poll(async () => (await apiGetAddendumState(api, addendumId)).effectsStatus, {
      message: `efeitos do aditivo ${addendumId} saem de Pending`,
      timeout: timeoutMs,
      intervals: [1_000],
    })
    .not.toBe('Pending');
  return apiGetAddendumState(api, addendumId);
}

/** Resposta do `GET /api/events/{id}/pending-contract-changes` (`PendingContractChangeDto`), no que os specs leem. */
export interface PendingContractChange {
  addendumId: string;
  contractId: string;
  addendumNumber: number;
  status: string;
  revision: number;
  requiresInternalApproval: boolean;
  financialImpact: number | null;
  changeSet: Record<string, unknown>;
}

/** `GET /api/events/{id}/pending-contract-changes`: o aditivo aberto da festa, ou `null`. */
export async function apiGetPendingContractChange(
  api: APIRequestContext,
  eventId: string,
): Promise<PendingContractChange | null> {
  const res = await api.get(`/api/events/${eventId}/pending-contract-changes`);
  await assertOk(res, 'GET /api/events/{id}/pending-contract-changes');
  const body = (await res.json()) as { data?: PendingContractChange | null };
  return body.data ?? null;
}

/**
 * Plano em 3 parcelas (vencem em 3, 7 e 10 dias) com o sinal pago, como a massa
 * do 9.8 e do 9.13; devolve as parcelas depois do pagamento.
 */
export async function apiPlanInThreeWithDepositPaid(api: APIRequestContext, eventId: string): Promise<EventInstallment[]> {
  const dayPlus = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const total = (await apiGetPaymentSummary(api, eventId)).eventTotal;
  const part = Math.floor((total / 3) * 100) / 100;
  const last = Math.round((total - part * 2) * 100) / 100;
  const plan = await apiCreatePaymentPlan(api, eventId, [
    { order: 1, label: 'Sinal', expectedAmount: part, dueDate: dayPlus(3) },
    { order: 2, label: 'Segunda parcela', expectedAmount: part, dueDate: dayPlus(7) },
    { order: 3, label: 'Quitação', expectedAmount: last, dueDate: dayPlus(10) },
  ]);
  const deposit = plan.installments.find((i) => i.order === 1)!;
  await apiRegisterPayment(api, eventId, { amount: deposit.expectedAmount, method: 'Pix', installmentId: deposit.id });
  return (await apiGetPaymentPlan(api, eventId))!.installments;
}

/** Festa com contrato formalizado por aceite manual e o plano em 3 parcelas com o sinal pago. */
export async function setupFormalizedContractWithPlan(
  api: APIRequestContext,
  tenantId: string,
): Promise<{ contractId: string; eventId: string; templateId: string; clienteId: string; installments: EventInstallment[] }> {
  const draft = await setupDraftContract(api, tenantId);
  const installments = await apiPlanInThreeWithDepositPaid(api, draft.eventId);
  await apiFormalizeContractManually(api, draft.contractId);
  return { ...draft, installments };
}

/** O link de aceite do aditivo (`AddendumPublicLinkDto`) e o token, que é o último segmento do endereço. */
export interface AddendumPublicLink {
  url: string;
  expiresAt: string;
  token: string;
}

/** O token do endereço `<front>/addendums/<token>`. */
export function addendumTokenFromUrl(url: string): string {
  const token = new URL(url).pathname.split('/').filter(Boolean).at(-1);
  if (!token) throw new Error(`link de aceite sem token: ${url}`);
  return token;
}

/**
 * PDF da revisão atual + `POST /api/addendums/{id}/public-link` (Etapa 290): o
 * aditivo vai a "Enviado" e o back devolve o link. Devolve a resposta crua do
 * POST junto, para quem confere a recusa.
 */
export async function apiTryCreateAddendumPublicLink(api: APIRequestContext, addendumId: string): Promise<APIResponse> {
  await apiAddendumPdf(api, addendumId);
  return api.post(`/api/addendums/${addendumId}/public-link`);
}

/** Igual ao `apiTryCreateAddendumPublicLink`, mas lança se o back recusar. */
export async function apiCreateAddendumPublicLink(api: APIRequestContext, addendumId: string): Promise<AddendumPublicLink> {
  const res = await apiTryCreateAddendumPublicLink(api, addendumId);
  await assertOk(res, 'POST /api/addendums/{id}/public-link');
  const link = await readJson<{ url: string; expiresAt: string }>(res);
  return { ...link, token: addendumTokenFromUrl(link.url) };
}

/** A página pública do aditivo (`PublicAddendumDto`), no que os specs leem. */
export interface PublicAddendumView {
  status: 'Sent' | 'Formalized' | 'Rejected';
  companyName: string;
  contractNumber: string;
  addendumNumber: number;
  revision: number;
  reason: string;
  pdfSha256: string;
  acceptanceText: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedByFirstName: string | null;
  rejectedAt: string | null;
  clauseChanges: Array<{ operation: string; title: string; bodyHtml: string | null }>;
  changeSet: Record<string, unknown> | null;
}

/** `GET /api/public/addendums/{token}` com o contexto dado (anônimo ou com o Bearer de alguém). */
export async function apiGetPublicAddendum(api: APIRequestContext, token: string): Promise<PublicAddendumView> {
  const res = await api.get(`/api/public/addendums/${token}`);
  await assertOk(res, 'GET /api/public/addendums/{token}');
  return readJson<PublicAddendumView>(res);
}

/** `POST /api/public/addendums/{token}/accept` com o hash do PDF no header; devolve a resposta crua. */
export async function apiTryAcceptPublicAddendum(
  api: APIRequestContext,
  token: string,
  body: { name: string | null; document?: string | null },
  pdfSha256: string,
): Promise<APIResponse> {
  return api.post(`/api/public/addendums/${token}/accept`, {
    data: { name: body.name, document: body.document ?? null },
    headers: { 'X-Addendum-Pdf-Sha256': pdfSha256 },
  });
}

/**
 * O cliente aceita o aditivo pelo link, sem tela: gera o link (com o PDF), lê a
 * página pública anônima e aceita com o hash que ela traz. É a pré-condição de
 * quem precisa do aditivo formalizado pelo cliente (o estorno do 9.11).
 */
export async function apiAcceptAddendumByLink(api: APIRequestContext, addendumId: string): Promise<AddendumPublicLink> {
  const link = await apiCreateAddendumPublicLink(api, addendumId);
  const anon = await createPublicApiContext();
  try {
    const page = await apiGetPublicAddendum(anon, link.token);
    await assertOk(
      await apiTryAcceptPublicAddendum(anon, link.token, { name: 'Cliente E2E Link' }, page.pdfSha256),
      'POST /api/public/addendums/{token}/accept',
    );
  } finally {
    await anon.dispose();
  }
  return link;
}

/** O estorno pré-montado (`AddendumReversalDraftDto`), no que os specs leem. */
export interface AddendumReversalDraft {
  originalAddendumId: string;
  originalAddendumNumber: number;
  contractId: string;
  eventId: string | null;
  hasEventScope: boolean;
  change: Record<string, unknown> | null;
  suggestedPayment: { mode: string; installmentCount: number | null } | null;
  clauses: ClauseOperation[];
}

/** `GET /api/addendums/{id}/reversal-draft`; devolve a resposta crua. */
export async function apiTryGetReversalDraft(api: APIRequestContext, addendumId: string): Promise<APIResponse> {
  return api.get(`/api/addendums/${addendumId}/reversal-draft`);
}

/** Igual ao `apiTryGetReversalDraft`, mas lança se o back recusar. */
export async function apiGetReversalDraft(api: APIRequestContext, addendumId: string): Promise<AddendumReversalDraft> {
  const res = await apiTryGetReversalDraft(api, addendumId);
  await assertOk(res, 'GET /api/addendums/{id}/reversal-draft');
  return readJson<AddendumReversalDraft>(res);
}

/** O corpo de erro do back: `errors[].code` e `description`, e o `data` (metadata dos 409). */
export async function apiErrorBody(
  res: APIResponse,
): Promise<{ codes: string[]; descriptions: string[]; data: Record<string, unknown> | null }> {
  const body = (await res.json()) as {
    errors?: Array<{ code: string; description: string }>;
    data?: Record<string, unknown> | null;
  };
  return {
    codes: (body.errors ?? []).map((e) => e.code),
    descriptions: (body.errors ?? []).map((e) => e.description),
    data: body.data ?? null,
  };
}
