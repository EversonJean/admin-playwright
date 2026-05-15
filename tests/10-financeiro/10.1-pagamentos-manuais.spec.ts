import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 10.1 — Pagamentos manuais
 * Diagrama: docs/fluxos/negocio-10.1-pagamentos-manuais.mmd
 *
 * Pagamentos vivem no detalhe do Event (no eixo financeiro do status).
 * Cobertura via UI exige Event criado. Smoke da tela de recebíveis.
 */

test.describe('Fluxo 10.1 — Pagamentos manuais', () => {
  test('@flow tela de recebíveis carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/finance/receivables');
  });
});
