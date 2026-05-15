import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 12.1 — Dashboard
 * Diagrama: docs/fluxos/negocio-12.1-dashboard.mmd
 */

test.describe('Fluxo 12.1 — Dashboard', () => {
  test('@flow dashboard carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/dashboard');
  });
});
