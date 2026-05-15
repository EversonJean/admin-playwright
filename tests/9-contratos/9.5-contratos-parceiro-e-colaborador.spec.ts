import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 9.5 — Outros tipos de contrato (parceiro, colaborador)
 * Diagrama: docs/fluxos/negocio-9.5-contratos-parceiro-e-colaborador.mmd
 */

test.describe('Fluxo 9.5 — Contratos parceiro e colaborador', () => {
  test('@flow listagem de contratos de parceiro carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/contracts/partner/list');
  });

  test('@flow criação de contrato de parceiro carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/contracts/partner/new');
  });

  test('@flow listagem de contratos de colaborador carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/contracts/collaborator/list');
  });

  test('@flow criação de contrato de colaborador carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/contracts/collaborator/new');
  });
});
