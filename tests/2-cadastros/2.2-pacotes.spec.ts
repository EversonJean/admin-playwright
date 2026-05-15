import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 2.2 — Pacotes
 * Diagrama: docs/fluxos/negocio-2.2-pacotes.mmd
 */

test.describe('Fluxo 2.2 — Pacotes', () => {
  test('@flow tela de listagem carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/packages/list');
  });

  test('@flow tela de criação carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/packages/new');
  });
});
