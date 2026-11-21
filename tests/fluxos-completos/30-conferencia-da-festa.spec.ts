import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCompleteOnboarding, apiListNotifications, apiSetSettingParameter } from '../../helpers/api-entities';
import { apiPatchEvent } from '../../helpers/api-event-flow';
import { enableFeatureFlagDirect, seedWhatsappChannelDirect } from '../../helpers/db-helper';
import {
  EVENT_INFO_SECTIONS,
  apiGetInfoReview,
  infoReviewCheckbox,
  openTeamTab,
  teamInfoReviewCell,
} from '../../helpers/event-info-review';
import { fakeWhatsApp } from '../../helpers/fake-providers';
import {
  TRIGGER_TIMEOUT,
  apiGetReadiness,
  apiTriggerDailyJob,
  setupConfirmedPortalCollaborator,
  tenantDayPlus,
} from '../../helpers/rain-plan';
import { openSessionPage, setupAcceptedEvent } from '../../helpers/setup-flows';

/**
 * Fluxo: 30 — Conferência da festa pela equipe
 * Diagrama: — (o plano é a fonte: PLANO-ESTOQUE-DO-RECREADOR §5, ER-C;
 * §5.1 regras 2, 4, 5 e 6; §5.2 itens 1, 2 e 4; decisão 20)
 *
 * E5: o recreador confirmado confere a festa ("Conferi tudo" só com as sete
 * caixas marcadas) e a aba Equipe mostra a hora da conferência; o gestor muda o
 * horário; a aba Equipe mostra "desatualizada: horário" e o Portal pede nova
 * conferência com o horário destacado; o ciclo diário de avisos manda "a festa
 * mudou: horário" no sino e no WhatsApp pelo fake; o recreador confere de novo
 * e a prontidão "Equipe conferiu a festa" fica atendida.
 */

const REMINDER_DAYS = 7;

test.describe('Fluxo 30 — Conferência da festa pela equipe', () => {
  test('@flow E5: the confirmed collaborator reviews the party with all seven boxes and the Team tab shows the time; the manager changes the schedule; the Team tab says "desatualizada: horário" and the Portal asks again with the schedule highlighted; the daily cycle sends "mudou: horário" by bell and WhatsApp; the collaborator reviews again and the readiness requirement is met', async ({
    authApi,
    authPage,
    browser,
    tenant,
  }) => {
    test.setTimeout(TRIGGER_TIMEOUT + 360_000);
    await apiCompleteOnboarding(authApi);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_whatsapp');
    const phoneNumberId = seedWhatsappChannelDirect(tenant.tenantId);
    await apiSetSettingParameter(authApi, 'EVENT_INFO_REVIEW_REMINDER_DAYS', REMINDER_DAYS);

    const { eventId } = await setupAcceptedEvent(authApi, {
      budget: { eventDate: tenantDayPlus(4), startTime: '14:00', endTime: '18:00', childrenCount: 20 },
    });
    const phone = `+55419${String(Date.now()).slice(-7)}5`;
    const team = await setupConfirmedPortalCollaborator(authApi, tenant.tenantId, eventId, {
      name: `Ana Conferência ${Date.now()}`,
      phone,
    });

    // A recreadora já falou com o número da empresa: a janela de 24 h está aberta e o texto livre sai.
    const hook = await fakeWhatsApp.triggerWebhook({ kind: 'inbound', phoneNumberId, phone, text: 'Oi, sou da equipe' });
    expect(hook.backStatus, `webhook inbound: ${hook.backBody}`).toBe(200);

    const view = await openSessionPage(browser, team.portal.tokens);
    try {
      // §5.2 item 1: o card "Conferir a festa", aberto, com uma caixa por seção.
      await view.page.goto(`/portal/events/${eventId}`);
      const card = view.page.getByTestId('portal-event-detail-info-review');
      await expect(card).toBeVisible({ timeout: 20_000 });
      await expect(card).toHaveAttribute('data-status', 'NotReviewed');
      const submit = view.page.getByTestId('portal-event-detail-info-review-submit');

      // "Conferi tudo" só habilita com as sete caixas marcadas.
      for (const section of EVENT_INFO_SECTIONS.slice(0, -1)) await infoReviewCheckbox(view.page, section).check();
      await expect(submit, 'seis de sete caixas').toBeDisabled();
      await infoReviewCheckbox(view.page, 'DayContact').check();
      await expect(submit, 'as sete caixas').toBeEnabled();
      await submit.click();
      await expect(card).toHaveAttribute('data-status', 'Current', { timeout: 20_000 });
      await expect(view.page.getByTestId('portal-event-detail-info-review-current')).toContainText('Você conferiu em');

      const reviewed = await apiGetInfoReview(team.portal.api, eventId);
      expect(reviewed.status).toBe('Current');
      expect(reviewed.reviewedAt).toBeTruthy();
      expect(reviewed.changedSections).toEqual([]);

      // §5.2 item 4: a aba Equipe mostra a hora da conferência.
      await openTeamTab(authPage, eventId);
      const cell = teamInfoReviewCell(authPage, team.collaboratorId);
      await expect(cell).toHaveAttribute('data-status', 'Current', { timeout: 20_000 });
      await expect(cell).toHaveText(/^\s*às \d{2}:\d{2} de \d{2}\/\d{2}\s*$/);

      // O gestor muda o horário da festa.
      await apiPatchEvent(authApi, eventId, { startTime: '15:00', endTime: '19:00' });

      // §5.1 regra 4: a comparação é na leitura; só o horário mudou.
      const outdated = await apiGetInfoReview(team.portal.api, eventId);
      expect(outdated.status).toBe('Outdated');
      expect(outdated.changedSections).toEqual(['Schedule']);

      await openTeamTab(authPage, eventId);
      await expect(cell).toHaveAttribute('data-status', 'Outdated', { timeout: 20_000 });
      await expect(cell).toContainText('desatualizada: horário');

      // §5.2 item 2: o Portal pede nova conferência, com o horário destacado e desmarcado.
      await view.page.reload();
      await expect(card).toHaveAttribute('data-status', 'Outdated', { timeout: 20_000 });
      await expect(view.page.getByTestId('portal-event-detail-info-review-outdated')).toContainText('Mudou: horário');
      await expect(view.page.getByTestId('portal-event-detail-info-review-changed-Schedule')).toBeVisible();
      await expect(view.page.getByTestId('portal-event-detail-info-review-changed-Place')).toHaveCount(0);
      await expect(infoReviewCheckbox(view.page, 'Schedule')).not.toBeChecked();
      await expect(submit).toBeDisabled();

      // §5.1 regra 6: com a conferência desatualizada, o requisito não está atendido.
      const before = (await apiGetReadiness(authApi, eventId)).find((r) => r.key === 'team_info_reviewed');
      expect(before, 'requisito team_info_reviewed na prontidão').toBeTruthy();
      expect(before!.level).toBe('Recommended');
      expect(before!.isMet).toBe(false);

      // §5.1 regra 5: o ciclo diário avisa no sino e no WhatsApp, com as seções.
      await apiTriggerDailyJob(authApi);
      await expect
        .poll(async () =>
          (await apiListNotifications(team.portal.api)).filter(
            (n) => n.type === 'EventInfoReviewPending' && n.contextEntityId === eventId,
          ).length,
        )
        .toBe(1);
      const notice = (await apiListNotifications(team.portal.api)).find(
        (n) => n.type === 'EventInfoReviewPending' && n.contextEntityId === eventId,
      )!;
      expect(notice.message).toContain('mudou: horário');

      const digits = phone.replace(/\D/g, '');
      await expect
        .poll(async () =>
          (await fakeWhatsApp.inbox({ path: '/messages' }))
            .map((e) => JSON.stringify(e.body))
            .filter((body) => body.includes(digits) && body.includes('mudou: horário')).length,
        )
        .toBeGreaterThan(0);

      // O recreador confere de novo: só falta o horário.
      await infoReviewCheckbox(view.page, 'Schedule').check();
      await expect(submit).toBeEnabled();
      await submit.click();
      await expect(card).toHaveAttribute('data-status', 'Current', { timeout: 20_000 });
      expect((await apiGetInfoReview(team.portal.api, eventId)).status).toBe('Current');

      // §5.1 regra 6: a prontidão "Equipe conferiu a festa" fica atendida.
      const after = (await apiGetReadiness(authApi, eventId)).find((r) => r.key === 'team_info_reviewed');
      expect(after!.isMet).toBe(true);

      await openTeamTab(authPage, eventId);
      await expect(cell).toHaveAttribute('data-status', 'Current', { timeout: 20_000 });
    } finally {
      await view.context.close();
      await team.portal.api.dispose();
    }
  });
});
