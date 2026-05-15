import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 16.2 — Planos e assinatura
 * Diagrama: docs/fluxos/negocio-16.2-planos-e-assinatura.mmd
 *
 * Tenant vê o próprio plano + comparação em /app/billing/*. Gestão dos
 * planos em si (catálogo) fica sob SuperAdmin.
 */

test.describe('Fluxo 16.2 — Planos e assinatura', () => {
  test('@flow tela "meu plano" carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/billing/my-plan');
  });

  test('@flow tela de comparação de planos carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/billing/plans');
  });
});
