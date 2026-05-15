import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 5.1 — Montagem do orçamento
 * Diagrama: docs/fluxos/negocio-5.1-montagem-orcamento.mmd
 */

test.describe('Fluxo 5.1 — Montagem do orçamento', () => {
  test('@flow tela de listagem carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/budgets/list');
  });

  test('@flow tela de criação rápida carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/budgets/quick');
  });
});
