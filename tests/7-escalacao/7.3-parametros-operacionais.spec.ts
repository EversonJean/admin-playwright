import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 7.3 — Parâmetros operacionais (configuráveis por empresa)
 * Diagrama: docs/fluxos/negocio-7.3-parametros-operacionais.mmd
 *
 * Inclui modalidades, níveis, prazos de pagamento — todos sob /app/settings/*.
 */

test.describe('Fluxo 7.3 — Parâmetros operacionais', () => {
  test('@flow modalidades carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/service-modalities');
  });

  test('@flow níveis de colaborador carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/collaborator-levels');
  });

  test('@flow termos de pagamento carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/payment-terms');
  });

  test('@flow tela geral de parâmetros carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/parameters');
  });
});
