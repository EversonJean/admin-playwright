import { APIRequestContext } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { twoTenantsTest } from '../../fixtures/two-tenants.fixture';
import { setSubscriptionActiveDirect, setTrialEndDirect } from '../../helpers/db-helper';
import { fakeEmail } from '../../helpers/fake-providers';
import { assertOk } from '../../helpers/response';

/**
 * Fluxo: 11.1.1 — e-mails de fim do período de teste
 * Plano: docs/implementar/PLANO-AJUSTES-DA-CONVERSAO.md §10 item 2 (AJ-D,
 * Etapa 201) e "Testes" da §10. Registro e2e: E30.
 *
 *   1. Tenant em teste com fim em 3 dias NO FUSO DELE recebe "Seu período de
 *      teste termina em 3 dias" uma vez só, mesmo com dois disparos no dia.
 *   2. No dia do fim recebe "chegou ao fim", também uma vez.
 *   3. Tenant que já assinou não recebe nenhum dos dois.
 *
 * O disparo é o job diário de gatilhos (`NotificationTriggerService`, 07:00 no
 * fuso do tenant), que tem o gatilho manual `POST /api/notifications/trigger-overdue`
 * para o tenant do usuário: é ele que o teste chama, duas vezes no mesmo dia.
 * O fuso do tenant é o de Tóquio (UTC+9), para a data local poder ser outra
 * que a do servidor e a do navegador.
 *
 * Um teste por vez, na ordem (sem pular os seguintes quando um falha): cada
 * teste chama o job diário até quatro vezes, e em paralelo os disparos disputariam
 * o mesmo back no prazo do TRIGGER_TIMEOUT.
 *
 * Sem diagrama `.mmd`: verificação de plano de ajustes.
 */

test.describe.configure({ mode: 'default' });

const EXPIRING = 'Seu período de teste termina em';
const EXPIRED = 'Seu período de teste chegou ao fim';
const TENANT_TZ = 'Asia/Tokyo';

/**
 * Prazo próprio do disparo, por folga: o job percorre todos os gatilhos do
 * tenant (parcelas, eventos, avisos) num request só, e com o back do e2e
 * compilando ou sob carga isso pode passar dos 15 s padrão.
 */
const TRIGGER_TIMEOUT = 180_000;

async function triggerDailyJob(api: APIRequestContext): Promise<void> {
  await assertOk(
    await api.post('/api/notifications/trigger-overdue', { timeout: TRIGGER_TIMEOUT }),
    'POST /api/notifications/trigger-overdue',
  );
}

async function mails(to: string, subject: string) {
  return fakeEmail.emails({ to, subject });
}

test.describe('Fluxo 11.1.1 — trial ending e-mails', () => {
  // Quatro disparos por teste, cada um até TRIGGER_TIMEOUT (ver acima).
  test.describe.configure({ timeout: 4 * TRIGGER_TIMEOUT + 60_000 });

  test('@flow trial ending in 3 days (tenant timezone) gets "termina em 3 dias" once with two runs, and "chegou ao fim" once on the last day', async ({
    authApi,
    tenant,
  }) => {
    // 1. D-3 no calendário do tenant.
    setTrialEndDirect(tenant.tenantId, TENANT_TZ, 3);
    await triggerDailyJob(authApi);
    await triggerDailyJob(authApi);

    await expect
      .poll(async () => (await mails(tenant.email, EXPIRING)).length, {
        message: 'aviso de D-3 chega ao dono do tenant',
      })
      .toBe(1);
    const [expiring] = await mails(tenant.email, EXPIRING);
    expect(expiring!.subject).toBe('Seu período de teste termina em 3 dias');
    expect(await mails(tenant.email, EXPIRED), 'D-3 não manda o de fim').toHaveLength(0);

    // 2. O dia do fim, também no fuso do tenant.
    setTrialEndDirect(tenant.tenantId, TENANT_TZ, 0);
    await triggerDailyJob(authApi);
    await triggerDailyJob(authApi);

    await expect
      .poll(async () => (await mails(tenant.email, EXPIRED)).length, {
        message: 'aviso de fim do teste chega ao dono do tenant',
      })
      .toBe(1);
    expect(await mails(tenant.email, EXPIRING), 'o de D-3 não repete').toHaveLength(1);
  });

  test('@flow tenant that already subscribed receives neither e-mail', async ({ authApi, tenant }) => {
    // A data do teste fica em D-3 de propósito: quem decide é a assinatura paga.
    setTrialEndDirect(tenant.tenantId, TENANT_TZ, 3);
    setSubscriptionActiveDirect(tenant.tenantId, { keepTrialEndsAt: true });
    await triggerDailyJob(authApi);
    await triggerDailyJob(authApi);

    setTrialEndDirect(tenant.tenantId, TENANT_TZ, 0);
    await triggerDailyJob(authApi);

    expect(await mails(tenant.email, EXPIRING)).toHaveLength(0);
    expect(await mails(tenant.email, EXPIRED)).toHaveLength(0);
  });
});

twoTenantsTest.describe('Fluxo 11.1.1 — trial ending e-mails: tenant isolation', () => {
  twoTenantsTest.describe.configure({ timeout: TRIGGER_TIMEOUT + 60_000 });

  twoTenantsTest('@flow the trial e-mail of tenant A does not reach the owner of tenant B', async ({
    apiA,
    tenantA,
    tenantB,
  }) => {
    // B já assinou; A está a 3 dias do fim. Só A dispara o job.
    setSubscriptionActiveDirect(tenantB.tenantId);
    setTrialEndDirect(tenantA.tenantId, TENANT_TZ, 3);
    await triggerDailyJob(apiA);

    await expect.poll(async () => (await mails(tenantA.email, EXPIRING)).length).toBe(1);
    expect(await mails(tenantB.email, EXPIRING), 'e-mail de A no dono de B').toHaveLength(0);
  });
});
