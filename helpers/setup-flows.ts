import { APIRequestContext, request as playwrightRequest } from '@playwright/test';
import { apiCreateActivity, apiCreateClient, apiCreateCollaborator } from './api-entities';
import {
  apiAcceptPublicBudget,
  apiCreateBudget,
  apiCreatePaymentPlan,
  apiGetPaymentSummary,
  apiRegisterPayment,
  apiSendBudget,
  CreateBudgetInput,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from './api-event-flow';
import { enableFeatureFlagDirect, seedCollaboratorPortalUserDirect } from './db-helper';
import { fakeClicksign } from './fake-providers';
import { loginViaApi } from './api-client';
import { assertOk, readJson } from './response';

const BACK_URL = process.env.BACK_URL ?? 'https://localhost:1501';

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
 */
export async function setupAcceptedEvent(
  api: APIRequestContext,
  opts: {
    clientId?: string;
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
  const atividade = await apiCreateActivity(api);
  const orcamento = await apiCreateBudget(api, {
    ...opts.budget,
    clientId: clienteId,
    activityIds: [atividade.id],
  });
  const sent = await apiSendBudget(api, orcamento.id);
  const token = extractTokenFromPublicUrl(sent.publicUrl);

  const publicApi = await createPublicApiContext();
  try {
    const aceito = await apiAcceptPublicBudget(publicApi, token);
    return {
      eventId: aceito.eventId,
      clienteId,
      atividadeId: atividade.id,
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

/**
 * Cria Collaborator (via admin) + User CollaboratorPortal (via SQL com
 * hash reusado do superadmin) e faz login. Devolve um APIRequestContext
 * ja autenticado como portal user + o collaboratorId.
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
  publicApiDispose: () => Promise<void>;
}> {
  const colab = await apiCreateCollaborator(authApi);
  const portalUser = seedCollaboratorPortalUserDirect({
    tenantId,
    collaboratorId: colab.id,
  });

  const publicApi = await playwrightRequest.newContext({
    baseURL: BACK_URL,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { 'Content-Type': 'application/json' },
  });
  let tokens: { accessToken: string; refreshToken: string };
  try {
    tokens = await loginViaApi(publicApi, portalUser.email, portalUser.password);
  } catch (err) {
    await publicApi.dispose();
    throw err;
  }

  const portalApi = await playwrightRequest.newContext({
    baseURL: BACK_URL,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokens.accessToken}`,
    },
  });

  return {
    portalApi,
    collaboratorId: colab.id,
    email: portalUser.email,
    tokens,
    publicApiDispose: async () => {
      await publicApi.dispose();
    },
  };
}
