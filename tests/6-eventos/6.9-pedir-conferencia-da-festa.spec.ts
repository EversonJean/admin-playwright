import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import { apiCompleteOnboarding, apiListNotifications } from '../../helpers/api-entities';
import { apiPatchEvent } from '../../helpers/api-event-flow';
import { enableFeatureFlagDirect, seedWhatsappChannelDirect } from '../../helpers/db-helper';
import {
  apiGetInfoReview,
  apiReviewEventInfo,
  openTeamTab,
  remindInfoReview,
  teamInfoReviewCell,
} from '../../helpers/event-info-review';
import { fakeWhatsApp } from '../../helpers/fake-providers';
import { setupConfirmedPortalCollaborator, tenantDayPlus } from '../../helpers/rain-plan';
import { apiErrorCodes } from '../../helpers/response';
import { RoleSession, loginAsRole, openSessionPage, setupAcceptedEvent } from '../../helpers/setup-flows';

/**
 * Fluxo: 6.9 — Pedir conferência da festa à equipe
 * Diagrama: — (o plano é a fonte: PLANO-ESTOQUE-DO-RECREADOR §5.1, ER-C;
 * "Pedir conferência" e regra 5; §5.2 itens 4 e 5; decisão 20)
 *
 * E12: quem lê o evento sem `events.update` vê a coluna "Conferiu a festa" e
 * não tem o "Pedir conferência" (403 na API); o gestor de outra empresa recebe
 * 404; com toda a equipe em dia, o pedido responde 409 sem avisar ninguém; com
 * quem não conferiu, avisa só no sino e, com quem está desatualizado, também no
 * WhatsApp pelo fake, com o resultado por colaborador.
 */

function infoReviewNotices(api: Parameters<typeof apiListNotifications>[0], eventId: string) {
  return apiListNotifications(api).then((list) =>
    list.filter((n) => n.type === 'EventInfoReviewPending' && n.contextEntityId === eventId),
  );
}

test.describe('Fluxo 6.9 — Pedir conferência da festa', () => {
  test('@flow E12: without events.update the column shows and the request button does not (403 by API); another company gets 404; with the whole team current the request answers 409 and notifies nobody; the one who never reviewed gets only the bell, the outdated one also WhatsApp, with the result per collaborator', async ({
    authApi,
    authPage,
    browser,
    tenant,
  }) => {
    test.setTimeout(300_000);
    await apiCompleteOnboarding(authApi);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_whatsapp');
    const phoneNumberId = seedWhatsappChannelDirect(tenant.tenantId);
    const { eventId } = await setupAcceptedEvent(authApi, {
      budget: { eventDate: tenantDayPlus(5), startTime: '14:00', endTime: '18:00' },
    });

    const suffix = String(Date.now()).slice(-7);
    const anaPhone = `+55419${suffix}3`;
    const biaPhone = `+55419${suffix}4`;
    const ana = await setupConfirmedPortalCollaborator(authApi, tenant.tenantId, eventId, {
      name: `Ana Equipe ${suffix}`,
      phone: anaPhone,
    });
    const sessions: RoleSession[] = [ana.portal];
    // Quem já falou com o número da empresa tem a janela de 24 h aberta: o texto livre sai.
    const openWindow = async (phone: string) => {
      const hook = await fakeWhatsApp.triggerWebhook({ kind: 'inbound', phoneNumberId, phone, text: 'Oi, sou da equipe' });
      expect(hook.backStatus, `webhook inbound: ${hook.backBody}`).toBe(200);
    };
    await openWindow(anaPhone);

    const otherTenant = await signupNewTenant();
    const otherAdmin = await createBearerApiContext(otherTenant.accessToken);
    try {
      await apiReviewEventInfo(ana.portal.api, eventId);
      expect((await apiGetInfoReview(ana.portal.api, eventId)).status).toBe('Current');

      // Sem `events.update` (Financial de verdade): a coluna aparece, o botão não, e a API recusa.
      const financial = await loginAsRole(tenant.tenantId, 'Financial');
      sessions.push(financial);
      const forbidden = await remindInfoReview(financial.api, eventId);
      expect(forbidden.status(), 'Financial pede conferência').toBe(403);
      const finView = await openSessionPage(browser, financial.tokens);
      try {
        await openTeamTab(finView.page, eventId);
        await expect(finView.page.getByRole('columnheader', { name: 'Conferiu a festa' })).toBeVisible({
          timeout: 20_000,
        });
        await expect(teamInfoReviewCell(finView.page, ana.collaboratorId)).toHaveAttribute('data-status', 'Current');
        await expect(finView.page.getByTestId('event-detail-remind-info-review')).toHaveCount(0);
      } finally {
        await finView.context.close();
      }

      // O gestor de outra empresa recebe 404.
      const alien = await remindInfoReview(otherAdmin, eventId);
      expect(alien.status(), 'pedir conferência em festa de outra empresa').toBe(404);

      // Toda a equipe confirmada em dia: 409 e ninguém é avisado.
      const allCurrent = await remindInfoReview(authApi, eventId);
      expect(allCurrent.status(), 'equipe toda em dia').toBe(409);
      expect(await apiErrorCodes(allCurrent)).toContain('Event.InfoReviewAllCurrent');
      expect(await infoReviewNotices(ana.portal.api, eventId), 'nenhum aviso com a equipe em dia').toHaveLength(0);

      // A festa muda de horário (Ana fica desatualizada) e Bia entra na equipe sem conferir.
      await apiPatchEvent(authApi, eventId, { startTime: '15:00', endTime: '19:00' });
      const bia = await setupConfirmedPortalCollaborator(authApi, tenant.tenantId, eventId, {
        name: `Bia Equipe ${suffix}`,
        phone: biaPhone,
        isLeader: false,
      });
      sessions.push(bia.portal);
      // A janela aberta também para Bia: se o WhatsApp não sai, é a regra, não a janela.
      await openWindow(biaPhone);
      expect((await apiGetInfoReview(ana.portal.api, eventId)).status).toBe('Outdated');
      expect((await apiGetInfoReview(bia.portal.api, eventId)).status).toBe('NotReviewed');

      // O gestor pede a conferência pela tela e vê o resultado por colaborador.
      await openTeamTab(authPage, eventId);
      await expect(teamInfoReviewCell(authPage, ana.collaboratorId)).toContainText('desatualizada: horário', {
        timeout: 20_000,
      });
      await expect(teamInfoReviewCell(authPage, bia.collaboratorId)).toContainText('pendente');
      await authPage.getByTestId('event-detail-remind-info-review').click();
      const result = authPage.getByTestId('event-detail-remind-info-review-result');
      await expect(result).toContainText('Pedido de conferência enviado a 2 de 2 pessoas.', { timeout: 20_000 });
      const anaLine = authPage.getByTestId(`event-detail-remind-info-review-recipient-${ana.collaboratorId}`);
      await expect(anaLine).toContainText('desatualizada: horário');
      await expect(anaLine).toContainText('no Portal e no WhatsApp');
      const biaLine = authPage.getByTestId(`event-detail-remind-info-review-recipient-${bia.collaboratorId}`);
      await expect(biaLine).toContainText('pendente');
      await expect(biaLine).toContainText('no Portal');
      await expect(biaLine).not.toContainText('no Portal e no WhatsApp');

      // Bia: só o sino. Ana: o sino e o WhatsApp, com as seções.
      await expect.poll(async () => (await infoReviewNotices(bia.portal.api, eventId)).length).toBe(1);
      await expect.poll(async () => (await infoReviewNotices(ana.portal.api, eventId)).length).toBe(1);
      expect((await infoReviewNotices(ana.portal.api, eventId))[0]!.message).toContain('mudou: horário');

      // Só o aviso da conferência ("mudou", "Confira", "conferir"); o pedido de
      // confirmação da escala ("Confirme") é outro aviso.
      const messages = async (phone: string) => {
        const digits = phone.replace(/\D/g, '');
        return (await fakeWhatsApp.inbox({ path: '/messages' }))
          .map((e) => JSON.stringify(e.body))
          .filter((body) => body.includes(digits) && /mudou|[Cc]onfira|[Cc]onferi/.test(body));
      };
      await expect.poll(async () => (await messages(anaPhone)).filter((b) => b.includes('mudou: horário')).length).toBeGreaterThan(0);
      expect(await messages(biaPhone), 'quem nunca conferiu não recebe WhatsApp').toHaveLength(0);
    } finally {
      for (const s of sessions) await s.api.dispose();
      await otherAdmin.dispose();
    }
  });
});
