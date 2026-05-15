import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 10.2 — Parcelas automáticas
 * Diagrama: docs/fluxos/negocio-10.2-parcelas-automaticas.mmd
 */

test.describe('Fluxo 10.2 — Parcelas automáticas', () => {
  test('@flow termos de pagamento carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/payment-terms');
  });

  test('@flow tela de recebíveis carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/finance/receivables');
  });
});
