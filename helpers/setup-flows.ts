import { APIRequestContext, Browser, BrowserContext, Page, request as playwrightRequest } from '@playwright/test';
import { apiCreateActivity, apiCreateClient, apiCreateCollaborator } from './api-entities';
import {
  apiAcceptPublicBudget,
  apiCreateBudget,
  apiCreatePaymentPlan,
  apiGetPaymentSummary,
  apiPatchEvent,
  apiRegisterPayment,
  apiSendBudget,
  CreateBudgetInput,
  createPublicApiContext,
  extractTokenFromPublicUrl,
  publicAcceptBody,
} from './api-event-flow';
import { enableFeatureFlagDirect, seedCollaboratorPortalUserDirect, seedUserWithRoleDirect } from './db-helper';
import { fakeClicksign } from './fake-providers';
import { loginViaApi } from './api-client';
import { assertOk, readJson } from './response';

const BACK_URL = process.env.BACK_URL ?? 'https://localhost:1501';
const FRONT_URL = process.env.FRONT_URL ?? 'http://localhost:4200';
const DAY_MS = 86_400_000;

/** `iso` (YYYY-MM-DD) deslocada de `days` dias. */
function shiftIsoDate(iso: string, days: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Data em que o orçamento de uma festa em `eventDate` pode nascer, e quantos
 * dias ela foi adiantada. A validade do orçamento fica entre hoje e a véspera
 * da festa; o "hoje" do back é a data UTC ou a do tenant (Brasília), que nunca
 * passa da UTC. Véspera antes da data UTC de hoje não tem validade possível:
 * a festa de hoje (domingo do card da Home) e a de amanhã de sexta das 21:00
 * à meia-noite de Brasília, quando o UTC já virou sábado. Essas nascem em hoje
 * UTC + 2 e voltam para a data pedida depois do aceite.
 */
function budgetDateFor(eventDate: string): { date: string; shiftDays: number } {
  const utcToday = new Date().toISOString().slice(0, 10);
  if (shiftIsoDate(eventDate, -1) >= utcToday) return { date: eventDate, shiftDays: 0 };
  const safe = shiftIsoDate(utcToday, 2);
  const shiftDays = Math.round((Date.parse(`${safe}T00:00:00Z`) - Date.parse(`${eventDate}T00:00:00Z`)) / DAY_MS);
  return { date: safe, shiftDays };
}

/**
 * Cria a cadeia completa cliente -> atividade -> orcamento -> envio ->
 * aceite publico (sem fixture) e devolve o eventId resultante + ids
 * intermediarios. Elimina ~17 linhas de duplicacao em 6.x, 7.x, 9.x, 10.x.
 *
 * Uso:
 *   const { eventId, clienteId, orcamentoId } = await setupAcceptedEvent(authApi);
 *
 * `opts.clientId` reaproveita um cliente existente (duas festas do mesmo
 * cliente); `opts.budget` troca data, horário e crianças do orçamento.
 * `opts.activityIds` usa atividades já criadas (com requisito de habilidade ou
 * insumo) no lugar de uma nova. Com `opts.budget.address`, o aceite manda
 * `address: null` e o evento herda o endereço estruturado do orçamento (com a
 * coordenada); sem ele, o corpo padrão do aceite.
 *
 * Festa cuja véspera já passou na data UTC (hoje; amanhã de sexta à noite em
 * Brasília) não nasce por orçamento: o orçamento sai numa data segura e o
 * evento volta para `opts.budget.eventDate` por `PATCH /api/events/{id}` depois
 * do aceite (`budgetDateFor`). Vale com o back validando pela data UTC ou pela
 * do tenant.
 */
export async function setupAcceptedEvent(
  api: APIRequestContext,
  opts: {
    clientId?: string;
    activityIds?: string[];
    budget?: Partial<Omit<CreateBudgetInput, 'clientId' | 'activityIds'>>;
  } = {},
): Promise<{
  eventId: string;
  clienteId: string;
  atividadeId: string;
  orcamentoId: string;
  budgetTotal: number;
}> {
  const clienteId = opts.clientId ?? (await apiCreateClient(api)).id;
  const activityIds = opts.activityIds ?? [(await apiCreateActivity(api)).id];
  const wantedDate = opts.budget?.eventDate;
  const relocation = wantedDate ? budgetDateFor(wantedDate) : { date: undefined, shiftDays: 0 };
  const endDate = opts.budget?.eventEndDate;
  const orcamento = await apiCreateBudget(api, {
    ...opts.budget,
    ...(relocation.shiftDays > 0
      ? {
          eventDate: relocation.date,
          eventEndDate: endDate ? shiftIsoDate(endDate, relocation.shiftDays) : undefined,
        }
      : {}),
    clientId: clienteId,
    activityIds,
  });
  const sent = await apiSendBudget(api, orcamento.id);
  const token = extractTokenFromPublicUrl(sent.publicUrl);

  const acceptBody = opts.budget?.address
    ? { ...publicAcceptBody(), address: null }
    : publicAcceptBody();

  const publicApi = await createPublicApiContext();
  try {
    const aceito = await apiAcceptPublicBudget(publicApi, token, acceptBody);
    // Só a data: o domínio desloca o fim mantendo a diferença de dias.
    if (relocation.shiftDays > 0 && wantedDate) {
      await apiPatchEvent(api, aceito.eventId, { eventDate: wantedDate });
    }
    return {
      eventId: aceito.eventId,
      clienteId,
      atividadeId: activityIds[0]!,
      orcamentoId: orcamento.id,
      budgetTotal: (orcamento as unknown as { total?: number }).total ?? 0,
    };
  } finally {
    await publicApi.dispose();
  }
}

/**
 * Festa aceita e QUITADA numa parcela única: plano com uma parcela do total
 * do evento e um Pix do mesmo valor nela. É a pré-condição do crédito ao
 * cliente (Etapa 198), que só devolve o que já foi pago na parcela.
 */
export async function setupPaidEvent(
  api: APIRequestContext,
  opts: Parameters<typeof setupAcceptedEvent>[1] = {},
): Promise<{ eventId: string; clienteId: string; installmentId: string; total: number }> {
  const { eventId, clienteId } = await setupAcceptedEvent(api, opts);
  const { eventTotal } = await apiGetPaymentSummary(api, eventId);
  const due = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const plan = await apiCreatePaymentPlan(api, eventId, [
    { order: 1, label: 'Parcela única', expectedAmount: eventTotal, dueDate: due },
  ]);
  const installmentId = plan.installments[0]!.id;
  await apiRegisterPayment(api, eventId, { amount: eventTotal, method: 'Pix', installmentId });
  return { eventId, clienteId, installmentId, total: eventTotal };
}

/**
 * Contrato em rascunho de um evento aceito: aceite -> template + cláusula
 * ativos -> create contract. Ainda não enviado para assinatura. Liga
 * `feature_digital_signature` para o envio que o chamador fizer depois.
 */
export async function setupDraftContract(
  api: APIRequestContext,
  tenantId: string,
): Promise<{ contractId: string; eventId: string; templateId: string; clienteId: string }> {
  enableFeatureFlagDirect(tenantId, 'feature_digital_signature');
  const { eventId, clienteId } = await setupAcceptedEvent(api);

  // Layout pra usar como base do template
  const layoutsRes = await api.get('/api/contract-layouts');
  await assertOk(layoutsRes, 'GET /api/contract-layouts');
  const layoutsBody = (await layoutsRes.json()) as
    | { data?: Array<{ key: string }> | { items: Array<{ key: string }> } }
    | Array<{ key: string }>;
  const layoutsArr = Array.isArray(layoutsBody)
    ? layoutsBody
    : Array.isArray(layoutsBody.data)
      ? layoutsBody.data
      : (layoutsBody.data as { items: Array<{ key: string }> })?.items ?? [];
  const layoutKey = layoutsArr[0]?.key;
  if (!layoutKey) {
    throw new Error('Catalogo de layouts vazio — back nao seedou ContractLayouts');
  }

  // Template
  const tplRes = await api.post('/api/contract-templates', {
    data: {
      name: `Template E2E ${Date.now()}`,
      description: 'Template setupFormalizedContract',
      type: 'ClientIndividual',
      layoutKey,
      header: 'Cabecalho',
      footer: 'Rodape',
      showLogo: true,
    },
  });
  await assertOk(tplRes, 'POST /api/contract-templates');
  const template = await readJson<{ id: string }>(tplRes);

  // Clausula minima ativa
  const clauseRes = await api.post('/api/clauses', {
    data: {
      title: `Clausula E2E ${Date.now()}`,
      category: 'Geral',
      // `ClauseApplicability` é flags e o DTO recebe o número (1 = pessoa física).
      applicableTo: 1,
      isRequired: false,
      suggestedOrder: 1,
      bodyHtml: '<p>Clausula de teste.</p>',
      bodyPlain: 'Clausula de teste.',
    },
  });
  await assertOk(clauseRes, 'POST /api/clauses');
  const clause = await readJson<{ id: string }>(clauseRes);

  const issueRes = await api.post(`/api/clauses/${clause.id}/versions`, {
    data: { bodyHtml: '<p>Clausula de teste.</p>', bodyPlain: 'Clausula de teste.' },
  });
  await assertOk(issueRes, 'POST clause version');
  const issued = await readJson<{ id?: string; versionId?: string }>(issueRes);
  const versionId = issued.id ?? issued.versionId;
  if (!versionId) throw new Error('Issue version nao devolveu id');

  await assertOk(
    await api.post(`/api/clauses/${clause.id}/versions/${versionId}/activate`),
    'activate clause version',
  );
  await assertOk(
    await api.put(`/api/contract-templates/${template.id}/clauses`, {
      data: { clauses: [{ clauseId: clause.id, order: 1 }] },
    }),
    'PUT template clauses',
  );
  await assertOk(
    await api.post(`/api/contract-templates/${template.id}/activate`),
    'activate template',
  );

  // Contract
  const contractRes = await api.post('/api/contracts', {
    data: { eventId, templateId: template.id },
  });
  await assertOk(contractRes, 'POST /api/contracts');
  const contract = await readJson<{ id: string }>(contractRes);
  return { contractId: contract.id, eventId, templateId: template.id, clienteId };
}

/**
 * Setup completo de contrato Formalized: `setupDraftContract` -> send digital
 * signature -> webhook 'sign' via fake ClickSign HMAC real. Devolve
 * contractId + envelope + eventId.
 *
 * Substitui ~80 linhas duplicadas em 9.3, 9.4 e futuros specs que
 * precisam de contrato assinado.
 *
 * Requer: `feature_digital_signature` ativo (helper ativa automaticamente).
 */
export async function setupFormalizedContract(
  api: APIRequestContext,
  tenantId: string,
): Promise<{
  contractId: string;
  eventId: string;
  templateId: string;
  envelope: { providerDocumentKey: string; providerSignerKey?: string };
}> {
  const { contractId, eventId, templateId } = await setupDraftContract(api, tenantId);
  const contract = { id: contractId };

  // Envia pra assinatura digital
  await assertOk(
    await api.post(`/api/contracts/${contract.id}/digital-signature/send`, {
      data: {
        signerName: 'Cliente E2E',
        signerEmail: 'cliente@e2e.test',
        deliveryChannel: 'Email',
        message: 'Por favor, assine.',
      },
    }),
    'POST send digital-signature',
  );

  // Le envelope pra pegar providerDocumentKey
  const envRes = await api.get(`/api/contracts/${contract.id}/digital-signature`);
  await assertOk(envRes, 'GET digital-signature envelope');
  const envelope = await readJson<{
    providerDocumentKey: string;
    providerSignerKey?: string;
  }>(envRes);

  // Webhook sign via fake ClickSign HMAC -> back formaliza contrato
  const trigger = await fakeClicksign.triggerWebhook({
    event: 'sign',
    providerDocumentKey: envelope.providerDocumentKey,
    providerSignerKey: envelope.providerSignerKey,
  });
  if (trigger.backStatus !== 200) {
    throw new Error(`webhook sign retornou ${trigger.backStatus}: ${trigger.backBody}`);
  }

  return {
    contractId: contract.id,
    eventId,
    templateId,
    envelope,
  };
}

/** Sessão de um usuário logado pela API (papel do tenant ou Portal). */
export interface RoleSession {
  /** API autenticada como o usuário; o chamador faz `dispose()`. */
  api: APIRequestContext;
  tokens: { accessToken: string; refreshToken: string };
  email: string;
}

async function loginAndContext(email: string, password: string): Promise<RoleSession> {
  const anon = await playwrightRequest.newContext({
    baseURL: BACK_URL,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { 'Content-Type': 'application/json' },
  });
  const tokens = await loginViaApi(anon, email, password).finally(() => anon.dispose());
  const api = await playwrightRequest.newContext({
    baseURL: BACK_URL,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens.accessToken}` },
  });
  return { api, tokens, email };
}

/** Página num contexto de navegador próprio, já logada com os tokens dados. */
export interface SessionPage {
  page: Page;
  context: BrowserContext;
}

/**
 * Abre um contexto de navegador NOVO com a sessão destes tokens (molde do
 * `13.4` e do `1.3`): o `localStorage` dele não tem o init script do
 * `authPage`, então a sessão não depende da ordem dos init scripts. O chamador
 * fecha com `context.close()`.
 */
export async function openSessionPage(
  browser: Browser,
  tokens: { accessToken: string; refreshToken: string },
): Promise<SessionPage> {
  const context = await browser.newContext({ baseURL: FRONT_URL, ignoreHTTPSErrors: true });
  await context.addInitScript(
    ({ access, refresh }) => {
      localStorage.setItem('access_token', access);
      if (refresh) localStorage.setItem('refresh_token', refresh);
    },
    { access: tokens.accessToken, refresh: tokens.refreshToken ?? null },
  );
  return { page: await context.newPage(), context };
}

/**
 * Usuário de verdade com o papel dado no tenant (não stub de permissão):
 * `seedUserWithRoleDirect` + login pela API. Para navegar como ele, abra a
 * página com `openSessionPage(browser, session.tokens)`.
 */
export async function loginAsRole(
  tenantId: string,
  role: 'Owner' | 'Admin' | 'Manager' | 'Financial',
): Promise<RoleSession> {
  const user = seedUserWithRoleDirect({ tenantId, role, emailPrefix: role.toLowerCase() });
  return loginAndContext(user.email, user.password);
}

/**
 * Login no Portal de um colaborador JÁ existente (o `setupPortalUser` cria um
 * novo): usuário `CollaboratorPortal` semeado por SQL + login pela API.
 */
export async function loginPortalCollaborator(tenantId: string, collaboratorId: string): Promise<RoleSession> {
  const user = seedCollaboratorPortalUserDirect({ tenantId, collaboratorId });
  return loginAndContext(user.email, user.password);
}

/** POST /api/portal/availability/overrides — o colaborador declara que NÃO está disponível no dia. */
export async function portalDeclareUnavailable(
  portalApi: APIRequestContext,
  date: string,
  reason = 'Indisponível (E2E)',
): Promise<void> {
  const res = await portalApi.post('/api/portal/availability/overrides', {
    data: { date, isAvailable: false, reason },
  });
  await assertOk(res, 'POST /api/portal/availability/overrides');
}

/** POST /api/portal/my-events/{id}/decline — o colaborador recusa a escalação. */
export async function portalDeclineEvent(
  portalApi: APIRequestContext,
  eventId: string,
  reason = 'Não vou conseguir (E2E)',
): Promise<void> {
  const res = await portalApi.post(`/api/portal/my-events/${eventId}/decline`, { data: { reason } });
  await assertOk(res, 'POST /api/portal/my-events/{id}/decline');
}

/**
 * Cria Collaborator (via admin) + User CollaboratorPortal (via SQL com
 * hash reusado do superadmin) e faz login (`loginAndContext`). Devolve um
 * APIRequestContext ja autenticado como portal user + o collaboratorId.
 *
 * IMPORTANTE: o caller eh responsavel por chamar `.dispose()` no
 * `portalApi` retornado pra evitar leak.
 *
 * Substitui ~30 linhas duplicadas em 13.spec.
 */
export async function setupPortalUser(
  authApi: APIRequestContext,
  tenantId: string,
): Promise<{
  portalApi: APIRequestContext;
  collaboratorId: string;
  email: string;
  /** Tokens do usuário de portal — para injetar no localStorage de uma Page (UI do Portal). */
  tokens: { accessToken: string; refreshToken: string };
  /**
   * Mantido para os chamadores antigos: o contexto anônimo do login já é
   * descartado pelo `loginAndContext`, então não há nada a liberar.
   */
  publicApiDispose: () => Promise<void>;
}> {
  const colab = await apiCreateCollaborator(authApi);
  const portalUser = seedCollaboratorPortalUserDirect({
    tenantId,
    collaboratorId: colab.id,
  });
  const session = await loginAndContext(portalUser.email, portalUser.password);

  return {
    portalApi: session.api,
    collaboratorId: colab.id,
    email: portalUser.email,
    tokens: session.tokens,
    publicApiDispose: async () => {},
  };
}
