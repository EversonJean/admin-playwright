import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCompleteOnboarding, apiListNotifications } from '../../helpers/api-entities';
import {
  HomeProduct,
  apiGetStockCount,
  apiGetStockLocationItem,
  apiListStockCounts,
  setupHomeStock,
} from '../../helpers/home-stock';
import { tenantDayPlus } from '../../helpers/rain-plan';
import { openSessionPage } from '../../helpers/setup-flows';
import { snack } from '../../helpers/ui';

/**
 * Fluxo: 28 — Contagem completa do estoque de casa pedida pelo gestor
 * Diagrama: — (o plano é a fonte: PLANO-ESTOQUE-DO-RECREADOR §4, ER-B;
 * regras 1, 3 e 4; §4.2 itens 1 a 3; decisão 3)
 *
 * E4: o gestor pede a contagem; o recreador confere linha a linha, só envia com
 * tudo respondido, e a tela de locais passa a mostrar "contado hoje".
 */

test.describe('Fluxo 28 — Contagem do estoque de casa', () => {
  test('@flow E4: the manager requests the count; the collaborator answers line by line, can only send with every line answered, and the locations screen then shows the home counted today', async ({
    authApi,
    authPage,
    browser,
    tenant,
  }) => {
    test.setTimeout(300_000);
    await apiCompleteOnboarding(authApi);
    const home = await setupHomeStock(authApi, tenant.tenantId, {
      firstName: 'Ana',
      products: [
        { quantity: 5, isReusable: true, unitCost: 20 },
        { quantity: 3, isReusable: false, unitCost: 4 },
      ],
    });
    const [ball, glue] = home.products as [HomeProduct, HomeProduct];
    const portal = home.portal!;
    const note = 'Conferir antes do fim do mês';

    try {
      // §4.2 item 3: a casa nunca contada, e "Pedir contagem" na tela de locais.
      await authPage.goto('/app/stock/locations');
      const lastCount = authPage.getByTestId(`stock-location-last-count-${home.locationId}`);
      await expect(lastCount).toBeVisible({ timeout: 20_000 });
      await expect(lastCount.locator('[data-state]')).toHaveAttribute('data-state', 'never');
      await expect(lastCount).toContainText('Nunca');

      await authPage.getByTestId(`stock-location-request-count-${home.locationId}`).click();
      await authPage.getByTestId('request-count-due-in-days').fill('5');
      await authPage.getByTestId('request-count-note').fill(note);
      await authPage.getByTestId('request-count-submit').click();
      await expect(snack(authPage, /Contagem #\d+ pedida/)).toBeVisible({ timeout: 20_000 });
      await expect(authPage.getByTestId(`stock-location-active-count-${home.locationId}`)).toContainText('Aberta', {
        timeout: 20_000,
      });

      // §4.1 regras 1 e 3: contagem completa pelo gestor, uma linha por produto com saldo.
      const [opened] = await apiListStockCounts(authApi, { status: 'Open', locationId: home.locationId });
      expect(opened, 'a contagem aberta no local').toBeTruthy();
      const count = await apiGetStockCount(authApi, opened!.id);
      expect(count.kind).toBe('FullCount');
      expect(count.origin).toBe('Manager');
      expect(count.dueOn).toBe(tenantDayPlus(5));
      expect(count.lines.map((l) => l.productId).sort()).toEqual([ball.id, glue.id].sort());
      expect(count.lines.every((l) => l.countedQuantity === null), 'linhas sem resposta').toBe(true);

      // §4.2 itens 1 e 2: o bloco "Contagem do mês" abre a contagem; cada linha pede a sua resposta.
      const view = await openSessionPage(browser, portal.tokens);
      try {
        await view.page.goto('/portal/my-stock');
        await expect(view.page.getByTestId('portal-stock-count-card')).toBeVisible({ timeout: 20_000 });
        await view.page.getByTestId('portal-stock-count-card-open').click();
        await view.page.waitForURL(new RegExp(`/portal/my-stock/count/${count.id}`));

        await expect(view.page.getByTestId('portal-my-stock-count-request-note')).toContainText(note);
        await expect(view.page.getByTestId(`portal-my-stock-count-row-${ball.id}`)).toContainText('No sistema: 5');
        await expect(view.page.getByTestId(`portal-my-stock-count-row-${glue.id}`)).toContainText('No sistema: 3');
        await expect(view.page.getByTestId('portal-my-stock-count-progress')).toContainText('0 de 2 conferidos');
        const submit = view.page.getByTestId('portal-my-stock-count-submit');
        await expect(submit).toBeDisabled();
        await expect(view.page.getByTestId('portal-my-stock-count-missing')).toContainText('Faltam responder 2 itens.');

        // Regra 4: com uma linha sem resposta, o envio segue travado.
        await view.page.getByTestId(`portal-my-stock-count-matches-${ball.id}`).click();
        await expect(view.page.getByTestId('portal-my-stock-count-progress')).toContainText('1 de 2 conferidos');
        await expect(view.page.getByTestId('portal-my-stock-count-missing')).toContainText('Falta responder 1 item.');
        await expect(submit).toBeDisabled();

        await view.page.getByTestId(`portal-my-stock-count-matches-${glue.id}`).click();
        await expect(view.page.getByTestId('portal-my-stock-count-progress')).toContainText('2 de 2 conferidos');
        await expect(view.page.getByTestId('portal-my-stock-count-missing')).toHaveCount(0);
        await expect(submit).toBeEnabled({ timeout: 20_000 });
        await submit.click();

        // Regra 4: tudo igual ao sistema fecha sem revisão.
        await expect(view.page.getByTestId('portal-my-stock-count-sent')).toContainText(
          `Contagem #${count.number} enviada. Tudo conferia`,
          { timeout: 20_000 },
        );
      } finally {
        await view.context.close();
      }

      const closed = await apiGetStockCount(authApi, count.id);
      expect(closed.status, 'sem diferença vai direto a Revisada').toBe('Reviewed');
      expect(closed.reviewedByUserId, 'ninguém revisou: nada a aprovar').toBeNull();
      expect(closed.lines.every((l) => l.decision === 'NoChange')).toBe(true);
      expect(
        (await apiListNotifications(authApi)).filter((n) => n.contextEntityId === count.id && n.type === 'StockCorrectionSubmitted'),
        'sem diferença, o gestor não é avisado',
      ).toHaveLength(0);

      const location = await apiGetStockLocationItem(authApi, home.locationId);
      expect(location.lastReviewedCountAt, 'a última contagem revisada').toBeTruthy();
      expect(location.activeCountId).toBeNull();

      // §4.2 item 3: a tela de locais mostra a casa contada hoje.
      await authPage.goto('/app/stock/locations');
      const counted = authPage.getByTestId(`stock-location-last-count-${home.locationId}`);
      await expect(counted).toContainText('Hoje', { timeout: 20_000 });
      await expect(counted.locator('[data-state]')).toHaveAttribute('data-state', 'recent');
      await expect(authPage.getByTestId(`stock-location-active-count-${home.locationId}`)).toHaveCount(0);
    } finally {
      await portal.api.dispose();
    }
  });
});
