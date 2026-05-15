import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 9.2 — Templates de contrato
 * Diagrama: docs/fluxos/negocio-9.2-templates-de-contrato.mmd
 */

test.describe('Fluxo 9.2 — Templates de contrato', () => {
  test('@flow listagem de templates carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/contract-templates/list');
  });

  test('@flow criação de template carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/contract-templates/new');
  });

  test('@flow variáveis de contrato carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/contract-variables');
  });
});
