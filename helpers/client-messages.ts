import { APIRequestContext, expect } from '@playwright/test';

import { apiCreateClient, apiSetSettingParameter } from './api-entities';
import { apiCreatePaymentPlan, apiGetPaymentSummary } from './api-event-flow';
import {
  enableFeatureFlagDirect,
  ensureTriggerWhatsAppTemplateDirect,
  execSql,
  seedConnectedWhatsappTenantDirect,
} from './db-helper';
import { InboxEntry } from './fake-providers';
import { TRIGGER_TIMEOUT, tenantDayPlus, uniqueSuffix } from './rain-plan';
import { assertOk, readJson } from './response';
import { setupAcceptedEvent } from './setup-flows';
import { uniqueMobilePhone } from './test-data';

/**
 * Pré-condições e leituras de "Mensagens ao cliente"
 * (`docs/implementar/PLANO-MENSAGENS-AO-CLIENTE-COM-APROVACAO.md`, MC-A e MC-C):
 * o lembrete de parcela que o ciclo diário (`POST /api/notifications/trigger-overdue`)
 * submete e que espera o ok do gestor em `GET /api/client-messages`.
 * Usado pelos `tests/11-comunicacao/11.4` e `11.5` e pelo `fluxos-completos/32`.
 */

// ─────────────────────────── contratos (o que o spec lê) ───────────────────────────

export type ClientMessageStatus = 'PendingApproval' | 'Approved' | 'Rejected' | 'Expired' | 'Obsolete';
export type ClientMessageChannel = 'WhatsApp' | 'Email';
export type ClientMessageDeliveryStatus = 'Pending' | 'Skipped' | 'Queued' | 'Sent' | 'Failed';

export interface ClientMessageDelivery {
  id: string;
  channel: ClientMessageChannel;
  address: string;
  previewSubject: string | null;
  previewBody: string;
  status: ClientMessageDeliveryStatus;
  sentAt: string | null;
  failureReason: string | null;
}

export interface ClientMessage {
  id: string;
  origin: string;
  status: ClientMessageStatus;
  recipientName: string;
  contextEventId: string | null;
  contextEventName: string | null;
  expiresAt: string;
  createdAt: string;
  decidedAt: string | null;
  decidedByUserName: string | null;
  rejectionReason: string | null;
  obsoleteReason: string | null;
  deliveries: ClientMessageDelivery[];
}

// ─────────────────────────── leituras ───────────────────────────

/** GET /api/client-messages (a primeira página, 100 por vez) com os status pedidos; vazio = todos. */
export async function apiListClientMessages(
  api: APIRequestContext,
  statuses: ClientMessageStatus[] = [],
): Promise<ClientMessage[]> {
  const qs = new URLSearchParams();
  for (const s of statuses) qs.append('status', s);
  qs.set('pageSize', '100');
  const res = await api.get(`/api/client-messages?${qs.toString()}`);
  await assertOk(res, 'GET /api/client-messages');
  const data = await readJson<{ items: ClientMessage[] }>(res);
  return data.items;
}

/** GET /api/client-messages/{id}. */
export async function apiGetClientMessage(api: APIRequestContext, id: string): Promise<ClientMessage> {
  const res = await api.get(`/api/client-messages/${id}`);
  await assertOk(res, 'GET /api/client-messages/{id}');
  return readJson<ClientMessage>(res);
}

/** As mensagens do tenant cujo contexto é a festa dada. */
export async function messagesOfEvent(api: APIRequestContext, eventId: string): Promise<ClientMessage[]> {
  return (await apiListClientMessages(api)).filter((m) => m.contextEventId === eventId);
}

/**
 * Espera a submissão do lembrete sair pelo Outbox e virar mensagem aguardando
 * ok, e a devolve. A submissão é assíncrona: o `trigger-overdue` responde antes.
 */
export async function waitForPendingMessage(api: APIRequestContext, eventId: string): Promise<ClientMessage> {
  let found: ClientMessage | undefined;
  await expect
    .poll(
      async () => {
        found = (await messagesOfEvent(api, eventId)).find((m) => m.status === 'PendingApproval');
        return found !== undefined;
      },
      { message: 'mensagem aguardando ok da parcela da festa', timeout: TRIGGER_TIMEOUT },
    )
    .toBe(true);
  return found!;
}

// ─────────────────────────── pré-condições ───────────────────────────

/**
 * Liga o lembrete ao cliente e deixa a régua só com o estágio de 3 dias
 * (`FINANCIAL_INSTALLMENT_REMINDER_DAYS = 3`): uma mensagem por parcela.
 */
export async function enableClientReminder(api: APIRequestContext): Promise<void> {
  await apiSetSettingParameter(api, 'FINANCIAL_INSTALLMENT_REMINDER_DAYS', '3');
  await apiSetSettingParameter(api, 'FINANCIAL_INSTALLMENT_REMINDER_NOTIFY_CLIENT', 'true');
}

/** O modelo aprovado do disparo `PaymentReminder`, com o corpo dele (para remontar o texto enviado). */
export interface PaymentReminderTemplate {
  id: string;
  name: string;
  body: string;
}

/**
 * Tenant com o WhatsApp conectado e o modelo de lembrete de pagamento
 * (`PaymentReminder`) aprovado e vinculado à WABA dele: sem isso a mensagem
 * nasce só com o e-mail (CE-12). Molde do `fluxos-completos/32` da Etapa 262.
 */
export function seedPaymentReminderWhatsApp(tenantId: string): PaymentReminderTemplate {
  enableFeatureFlagDirect(tenantId, 'feature_whatsapp');
  const template = ensureTriggerWhatsAppTemplateDirect({
    trigger: 'PaymentReminder',
    namePrefix: 'lembrete_parcela_e2e',
    body: 'Ola, {{1}}! A parcela {{2}} de R$ {{3}} vence em {{4}}.',
    variables: ['nome', 'parcela', 'valor', 'vencimento'],
  });
  seedConnectedWhatsappTenantDirect(tenantId, [template.id]);
  // O catálogo só tem um modelo vivo por disparo: o corpo é o do que já existia.
  const body = execSql(`SELECT "Body" FROM "WhatsAppTemplates" WHERE "Id" = '${template.id}';`);
  return { ...template, body };
}

/** Festa aceita com uma parcela única vencendo em `dueInDays` dias, de um cliente com e-mail e celular próprios. */
export interface ReminderParty {
  clientId: string;
  clientName: string;
  clientEmail: string;
  clientPhone: string;
  eventId: string;
  installmentId: string;
  amount: number;
  dueDate: string;
}

export async function setupReminderParty(api: APIRequestContext, opts: { dueInDays?: number } = {}): Promise<ReminderParty> {
  const suffix = uniqueSuffix();
  const clientName = `Cliente Lembrete ${suffix}`;
  const clientEmail = `cliente-lembrete-${suffix}@e2e.test`;
  const clientPhone = uniqueMobilePhone();
  const client = await apiCreateClient(api, { name: clientName, email: clientEmail, phone: clientPhone });
  const { eventId } = await setupAcceptedEvent(api, {
    clientId: client.id,
    budget: { eventDate: tenantDayPlus(20), childrenCount: 15, startTime: '14:00', endTime: '18:00' },
  });
  const { eventTotal } = await apiGetPaymentSummary(api, eventId);
  const dueDate = tenantDayPlus(opts.dueInDays ?? 3);
  const plan = await apiCreatePaymentPlan(api, eventId, [
    { order: 1, label: 'Parcela única', expectedAmount: eventTotal, dueDate },
  ]);
  return {
    clientId: client.id,
    clientName,
    clientEmail,
    clientPhone,
    eventId,
    installmentId: plan.installments[0]!.id,
    amount: eventTotal,
    dueDate,
  };
}

// ─────────────────────────── envio ───────────────────────────

/** POST /api/client-messages/{id}/approve — a resposta crua, para o cenário negativo ler o status. */
export function approveClientMessage(
  api: APIRequestContext,
  id: string,
  channels: ClientMessageChannel[] = ['Email'],
) {
  return api.post(`/api/client-messages/${id}/approve`, { data: { channels } });
}

/**
 * O texto que o fake do WhatsApp recebeu num envio por modelo: o corpo do
 * modelo com cada `{{n}}` trocado pelo parâmetro `n` do componente `body`.
 */
export function whatsAppTemplateText(entry: InboxEntry, templateBody: string): string {
  const body = entry.body as {
    template?: { components?: Array<{ type?: string; parameters?: Array<{ text?: string }> }> };
  };
  const params = body.template?.components?.find((c) => (c.type ?? '').toLowerCase() === 'body')?.parameters ?? [];
  return templateBody.replace(/\{\{(\d+)\}\}/g, (_, n: string) => params[Number(n) - 1]?.text ?? `{{${n}}}`);
}

/** Nome do usuário do contexto (`GET /api/auth/me`), o que a tela mostra em "Decidida por". */
export async function apiCurrentUserName(api: APIRequestContext): Promise<string> {
  const res = await api.get('/api/auth/me');
  await assertOk(res, 'GET /api/auth/me');
  return (await readJson<{ name: string }>(res)).name;
}
