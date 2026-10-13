import { APIRequestContext, Page, expect } from '@playwright/test';

import { enableFeatureFlagDirect } from './db-helper';
import { InboxEntry, fakeWhatsApp } from './fake-providers';
import { assertOk, readJson, unwrapList } from './response';
import { uniqueMobilePhone } from './test-data';

/**
 * Passos repetidos dos specs de WhatsApp pelo canal do tenant (PLANO-SEGURANCA
 * §5 e §5b, Etapas 239 e 242): ligar as features, receber mensagem pelo webhook
 * do fake, achar a conversa, ler o que o fake recebeu e abrir o diálogo de envio
 * por modelo. O canal e o vínculo do modelo vêm do `db-helper`
 * (`seedConnectedWhatsappTenantDirect`).
 */

/** `WhatsApp:ApiKey` do `appsettings.E2E.json`: o fake o recusa com 401 em tudo que é do tenant. */
export const PLATFORM_WHATSAPP_TOKEN = 'fake-whatsapp-key-e2e';

/** `feature_whatsapp` (envio, rota de conversas) e `feature_conversations` (caixa de entrada). */
export function enableWhatsAppFeaturesDirect(tenantId: string): void {
  enableFeatureFlagDirect(tenantId, 'feature_whatsapp');
  enableFeatureFlagDirect(tenantId, 'feature_conversations');
}

/** Celular único em E.164 (`+55419XXXXXXXX`). */
export function uniquePhoneE164(): string {
  return `+55${uniqueMobilePhone()}`;
}

export function digitsOf(phone: string): string {
  return phone.replace(/\D/g, '');
}

/** Telefone brasileiro do cadastro (com ou sem DDI, formatado ou não) em E.164. */
export function toE164Br(phone: string): string {
  const d = digitsOf(phone);
  return d.startsWith('55') && d.length >= 12 ? `+${d}` : `+55${d}`;
}

/** Sufixo único só com letras e dígitos, para nome de modelo (snake_case) e ids do fake. */
export function uid(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Mensagem de texto recebida pelo número do canal (`phone_number_id`), pelo webhook assinado do fake. */
export async function receiveInbound(phoneNumberId: string, phoneE164: string, text: string): Promise<void> {
  const hook = await fakeWhatsApp.triggerWebhook({ kind: 'inbound', phoneNumberId, phone: phoneE164, text });
  expect(hook.backStatus, `webhook inbound: ${hook.backBody}`).toBe(200);
}

interface ConversationRow {
  id: string;
  contactPhone: string;
  lastMessagePreview?: string | null;
}

/** Conversas do tenant (primeira página, todas as situações que a caixa lista por padrão). */
export async function apiListConversations(api: APIRequestContext): Promise<ConversationRow[]> {
  const res = await api.get('/api/conversations?page=1&pageSize=100');
  await assertOk(res, 'GET /api/conversations');
  return unwrapList<ConversationRow>(res);
}

/** Id da conversa do telefone no tenant; espera o webhook gravar. */
export async function apiConversationIdByPhone(api: APIRequestContext, phoneE164: string): Promise<string> {
  let id: string | undefined;
  await expect
    .poll(
      async () => {
        const rows = await apiListConversations(api);
        id = rows.find((c) => digitsOf(c.contactPhone) === digitsOf(phoneE164))?.id;
        return id ?? null;
      },
      { message: `conversa de ${phoneE164} no tenant` },
    )
    .not.toBeNull();
  return id!;
}

export interface DailyQuota {
  limit: number;
  used: number;
  remaining: number;
  isTrial: boolean;
  resetsAt: string;
}

export async function apiDailyQuota(api: APIRequestContext): Promise<DailyQuota> {
  const res = await api.get('/api/whatsapp/outbound/quota');
  await assertOk(res, 'GET /api/whatsapp/outbound/quota');
  return readJson<DailyQuota>(res);
}

/** `POST /api/whatsapp/outbound/send` (envio manual por modelo), sem afirmar o status. */
export function apiSendTemplate(
  api: APIRequestContext,
  body: { templateId: string; conversationId?: string; phoneE164?: string },
) {
  return api.post('/api/whatsapp/outbound/send', {
    data: {
      templateId: body.templateId,
      conversationId: body.conversationId ?? null,
      phoneE164: body.phoneE164 ?? null,
      variableValues: {},
    },
  });
}

/** `{ code, description }` dos erros do envelope do back. */
export async function apiErrors(res: { json: () => Promise<unknown> }): Promise<Array<{ code: string; description: string }>> {
  const body = (await res.json()) as { errors?: Array<{ code: string; description: string }> };
  return body.errors ?? [];
}

/** Valor do header `Authorization` de uma chamada capturada pelo fake. */
export function authorizationOf(entry: InboxEntry): string | undefined {
  const raw = entry.headers['authorization'];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Destinatário (`to`) do corpo de um `POST /{número}/messages`, só dígitos. */
export function recipientOf(entry: InboxEntry): string {
  const to = (entry.body as { to?: string } | null)?.to;
  return to ? digitsOf(to) : '';
}

/** `POST /{número}/messages` capturados pelo fake desde `since`, para o telefone dado. */
export async function fakeMessagesTo(phoneE164: string, since: string): Promise<InboxEntry[]> {
  const inbox = await fakeWhatsApp.inbox({ since, path: '/messages' });
  return inbox.filter((e) => e.method === 'POST' && recipientOf(e) === digitsOf(phoneE164));
}

/** Toda chamada ao fake desde `since` cujo corpo cita o telefone (envio, mídia, qualquer rota). */
export async function fakeCallsMentioning(phoneE164: string, since: string): Promise<InboxEntry[]> {
  const inbox = await fakeWhatsApp.inbox({ since });
  return inbox.filter((e) => JSON.stringify(e.body ?? '').includes(digitsOf(phoneE164)));
}

/** Textos (`type: text`) que o fake recebeu para o telefone desde `since`. */
export async function fakeTextsTo(phoneE164: string, since: string): Promise<string[]> {
  return (await fakeMessagesTo(phoneE164, since))
    .map((e) => (e.body as { type?: string; text?: { body?: string } }).text?.body ?? '')
    .filter((t) => t.length > 0);
}

/**
 * Abre a conversa e o diálogo "Enviar mensagem" (envio manual por modelo) e
 * escolhe o modelo pelo nome. O spec chama `apiCompleteOnboarding` antes.
 */
export async function openSendTemplateDialog(page: Page, conversationId: string, templateName?: string): Promise<void> {
  await page.goto(`/app/conversations/${conversationId}`);
  await page.getByTestId('conversation-send-message').click();
  await expect(page.getByTestId('send-whatsapp-form')).toBeVisible();
  if (templateName) {
    await page.getByTestId('send-whatsapp-template').click();
    await page.getByRole('option', { name: new RegExp(`^\\s*${templateName}\\b`) }).click();
  }
}
