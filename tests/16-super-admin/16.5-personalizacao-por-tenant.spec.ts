import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 16.5 — Personalização por tenant (tema/branding)
 * Diagrama: docs/fluxos/negocio-16.5-personalizacao-por-tenant.mmd
 */

test.describe('Fluxo 16.5 — Personalização por tenant', () => {
  test('@flow tela de tema carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/theme');
  });
});
