import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import { apiCompleteOnboarding } from '../../helpers/api-entities';
import { disableFeatureFlagDirect, enableFeatureFlagDirect, setSubscriptionPlanDirect } from '../../helpers/db-helper';
import {
  MyStockCount,
  StockCount,
  requestStockCount,
  saveStockCountLines,
  setupHomeStock,
  submitStockCount,
} from '../../helpers/home-stock';
import { apiErrorCodes, readJson } from '../../helpers/response';
import { RoleSession, loginAsRole, openSessionPage } from '../../helpers/setup-flows';

/**
 * Fluxo: 13.8 — Contagem do estoque de casa: permissão, add-on e isolamento
 * Diagrama: — (o plano é a fonte: PLANO-ESTOQUE-DO-RECREADOR §4.1 e §4.3, ER-B;
 * §3.1 para o gate do add-on nas escritas do Portal)
 *
 * E9: quem não tem `stock.reviewcount` (Financial) não pede contagem (403); o
 * gestor de outra empresa recebe 404 no local; empresa sem o add-on de estoque
 * recebe 403 ao salvar ou enviar a contagem pelo Portal; o recreador não abre a
 * contagem da casa de outro colaborador (404).
 */

test.describe('Fluxo 13.8 — Contagem do estoque de casa: permissão e isolamento', () => {
  test('@flow E9: Financial cannot request a count (403); a manager of another company gets 404 on the location; another collaborator gets 404 on the count; without the stock add-on saving or sending the count through the Portal gets 403', async ({
    authApi,
    browser,
    tenant,
  }) => {
    test.setTimeout(300_000);
    await apiCompleteOnboarding(authApi);
    const home = await setupHomeStock(authApi, tenant.tenantId, { firstName: 'Ana' });
    const product = home.products[0]!;
    const portal = home.portal!;
    const sessions: RoleSession[] = [portal];

    const otherTenant = await signupNewTenant();
    enableFeatureFlagDirect(otherTenant.tenantId, 'feature_stock');
    const otherAdmin = await createBearerApiContext(otherTenant.accessToken);
    try {
      // §4.3: sem `stock.reviewcount` (Financial) não pede contagem; nada abre.
      const financial = await loginAsRole(tenant.tenantId, 'Financial');
      sessions.push(financial);
      const forbidden = await requestStockCount(financial.api, home.locationId);
      expect(forbidden.status(), 'Financial pede contagem').toBe(403);
      expect((await portal.api.get('/api/portal/my-stock/counts/current')).status(), 'nada aberto').toBe(204);

      // §4.2 item 3: na tela de locais, o Financial não tem o botão.
      const view = await openSessionPage(browser, financial.tokens);
      try {
        await view.page.goto('/app/stock/locations');
        await expect(view.page.getByTestId(`stock-location-last-count-${home.locationId}`)).toBeVisible({
          timeout: 20_000,
        });
        await expect(view.page.getByTestId(`stock-location-request-count-${home.locationId}`)).toHaveCount(0);
      } finally {
        await view.context.close();
      }

      // Cross-tenant: o gestor de outra empresa (com o add-on) recebe 404 no local.
      const alien = await requestStockCount(otherAdmin, home.locationId);
      expect(alien.status(), 'pedir contagem no local de outra empresa').toBe(404);
      expect(await apiErrorCodes(alien)).toContain('StockLocation.NotFound');
      expect((await portal.api.get('/api/portal/my-stock/counts/current')).status()).toBe(204);

      // O dono pede a contagem.
      const requested = await requestStockCount(authApi, home.locationId);
      expect(requested.status(), `pedir contagem: ${await requested.text()}`).toBe(201);
      const count = await readJson<StockCount>(requested);

      // O recreador de outro local do mesmo tenant não abre, não salva nem envia a contagem alheia (404).
      const neighbor = await setupHomeStock(authApi, tenant.tenantId, { firstName: 'Bia' });
      sessions.push(neighbor.portal!);
      const neighborRead = await neighbor.portal!.api.get(`/api/portal/my-stock/counts/${count.id}`);
      expect(neighborRead.status(), 'contagem de outra casa').toBe(404);
      expect(await apiErrorCodes(neighborRead)).toContain('StockCount.NotFound');
      const neighborSave = await saveStockCountLines(neighbor.portal!.api, count.id, [
        { productId: product.id, countedQuantity: product.quantity },
      ]);
      expect(neighborSave.status(), 'salvar a contagem de outra casa').toBe(404);
      const neighborSubmit = await submitStockCount(neighbor.portal!.api, count.id);
      expect(neighborSubmit.status(), 'enviar a contagem de outra casa').toBe(404);
      expect((await neighbor.portal!.api.get('/api/portal/my-stock/counts/current')).status()).toBe(204);

      // Nada foi gravado pelo vizinho.
      const untouched = await readJson<MyStockCount>(await portal.api.get(`/api/portal/my-stock/counts/${count.id}`));
      expect(untouched.status).toBe('Open');
      expect(untouched.lines.every((l) => l.countedQuantity === null)).toBe(true);

      // §3.1: sem o add-on, as escritas do Portal respondem 403 `Entitlement.NotIncludedInPlan`.
      setSubscriptionPlanDirect(tenant.tenantId, 'plan_free');
      disableFeatureFlagDirect(tenant.tenantId, 'feature_stock');
      const gatedSave = await saveStockCountLines(portal.api, count.id, [
        { productId: product.id, countedQuantity: product.quantity },
      ]);
      expect(gatedSave.status(), 'salvar sem o add-on').toBe(403);
      expect(await apiErrorCodes(gatedSave)).toContain('Entitlement.NotIncludedInPlan');
      const gatedSubmit = await submitStockCount(portal.api, count.id);
      expect(gatedSubmit.status(), 'enviar sem o add-on').toBe(403);
      expect(await apiErrorCodes(gatedSubmit)).toContain('Entitlement.NotIncludedInPlan');

      // A leitura do Portal fica sem gate (§3.1): a contagem segue aberta e sem resposta.
      const stillOpen = await portal.api.get(`/api/portal/my-stock/counts/${count.id}`);
      expect(stillOpen.status()).toBe(200);
      const after = await readJson<MyStockCount>(stillOpen);
      expect(after.status).toBe('Open');
      expect(after.lines.every((l) => l.countedQuantity === null)).toBe(true);
    } finally {
      for (const s of sessions) await s.api.dispose();
      await otherAdmin.dispose();
    }
  });
});
