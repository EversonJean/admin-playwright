import { randomUUID } from 'node:crypto';
import { APIRequestContext, Locator } from '@playwright/test';

import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createBearerMultipartContext } from '../../helpers/api-client';
import { apiCompleteOnboarding, apiCreateClient, apiSetAiFeature } from '../../helpers/api-entities';
import { apiGetPaymentSummary } from '../../helpers/api-event-flow';
import { pngBytes } from '../../helpers/binary-files';
import { enableFeatureFlagDirect, seedAiInsightDirect, seedWhatsappChannelDirect } from '../../helpers/db-helper';
import { fakeOpenAi, fakeWhatsApp } from '../../helpers/fake-providers';
import { assertOk, readJson, unwrapList } from '../../helpers/response';
import { RoleSession, loginAsRole, openSessionPage, setupAcceptedEvent } from '../../helpers/setup-flows';

/**
 * Fluxo: 14.5 — Ações por permissão: Financial só leitura e fila de mídia por dono
 * Diagrama: — (cenários E97 e E98 do registro e2e de `docs/implementados/PLANO-SEGURANCA.md`)
 *
 * Fonte do comportamento: PLANO-SEGURANCA §8 (SEG-F): item 5 (`api/media-jobs/{id}`
 * só para quem pediu ou Owner/Admin, 404 para os outros), item 6 (dispensar e
 * fixar insight e avaliar a previsão de caixa exigem permission de escrita) e
 * item 13 (botões do front da largura da permission do back: template na
 * conversa por `whatsapp.send`, troca de plano por `billing.changeplan`,
 * arrastar no calendário por `events.update`). A rota do dia fica de fora:
 * nenhum papel tem `routing.read` sem `routing.manage` (registro E97). O spec
 * afirma o plano; divergência é falha de código, não de asserção.
 */

function uid(): string {
  return Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
}

/** Data (YYYY-MM-DD) em Brasília daqui a `days` dias. */
function saoPauloDay(days = 0): string {
  const now = new Date(Date.now() + days * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(now);
}

/** Um dia ainda no mês corrente (o calendário abre no mês): amanhã, ou hoje no último dia. */
function dayInCurrentMonth(): string {
  const today = saoPauloDay(0);
  const tomorrow = saoPauloDay(1);
  return tomorrow.slice(0, 7) === today.slice(0, 7) ? tomorrow : today;
}

/** `1234.5` -> `1.234,50`, como o `C2` pt-BR do back escreve o número no prompt. */
function ptBrNumber(value: number): string {
  return value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Todos os CTAs de troca de plano estão desabilitados (o do plano atual nasce assim). */
async function enabledCount(locator: Locator): Promise<number> {
  let enabled = 0;
  for (const el of await locator.all()) if (await el.isEnabled()) enabled++;
  return enabled;
}

/** Conversa nova pela mensagem de entrada do fake, no canal próprio do tenant. */
async function inboundConversation(api: APIRequestContext, tenantId: string): Promise<string> {
  const phoneNumberId = seedWhatsappChannelDirect(tenantId);
  const phone = `+55419${String(Date.now()).slice(-7)}${Math.floor(Math.random() * 10)}`;
  const hook = await fakeWhatsApp.triggerWebhook({ kind: 'inbound', phoneNumberId, phone, text: 'Oi, quero um orçamento' });
  expect(hook.backStatus, `webhook inbound: ${hook.backBody}`).toBe(200);
  const res = await api.get('/api/conversations?page=1&pageSize=50');
  await assertOk(res, 'GET /api/conversations');
  const own = (await unwrapList<{ id: string; contactPhone: string }>(res)).find((c) => c.contactPhone === phone);
  expect(own, `conversa do telefone ${phone}`).toBeTruthy();
  return own!.id;
}

test.describe('Fluxo 14.5 — Ações por permissão', () => {
  test('E97 @flow Financial só leitura: Painel, previsão de caixa, Meu plano, planos, calendário e conversa sem as ações de escrita; a API dá 403', async ({
    authApi,
    authPage,
    tenant,
    browser,
  }) => {
    test.setTimeout(300_000);
    await apiCompleteOnboarding(authApi);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_conversations');
    enableFeatureFlagDirect(tenant.tenantId, 'feature_whatsapp');
    await apiSetAiFeature(authApi, 'ai_insights', true);
    await apiSetAiFeature(authApi, 'ai_cashflow_forecast', true);

    // Pré-condições: um insight no Painel, uma festa no mês, uma conversa e a previsão com narrativa.
    const insightTitle = `Receita abaixo da media ${uid()}`;
    const insightId = seedAiInsightDirect(tenant.tenantId, insightTitle);
    const client = await apiCreateClient(authApi, { name: `Cliente Calendario ${uid()}` });
    const { eventId } = await setupAcceptedEvent(authApi, {
      clientId: client.id,
      budget: { eventDate: dayInCurrentMonth() },
    });
    // Valor único no total a receber: é por ele que o fake reconhece o prompt da previsão.
    const cents = 100 + Math.floor(Math.random() * 9_000) / 100;
    await assertOk(
      await authApi.post(`/api/events/${eventId}/pricing-items`, {
        data: {
          sourceType: 'Custom',
          sourceId: null,
          description: 'Ajuste E2E',
          quantity: 1,
          unit: 'un',
          unitPrice: cents,
          discountAmount: 0,
          additionalAmount: 0,
          notes: null,
        },
      }),
      'POST pricing item',
    );
    const { eventTotal } = await apiGetPaymentSummary(authApi, eventId);
    await fakeOpenAi.scriptNext(
      ptBrNumber(eventTotal),
      JSON.stringify({
        narrative: 'Caixa do mês sustentado pelas festas já contratadas (E2E).',
        recommendations: [{ title: 'Antecipe a cobrança', detail: 'Lembre os clientes da parcela.', monthRef: null }],
      }),
      3,
    );
    await assertOk(await authApi.post('/api/ai/cashflow-forecast/recalculate'), 'POST cashflow recalculate');
    const conversationId = await inboundConversation(authApi, tenant.tenantId);

    const financial: RoleSession = await loginAsRole(tenant.tenantId, 'Financial');
    const { page, context } = await openSessionPage(browser, financial.tokens);
    try {
      // Painel: o insight aparece, sem dispensar nem fixar (o dono tem as duas).
      await page.goto('/app/dashboard');
      const card = page.getByTestId('insight-card').filter({ hasText: insightTitle });
      await expect(card, 'o Financial vê o insight').toBeVisible({ timeout: 30_000 });
      await expect(card.getByTestId('insight-dismiss')).toHaveCount(0);
      await expect(card.getByTestId('insight-pin')).toHaveCount(0);
      await authPage.goto('/app/dashboard');
      const ownerCard = authPage.getByTestId('insight-card').filter({ hasText: insightTitle });
      await expect(ownerCard.getByTestId('insight-dismiss'), 'controle: o dono dispensa').toBeVisible({ timeout: 30_000 });

      // Previsão de caixa: a narrativa aparece, sem a avaliação (o dono avalia).
      await page.goto('/app/ai/cashflow-forecast');
      await expect(page.getByTestId('forecast-narrative'), 'o Financial lê a narrativa').toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('forecast-rate-up')).toHaveCount(0);
      await expect(page.getByTestId('forecast-rate-down')).toHaveCount(0);
      await authPage.goto('/app/ai/cashflow-forecast');
      await expect(authPage.getByTestId('forecast-rate-up'), 'controle: o dono avalia').toBeVisible({ timeout: 30_000 });

      // Meu plano: sem "Quero contratar".
      await page.goto('/app/billing/my-plan');
      await expect(page.getByTestId('my-plan-current')).toBeVisible();
      await expect(page.getByTestId('my-plan-request-contract')).toHaveCount(0);

      // Comparação de planos: nenhum botão de troca habilitado.
      await page.goto('/app/billing/plans');
      await expect(page.getByTestId('plans-grid')).toBeVisible();
      expect(await enabledCount(page.locator('[data-testid^="plan-card-cta-"]')), 'Financial sem troca de plano').toBe(0);
      await authPage.goto('/app/billing/plans');
      await expect(authPage.getByTestId('plans-grid')).toBeVisible();
      expect(
        await enabledCount(authPage.locator('[data-testid^="plan-card-cta-"]')),
        'controle: o dono troca de plano',
      ).toBeGreaterThan(0);

      // Calendário: a festa aparece, mas não arrasta.
      await page.goto('/app/schedule/calendar');
      const event = page.locator('.fc-event').filter({ hasText: String(client.name) });
      await expect(event, 'a festa no calendário do Financial').toBeVisible({ timeout: 30_000 });
      await expect(event).not.toHaveClass(/fc-event-draggable/);
      await authPage.goto('/app/schedule/calendar');
      const ownerEvent = authPage.locator('.fc-event').filter({ hasText: String(client.name) });
      await expect(ownerEvent, 'controle: o dono arrasta').toHaveClass(/fc-event-draggable/, { timeout: 30_000 });

      // Conversa: sem "Enviar mensagem" por template.
      await page.goto(`/app/conversations/${conversationId}`);
      await expect(page.getByTestId('conversation-status-chip')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('conversation-send-message')).toHaveCount(0);
      await authPage.goto(`/app/conversations/${conversationId}`);
      await expect(authPage.getByTestId('conversation-send-message'), 'controle: o dono envia').toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await context.close();
    }

    // As mesmas ações pela API: 403.
    const api = financial.api;
    try {
      const calls: Array<[string, Promise<{ status: () => number }>]> = [
        ['dispensar insight', api.post(`/api/ai/insights/${insightId}/dismiss`)],
        ['fixar insight', api.post(`/api/ai/insights/${insightId}/pin`)],
        ['desafixar insight', api.post(`/api/ai/insights/${insightId}/unpin`)],
        ['avaliar previsão', api.post('/api/ai/cashflow-forecast/rating', { data: { rating: 'Up' } })],
        ['quero contratar', api.post('/api/billing/contract-intent', { data: { planCode: 'plan_essential', billingPeriod: 'Monthly', note: null } })],
        ['trocar plano', api.post('/api/billing/change-plan', { data: { planCode: 'plan_essential', billingPeriod: 'Monthly' } })],
        ['arrastar no calendário', api.patch(`/api/events/${eventId}`, { data: { eventDate: saoPauloDay(40) } })],
        [
          'enviar template',
          api.post('/api/whatsapp/outbound/send', {
            data: { templateId: randomUUID(), conversationId, phoneE164: null, variableValues: null },
          }),
        ],
      ];
      for (const [label, call] of calls) expect((await call).status(), label).toBe(403);
    } finally {
      await api.dispose();
    }

    // O insight continua como estava (nada foi dispensado).
    const insights = await authApi.get('/api/ai/insights');
    await assertOk(insights, 'GET /api/ai/insights');
    const list = await readJson<Array<{ id: string }> | { items: Array<{ id: string }> }>(insights);
    const items = Array.isArray(list) ? list : list.items;
    expect(items.map((i) => i.id), 'insight segue na faixa').toContain(insightId);
  });

  test('E98 @flow job de mídia: o Manager B não vê nem cancela o job do Manager A (404, o job segue); o Admin vê', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(120_000);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_stock');
    enableFeatureFlagDirect(tenant.tenantId, 'feature_ai_multimodal');
    await apiSetAiFeature(authApi, 'ai_purchase_invoice', true);

    const managerA = await loginAsRole(tenant.tenantId, 'Manager');
    const managerB = await loginAsRole(tenant.tenantId, 'Manager');
    const admin = await loginAsRole(tenant.tenantId, 'Admin');
    const upload = await createBearerMultipartContext(managerA.tokens.accessToken);
    try {
      const enqueue = await upload.post('/api/stock/purchase-entries/from-invoice', {
        // Tamanho aleatório: o back deduplica a foto pelo hash dos bytes.
        multipart: {
          files: {
            name: `cupom-${uid()}.png`,
            mimeType: 'image/png',
            buffer: pngBytes({ width: 32 + Math.floor(Math.random() * 64), height: 32 }),
          },
        },
      });
      expect(enqueue.status(), `job do Manager A: ${await enqueue.text()}`).toBe(202);
      const { jobId } = await readJson<{ jobId: string }>(enqueue);

      expect((await managerA.api.get(`/api/media-jobs/${jobId}`)).status(), 'A vê o próprio job').toBe(200);

      expect((await managerB.api.get(`/api/media-jobs/${jobId}`)).status(), 'B não vê o job de A').toBe(404);
      expect((await managerB.api.delete(`/api/media-jobs/${jobId}`)).status(), 'B não cancela o job de A').toBe(404);

      const after = await managerA.api.get(`/api/media-jobs/${jobId}`);
      expect(after.status(), 'o job segue existindo para A').toBe(200);
      const job = await readJson<{ failureCode: string | null; status: string }>(after);
      expect(job.failureCode ?? '', 'o job não foi cancelado por B').not.toMatch(/cancel/i);

      expect((await admin.api.get(`/api/media-jobs/${jobId}`)).status(), 'o Admin vê').toBe(200);
    } finally {
      await upload.dispose();
      await managerA.api.dispose();
      await managerB.api.dispose();
      await admin.api.dispose();
    }
  });
});
