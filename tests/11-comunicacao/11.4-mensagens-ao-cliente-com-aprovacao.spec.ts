import { Page } from '@playwright/test';

import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import { apiCompleteOnboarding } from '../../helpers/api-entities';
import { apiRegisterPayment } from '../../helpers/api-event-flow';
import {
  ClientMessage,
  ReminderParty,
  apiCurrentUserName,
  apiGetClientMessage,
  apiListClientMessages,
  approveClientMessage,
  enableClientReminder,
  seedPaymentReminderWhatsApp,
  setupReminderParty,
  waitForPendingMessage,
  whatsAppTemplateText,
} from '../../helpers/client-messages';
import { fakeEmail } from '../../helpers/fake-providers';
import { withoutPermissions } from '../../helpers/monthly-expenses';
import { TRIGGER_TIMEOUT, apiTriggerDailyJob, tenantDayPlus } from '../../helpers/rain-plan';
import { apiErrorCodes } from '../../helpers/response';
import { setupPortalUser } from '../../helpers/setup-flows';
import { smokeRoute } from '../../helpers/smoke';
import { snack } from '../../helpers/ui';
import { fakeMessagesTo, toE164Br } from '../../helpers/whatsapp-flow';

/**
 * Fluxo: 11.4 — Mensagens ao cliente com aprovação
 * Diagrama: docs/fluxos/negocio-11.4-mensagens-ao-cliente-com-aprovacao.mmd
 *
 * PLANO-MENSAGENS-AO-CLIENTE-COM-APROVACAO §3 (MC-A, Etapa 266), registro e2e
 * E1 a E5: o lembrete de parcela a vencer que o ciclo diário prepara
 * (`POST /api/notifications/trigger-overdue`, régua só com 3 dias) espera em
 * "Mensagens ao cliente" e só sai com o ok do gestor; a parcela paga antes do
 * ok torna a mensagem obsoleta (R3); recusar não envia; quem não tem
 * `ClientMessages.Approve` não aprova; outra empresa não vê nem aprova (R7).
 *
 * WhatsApp: o modelo do disparo `PaymentReminder` aprovado e vinculado à WABA
 * do tenant (`seedPaymentReminderWhatsApp`), para a mensagem nascer com os dois
 * canais.
 */

const SCENARIO_TIMEOUT = 2 * TRIGGER_TIMEOUT + 180_000;

/** Lembrete aguardando ok de uma parcela que vence em 3 dias. */
async function pendingReminder(
  authApi: Parameters<typeof setupReminderParty>[0],
  tenantId: string,
  opts: { whatsApp?: boolean } = {},
): Promise<{ party: ReminderParty; message: ClientMessage; since: string; templateBody: string | null }> {
  const template = opts.whatsApp === false ? null : seedPaymentReminderWhatsApp(tenantId);
  await enableClientReminder(authApi);
  const party = await setupReminderParty(authApi);
  const since = new Date(Date.now() - 1_000).toISOString();
  await apiTriggerDailyJob(authApi);
  const message = await waitForPendingMessage(authApi, party.eventId);
  return { party, message, since, templateBody: template?.body ?? null };
}

/**
 * Os e-mails do LEMBRETE que chegaram ao cliente: o assunto é o da prévia. A
 * caixa dele também tem o envio do orçamento da pré-condição (`setupAcceptedEvent`).
 */
async function clientEmails(party: ReminderParty, message: ClientMessage) {
  const subject = message.deliveries.find((d) => d.channel === 'Email')!.previewSubject!;
  return (await fakeEmail.emails({ to: party.clientEmail })).filter((m) => m.subject === subject);
}

function clientWhatsApps(party: ReminderParty, since: string) {
  return fakeMessagesTo(toE164Br(party.clientPhone), since);
}

async function openQueue(page: Page): Promise<void> {
  await smokeRoute(page, '/app/client-messages', { ready: 'client-messages-page' });
}

test.describe('Fluxo 11.4 — Mensagens ao cliente com aprovação', () => {
  test.beforeEach(async ({ authApi }) => {
    await apiCompleteOnboarding(authApi);
  });

  test('@smoke tela carrega autenticada', async ({ authPage }) => {
    await openQueue(authPage);
    await expect(authPage.getByTestId('client-messages-empty')).toBeVisible();
  });

  test('@flow E1: the installment reminder waits for the ok with the preview of each channel, and nothing reaches the WhatsApp and e-mail fakes before the approval', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(SCENARIO_TIMEOUT);
    const { party, message, since } = await pendingReminder(authApi, tenant.tenantId);

    expect(message.origin).toBe('InstallmentReminder');
    expect(message.recipientName).toBe(party.clientName);
    expect(message.deliveries.map((d) => d.channel).sort()).toEqual(['Email', 'WhatsApp']);
    expect(message.deliveries.every((d) => d.status === 'Pending'), 'nenhuma entrega saiu').toBe(true);
    const email = message.deliveries.find((d) => d.channel === 'Email')!;
    expect(email.address.toLowerCase()).toBe(party.clientEmail.toLowerCase());
    expect(email.previewSubject, 'o e-mail tem assunto na prévia').toBeTruthy();
    const whatsApp = message.deliveries.find((d) => d.channel === 'WhatsApp')!;
    expect(whatsApp.previewBody, 'o WhatsApp tem texto na prévia').toBeTruthy();

    // Tela: o card em "Aguardando ok" com origem, cliente, festa, prazo e as prévias.
    await openQueue(authPage);
    const card = authPage.getByTestId(`client-message-card-${message.id}`);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText('Lembrete de parcela');
    await expect(card).toContainText(party.clientName);
    await expect(card.getByTestId('client-message-event-link')).toBeVisible();
    // §3 Front item 2: "vale até hoje 23:59" (o lembrete vale até o fim do dia do tenant).
    // `soft`: a divergência fica registrada e o resto do cenário ainda roda.
    const today = tenantDayPlus(0).split('-').reverse().join('/');
    await expect
      .soft(card.getByTestId('client-message-expires'), 'o prazo é hoje, 23:59')
      .toHaveText(new RegExp(`Vale até ${today.replace(/\//g, '\\/')} 23:59`));
    await expect(card.getByTestId('client-message-email-subject')).toContainText(email.previewSubject!);
    await expect(card.getByTestId('client-message-whatsapp-preview')).toBeVisible();
    await expect(authPage.getByTestId(`client-message-approve-${message.id}`)).toBeVisible();

    // Nada saiu ao cliente: a submissão já foi processada (a mensagem existe).
    expect(await clientEmails(party, message), 'nenhum e-mail ao cliente antes do ok').toHaveLength(0);
    expect(await clientWhatsApps(party, since), 'nenhum WhatsApp ao cliente antes do ok').toHaveLength(0);
    expect((await apiGetClientMessage(authApi, message.id)).status).toBe('PendingApproval');
  });

  test('@crud E2: the manager approves and the client receives exactly the previewed text on the checked channels; the history shows who approved', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(SCENARIO_TIMEOUT);
    const { party, message, since, templateBody } = await pendingReminder(authApi, tenant.tenantId);
    const email = message.deliveries.find((d) => d.channel === 'Email')!;
    const whatsApp = message.deliveries.find((d) => d.channel === 'WhatsApp')!;
    const approver = await apiCurrentUserName(authApi);

    await openQueue(authPage);
    const card = authPage.getByTestId(`client-message-card-${message.id}`);
    await expect(card).toBeVisible({ timeout: 20_000 });
    // Os dois canais vêm marcados por padrão.
    await expect(authPage.getByTestId(`client-message-channel-${message.id}-Email`).locator('input')).toBeChecked();
    await expect(authPage.getByTestId(`client-message-channel-${message.id}-WhatsApp`).locator('input')).toBeChecked();
    await authPage.getByTestId(`client-message-approve-${message.id}`).click();
    await expect(snack(authPage, 'Mensagem aprovada; o envio sai em instantes.')).toBeVisible();
    await expect(card).toHaveCount(0);

    // O envio sai pelo Outbox: cada entrega vira Enviada.
    await expect
      .poll(
        async () => {
          const m = await apiGetClientMessage(authApi, message.id);
          return [m.status, ...m.deliveries.map((d) => `${d.channel}:${d.status}`).sort()].join('|');
        },
        { message: 'aprovada e entregue nos dois canais', timeout: 60_000 },
      )
      .toBe('Approved|Email:Sent|WhatsApp:Sent');

    const mails = await clientEmails(party, message);
    expect(mails, 'um e-mail ao cliente').toHaveLength(1);
    expect(mails[0]!.subject).toBe(email.previewSubject);
    expect(mails[0]!.bodyHtml.trim(), 'o corpo do e-mail é o da prévia').toBe(email.previewBody.trim());

    const sent = await clientWhatsApps(party, since);
    expect(sent, 'um WhatsApp ao cliente').toHaveLength(1);
    expect(whatsAppTemplateText(sent[0]!, templateBody!), 'o WhatsApp é o texto da prévia').toBe(whatsApp.previewBody);

    // Histórico: Aprovada, quem aprovou, e cada canal Enviado.
    await authPage.getByTestId('client-messages-tab-history').click();
    const row = authPage.getByTestId(`client-message-history-${message.id}`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByTestId('client-message-status')).toHaveText('Aprovada');
    await expect(row.getByTestId('client-message-decided')).toContainText(`Decidida por ${approver}`);
    await expect(row.getByTestId('client-message-history-delivery-Email')).toContainText('Enviado');
    await expect(row.getByTestId('client-message-history-delivery-WhatsApp')).toContainText('Enviado');
  });

  test('@crud E3: the installment is paid before the ok; approving sends nothing and the message becomes obsolete with the reason', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(SCENARIO_TIMEOUT);
    const { party, message, since } = await pendingReminder(authApi, tenant.tenantId);

    await openQueue(authPage);
    const card = authPage.getByTestId(`client-message-card-${message.id}`);
    await expect(card).toBeVisible({ timeout: 20_000 });

    // Em outra aba: o pagamento total da parcela.
    await apiRegisterPayment(authApi, party.eventId, {
      amount: party.amount,
      method: 'Pix',
      installmentId: party.installmentId,
    });

    await authPage.getByTestId(`client-message-approve-${message.id}`).click();
    await expect(snack(authPage, 'Não enviada: a parcela já foi paga.')).toBeVisible();
    await expect(card.getByTestId('client-message-status')).toHaveText('Não enviada');

    const obsolete = await apiGetClientMessage(authApi, message.id);
    expect(obsolete.status).toBe('Obsolete');
    expect(obsolete.obsoleteReason).toBe('a parcela já foi paga');
    expect(obsolete.deliveries.some((d) => d.status === 'Sent' || d.status === 'Queued'), 'nada foi para a fila').toBe(
      false,
    );

    // Aprovar de novo pela API: já decidida.
    const again = await approveClientMessage(authApi, message.id, ['Email']);
    expect(again.status()).toBe(409);
    expect(await apiErrorCodes(again)).toContain('ClientMessages.NotPending');

    await authPage.getByTestId('client-messages-tab-history').click();
    const row = authPage.getByTestId(`client-message-history-${message.id}`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByTestId('client-message-status')).toHaveText('Não enviada');
    await expect(row.getByTestId('client-message-obsolete-reason')).toContainText('a parcela já foi paga');

    expect(await clientEmails(party, message), 'nenhum e-mail ao cliente').toHaveLength(0);
    expect(await clientWhatsApps(party, since), 'nenhum WhatsApp ao cliente').toHaveLength(0);
  });

  test('@crud E4: rejecting sends nothing and the history shows who rejected and why', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(SCENARIO_TIMEOUT);
    const { party, message, since } = await pendingReminder(authApi, tenant.tenantId);
    const rejecter = await apiCurrentUserName(authApi);
    const reason = 'Cliente pediu para não receber';

    await openQueue(authPage);
    const card = authPage.getByTestId(`client-message-card-${message.id}`);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await authPage.getByTestId(`client-message-reject-${message.id}`).click();
    await authPage.getByTestId('client-message-reject-reason').fill(reason);
    await authPage.getByTestId('client-message-reject-confirm').click();
    await expect(snack(authPage, 'Mensagem recusada; nada foi enviado.')).toBeVisible();
    await expect(card).toHaveCount(0);

    const rejected = await apiGetClientMessage(authApi, message.id);
    expect(rejected.status).toBe('Rejected');
    expect(rejected.rejectionReason).toBe(reason);
    expect(rejected.decidedByUserName).toBe(rejecter);

    await authPage.getByTestId('client-messages-tab-history').click();
    const row = authPage.getByTestId(`client-message-history-${message.id}`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.getByTestId('client-message-status')).toHaveText('Recusada');
    await expect(row.getByTestId('client-message-decided')).toContainText(`Recusada por ${rejecter}`);
    await expect(row.getByTestId('client-message-rejection-reason')).toHaveText(`Motivo: ${reason}`);

    expect(await clientEmails(party, message), 'nenhum e-mail ao cliente').toHaveLength(0);
    expect(await clientWhatsApps(party, since), 'nenhum WhatsApp ao cliente').toHaveLength(0);
  });

  test('@flow E5: without ClientMessages.Approve the queue is read-only and the API refuses with 403; another tenant neither sees nor approves the message', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(SCENARIO_TIMEOUT);
    const { party, message } = await pendingReminder(authApi, tenant.tenantId, { whatsApp: false });

    // Tela: o usuário vê a fila e a prévia, sem aprovar, recusar, selecionar nem escolher canal.
    // Nenhum papel interno tem `clientmessages.read` sem `clientmessages.approve`
    // (§3 item 12, decisão 8): a tela recebe a lista sem o código, e o back segue
    // decidindo pelo papel real.
    await withoutPermissions(authPage, ['clientmessages.approve']);
    await openQueue(authPage);
    const card = authPage.getByTestId(`client-message-card-${message.id}`);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card.getByTestId('client-message-email-preview')).toBeVisible();
    await expect(authPage.getByTestId(`client-message-approve-${message.id}`)).toHaveCount(0);
    await expect(authPage.getByTestId(`client-message-reject-${message.id}`)).toHaveCount(0);
    await expect(authPage.getByTestId(`client-message-select-${message.id}`)).toHaveCount(0);
    await expect(authPage.getByTestId(`client-message-channel-${message.id}-Email`)).toHaveCount(0);
    await expect(authPage.getByTestId('client-messages-bulk-bar')).toHaveCount(0);

    // API: um usuário de verdade sem `ClientMessages.Approve` (o do Portal) é recusado.
    const portal = await setupPortalUser(authApi, tenant.tenantId);
    try {
      const forbidden = await approveClientMessage(portal.portalApi, message.id, ['Email']);
      expect(forbidden.status(), 'aprovar sem ClientMessages.Approve').toBe(403);
      const rejectForbidden = await portal.portalApi.post(`/api/client-messages/${message.id}/reject`, {
        data: { reason: null },
      });
      expect(rejectForbidden.status(), 'recusar sem ClientMessages.Approve').toBe(403);
    } finally {
      await portal.portalApi.dispose();
    }

    // Outra empresa: não vê a mensagem, e aprovar pelo id é 404 NotFound.
    const other = await signupNewTenant();
    const otherApi = await createBearerApiContext(other.accessToken);
    try {
      expect((await apiListClientMessages(otherApi)).map((m) => m.id)).not.toContain(message.id);
      const get = await otherApi.get(`/api/client-messages/${message.id}`);
      expect(get.status()).toBe(404);
      expect(await apiErrorCodes(get)).toContain('ClientMessages.NotFound');
      const cross = await approveClientMessage(otherApi, message.id, ['Email']);
      expect(cross.status()).toBe(404);
      expect(await apiErrorCodes(cross)).toContain('ClientMessages.NotFound');
    } finally {
      await otherApi.dispose();
    }

    // Nada mudou na mensagem nem chegou ao cliente.
    expect((await apiGetClientMessage(authApi, message.id)).status).toBe('PendingApproval');
    expect(await clientEmails(party, message), 'nenhum e-mail ao cliente').toHaveLength(0);
  });
});
