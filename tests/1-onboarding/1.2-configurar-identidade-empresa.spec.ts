import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { apiCompleteOnboarding } from '../../helpers/api-entities';

/**
 * Fluxo: 1.2 — Configurar identidade da empresa
 * Diagrama: docs/fluxos/negocio-1.2-configurar-identidade-empresa.mmd
 * Especificação: docs/FUNCIONALIDADES-NEGOCIO.md §1.2
 */

test.describe('Fluxo 1.2 — Configurar identidade da empresa', () => {
  test('@flow tela de empresa carrega autenticada', async ({ authPage, authApi }) => {
    await apiCompleteOnboarding(authApi);
    await smokeRoute(authPage, '/app/settings/company', { ready: 'company-page' });
  });

  test('@flow tela de tema/branding carrega autenticada', async ({ authPage, authApi }) => {
    await apiCompleteOnboarding(authApi);
    await smokeRoute(authPage, '/app/settings/theme', { ready: 'theme-page' });
  });
});
