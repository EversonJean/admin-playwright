import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 10.3 — Ajustes financeiros imutáveis
 * Diagrama: docs/fluxos/negocio-10.3-ajustes-financeiros.mmd
 *
 * Ajustes acontecem no detalhe do Event. Smoke da listagem.
 */

test.describe('Fluxo 10.3 — Ajustes financeiros', () => {
  test('@flow tela de recebíveis carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/finance/receivables');
  });
});
