import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 14.2 — Dados pessoais (LGPD)
 * Diagrama: docs/fluxos/negocio-14.2-dados-pessoais-lgpd.mmd
 */

test.describe('Fluxo 14.2 — Dados pessoais (LGPD)', () => {
  test('@flow tela de privacidade carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/privacy');
  });
});
