import { APIRequestContext, mergeTests } from '@playwright/test';

import { authTest, expect } from '../../fixtures/auth.fixture';
import { superAdminTest } from '../../fixtures/super-admin.fixture';
import { twoTenantsTest } from '../../fixtures/two-tenants.fixture';
import { addSessionToContext } from '../../helpers/api-client';
import { apiCompleteOnboarding } from '../../helpers/api-entities';
import { enableFeatureFlagDirect, seedWhatsappChannelDirect, tenantRowCountDirect } from '../../helpers/db-helper';
import { fakeOpenAi } from '../../helpers/fake-providers';
import { assertOk, readJson, unwrapList } from '../../helpers/response';
import {
  apiConversationIdByPhone,
  apiListMessages,
  enableWhatsAppFeaturesDirect,
  receiveInbound,
  uid,
  uniquePhoneE164,
} from '../../helpers/whatsapp-flow';
import { backendUtcMs, waitForWorkerCycleAfter } from '../../helpers/workers';

/**
 * Fluxo: 33 — Extração de conversa pela fila própria
 * Diagrama: — (o plano é a fonte: PLANO-EXECUCAO-DOS-WORKERS §6 regra 1, D11,
 * WK-D, Etapa 265; registro e2e E17 e E18)
 *
 * E17: com a Inteligência de Conversas ligada, três mensagens seguidas do
 * cliente pelo WhatsApp (webhook assinado do fake) geram UMA sugestão, depois de
 * a conversa assentar (o item da fila nasce com `DebounceUntil` = hora da
 * mensagem + 90 s e cada mensagem nova empurra o prazo); a mesma conversa não
 * gera de novo sem mensagem nova (o desfecho fecha o item); uma mensagem nova
 * reabre o item e gera a sugestão da janela nova.
 *
 * E18: o mesmo número escreve para a empresa A (extração ligada) e para a B
 * (add-on contratado, extração desligada): só A ganha item na fila e sugestão;
 * nada da conversa de A aparece na fila, na API nem na tela de B.
 *
 * O ritmo é o do produto, sem atalho: o debounce de 90 s é constante do domínio
 * e o `ConversationExtractionWorker` roda a cada 30 s, então cada janela leva
 * de 2 a 3 minutos. O "rodar agora" do Super Admin não encurta nada (o worker só
 * consulta o pedido a cada até 60 s e o debounce vale do mesmo jeito). Por isso
 * as esperas são `expect.poll` com teto explícito, e "não gerou de novo" espera
 * um ciclo inteiro do worker pelo `lastSucceededAt` (helpers/workers.ts).
 *
 * A IA é o fake da OpenAI com resposta roteirizada pelo marcador único da janela
 * (`scriptNext`, uma resposta por janela); chamada a mais cai na resposta padrão
 * do fake, sem `extractions`, e aparece no inbox: é o inbox que conta quantas
 * vezes a janela foi à IA.
 */

const test = mergeTests(authTest, superAdminTest, twoTenantsTest);

const EXTRACTION_WORKER = 'ConversationExtractionWorker';
/** Período do `ConversationExtractionWorker`. */
const WORKER_PERIOD_MS = 30_000;
/** Debounce do item da fila (`ConversationExtractionWork.DebounceWindow`). */
const DEBOUNCE_MS = 90_000;
/** Debounce + até dois ciclos do worker + Outbox do evento de inbound, com folga para a máquina carregada. */
const EXTRACTION_TIMEOUT = 300_000;
const POLL_INTERVALS = [5_000];
const SUGGESTIONS_ROUTE = '/app/conversation-intelligence';

interface AiExtraction {
  id: string;
  conversationId: string;
  lastMessageId: string;
  type: string;
  payloadJson: string;
  status: string;
  createdAt: string;
}

/** Add-on contratado (entitlement) e o canal do tenant; a extração em si é a config. */
function prepareTenant(tenantId: string): string {
  enableWhatsAppFeaturesDirect(tenantId);
  enableFeatureFlagDirect(tenantId, 'feature_ai');
  enableFeatureFlagDirect(tenantId, 'feature_ai_conversations');
  return seedWhatsappChannelDirect(tenantId);
}

/** Liga a extração só com resumo e próximo passo (fica `Pending`: nenhum auto-aplicar). */
async function apiEnableExtraction(api: APIRequestContext): Promise<void> {
  const res = await api.put('/api/conversation-intelligence/config', {
    data: {
      enabled: true,
      extractLeads: false,
      extractBudgets: false,
      extractPayments: false,
      summarize: true,
      autoApplyLeads: false,
      autoApplyBudgets: false,
      autoApplySummaries: false,
      autoApplyMinConfidence: 0.8,
      contextWindowMessages: 20,
    },
  });
  await assertOk(res, 'PUT /api/conversation-intelligence/config');
}

async function apiExtractionEnabled(api: APIRequestContext): Promise<boolean> {
  const res = await api.get('/api/conversation-intelligence/config');
  await assertOk(res, 'GET /api/conversation-intelligence/config');
  return (await readJson<{ enabled: boolean }>(res)).enabled;
}

async function apiConversationExtractions(api: APIRequestContext, conversationId: string): Promise<AiExtraction[]> {
  const res = await api.get(`/api/conversation-intelligence/conversations/${conversationId}/extractions`);
  await assertOk(res, 'GET /api/conversation-intelligence/conversations/{id}/extractions');
  return readJson<AiExtraction[]>(res);
}

/** Sugestões do tenant em qualquer situação (a central lista as pendentes). */
async function apiAllExtractions(api: APIRequestContext): Promise<AiExtraction[]> {
  const res = await api.get('/api/conversation-intelligence/extractions?page=1&pageSize=100');
  await assertOk(res, 'GET /api/conversation-intelligence/extractions');
  return unwrapList<AiExtraction>(res);
}

/** Resposta da IA com uma sugestão de resumo (o tipo habilitado na config). */
function summaryResponse(summary: string): string {
  return JSON.stringify({
    extractions: [
      {
        type: 'SummaryAndNextStep',
        confidence: 0.9,
        data: { summary, nextStep: 'Enviar o orçamento' },
      },
    ],
  });
}

/** Chamadas à IA desde `since` cujo prompt cita o marcador (a janela de mensagens vai no prompt). */
async function aiCallsMentioning(marker: string, since: string): Promise<number> {
  const inbox = await fakeOpenAi.inbox({ since });
  return inbox.filter((e) => e.method === 'POST' && JSON.stringify(e.body ?? '').includes(marker)).length;
}

/** Espera a conversa ter `count` sugestões e devolve a lista. */
async function waitForExtractions(
  api: APIRequestContext,
  conversationId: string,
  count: number,
  message: string,
): Promise<AiExtraction[]> {
  let items: AiExtraction[] = [];
  await expect
    .poll(
      async () => {
        items = await apiConversationExtractions(api, conversationId);
        return items.length;
      },
      { message, timeout: EXTRACTION_TIMEOUT, intervals: POLL_INTERVALS },
    )
    .toBeGreaterThanOrEqual(count);
  return items;
}

test.describe('Fluxo 33 — Extração de conversa pela fila própria', () => {
  // ─── E17 — Debounce, uma sugestão por janela e reabertura ───────────────
  test('E17 @flow three messages in a row generate one suggestion after the conversation settles; no new suggestion without a new message; a new message generates the suggestion of the new window', async ({
    authApi,
    authPage,
    tenant,
    superAdminApi,
  }) => {
    test.setTimeout(2 * EXTRACTION_TIMEOUT + 300_000);
    const phoneNumberId = prepareTenant(tenant.tenantId);
    await apiEnableExtraction(authApi);
    await apiCompleteOnboarding(authApi);

    const tag = uid();
    const firstWindow = `janela1${tag}`;
    const secondWindow = `janela2${tag}`;
    const firstSummary = `Cliente quer festa para 15 criancas ${tag}`;
    const secondSummary = `Cliente confirmou o sabado ${tag}`;
    const phone = uniquePhoneE164();
    const since = new Date(Date.now() - 1_000).toISOString();
    await fakeOpenAi.scriptNext(firstWindow, summaryResponse(firstSummary));

    // Três mensagens seguidas, em segundos distintos: a última manda no debounce.
    const t0 = Math.floor(Date.now() / 1000) - 3;
    await receiveInbound(phoneNumberId, phone, `Oi! Queria orcar uma festa ${firstWindow} (1/3)`, { timestamp: t0 });
    await receiveInbound(phoneNumberId, phone, `Seria no sabado ${firstWindow} (2/3)`, { timestamp: t0 + 1 });
    await receiveInbound(phoneNumberId, phone, `Umas 15 criancas ${firstWindow} (3/3)`, { timestamp: t0 + 2 });
    const conversationId = await apiConversationIdByPhone(authApi, phone);
    const third = (await apiListMessages(authApi, conversationId)).find((m) => m.body?.includes('(3/3)'));
    expect(third, 'a terceira mensagem gravada na conversa').toBeTruthy();

    // Uma sugestão só, da janela até a terceira mensagem, depois de assentar.
    const afterFirst = await waitForExtractions(authApi, conversationId, 1, 'sugestão da primeira janela');
    expect(afterFirst, 'três mensagens seguidas, uma sugestão').toHaveLength(1);
    const first = afterFirst[0]!;
    expect(first.type).toBe('SummaryAndNextStep');
    expect(first.status).toBe('Pending');
    expect(first.lastMessageId, 'a janela vai até a última mensagem').toBe(third!.id);
    expect(first.payloadJson).toContain(firstSummary);
    expect(
      backendUtcMs(first.createdAt),
      'a sugestão só nasce depois do debounce contado da última mensagem',
    ).toBeGreaterThanOrEqual(backendUtcMs(third!.occurredAt) + DEBOUNCE_MS);
    expect(await aiCallsMentioning(firstWindow, since), 'a janela foi à IA uma vez').toBe(1);

    // Um ciclo inteiro do worker depois, sem mensagem nova: nada se repete.
    await waitForWorkerCycleAfter(superAdminApi, EXTRACTION_WORKER, backendUtcMs(first.createdAt) + WORKER_PERIOD_MS + 1_000, {
      message: 'um ciclo do worker depois da sugestão',
    });
    expect(await apiConversationExtractions(authApi, conversationId), 'sem mensagem nova, sem sugestão nova').toHaveLength(1);
    expect(await aiCallsMentioning(firstWindow, since), 'a mesma janela não volta à IA').toBe(1);
    expect(tenantRowCountDirect(tenant.tenantId, 'ConversationExtractionWorks'), 'um item por conversa').toBe(1);

    // A central de sugestões mostra a sugestão uma vez.
    await authPage.goto(SUGGESTIONS_ROUTE);
    await expect(authPage.getByTestId('ci-list')).toBeVisible({ timeout: 30_000 });
    await expect(authPage.getByTestId('ci-card').filter({ hasText: firstSummary })).toHaveCount(1);

    // Mensagem nova: o item reabre e a janela nova gera a própria sugestão.
    await fakeOpenAi.scriptNext(secondWindow, summaryResponse(secondSummary));
    await receiveInbound(phoneNumberId, phone, `Fechado, pode ser no sabado ${secondWindow}`);
    const fourth = (await apiListMessages(authApi, conversationId)).find((m) => m.body?.includes(secondWindow));
    expect(fourth, 'a mensagem nova gravada na conversa').toBeTruthy();

    const afterSecond = await waitForExtractions(authApi, conversationId, 2, 'sugestão da janela nova');
    expect(afterSecond, 'uma sugestão por janela').toHaveLength(2);
    const second = afterSecond.find((x) => x.id !== first.id)!;
    expect(second.lastMessageId, 'a janela nova vai até a mensagem nova').toBe(fourth!.id);
    expect(second.payloadJson).toContain(secondSummary);
    expect(await aiCallsMentioning(secondWindow, since), 'a janela nova foi à IA uma vez').toBe(1);

    await authPage.reload();
    await expect(authPage.getByTestId('ci-list')).toBeVisible({ timeout: 30_000 });
    await expect(authPage.getByTestId('ci-card').filter({ hasText: secondSummary })).toHaveCount(1);
    await expect(authPage.getByTestId('ci-card').filter({ hasText: firstSummary })).toHaveCount(1);
  });

  // ─── E18 — Só o tenant com a extração ligada ganha item e sugestão ──────
  test('E18 @flow the same number writes to company A (extraction on) and B (extraction off): only A gets a suggestion, and nothing of A shows up in the queue, the API or the screen of B', async ({
    tenantA,
    tenantB,
    apiA,
    apiB,
    page,
  }) => {
    test.setTimeout(EXTRACTION_TIMEOUT + 180_000);
    const channelA = prepareTenant(tenantA.tenantId);
    const channelB = prepareTenant(tenantB.tenantId);
    await apiEnableExtraction(apiA);
    expect(await apiExtractionEnabled(apiB), 'B contratou o add-on mas não ligou a extração').toBe(false);

    const tag = uid();
    const markerA = `empresaA${tag}`;
    const markerB = `empresaB${tag}`;
    const summaryA = `Resumo da empresa A ${tag}`;
    const summaryB = `Resumo da empresa B ${tag}`;
    const since = new Date(Date.now() - 1_000).toISOString();
    // B também tem resposta roteirizada: se a conversa de B fosse à IA, viraria sugestão.
    await fakeOpenAi.scriptNext(markerA, summaryResponse(summaryA));
    await fakeOpenAi.scriptNext(markerB, summaryResponse(summaryB));

    // Mesmo número, uma mensagem para cada empresa; a de B chega primeiro, então
    // o prazo dela vence antes do de A.
    const phone = uniquePhoneE164();
    await receiveInbound(channelB, phone, `Oi, quero orcar uma festa ${markerB}`);
    await receiveInbound(channelA, phone, `Oi, quero orcar uma festa ${markerA}`);
    const conversationA = await apiConversationIdByPhone(apiA, phone);
    const conversationB = await apiConversationIdByPhone(apiB, phone);
    expect(conversationA, 'uma conversa por empresa').not.toBe(conversationB);

    const extractionsA = await waitForExtractions(apiA, conversationA, 1, 'sugestão da empresa A');
    expect(extractionsA).toHaveLength(1);
    expect(extractionsA[0]!.payloadJson).toContain(summaryA);
    expect(tenantRowCountDirect(tenantA.tenantId, 'ConversationExtractionWorks'), 'item na fila de A').toBe(1);

    // B: sem item na fila, sem chamada à IA, sem sugestão.
    expect(tenantRowCountDirect(tenantB.tenantId, 'ConversationExtractionWorks'), 'nenhum item na fila de B').toBe(0);
    expect(await aiCallsMentioning(markerB, since), 'a conversa de B não foi à IA').toBe(0);
    expect(await aiCallsMentioning(markerA, since), 'a conversa de A foi à IA uma vez').toBe(1);
    expect(await apiAllExtractions(apiB), 'nenhuma sugestão em B').toHaveLength(0);
    expect(await apiConversationExtractions(apiB, conversationB), 'a conversa de B sem sugestão').toHaveLength(0);
    expect(
      (await apiAllExtractions(apiA)).filter((x) => x.conversationId === conversationB),
      'nada de B na lista de A',
    ).toHaveLength(0);

    // B pedindo as sugestões da conversa de A pelo id: nada vem.
    const crossRes = await apiB.get(`/api/conversation-intelligence/conversations/${conversationA}/extractions`);
    if (crossRes.ok()) {
      expect(await readJson<AiExtraction[]>(crossRes), 'B não lê as sugestões da conversa de A').toHaveLength(0);
    } else {
      expect(crossRes.status(), 'B pedindo a conversa de A').toBe(404);
    }

    // A tela de B: a central de sugestões vazia, sem o resumo de A.
    await apiCompleteOnboarding(apiB);
    await addSessionToContext(page.context(), tenantB.refreshToken);
    await page.goto(SUGGESTIONS_ROUTE);
    await expect(page.getByTestId('ci-empty')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('ci-card')).toHaveCount(0);
    await expect(page.getByText(summaryA)).toHaveCount(0);
  });
});
