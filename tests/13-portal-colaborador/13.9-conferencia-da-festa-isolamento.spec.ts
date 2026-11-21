import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import { apiCompleteOnboarding, apiCreateCollaborator } from '../../helpers/api-entities';
import { apiAssignCollaborator, apiPatchEvent } from '../../helpers/api-event-flow';
import {
  apiGetInfoReview,
  getInfoReview,
  infoReviewCheckbox,
  postInfoReview,
} from '../../helpers/event-info-review';
import { setupConfirmedPortalCollaborator, tenantDayPlus } from '../../helpers/rain-plan';
import { apiErrorCodes } from '../../helpers/response';
import {
  RoleSession,
  loginPortalCollaborator,
  openSessionPage,
  portalDeclineEvent,
  setupAcceptedEvent,
} from '../../helpers/setup-flows';

/**
 * Fluxo: 13.9 — Conferência da festa: escala, isolamento e corrida
 * Diagrama: — (o plano é a fonte: PLANO-ESTOQUE-DO-RECREADOR §5.1, ER-C;
 * regras 1 e 2; §5.2 item 2, escala pendente)
 *
 * E11: o recreador com escala pendente vê a festa e o card só para leitura e
 * recebe 403 ao conferir; o recreador de outra festa, que recusou ou de outra
 * empresa recebe 404 no estado e na conferência; o token lido antes de o gestor
 * mudar a festa recebe 409 e nada é gravado.
 */

test.describe('Fluxo 13.9 — Conferência da festa: escala, isolamento e corrida', () => {
  test('@flow E11: a pending assignment reads the card read-only and gets 403 reviewing; a collaborator of another party, one who declined and one of another company get 404 on the state and the review; a token read before the manager changes the party gets 409 and nothing is saved', async ({
    authApi,
    browser,
    tenant,
  }) => {
    test.setTimeout(300_000);
    await apiCompleteOnboarding(authApi);
    const { eventId } = await setupAcceptedEvent(authApi, {
      budget: { eventDate: tenantDayPlus(6), startTime: '14:00', endTime: '18:00' },
    });
    const sessions: RoleSession[] = [];
    const otherTenant = await signupNewTenant();
    const otherAdmin = await createBearerApiContext(otherTenant.accessToken);
    try {
      // Regra 1: escala `Pending` lê a festa e o card, sem poder conferir.
      const pendingCollaborator = await apiCreateCollaborator(authApi);
      await apiAssignCollaborator(authApi, eventId, pendingCollaborator.id, { isLeader: false });
      const pending = await loginPortalCollaborator(tenant.tenantId, pendingCollaborator.id);
      sessions.push(pending);

      const pendingState = await apiGetInfoReview(pending.api, eventId);
      expect(pendingState.status).toBe('NotReviewed');
      expect(pendingState.canReview, 'escala pendente não confere').toBe(false);

      const view = await openSessionPage(browser, pending.tokens);
      try {
        await view.page.goto(`/portal/events/${eventId}`);
        const card = view.page.getByTestId('portal-event-detail-info-review');
        await expect(card).toBeVisible({ timeout: 20_000 });
        await expect(view.page.getByTestId('portal-event-detail-info-review-confirm-hint')).toContainText(
          'Confirme a escala para conferir',
        );
        await expect(infoReviewCheckbox(view.page, 'Schedule')).toBeDisabled();
        await expect(view.page.getByTestId('portal-event-detail-info-review-submit')).toHaveCount(0);
      } finally {
        await view.context.close();
      }

      const pendingPost = await postInfoReview(pending.api, eventId, pendingState.token);
      expect(pendingPost.status(), 'conferir com a escala pendente').toBe(403);
      expect(await apiErrorCodes(pendingPost)).toContain('Portal.AssignmentNotConfirmed');
      expect((await apiGetInfoReview(pending.api, eventId)).status, 'nada gravado').toBe('NotReviewed');

      // O token de uma festa confirmada, para as tentativas de fora usarem um token válido.
      const team = await setupConfirmedPortalCollaborator(authApi, tenant.tenantId, eventId);
      sessions.push(team.portal);
      const teamState = await apiGetInfoReview(team.portal.api, eventId);
      expect(teamState.canReview).toBe(true);

      // Regra 1: o recreador confirmado em OUTRA festa recebe 404.
      const { eventId: otherEventId } = await setupAcceptedEvent(authApi, {
        budget: { eventDate: tenantDayPlus(8), startTime: '09:00', endTime: '12:00' },
      });
      const elsewhere = await setupConfirmedPortalCollaborator(authApi, tenant.tenantId, otherEventId);
      sessions.push(elsewhere.portal);

      // Regra 1: quem recusou a escala recebe 404 (o Portal só recusa escala ainda `Pending`).
      const declinedCollaborator = await apiCreateCollaborator(authApi);
      await apiAssignCollaborator(authApi, eventId, declinedCollaborator.id, { isLeader: false });
      const declined = await loginPortalCollaborator(tenant.tenantId, declinedCollaborator.id);
      sessions.push(declined);
      await portalDeclineEvent(declined.api, eventId);

      // Regra 1: o recreador de outra empresa recebe o mesmo 404.
      const outsiderCollaborator = await apiCreateCollaborator(otherAdmin);
      const outsider = await loginPortalCollaborator(otherTenant.tenantId, outsiderCollaborator.id);
      sessions.push(outsider);

      for (const [label, session] of [
        ['de outra festa', elsewhere.portal],
        ['que recusou', declined],
        ['de outra empresa', outsider],
      ] as const) {
        const read = await getInfoReview(session.api, eventId);
        expect(read.status(), `estado, recreador ${label}`).toBe(404);
        expect(await apiErrorCodes(read)).toContain('Portal.EventNotFound');
        const write = await postInfoReview(session.api, eventId, teamState.token);
        expect(write.status(), `conferência, recreador ${label}`).toBe(404);
        expect(await apiErrorCodes(write)).toContain('Portal.EventNotFound');
      }
      expect((await apiGetInfoReview(team.portal.api, eventId)).status, 'nada gravado por quem é de fora').toBe(
        'NotReviewed',
      );

      // Regra 2: o token lido antes de o gestor mudar a festa recebe 409 e nada é gravado.
      await apiPatchEvent(authApi, eventId, { location: `Salão novo E2E ${Date.now()}` });
      const stale = await postInfoReview(team.portal.api, eventId, teamState.token);
      expect(stale.status(), 'token de antes da mudança').toBe(409);
      expect(await apiErrorCodes(stale)).toContain('Event.InfoChangedSinceRead');
      expect(JSON.stringify(await stale.json())).toContain('A festa mudou enquanto você conferia');
      const afterStale = await apiGetInfoReview(team.portal.api, eventId);
      expect(afterStale.status, 'nada gravado com o token velho').toBe('NotReviewed');
      expect(afterStale.reviewedAt).toBeNull();
      expect(afterStale.token).not.toBe(teamState.token);

      // Com o token atual, a conferência grava.
      const ok = await postInfoReview(team.portal.api, eventId, afterStale.token);
      expect(ok.status(), `token atual: ${await ok.text()}`).toBe(200);
      expect((await apiGetInfoReview(team.portal.api, eventId)).status).toBe('Current');
    } finally {
      for (const s of sessions) await s.api.dispose();
      await otherAdmin.dispose();
    }
  });
});
