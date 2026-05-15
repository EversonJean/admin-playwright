import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 2.4 — Produtos
 * Diagrama: docs/fluxos/negocio-2.4-produtos.mmd
 */

test.describe('Fluxo 2.4 — Produtos', () => {
  test('@flow tela de listagem carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/products/list');
  });

  test('@flow tela de criação carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/products/new');
  });

  test('@crud cria produto via UI e valida no back', async ({ authPage, authApi }) => {
    const nome = `Produto E2E ${Date.now()}`;

    await authPage.goto('/app/products/new');
    await authPage.getByTestId('product-form-name').fill(nome);
    await authPage.getByTestId('product-form-category').fill('Brindes');
    await authPage.getByTestId('product-form-unit').fill('unidade');
    await authPage.getByTestId('product-form-unitCost').fill('25.50');
    await authPage.getByTestId('product-form-save').click();

    await authPage.waitForURL(/\/app\/products\/list(\?|$)/, { timeout: 10_000 });

    const res = await authApi.get('/api/products');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const items = body.data?.items ?? body.items ?? body.data ?? body;
    const list = Array.isArray(items) ? items : items.items ?? [];
    expect(list.some((p: { name?: string }) => p.name === nome)).toBe(true);
  });
});
