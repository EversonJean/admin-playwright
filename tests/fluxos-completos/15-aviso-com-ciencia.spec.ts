import type { APIRequestContext } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createApiContext, createBearerApiContext, loginViaApi, signupNewTenant } from '../../helpers/api-client';
import {
  NotificationItem,
  apiCompleteOnboarding,
  apiCreateCollaborator,
  apiListNotifications,
} from '../../helpers/api-entities';
import {
  seedUserWithRoleDirect,
  seedWhatsappChannelDirect,
  setUserRoleDirect,
  userIdByEmailDirect,
} from '../../helpers/db-helper';
import { tenantDayPlus } from '../../helpers/rain-plan';
import { apiListPendingAcknowledgement, setupReservedRental } from '../../helpers/rental-preparation';
import { apiErrorCodes, assertOk, readJson } from '../../helpers/response';
import { RoleSession, loginPortalCollaborator, openSessionPage } from '../../helpers/setup-flows';
import { uniqueMobilePhone } from '../../helpers/test-data';
import { enableWhatsAppFeaturesDirect, fakeTextsTo, receiveInbound } from '../../helpers/whatsapp-flow';

/**
 * Fluxo: 15 — Aviso com ciência e encaminhamento ao colaborador
 * Diagrama: — (o plano é a fonte: PLANO-PREPARACAO-DE-EQUIPAMENTOS §5, PE-C,
 * itens 2, 4 e 7)
 *
 * E2: aviso com ciência encaminhado ao colaborador pelo Portal e pelo WhatsApp
 * (fake); o colaborador dá ciência pelo Portal e pelo comando CIENTE; quem
 * encaminhou recebe o aviso de ciência; colaborador de outro tenant não recebe.
 *
 * E17: permissão com o usuário de verdade: o Financeiro não vê "Encaminhar" e o
 * `forward` e o `forward-targets` pela API dão 403; o colaborador não dá ciência
 * num aviso que não é dele (404) nem dispensa o próprio antes da ciência (409).
 *
 * O aviso de origem é o 35 `RentalPreparationDue` (PE-D), o primeiro do sistema
 * que nasce pedindo ciência (§5: "nesta fatia nenhum aviso ainda a usa"): uma
 * locação reservada com entrega em 7 dias o grava para os gestores.
 */

interface ForwardRow {
  id: string;
  collaboratorId: string;
  channels: string[];
  acknowledgedAt: string | null;
  acknowledgedVia: string | null;
}

/** O 35 do usuário sobre a locação. */
async function dueNoticeOf(api: APIRequestContext, rentalId: string): Promise<NotificationItem | undefined> {
  return (await apiListNotifications(api)).find(
    (n) => n.type === 'RentalPreparationDue' && n.contextEntityId === rentalId,
  );
}

/** Os avisos encaminhados (33) que o colaborador recebeu no Portal. */
async function forwardedTo(portalApi: APIRequestContext): Promise<NotificationItem[]> {
  return (await apiListNotifications(portalApi)).filter((n) => n.type === 'NoticeForwarded');
}

/** GET /api/notifications/{id}/forwards — a linha do tempo do aviso de origem. */
async function forwardsOf(api: APIRequestContext, notificationId: string): Promise<ForwardRow[]> {
  const res = await api.get(`/api/notifications/${notificationId}/forwards`);
  await assertOk(res, 'GET /api/notifications/{id}/forwards');
  return readJson<ForwardRow[]>(res);
}

function forward(
  api: APIRequestContext,
  notificationId: string,
  body: { collaboratorId: string; channels: Array<'Portal' | 'WhatsApp'>; note?: string },
) {
  return api.post(`/api/notifications/${notificationId}/forward`, {
    data: { collaboratorId: body.collaboratorId, channels: body.channels, note: body.note ?? null },
  });
}

test.describe('Fluxo 15 — Aviso com ciência e encaminhamento ao colaborador', () => {
  test('@flow E2: a notice that requires acknowledgement is forwarded by Portal and WhatsApp; the collaborator acknowledges by Portal and by the CIENTE command; the forwarder gets the acknowledgement notice; a collaborator of another tenant gets nothing', async ({
    authApi,
    authPage,
    browser,
    tenant,
  }) => {
    test.setTimeout(300_000);
    await apiCompleteOnboarding(authApi);
    enableWhatsAppFeaturesDirect(tenant.tenantId);
    const phoneNumberId = seedWhatsappChannelDirect(tenant.tenantId);
    // §5 item 7: o "Responda CIENTE" e o comando só valem com o assistente ligado.
    await assertOk(
      await authApi.put('/api/collaborator-assistant/whatsapp-config', {
        data: {
          enabled: true,
          requirePhoneVerification: false,
          whatsappCommissionsEnabled: true,
          whatsappLeaderPhoneEnabled: true,
        },
      }),
      'PUT /api/collaborator-assistant/whatsapp-config',
    );

    const { rental } = await setupReservedRental(authApi, tenant.tenantId, { deliveryDate: tenantDayPlus(7) });
    const due = await dueNoticeOf(authApi, rental.id);
    expect(due, 'o 35 da reserva, com ciência').toBeTruthy();
    expect(due!.requiresAcknowledgement).toBe(true);

    // O colaborador tem Portal e WhatsApp; ele já escreveu para o número da
    // empresa, então a janela de 24 h está aberta e o texto livre sai.
    const name = `Joao Ciencia ${Date.now()}`;
    const phone = `+55${uniqueMobilePhone()}`;
    const collaborator = await apiCreateCollaborator(authApi, { name, phone });
    const portal = await loginPortalCollaborator(tenant.tenantId, collaborator.id);
    await receiveInbound(phoneNumberId, phone, 'Oi, sou da equipe');

    const sessions: RoleSession[] = [portal];
    try {
      // §5 itens 4 e 10: o gestor encaminha pelo diálogo, pelos dois canais.
      const sentSince = new Date().toISOString();
      await authPage.goto('/app');
      await authPage.getByTestId('notification-bell').click();
      await expect(authPage.getByTestId(`notification-ack-pending-${due!.id}`)).toBeVisible({ timeout: 20_000 });
      await authPage.getByTestId(`notification-forward-${due!.id}`).click();
      await expect(authPage.getByTestId('forward-notification-title')).toBeVisible();
      await authPage.getByTestId('forward-notification-collaborator').fill(name);
      await authPage.getByTestId(`forward-notification-collaborator-option-${collaborator.id}`).click();
      // O diálogo marca de saída os canais que o colaborador tem.
      await expect(authPage.getByTestId('forward-notification-channel-portal').locator('input')).toBeChecked();
      await expect(authPage.getByTestId('forward-notification-channel-whatsapp').locator('input')).toBeChecked();
      await authPage.getByTestId('forward-notification-note').fill('Confere a bomba antes de sair');
      await authPage.getByTestId('forward-notification-send').click();
      await expect(authPage.getByTestId('forward-notification-result')).toBeVisible({ timeout: 20_000 });
      await expect(authPage.getByTestId('forward-notification-result-Portal')).toContainText('enviado');
      await expect(authPage.getByTestId('forward-notification-result-WhatsApp')).toContainText('enviado');
      await authPage.getByTestId('forward-notification-close').click();

      // Portal: o aviso filho 33, com ciência, sobre a mesma locação.
      await expect.poll(async () => (await forwardedTo(portal.api)).length).toBeGreaterThan(0);
      const child = (await forwardedTo(portal.api))[0]!;
      expect(child.requiresAcknowledgement).toBe(true);
      expect(child.forwardedType).toBe('RentalPreparationDue');
      expect(child.contextEntityId).toBe(rental.id);

      // WhatsApp (fake): o texto chega ao telefone e pede "CIENTE" (assistente ligado).
      await expect
        .poll(
          async () =>
            (await fakeTextsTo(phone, sentSince)).filter(
              (t) => t.includes('CIENTE') && t.includes(rental.rentalNumber),
            ).length,
          { message: 'o aviso encaminhado no WhatsApp, com "Responda CIENTE"' },
        )
        .toBeGreaterThan(0);

      // §5 item 7: ciência pelo Portal, na tela do colaborador.
      const view = await openSessionPage(browser, portal.tokens);
      try {
        await view.page.goto('/portal/notifications');
        await expect(view.page.getByTestId(`portal-notification-ack-pending-${child.id}`)).toBeVisible({
          timeout: 20_000,
        });
        await view.page.getByTestId(`portal-notification-acknowledge-${child.id}`).click();
        await expect(view.page.getByTestId(`portal-notification-acknowledged-${child.id}`)).toBeVisible({
          timeout: 20_000,
        });
      } finally {
        await view.context.close();
      }

      const afterPortal = await forwardsOf(authApi, due!.id);
      expect(afterPortal).toHaveLength(1);
      expect(afterPortal[0]!.channels.sort()).toEqual(['Portal', 'WhatsApp']);
      expect(afterPortal[0]!.acknowledgedAt, 'ciência gravada no encaminhamento').toBeTruthy();
      expect(afterPortal[0]!.acknowledgedVia).toBe('Portal');

      // Quem encaminhou recebe o 34 ("João deu ciência pelo Portal").
      await expect
        .poll(async () =>
          (await apiListNotifications(authApi)).filter(
            (n) => n.type === 'NoticeAcknowledged' && n.message.includes('deu ciência pelo Portal'),
          ).length,
        )
        .toBe(1);

      // §5 item 7: encaminhado de novo, só pelo WhatsApp, e a ciência pelo comando CIENTE.
      const whatsOnly = await forward(authApi, due!.id, { collaboratorId: collaborator.id, channels: ['WhatsApp'] });
      await assertOk(whatsOnly, 'forward WhatsApp');
      const whatsResult = await readJson<{ forwardId: string; channels: Array<{ channel: string; delivered: boolean }> }>(
        whatsOnly,
      );
      expect(whatsResult.channels.find((c) => c.channel === 'WhatsApp')?.delivered).toBe(true);

      const replySince = new Date().toISOString();
      await receiveInbound(phoneNumberId, phone, 'ciente');
      await expect
        .poll(async () => (await fakeTextsTo(phone, replySince)).join('\n'), { message: 'resposta ao CIENTE' })
        .toContain('Ciência registrada');

      const byWhatsApp = (await forwardsOf(authApi, due!.id)).find((f) => f.id === whatsResult.forwardId);
      expect(byWhatsApp?.acknowledgedAt, 'ciência pelo comando').toBeTruthy();
      expect(byWhatsApp?.acknowledgedVia).toBe('WhatsApp');
      await expect
        .poll(async () =>
          (await apiListNotifications(authApi)).filter(
            (n) => n.type === 'NoticeAcknowledged' && n.message.includes('deu ciência pelo WhatsApp'),
          ).length,
        )
        .toBe(1);

      // Isolamento: colaborador de outro tenant não é alvo nem recebe nada.
      const other = await signupNewTenant();
      const otherAdmin = await createBearerApiContext(other.accessToken);
      try {
        const outsiderName = `Fora Ciencia ${Date.now()}`;
        const outsider = await apiCreateCollaborator(otherAdmin, { name: outsiderName });
        const outsiderPortal = await loginPortalCollaborator(other.tenantId, outsider.id);
        sessions.push(outsiderPortal);

        const cross = await forward(authApi, due!.id, { collaboratorId: outsider.id, channels: ['Portal'] });
        expect(cross.status(), 'colaborador de outro tenant').toBe(400);
        expect(await apiErrorCodes(cross)).toContain('Notification.ForwardTargetNotFound');

        const targets = await authApi.get(`/api/notifications/forward-targets?search=${encodeURIComponent(outsiderName)}`);
        await assertOk(targets, 'GET forward-targets');
        const targetIds = (await readJson<Array<{ collaboratorId: string }>>(targets)).map((t) => t.collaboratorId);
        expect(targetIds).not.toContain(outsider.id);

        expect(await forwardedTo(outsiderPortal.api), 'nada chega ao Portal do outro tenant').toHaveLength(0);
        expect((await forwardsOf(authApi, due!.id)).map((f) => f.collaboratorId)).not.toContain(outsider.id);
      } finally {
        await otherAdmin.dispose();
      }
    } finally {
      for (const s of sessions) await s.api.dispose();
    }
  });

  test('@flow E17: Financial does not see "Encaminhar" and gets 403 on forward and forward-targets; the collaborator gets 404 acknowledging a notice that is not theirs and 409 dismissing their own before acknowledging', async ({
    authApi,
    browser,
    tenant,
  }) => {
    test.setTimeout(240_000);
    await apiCompleteOnboarding(authApi);

    // O 35 vai só a Owner/Admin/Manager. Para o Financeiro de verdade ter um
    // aviso com ciência na própria caixa, ele era gestor quando a locação foi
    // reservada e foi rebaixado depois (o aviso fica com ele).
    const user = seedUserWithRoleDirect({ tenantId: tenant.tenantId, role: 'Manager', emailPrefix: 'financial' });
    const { rental } = await setupReservedRental(authApi, tenant.tenantId, { deliveryDate: tenantDayPlus(7) });
    setUserRoleDirect(userIdByEmailDirect(user.email), 'Financial');
    const anon = await createApiContext();
    const tokens = await loginViaApi(anon, user.email, user.password).finally(() => anon.dispose());
    const financialApi = await createBearerApiContext(tokens.accessToken);

    const collaborator = await apiCreateCollaborator(authApi);
    const portal = await loginPortalCollaborator(tenant.tenantId, collaborator.id);
    try {
      const financialDue = await dueNoticeOf(financialApi, rental.id);
      expect(financialDue, 'o 35 está na caixa do Financeiro').toBeTruthy();
      expect(financialDue!.requiresAcknowledgement).toBe(true);

      // §5 item 4: `Notifications.Forward` é de Owner, Admin e Manager.
      const forbidden = await forward(financialApi, financialDue!.id, {
        collaboratorId: collaborator.id,
        channels: ['Portal'],
      });
      expect(forbidden.status(), 'Financial não encaminha').toBe(403);
      const targets = await financialApi.get('/api/notifications/forward-targets?search=a');
      expect(targets.status(), 'Financial não lista destinatários').toBe(403);

      // Tela: o aviso pede ciência ao Financeiro, sem o botão "Encaminhar".
      const view = await openSessionPage(browser, tokens);
      try {
        await view.page.goto('/app');
        await view.page.getByTestId('notification-bell').click();
        await expect(view.page.getByTestId(`notification-acknowledge-${financialDue!.id}`)).toBeVisible({
          timeout: 20_000,
        });
        await expect(view.page.getByTestId(`notification-forward-${financialDue!.id}`)).toHaveCount(0);
      } finally {
        await view.context.close();
      }

      // O gestor encaminha ao colaborador (o aviso dele, não o do Financeiro).
      const adminDue = (await dueNoticeOf(authApi, rental.id))!;
      await assertOk(
        await forward(authApi, adminDue.id, { collaboratorId: collaborator.id, channels: ['Portal'] }),
        'forward Portal',
      );
      await expect.poll(async () => (await forwardedTo(portal.api)).length).toBeGreaterThan(0);
      const child = (await forwardedTo(portal.api))[0]!;

      // §5 item 2: dispensar antes da ciência é 409.
      const dismiss = await portal.api.post(`/api/notifications/${child.id}/dismiss`);
      expect(dismiss.status(), 'dispensar o próprio antes da ciência').toBe(409);
      expect(await apiErrorCodes(dismiss)).toContain('Notification.AcknowledgementPending');

      // §5 item 1: só o destinatário dá ciência; o aviso do gestor é 404 para ele.
      const alien = await portal.api.post(`/api/notifications/${adminDue.id}/acknowledge`);
      expect(alien.status(), 'ciência em aviso alheio').toBe(404);
      expect((await dueNoticeOf(authApi, rental.id))!.acknowledgedAt ?? null, 'nada gravado').toBeNull();

      // E a própria ciência continua valendo.
      await assertOk(await portal.api.post(`/api/notifications/${child.id}/acknowledge`), 'acknowledge');
      expect((await apiListPendingAcknowledgement(portal.api)).map((n) => n.id)).not.toContain(child.id);
    } finally {
      await financialApi.dispose();
      await portal.api.dispose();
    }
  });
});
