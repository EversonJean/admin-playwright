import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 1.2 — Configurar identidade da empresa
 * Diagrama: docs/fluxos/negocio-1.2-configurar-identidade-empresa.mmd
 * Especificação: docs/FUNCIONALIDADES-NEGOCIO.md §1.2
 */

test.describe('Fluxo 1.2 — Configurar identidade da empresa', () => {
  test('@flow tela de empresa carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/company');
  });

  test('@flow tela de tema/branding carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/theme');
  });
});
