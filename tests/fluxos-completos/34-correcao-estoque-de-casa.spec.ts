import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCompleteOnboarding, apiListNotifications } from '../../helpers/api-entities';
import {
  HomeProduct,
  apiGetMyStock,
  apiGetStockCount,
  apiListStockCounts,
  setupHomeStock,
  stockMovementReasonDirect,
} from '../../helpers/home-stock';
import { assertOk, unwrapList } from '../../helpers/response';
import { openSessionPage } from '../../helpers/setup-flows';
import { snack } from '../../helpers/ui';

/**
 * Fluxo: 27 — Correção do estoque de casa pelo Portal, com aprovação do gestor
 * Diagrama: — (o plano é a fonte: PLANO-ESTOQUE-DO-RECREADOR §3, ER-A;
 * regras 3, 6, 8 e 10; decisões 2, 4 e 6)
 *
 * E1: o recreador informa pelo Portal que a bola quebrou; o gestor recebe o
 * aviso no sino, abre a contagem, aprova, e o saldo da casa cai com uma perda
 * no razão ("Contagem #N — quebrou"); o recreador recebe o aviso da revisão e
 * vê a decisão em "Últimas correções".
 */

test.describe('Fluxo 27 — Correção do estoque de casa', () => {
  test('@flow E1: the collaborator reports a broken ball through the Portal; the manager gets the bell notice, opens the count and approves; the home balance drops with a loss in the ledger; the collaborator gets the review notice and sees the decision in the history', async ({
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

    // Uma sessão de navegador só: o refresh token gira na primeira carga, e um
    // segundo contexto com os mesmos tokens cairia no login.
    const view = await openSessionPage(browser, portal.tokens);
    try {
      // §3.2 itens 1 e 2: "Corrigir meu estoque", quanto tenho agora, motivo, resumo, envio.
      {
        await view.page.goto('/portal/my-stock');
        await expect(view.page.getByTestId(`portal-my-stock-item-${ball.id}`)).toContainText('5 un', { timeout: 20_000 });
        await view.page.getByTestId('portal-my-stock-correct').click();
        await view.page.waitForURL(/\/portal\/my-stock\/correct/);

        await view.page.getByTestId(`portal-my-stock-correct-counted-${ball.id}`).fill('4');
        await view.page.getByTestId(`portal-my-stock-correct-reason-${ball.id}`).click();
        await view.page.getByRole('option', { name: 'Quebrou', exact: true }).click();
        await view.page.getByTestId('portal-my-stock-correct-review').click();

        const summary = view.page.getByTestId('portal-my-stock-correct-summary');
        await expect(summary).toContainText('1 item muda');
        await expect(summary).toContainText(ball.name);
        await expect(summary).toContainText('(quebrou)');
        await expect(summary).not.toContainText(glue.name);

        await view.page.getByTestId('portal-my-stock-correct-submit').click();
        await expect(view.page.getByTestId('portal-my-stock-correct-sent')).toContainText(/Pedido #\d+ enviado ao gestor/, {
          timeout: 20_000,
        });
      }

      // Decisão 4: a diferença é fotografada no envio; o saldo ainda não mudou.
      const [queued] = await apiListStockCounts(authApi, { status: 'Submitted', locationId: home.locationId });
      expect(queued, 'a correção espera o gestor na fila').toBeTruthy();
      expect(queued!.kind).toBe('Correction');
      expect(queued!.origin).toBe('Collaborator');
      const submitted = await apiGetStockCount(authApi, queued!.id);
      const line = submitted.lines.find((l) => l.productId === ball.id)!;
      expect(line.systemQuantityAtSubmit).toBe(5);
      expect(line.countedQuantity).toBe(4);
      expect(line.difference).toBe(-1);
      expect(line.reason).toBe('Broken');
      expect(line.decision).toBe('Pending');
      expect(submitted.lines.some((l) => l.productId === glue.id), 'o item não mexido não entra').toBe(false);
      expect((await apiGetMyStock(portal.api)).items.find((i) => i.productId === ball.id)!.quantity).toBe(5);

      // Regra 10: o aviso 40 aos gestores, um por pedido.
      await expect
        .poll(async () =>
          (await apiListNotifications(authApi)).filter(
            (n) => n.type === 'StockCorrectionSubmitted' && n.contextEntityId === submitted.id,
          ).length,
        )
        .toBe(1);
      const notice = (await apiListNotifications(authApi)).find(
        (n) => n.type === 'StockCorrectionSubmitted' && n.contextEntityId === submitted.id,
      )!;
      expect(notice.message).toContain(`${home.firstName} pediu correção de 1 item do estoque de casa`);

      // §3.2 item 5: o gestor abre a contagem e aprova pela tela.
      await authPage.goto(`/app/stock/counts/${submitted.id}`);
      await expect(authPage.getByTestId(`stock-count-line-${line.id}`)).toBeVisible({ timeout: 20_000 });
      await expect(authPage.getByTestId(`stock-count-line-${line.id}`)).toContainText(ball.name);
      await expect(authPage.getByTestId(`stock-count-line-${line.id}`)).toContainText('Quebrou');
      await expect(authPage.getByTestId('stock-count-status')).toContainText('Aguardando revisão');
      await authPage.getByTestId('stock-count-approve-all').click();
      await authPage.getByTestId('stock-count-submit-review').click();
      await expect(snack(authPage, 'Revisão concluída')).toBeVisible({ timeout: 20_000 });
      await expect(authPage.getByTestId('stock-count-status')).toContainText('Revisada');

      // Regra 6: diferença < 0 com "Quebrou" vira perda (`Loss`) no local da contagem.
      const reviewed = await apiGetStockCount(authApi, submitted.id);
      expect(reviewed.status).toBe('Reviewed');
      const approved = reviewed.lines.find((l) => l.id === line.id)!;
      expect(approved.decision).toBe('Approved');
      expect(approved.appliedQuantity).toBe(1);
      expect(approved.stockMovementId, 'a linha aprovada aponta o movimento').toBeTruthy();
      expect(stockMovementReasonDirect(approved.stockMovementId!)).toBe(`Contagem #${reviewed.number} — quebrou`);

      const movementsRes = await authApi.get(`/api/stock/movements?locationId=${home.locationId}&type=Loss`);
      await assertOk(movementsRes, 'GET /api/stock/movements');
      const losses = await unwrapList<{ id: string; productId: string; balanceAfter: number }>(movementsRes);
      expect(losses.map((m) => m.id)).toEqual([approved.stockMovementId]);
      expect(losses[0]!.productId).toBe(ball.id);
      expect(losses[0]!.balanceAfter).toBe(4);

      const after = await apiGetMyStock(portal.api);
      expect(after.items.find((i) => i.productId === ball.id)!.quantity, 'o saldo da casa cai').toBe(4);
      expect(after.items.find((i) => i.productId === glue.id)!.quantity).toBe(3);

      // Regra 8: o aviso 41 ao recreador com o resumo da decisão.
      await expect
        .poll(async () =>
          (await apiListNotifications(portal.api)).filter(
            (n) => n.type === 'StockCorrectionReviewed' && n.contextEntityId === submitted.id,
          ).length,
        )
        .toBe(1);
      const reviewNotice = (await apiListNotifications(portal.api)).find(
        (n) => n.type === 'StockCorrectionReviewed' && n.contextEntityId === submitted.id,
      )!;
      expect(reviewNotice.message).toContain('O gestor revisou sua correção: 1 aprovada.');

      // §3.2 item 1: a decisão em "Últimas correções".
      const back = view;
      {
        await back.page.goto('/portal/my-stock');
        await expect(back.page.getByTestId(`portal-my-stock-item-${ball.id}`)).toContainText('4 un', { timeout: 20_000 });
        await back.page.getByTestId('portal-my-stock-history-toggle').click();
        const entry = back.page.getByTestId(`portal-my-stock-history-${submitted.id}`);
        await expect(entry).toBeVisible({ timeout: 20_000 });
        await expect(entry).toContainText(`#${reviewed.number}`);
        await entry.getByRole('button').first().click();
        const historyLine = back.page.getByTestId(`portal-my-stock-count-line-${line.id}`);
        await expect(historyLine).toBeVisible({ timeout: 20_000 });
        await expect(historyLine).toContainText(ball.name);
        await expect(historyLine).toContainText('Quebrou');
        await expect(historyLine).toContainText('Aprovada');
      }
    } finally {
      await view.context.close();
      await portal.api.dispose();
    }
  });
});
