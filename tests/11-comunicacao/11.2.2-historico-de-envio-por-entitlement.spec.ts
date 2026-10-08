import { APIRequestContext, Page } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCompleteOnboarding } from '../../helpers/api-entities';
import { enableFeatureFlagDirect, seedWhatsappChannelDirect } from '../../helpers/db-helper';
import { fakeWhatsApp } from '../../helpers/fake-providers';
import { assertOk, unwrapList } from '../../helpers/response';

/**
 * Fluxo: 11.2.2 — histórico de envio da conversa depende do add-on WhatsApp
 * Plano: docs/implementar/PLANO-AJUSTES-DA-CONVERSAO.md §9 item 2 (AJ-E,
 * Etapa 200) e "Testes" da §9. Registro e2e: E26.
 *
 *   1. Tenant só com `feature_conversations` abre o detalhe da conversa sem o
 *      painel de histórico de envio e sem NENHUMA chamada a
 *      `outbound/history` (nenhum 403 na tela).
 *   2. Com `feature_whatsapp` e `whatsapp.read` (o dono do tenant tem), o
 *      painel carrega pelo endpoint, com 200.
 *
 * A conversa nasce pelo webhook de entrada assinado do fake, no canal próprio
 * do tenant (id devolvido pelo `seedWhatsappChannelDirect` e passado ao fake).
 *
 * Sem diagrama `.mmd`: verificação de plano de ajustes.
 */

test.describe.configure({ mode: 'serial' });

/** Conversa criada por mensagem de entrada do fake, no tenant do canal. */
async function inboundConversation(api: APIRequestContext, tenantId: string): Promise<string> {
  const phoneNumberId = seedWhatsappChannelDirect(tenantId);
  const phone = `+55419${String(Date.now()).slice(-7)}${Math.floor(Math.random() * 10)}`;
  const hook = await fakeWhatsApp.triggerWebhook({
    kind: 'inbound',
    phoneNumberId,
    phone,
    text: 'Oi, quero um orçamento',
  });
  expect(hook.backStatus, `webhook inbound: ${hook.backBody}`).toBe(200);

  const res = await api.get('/api/conversations?page=1&pageSize=50');
  await assertOk(res, 'GET /api/conversations');
  const conversations = await unwrapList<{ id: string; contactPhone: string }>(res);
  const own = conversations.find((c) => c.contactPhone === phone);
  expect(own, `conversa do telefone ${phone}`).toBeTruthy();
  return own!.id;
}

/** Abre o detalhe e espera a conversa carregar e a rede assentar (o painel carrega num setTimeout). */
async function openDetail(page: Page, conversationId: string): Promise<void> {
  await page.goto(`/app/conversations/${conversationId}`);
  await expect(page.getByTestId('conversation-status-chip')).toBeVisible();
  await page.waitForLoadState('networkidle');
}

test.describe('Fluxo 11.2.2 — send history panel by entitlement', () => {
  test('@flow tenant with only feature_conversations opens the conversation without the panel and without calling outbound/history', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_conversations');
    await apiCompleteOnboarding(authApi);
    const conversationId = await inboundConversation(authApi, tenant.tenantId);

    const historyCalls: string[] = [];
    const forbidden: string[] = [];
    authPage.on('request', (req) => {
      if (req.url().includes('/api/whatsapp/outbound/history')) historyCalls.push(req.url());
    });
    authPage.on('response', (res) => {
      if (res.url().includes('/api/') && res.status() === 403) forbidden.push(res.url());
    });

    await openDetail(authPage, conversationId);

    await expect(authPage.getByTestId('outbound-history-panel')).toHaveCount(0);
    expect(historyCalls, 'nenhuma chamada a outbound/history').toEqual([]);
    expect(forbidden, 'nenhum 403 ao abrir a conversa').toEqual([]);
  });

  test('@flow with feature_whatsapp and whatsapp.read the panel loads from outbound/history', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_conversations');
    enableFeatureFlagDirect(tenant.tenantId, 'feature_whatsapp');
    await apiCompleteOnboarding(authApi);
    const conversationId = await inboundConversation(authApi, tenant.tenantId);

    const historyResponse = authPage.waitForResponse((res) =>
      res.url().includes('/api/whatsapp/outbound/history'),
    );
    await authPage.goto(`/app/conversations/${conversationId}`);
    const res = await historyResponse;
    expect(res.status()).toBe(200);
    expect(res.url()).toContain(`conversationId=${conversationId}`);

    await expect(authPage.getByTestId('outbound-history-panel')).toBeVisible();
    // Conversa só com mensagem de entrada: nenhum envio, e o painel diz isso.
    await expect(authPage.getByTestId('outbound-history-empty')).toBeVisible();
  });
});
