import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 9.1 — Biblioteca de cláusulas
 * Diagrama: docs/fluxos/negocio-9.1-biblioteca-de-clausulas.mmd
 */

test.describe('Fluxo 9.1 — Biblioteca de cláusulas', () => {
  test('@flow tela de listagem carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/clauses/list');
  });

  test('@flow tela de criação carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/clauses/new');
  });
});
