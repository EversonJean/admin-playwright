import { authTest as test, expect } from '../../fixtures/auth.fixture';
import {
  enableClientReminder,
  messagesOfEvent,
  seedPaymentReminderWhatsApp,
  setupReminderParty,
  waitForPendingMessage,
} from '../../helpers/client-messages';
import { fakeEmail } from '../../helpers/fake-providers';
import { TRIGGER_TIMEOUT, apiTriggerDailyJob } from '../../helpers/rain-plan';
import { fakeMessagesTo, toE164Br } from '../../helpers/whatsapp-flow';

/**
 * Fluxo: 32 — Lembrete de parcela a vencer, uma vez, aguardando o ok
 * Diagrama: — (o plano é a fonte: PLANO-EXECUCAO-DOS-WORKERS §3 regras 3 e 4,
 * WK-A, Etapa 262; reescrito pelo PLANO-MENSAGENS-AO-CLIENTE-COM-APROVACAO §3
 * item 8, MC-A, Etapa 266, registro e2e E11)
 *
 * E11: com o aviso ao cliente ligado (`FINANCIAL_INSTALLMENT_REMINDER_NOTIFY_CLIENT`),
 * a parcela que vence em 3 dias (régua `FINANCIAL_INSTALLMENT_REMINDER_DAYS`)
 * NÃO sai mais sozinha ao cliente: o ciclo diário submete UMA mensagem
 * aguardando ok por parcela e offset (a chave única do ClientMessages absorve a
 * repetição), mesmo com dois disparos no mesmo dia, e nada chega aos fakes de
 * e-mail e WhatsApp do cliente. O e-mail ao gestor sai uma vez (dedupe da
 * notificação, §3 regra 4 da 262) e diz que o lembrete ao cliente está
 * aguardando o ok dele em Mensagens ao cliente. O "O cliente também recebeu
 * este lembrete." da 262 foi aposentado pela 266.
 *
 * O ciclo é o do `NotificationTriggerService`, pelo gatilho manual
 * `POST /api/notifications/trigger-overdue`. O WhatsApp é o modelo do disparo
 * `PaymentReminder`, aprovado e vinculado à WABA do canal do tenant: a mensagem
 * nasce com os dois canais.
 */

const MANAGER_SUBJECT = 'Parcela vence em';
const AWAITING_APPROVAL = 'O lembrete ao cliente está aguardando seu ok em Mensagens ao cliente';
const CLIENT_REACHED = 'O cliente também recebeu este lembrete.';

test.describe('Fluxo 32 — Lembrete de parcela uma vez, aguardando o ok', () => {
  test('@flow E11: with the client notice on, two daily runs on the same day prepare ONE message awaiting the ok for the installment due in 3 days, nothing reaches the client, and the manager e-mail goes once saying it awaits the ok', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(3 * TRIGGER_TIMEOUT + 240_000);
    seedPaymentReminderWhatsApp(tenant.tenantId);
    await enableClientReminder(authApi);
    const party = await setupReminderParty(authApi);
    const dueLabel = party.dueDate.split('-').reverse().join('/');
    const since = new Date(Date.now() - 1_000).toISOString();

    // Dois disparos do ciclo diário no mesmo dia.
    await apiTriggerDailyJob(authApi);
    await apiTriggerDailyJob(authApi);

    const message = await waitForPendingMessage(authApi, party.eventId);
    expect(message.origin).toBe('InstallmentReminder');
    expect(message.deliveries.map((d) => d.channel).sort()).toEqual(['Email', 'WhatsApp']);

    // A caixa do cliente também tem o envio do orçamento da pré-condição: conta só o lembrete.
    const reminderSubject = message.deliveries.find((d) => d.channel === 'Email')!.previewSubject!;
    const clientReminders = async () =>
      (await fakeEmail.emails({ to: party.clientEmail })).filter((m) => m.subject === reminderSubject);
    const managerEmails = async () =>
      (await fakeEmail.emails({ to: tenant.email, subject: MANAGER_SUBJECT })).filter((m) =>
        m.subject.includes(dueLabel),
      );
    await expect
      .poll(async () => (await managerEmails()).length, { message: 'e-mail de parcela a vencer ao gestor' })
      .toBe(1);
    const [managerMail] = await managerEmails();
    expect(managerMail!.bodyHtml, 'o gestor sabe que o lembrete aguarda o ok dele').toContain(AWAITING_APPROVAL);
    expect(managerMail!.bodyHtml, 'o texto da 262 saiu').not.toContain(CLIENT_REACHED);

    // Uma mensagem por parcela e offset, e nada ao cliente.
    expect(await messagesOfEvent(authApi, party.eventId), 'uma mensagem para a parcela').toHaveLength(1);
    expect(await clientReminders(), 'nenhum e-mail ao cliente').toHaveLength(0);
    expect(await fakeMessagesTo(toE164Br(party.clientPhone), since), 'nenhum WhatsApp ao cliente').toHaveLength(0);

    // Um terceiro disparo no mesmo dia também não repete nada.
    await apiTriggerDailyJob(authApi);
    expect(await messagesOfEvent(authApi, party.eventId), 'terceiro disparo: mensagens').toHaveLength(1);
    expect(await managerEmails(), 'terceiro disparo: e-mail ao gestor').toHaveLength(1);
    expect(await clientReminders(), 'terceiro disparo: e-mail ao cliente').toHaveLength(0);
    expect(await fakeMessagesTo(toE164Br(party.clientPhone), since), 'terceiro disparo: WhatsApp ao cliente').toHaveLength(
      0,
    );
  });
});
