import type { APIRequestContext } from '@playwright/test';

import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { NotificationItem, apiCompleteOnboarding, apiListNotifications } from '../../helpers/api-entities';
import {
  ClientMessage,
  enableClientReminder,
  setupReminderParty,
  waitForPendingMessage,
} from '../../helpers/client-messages';
import { TRIGGER_TIMEOUT, apiTriggerDailyJob } from '../../helpers/rain-plan';
import { loginAsRole, setupPortalUser } from '../../helpers/setup-flows';
import { snack } from '../../helpers/ui';

/**
 * Fluxo: 11.5 — Aviso e visão única das mensagens ao cliente
 * Diagrama: docs/fluxos/negocio-11.5-aviso-e-visao-unica-das-mensagens-ao-cliente.mmd
 *
 * PLANO-MENSAGENS-AO-CLIENTE-COM-APROVACAO §5 (MC-C, Etapa 268), registro e2e
 * E7: com mensagem aguardando ok, quem tem `ClientMessages.Approve` recebe UM
 * aviso no sino por dia ("Mensagens ao cliente aguardando seu ok"), que abre a
 * tela; o menu mostra o contador de pendentes; decidir todas zera e esconde o
 * contador, e o aviso fica no sino.
 *
 * Nenhum papel interno fica sem `ClientMessages.Approve` (§3 item 12, decisão
 * 8): o usuário de verdade sem a permissão é o do Portal do colaborador.
 */

const NOTICE_TYPE = 'ClientMessagesPendingApproval';
const NOTICE_TITLE = 'Mensagens ao cliente aguardando seu ok';
const BADGE = 'nav-badge-/app/client-messages';

async function pendingNotices(api: APIRequestContext): Promise<NotificationItem[]> {
  return (await apiListNotifications(api)).filter((n) => n.type === NOTICE_TYPE);
}

test.describe('Fluxo 11.5 — Aviso e visão única das mensagens ao cliente', () => {
  test.beforeEach(async ({ authApi }) => {
    await apiCompleteOnboarding(authApi);
  });

  test('@crud E7: a pending message notifies once a day only who can approve and opens the screen; the menu counts the pending ones, and deciding all of them hides the counter while the notice stays in the bell', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(3 * TRIGGER_TIMEOUT + 240_000);
    await enableClientReminder(authApi);

    // Os usuários nascem antes da varredura: o aviso é para quem existe quando a mensagem chega.
    const financial = await loginAsRole(tenant.tenantId, 'Financial');
    const portal = await setupPortalUser(authApi, tenant.tenantId);
    try {
      // Primeira passada: duas parcelas na régua, duas mensagens.
      const first = [await setupReminderParty(authApi), await setupReminderParty(authApi)];
      await apiTriggerDailyJob(authApi);
      const messages: ClientMessage[] = [];
      for (const p of first) messages.push(await waitForPendingMessage(authApi, p.eventId));

      await expect
        .poll(async () => (await pendingNotices(authApi)).length, { message: 'aviso ao Dono', timeout: 60_000 })
        .toBe(1);
      await expect
        .poll(async () => (await pendingNotices(financial.api)).length, {
          message: 'aviso ao Financeiro',
          timeout: 60_000,
        })
        .toBe(1);
      const [notice] = await pendingNotices(authApi);
      expect(notice!.title).toBe(NOTICE_TITLE);
      // A contagem é a da hora em que o aviso sai: com a primeira mensagem que nasce.
      expect(notice!.message).toMatch(/^(1 mensagem|[12] mensagens) ao cliente aguardando seu ok\./);
      expect(notice!.message, 'o primeiro aviso explica a mudança').toContain('Novidade:');
      expect(notice!.contextEntityId ?? null, 'aviso sem contexto').toBeNull();

      // Segunda passada no mesmo dia, com outra parcela entrando na régua: nenhum aviso novo.
      const late = await setupReminderParty(authApi);
      await apiTriggerDailyJob(authApi);
      messages.push(await waitForPendingMessage(authApi, late.eventId));

      // Menu: o contador mostra as 3 pendentes.
      await authPage.goto('/app');
      await expect(authPage.getByTestId('notification-bell')).toBeVisible({ timeout: 30_000 });
      await expect(authPage.getByTestId(BADGE)).toHaveText('3', { timeout: 30_000 });

      // Sino: o aviso abre "Mensagens ao cliente", na aba "Aguardando ok".
      await authPage.getByTestId('notification-bell').click();
      await authPage.getByTestId(`notification-open-${notice!.id}`).click();
      await expect(authPage.getByTestId('client-messages-page')).toBeVisible();
      await expect(authPage).toHaveURL(/\/app\/client-messages(\?|$)/);
      await expect(authPage.getByTestId('client-messages-tab-pending')).toHaveAttribute('aria-selected', 'true');

      // Decidir todas: aprovar uma, recusar outra, aprovar a última em lote.
      const [a, b, c] = messages;
      await expect(authPage.getByTestId(`client-message-card-${a!.id}`)).toBeVisible({ timeout: 20_000 });
      await authPage.getByTestId(`client-message-approve-${a!.id}`).click();
      await expect(snack(authPage, 'Mensagem aprovada; o envio sai em instantes.')).toBeVisible();
      await expect(authPage.getByTestId(BADGE)).toHaveText('2');

      await authPage.getByTestId(`client-message-reject-${b!.id}`).click();
      await authPage.getByTestId('client-message-reject-confirm').click();
      await expect(snack(authPage, 'Mensagem recusada; nada foi enviado.')).toBeVisible();
      await expect(authPage.getByTestId(BADGE)).toHaveText('1');

      await authPage.getByTestId(`client-message-select-${c!.id}`).click();
      await authPage.getByTestId('client-messages-approve-selected').click();
      await expect(authPage.getByTestId(`client-messages-batch-row-${c!.id}`)).toBeVisible();
      await expect(authPage.getByTestId(BADGE), 'decidir todas esconde o contador').toHaveCount(0);
      await expect(authPage.getByTestId('client-messages-empty')).toBeVisible();

      // O aviso fica no sino, e continua sendo um só no dia, para quem aprova.
      expect((await pendingNotices(authApi)).map((n) => n.id), 'um aviso no dia ao Dono').toEqual([notice!.id]);
      expect(await pendingNotices(financial.api), 'um aviso no dia ao Financeiro').toHaveLength(1);
      expect(await pendingNotices(portal.portalApi), 'sem ClientMessages.Approve não recebe').toHaveLength(0);
      await authPage.getByTestId('notification-bell').click();
      await expect(authPage.getByTestId(`notification-item-${notice!.id}`)).toBeVisible();
    } finally {
      await financial.api.dispose();
      await portal.portalApi.dispose();
    }
  });
});
