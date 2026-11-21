import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import { apiCompleteOnboarding } from '../../helpers/api-entities';
import {
  MyStockCount,
  apiApproveAllPending,
  apiGetStockCount,
  apiListStockCounts,
  createStockCorrection,
  reviewStockCount,
  setupHomeStock,
} from '../../helpers/home-stock';
import { apiErrorCodes, readJson } from '../../helpers/response';
import { RoleSession, loginAsRole, openSessionPage } from '../../helpers/setup-flows';

/**
 * Fluxo: 13.7 — Correção do estoque de casa: permissão e isolamento
 * Diagrama: — (o plano é a fonte: PLANO-ESTOQUE-DO-RECREADOR §3, ER-A;
 * regras 11 e 12, §3.2 item 6, §3.3 itens 3 e 4)
 *
 * E2: quem lê o estoque sem `stock.reviewcount` (papel Financial; o Manager tem
 * a permissão) vê a fila e o detalhe só para leitura e recebe 403 ao revisar;
 * o recreador de outra empresa, ou de outro local, recebe 404 na contagem.
 */

test.describe('Fluxo 13.7 — Correção do estoque de casa: permissão e isolamento', () => {
  test('@flow E2: Financial sees the queue and the detail read-only and gets 403 reviewing while Manager reviews; a collaborator of another location or another company and a manager of another company get 404 on the count', async ({
    authApi,
    browser,
    tenant,
  }) => {
    test.setTimeout(300_000);
    await apiCompleteOnboarding(authApi);
    const home = await setupHomeStock(authApi, tenant.tenantId, { firstName: 'Ana' });
    const product = home.products[0]!;
    const sessions: RoleSession[] = [home.portal!];

    const otherTenant = await signupNewTenant();
    const otherAdmin = await createBearerApiContext(otherTenant.accessToken);
    try {
      const created = await createStockCorrection(home.portal!.api, [
        { productId: product.id, countedQuantity: 3, reason: 'Lost' },
      ]);
      expect(created.status(), `correção: ${await created.text()}`).toBe(201);
      const count = await readJson<MyStockCount>(created);
      expect(count.status).toBe('Submitted');
      const lineId = count.lines.find((l) => l.productId === product.id)!.id;

      // Regra 11: o Financial lê a fila e o detalhe (`stock.read`)...
      const financial = await loginAsRole(tenant.tenantId, 'Financial');
      sessions.push(financial);
      expect((await apiListStockCounts(financial.api)).map((c) => c.id), 'Financial lê a fila').toContain(count.id);
      const detail = await apiGetStockCount(financial.api, count.id);
      expect(detail.status).toBe('Submitted');

      // ... e não revisa (403), nem cancela; nada muda.
      const forbidden = await reviewStockCount(financial.api, count.id, detail.rowVersion, [
        { lineId, decision: 'Approved' },
      ]);
      expect(forbidden.status(), 'Financial revisa').toBe(403);
      const forbiddenCancel = await financial.api.post(`/api/stock/counts/${count.id}/cancel`, {
        data: { reason: 'Teste' },
      });
      expect(forbiddenCancel.status(), 'Financial cancela').toBe(403);
      expect((await apiGetStockCount(authApi, count.id)).status).toBe('Submitted');

      // §3.2 item 6: sem a permissão, a tela é só leitura.
      const view = await openSessionPage(browser, financial.tokens);
      try {
        await view.page.goto(`/app/stock/counts/${count.id}`);
        await expect(view.page.getByTestId(`stock-count-line-${lineId}`)).toBeVisible({ timeout: 20_000 });
        await expect(view.page.getByTestId(`stock-count-line-${lineId}`)).toContainText(product.name);
        await expect(view.page.getByTestId(`stock-count-decision-${lineId}`)).toHaveCount(0);
        await expect(view.page.getByTestId('stock-count-approve-all')).toHaveCount(0);
        await expect(view.page.getByTestId('stock-count-submit-review')).toHaveCount(0);
        await expect(view.page.getByTestId('stock-count-cancel-toggle')).toHaveCount(0);
      } finally {
        await view.context.close();
      }

      // Regra 12: o recreador de OUTRO local do mesmo tenant recebe 404, não 403.
      const neighbor = await setupHomeStock(authApi, tenant.tenantId, { firstName: 'Bia' });
      sessions.push(neighbor.portal!);
      const neighborRead = await neighbor.portal!.api.get(`/api/portal/my-stock/counts/${count.id}`);
      expect(neighborRead.status(), 'contagem de outro local').toBe(404);
      expect(await apiErrorCodes(neighborRead)).toContain('StockCount.NotFound');
      const neighborList = await neighbor.portal!.api.get('/api/portal/my-stock/counts');
      expect(JSON.stringify(await neighborList.json())).not.toContain(count.id);

      // Regra 12: o recreador de OUTRA empresa, com a própria casa, recebe o mesmo 404.
      const outsider = await setupHomeStock(otherAdmin, otherTenant.tenantId, { firstName: 'Caio' });
      sessions.push(outsider.portal!);
      const outsiderRead = await outsider.portal!.api.get(`/api/portal/my-stock/counts/${count.id}`);
      expect(outsiderRead.status(), 'contagem de outra empresa (Portal)').toBe(404);
      expect(await apiErrorCodes(outsiderRead)).toContain('StockCount.NotFound');

      // Regra 12, a outra ponta: o gestor de outra empresa recebe 404 no detalhe e na revisão.
      expect((await otherAdmin.get(`/api/stock/counts/${count.id}`)).status(), 'detalhe de outra empresa').toBe(404);
      const alienReview = await reviewStockCount(otherAdmin, count.id, detail.rowVersion, [
        { lineId, decision: 'Approved' },
      ]);
      expect(alienReview.status(), 'revisão de outra empresa').toBe(404);
      expect((await apiListStockCounts(otherAdmin)).map((c) => c.id)).not.toContain(count.id);
      expect((await apiGetStockCount(authApi, count.id)).status).toBe('Submitted');

      // Regra 11: o Manager tem `stock.reviewcount` e revisa.
      const manager = await loginAsRole(tenant.tenantId, 'Manager');
      sessions.push(manager);
      const reviewed = await apiApproveAllPending(manager.api, count.id);
      expect(reviewed.status).toBe('Reviewed');
      expect(reviewed.lines.find((l) => l.id === lineId)!.decision).toBe('Approved');
    } finally {
      for (const s of sessions) await s.api.dispose();
      await otherAdmin.dispose();
    }
  });
});
