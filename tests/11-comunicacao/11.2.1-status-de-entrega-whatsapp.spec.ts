import { APIRequestContext, Page } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCompleteOnboarding } from '../../helpers/api-entities';
import {
  enableFeatureFlagDirect,
  seedApprovedWhatsAppTemplateDirect,
  seedWhatsappChannelDirect,
} from '../../helpers/db-helper';
import { fakeWhatsApp } from '../../helpers/fake-providers';
import { assertOk, readJson, unwrapList } from '../../helpers/response';

/**
 * Fluxo: 11.2.1 — status de entrega do WhatsApp (entregue, lido, falhou)
 * Plano: docs/implementar/PLANO-AJUSTES-DA-CONVERSAO.md §9 item 1 (AJ-E,
 * Etapa 200) e "Testes" da §9. Registro e2e: E25.
 *
 *   1. Template enviado pelo fake do WhatsApp; o webhook ASSINADO de status
 *      chega (`delivered`, depois `read`) e o histórico de envio da conversa
 *      mostra "Entregue" e "Lido" com a data.
 *   2. `read` antes de `delivered` termina "Lido"; o `delivered` atrasado e o
 *      replay do mesmo payload não mudam nada.
 *   3. `failed` mostra "Falhou" com o motivo da Meta.
 *
 * O webhook acha o tenant pelo `phone_number_id` do canal (`fake_phone`, o que
 * o fake sempre manda) e o envio pelo wamid devolvido no envio. Como o
 * `seedWhatsappChannelDirect` desativa o canal `fake_phone` dos outros
 * tenants, os testes deste arquivo rodam em série.
 *
 * Sem diagrama `.mmd`: verificação de plano de ajustes.
 */

test.describe.configure({ mode: 'serial' });

interface DispatchItem {
  id: string;
  status: string;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  lastError: string | null;
}

/** "dd/MM HH:mm" no fuso do tenant (o do signup, America/Sao_Paulo), como o painel mostra. */
function shortDateTime(epochSeconds: number): string {
  const parts = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(epochSeconds * 1000));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('day')}/${get('month')} ${get('hour')}:${get('minute')}`;
}

/** Instante em ms de uma data do back; sem offset na string, é UTC (o banco grava UTC). */
function utcMs(iso: string | null): number {
  if (!iso) return NaN;
  return new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`).getTime();
}

function uniquePhone(): string {
  return `+55419${String(Date.now()).slice(-7)}${Math.floor(Math.random() * 10)}`;
}

async function history(api: APIRequestContext, conversationId: string): Promise<DispatchItem[]> {
  const res = await api.get(
    `/api/whatsapp/outbound/history?conversationId=${conversationId}&page=1&pageSize=20`,
  );
  await assertOk(res, 'GET /api/whatsapp/outbound/history');
  return unwrapList<DispatchItem>(res);
}

async function dispatchOf(api: APIRequestContext, conversationId: string, dispatchId: string) {
  const item = (await history(api, conversationId)).find((d) => d.id === dispatchId);
  expect(item, `envio ${dispatchId} no histórico`).toBeTruthy();
  return item!;
}

/**
 * Envia um template pelo endpoint real e devolve o envio, a conversa e o wamid
 * que o fake respondeu (é por ele que o webhook de status acha o envio).
 */
async function sendTemplate(
  api: APIRequestContext,
  phone: string,
): Promise<{ dispatchId: string; conversationId: string; wamid: string }> {
  const templateId = seedApprovedWhatsAppTemplateDirect({
    name: `status_e2e_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    body: 'Sua festa esta confirmada!',
  });
  const since = new Date().toISOString();
  const res = await api.post('/api/whatsapp/outbound/send', {
    data: { templateId, phoneE164: phone, variableValues: {} },
  });
  await assertOk(res, 'POST /api/whatsapp/outbound/send');
  const dispatch = await readJson<{ id: string; conversationId: string }>(res);

  const wamidFromFake = async (): Promise<string | null> => {
    const inbox = await fakeWhatsApp.inbox({ since });
    const call = inbox.find(
      (e) =>
        e.method === 'POST' &&
        /\/messages$/.test(e.path) &&
        (e.body as { to?: string } | null)?.to === phone,
    );
    const body = call?.response.body as { messages?: Array<{ id: string }> } | undefined;
    return body?.messages?.[0]?.id ?? null;
  };
  await expect.poll(wamidFromFake, { message: 'fake recebeu o envio do template' }).not.toBeNull();
  const wamid = (await wamidFromFake())!;

  // O wamid fica gravado quando o envio sai como `Sent`.
  await expect
    .poll(async () => (await dispatchOf(api, dispatch.conversationId, dispatch.id)).status, {
      message: 'envio chega a Sent',
    })
    .toBe('Sent');

  return { dispatchId: dispatch.id, conversationId: dispatch.conversationId, wamid };
}

/**
 * Abre a conversa e carrega o painel pelo "Atualizar". O carregamento sozinho
 * ao abrir é o que o E26 (11.2.2) prova; aqui o que importa é o que o
 * histórico mostra.
 */
async function openHistory(page: Page, conversationId: string): Promise<void> {
  await page.goto(`/app/conversations/${conversationId}`);
  await expect(page.getByTestId('outbound-history-panel')).toBeVisible();
  await page.getByTestId('outbound-history-refresh').click();
  await expect(page.getByTestId('outbound-history-list')).toBeVisible();
}

async function postStatus(
  phone: string,
  wamid: string,
  status: 'delivered' | 'read' | 'failed',
  timestamp: number,
  errors?: Array<{ code: number; title: string; error_data?: { details?: string } }>,
): Promise<void> {
  const hook = await fakeWhatsApp.triggerWebhook({
    kind: 'status',
    phone,
    messageId: wamid,
    status,
    timestamp,
    errors,
  });
  expect(hook.backStatus, `webhook ${status}: ${hook.backBody}`).toBe(200);
}

test.describe('Fluxo 11.2.1 — WhatsApp delivery status', () => {
  test.beforeEach(async ({ tenant }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_whatsapp');
    enableFeatureFlagDirect(tenant.tenantId, 'feature_conversations');
    seedWhatsappChannelDirect(tenant.tenantId);
  });

  test('@flow signed delivered then read webhooks show "Entregue" and "Lido" with the date in the send history', async ({
    authApi,
    authPage,
  }) => {
    const phone = uniquePhone();
    const sent = await sendTemplate(authApi, phone);

    // Datas da Meta no passado recente, distintas, para conferir cada uma na tela.
    const now = Math.floor(Date.now() / 1000);
    const deliveredTs = now - 2 * 3600;
    const readTs = now - 3600;

    await apiCompleteOnboarding(authApi);

    // 1. delivered
    await postStatus(phone, sent.wamid, 'delivered', deliveredTs);
    const delivered = await dispatchOf(authApi, sent.conversationId, sent.dispatchId);
    expect(delivered.status).toBe('Delivered');
    expect(utcMs(delivered.deliveredAt)).toBe(deliveredTs * 1000);

    await openHistory(authPage, sent.conversationId);
    await expect(authPage.getByTestId(`outbound-dispatch-status-${sent.dispatchId}`)).toHaveText(
      'Entregue',
    );
    await expect(authPage.getByTestId(`outbound-dispatch-delivered-${sent.dispatchId}`)).toContainText(
      shortDateTime(deliveredTs),
    );

    // 2. read
    await postStatus(phone, sent.wamid, 'read', readTs);
    const read = await dispatchOf(authApi, sent.conversationId, sent.dispatchId);
    expect(read.status).toBe('Read');
    expect(utcMs(read.readAt)).toBe(readTs * 1000);

    await authPage.getByTestId('outbound-history-refresh').click();
    await expect(authPage.getByTestId(`outbound-dispatch-status-${sent.dispatchId}`)).toHaveText('Lido');
    await expect(authPage.getByTestId(`outbound-dispatch-delivered-${sent.dispatchId}`)).toContainText(
      shortDateTime(deliveredTs),
    );
    await expect(authPage.getByTestId(`outbound-dispatch-read-${sent.dispatchId}`)).toContainText(
      shortDateTime(readTs),
    );
  });

  test('@flow read before delivered ends "Lido"; the late delivered and the replay change nothing', async ({
    authApi,
    authPage,
  }) => {
    const phone = uniquePhone();
    const sent = await sendTemplate(authApi, phone);
    const now = Math.floor(Date.now() / 1000);
    const readTs = now - 1800;

    // A Meta troca a ordem: o `read` chega primeiro.
    await postStatus(phone, sent.wamid, 'read', readTs);
    const afterRead = await dispatchOf(authApi, sent.conversationId, sent.dispatchId);
    expect(afterRead.status).toBe('Read');

    // O `delivered` atrasado não rebaixa.
    await postStatus(phone, sent.wamid, 'delivered', now - 3600);
    // Replay byte a byte do `read` (mesmo timestamp).
    await postStatus(phone, sent.wamid, 'read', readTs);

    const final = await dispatchOf(authApi, sent.conversationId, sent.dispatchId);
    expect(final.status).toBe('Read');
    expect(final.readAt).toBe(afterRead.readAt);
    expect(utcMs(final.readAt)).toBe(readTs * 1000);

    await apiCompleteOnboarding(authApi);
    await openHistory(authPage, sent.conversationId);
    await expect(authPage.getByTestId(`outbound-dispatch-status-${sent.dispatchId}`)).toHaveText('Lido');
    await expect(authPage.getByTestId(`outbound-dispatch-read-${sent.dispatchId}`)).toContainText(
      shortDateTime(readTs),
    );
  });

  test('@flow failed webhook shows "Falhou" with the reason sent by Meta', async ({
    authApi,
    authPage,
  }) => {
    const phone = uniquePhone();
    const sent = await sendTemplate(authApi, phone);

    await postStatus(phone, sent.wamid, 'failed', Math.floor(Date.now() / 1000), [
      {
        code: 131026,
        title: 'Message undeliverable',
        error_data: { details: 'Destinatario sem WhatsApp' },
      },
    ]);

    const failed = await dispatchOf(authApi, sent.conversationId, sent.dispatchId);
    expect(failed.status).toBe('Failed');
    expect(failed.lastError).toContain('131026');
    expect(failed.lastError).toContain('Message undeliverable');

    await apiCompleteOnboarding(authApi);
    await openHistory(authPage, sent.conversationId);
    await expect(authPage.getByTestId(`outbound-dispatch-status-${sent.dispatchId}`)).toHaveText(
      'Falhou',
    );
    const reason = authPage.getByTestId(`outbound-dispatch-failure-${sent.dispatchId}`);
    await expect(reason).toContainText('Message undeliverable');
    await expect(reason).toContainText('Destinatario sem WhatsApp');
  });
});
