import { authTest as test } from '../../fixtures/auth.fixture';
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
});
