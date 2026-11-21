import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateClient, apiSetSettingParameter } from '../../helpers/api-entities';
import { apiCreatePaymentPlan, apiGetPaymentSummary } from '../../helpers/api-event-flow';
import {
  enableFeatureFlagDirect,
  ensureTriggerWhatsAppTemplateDirect,
  seedConnectedWhatsappTenantDirect,
} from '../../helpers/db-helper';
import { fakeEmail } from '../../helpers/fake-providers';
import { TRIGGER_TIMEOUT, apiTriggerDailyJob, tenantDayPlus, uniqueSuffix } from '../../helpers/rain-plan';
import { setupAcceptedEvent } from '../../helpers/setup-flows';
import { uniqueMobilePhone } from '../../helpers/test-data';
import { fakeMessagesTo, toE164Br } from '../../helpers/whatsapp-flow';

/**
 * Fluxo: 32 — Lembrete de parcela a vencer, uma vez por canal
 * Diagrama: — (o plano é a fonte: PLANO-EXECUCAO-DOS-WORKERS §3 regras 3 e 4,
 * WK-A, Etapa 262, e a revisão pós-entrega de 2026-11-20; registro e2e E4)
 *
 * E4: com o aviso ao cliente ligado (`FINANCIAL_INSTALLMENT_REMINDER_NOTIFY_CLIENT`),
 * a parcela que vence em 3 dias (régua `FINANCIAL_INSTALLMENT_REMINDER_DAYS`)
 * leva ao cliente UM e-mail e UM WhatsApp, mesmo com dois disparos do ciclo
 * diário no mesmo dia: cada canal reivindica (parcela, offset, canal) no
 * `IWorkLedger` antes de sair (§3 regra 3). O e-mail ao gestor sai uma vez
 * (dedupe da notificação, enviado depois do commit, §3 regra 4) e, como o
 * cliente foi alcançado, diz "O cliente também recebeu este lembrete.".
 *
 * O ciclo é o do `NotificationTriggerService`, pelo gatilho manual
 * `POST /api/notifications/trigger-overdue`. O ciclo de segundo plano pode ter
 * rodado também para este tenant; a contagem continua sendo uma por canal.
 *
 * O WhatsApp ao cliente é o template do disparo `PaymentReminder`, aprovado no
 * catálogo e vinculado à WABA do canal semeado do tenant.
 */

const CLIENT_SUBJECT = 'Lembrete: parcela da sua festa vence em';
const MANAGER_SUBJECT = 'Parcela vence em';
const CLIENT_REACHED = 'O cliente também recebeu este lembrete.';

test.describe('Fluxo 32 —Lembrete de parcela uma vez por canal', () => {
  test('@flow E4: with the client notice on, the installment due in 3 days reaches the client once by e-mail and once by WhatsApp with two daily runs on the same day, and the manager e-mail goes once saying the client was also reminded', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(3 * TRIGGER_TIMEOUT + 240_000);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_whatsapp');
    const template = ensureTriggerWhatsAppTemplateDirect({
      trigger: 'PaymentReminder',
      namePrefix: 'lembrete_parcela_e2e',
      body: 'Ola, {{1}}! A parcela {{2}} de R$ {{3}} vence em {{4}}.',
      variables: ['nome', 'parcela', 'valor', 'vencimento'],
    });
    seedConnectedWhatsappTenantDirect(tenant.tenantId, [template.id]);
    await apiSetSettingParameter(authApi, 'FINANCIAL_INSTALLMENT_REMINDER_DAYS', '3');
    await apiSetSettingParameter(authApi, 'FINANCIAL_INSTALLMENT_REMINDER_NOTIFY_CLIENT', 'true');

    // Cliente com e-mail e celular próprios; festa mais adiante, com uma
    // parcela única vencendo em 3 dias no calendário do tenant.
    const clientPhone = uniqueMobilePhone();
    const clientEmail = `cliente-parcela-${uniqueSuffix()}@e2e.test`;
    const client = await apiCreateClient(authApi, { phone: clientPhone, email: clientEmail });
    const { eventId } = await setupAcceptedEvent(authApi, {
      clientId: client.id,
      budget: { eventDate: tenantDayPlus(20), childrenCount: 15, startTime: '14:00', endTime: '18:00' },
    });
    const { eventTotal } = await apiGetPaymentSummary(authApi, eventId);
    const dueDate = tenantDayPlus(3);
    await apiCreatePaymentPlan(authApi, eventId, [
      { order: 1, label: 'Parcela única', expectedAmount: eventTotal, dueDate },
    ]);
    const dueLabel = dueDate.split('-').reverse().join('/');
    const since = new Date(Date.now() - 1_000).toISOString();

    // Dois disparos do ciclo diário no mesmo dia.
    await apiTriggerDailyJob(authApi);
    await apiTriggerDailyJob(authApi);

    const clientEmails = () => fakeEmail.emails({ to: clientEmail, subject: CLIENT_SUBJECT });
    const clientWhatsApps = () => fakeMessagesTo(toE164Br(clientPhone), since);
    const managerEmails = async () =>
      (await fakeEmail.emails({ to: tenant.email, subject: MANAGER_SUBJECT })).filter((m) =>
        m.subject.includes(dueLabel),
      );

    await expect
      .poll(async () => (await clientEmails()).length, { message: 'e-mail de lembrete ao cliente' })
      .toBe(1);
    await expect
      .poll(async () => (await clientWhatsApps()).length, { message: 'WhatsApp de lembrete ao cliente' })
      .toBe(1);
    await expect
      .poll(async () => (await managerEmails()).length, { message: 'e-mail de parcela a vencer ao gestor' })
      .toBe(1);

    const [clientMail] = await clientEmails();
    expect(clientMail!.subject).toContain(dueLabel);
    const [whatsApp] = await clientWhatsApps();
    expect(JSON.stringify(whatsApp!.body), 'o WhatsApp é o modelo do lembrete de parcela').toContain(template.name);
    const [managerMail] = await managerEmails();
    expect(managerMail!.bodyHtml, 'o gestor sabe que o cliente foi avisado').toContain(CLIENT_REACHED);

    // Um terceiro disparo no mesmo dia também não repete nenhum dos três.
    await apiTriggerDailyJob(authApi);
    expect(await clientEmails(), 'terceiro disparo: e-mail ao cliente').toHaveLength(1);
    expect(await clientWhatsApps(), 'terceiro disparo: WhatsApp ao cliente').toHaveLength(1);
    expect(await managerEmails(), 'terceiro disparo: e-mail ao gestor').toHaveLength(1);
  });
});
