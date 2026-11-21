import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import { apiCompleteOnboarding } from '../../helpers/api-entities';
import {
  MARGIN_CHILDREN,
  adjustMarginInUi,
  apiGetMaterialMargin,
  apiGetMaterialMarginSuggestion,
  apiRegisterActualChildren,
  completeWithLeader,
  getMaterialMargin,
  openMaterialsTab,
  putMaterialMargin,
  setupMarginParty,
} from '../../helpers/material-margin';
import { apiErrorCodes } from '../../helpers/response';
import { RoleSession, loginAsRole, openSessionPage } from '../../helpers/setup-flows';
import { snack } from '../../helpers/ui';

/**
 * Fluxo: 6.11 — Margem da festa: permissão, festa concluída e isolamento
 * Diagrama: — (o plano é a fonte: PLANO-ESTOQUE-DO-RECREADOR §6.1, §6.2 item 5,
 * §6.3; ER-D, Etapa 334)
 *
 * E15: quem lê o evento sem `events.update` (Financial) vê a faixa sem
 * "Ajustar nesta festa" e recebe 403 no PUT; na festa concluída o PUT responde
 * 409 traduzido; o gestor de outra empresa recebe 404 no GET e no PUT da
 * margem, e a sugestão de uma empresa não conta as festas da outra.
 */

test.describe('Fluxo 6.11 — Margem da festa: permissão e isolamento', () => {
  test('@flow E15: Financial sees the strip without "Ajustar nesta festa" and gets 403 on PUT; a completed party answers 409, translated; another company gets 404 on GET and PUT and its suggestion does not count this company parties', async ({
    authApi,
    authPage,
    browser,
    tenant,
  }) => {
    test.setTimeout(300_000);
    await apiCompleteOnboarding(authApi);
    const party = await setupMarginParty(authApi);
    const sessions: RoleSession[] = [];
    const otherTenant = await signupNewTenant();
    const otherAdmin = await createBearerApiContext(otherTenant.accessToken);

    try {
      // Financial de verdade: lê a faixa, não ajusta, e a API recusa com 403.
      const financial = await loginAsRole(tenant.tenantId, 'Financial');
      sessions.push(financial);
      const readByFinancial = await getMaterialMargin(financial.api, party.eventId);
      expect(readByFinancial.status(), 'Financial lê a margem').toBe(200);
      const forbidden = await putMaterialMargin(financial.api, party.eventId, 3);
      expect(forbidden.status(), 'Financial ajusta a margem').toBe(403);
      expect((await apiGetMaterialMargin(authApi, party.eventId)).extraChildrenOverride).toBeNull();
      const finView = await openSessionPage(browser, financial.tokens);
      try {
        await openMaterialsTab(finView.page, party.eventId);
        await expect(finView.page.getByTestId('material-margin-strip')).toContainText(
          `Levando material para ${MARGIN_CHILDREN} crianças`,
        );
        await expect(finView.page.getByTestId('material-margin-adjust')).toHaveCount(0);
      } finally {
        await finView.context.close();
      }

      // Gestor de outra empresa: 404 no GET e no PUT, e nada muda.
      const alienGet = await getMaterialMargin(otherAdmin, party.eventId);
      expect(alienGet.status(), 'GET da margem de festa de outra empresa').toBe(404);
      expect(await apiErrorCodes(alienGet)).toContain('Event.NotFound');
      const alienPut = await putMaterialMargin(otherAdmin, party.eventId, 7);
      expect(alienPut.status(), 'PUT da margem de festa de outra empresa').toBe(404);
      expect(await apiErrorCodes(alienPut)).toContain('Event.NotFound');
      expect((await apiGetMaterialMargin(authApi, party.eventId)).extraChildrenOverride).toBeNull();

      // Festa concluída, com os presentes lançados: o PUT responde 409 e a tela traduz.
      await completeWithLeader(authApi, party.eventId);
      await apiRegisterActualChildren(authApi, party.eventId, MARGIN_CHILDREN + 3);
      const locked = await putMaterialMargin(authApi, party.eventId, 2);
      expect(locked.status(), 'margem de festa concluída').toBe(409);
      expect(await apiErrorCodes(locked)).toContain('Event.MaterialMarginLocked');

      await openMaterialsTab(authPage, party.eventId);
      await adjustMarginInUi(authPage, 'none');
      await expect(
        snack(authPage, 'A festa já foi concluída ou cancelada: a margem de material não pode mais ser alterada.'),
      ).toBeVisible({ timeout: 20_000 });
      expect((await apiGetMaterialMargin(authApi, party.eventId)).extraChildrenOverride).toBeNull();

      // A sugestão é por empresa: a festa medida daqui não entra na da outra.
      const own = await apiGetMaterialMarginSuggestion(authApi);
      expect(own.eventsMeasured, 'a festa concluída com presentes conta aqui').toBe(1);
      expect(own.eventsWithMoreChildren).toBe(1);
      const alien = await apiGetMaterialMarginSuggestion(otherAdmin);
      expect(alien.eventsMeasured, 'a outra empresa não conta as festas desta').toBe(0);
      expect(alien.eventsWithMoreChildren).toBe(0);
      expect(alien.suggestedPercent).toBeNull();
    } finally {
      for (const s of sessions) await s.api.dispose();
      await otherAdmin.dispose();
    }
  });
});
