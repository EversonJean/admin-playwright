import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 16.4 — Suporte e bug tracking
 * Diagrama: docs/fluxos/negocio-16.4-suporte-e-bugs.mmd
 *
 * Tenant abre bugs em /app/support/bugs; SuperAdmin triagem cross-tenant
 * em área separada.
 */

test.describe('Fluxo 16.4 — Suporte e bugs', () => {
  test('@flow tela de bugs do tenant carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/support/bugs');
  });
});
