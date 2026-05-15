import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 10.6 — Pendências financeiras
 * Diagrama: docs/fluxos/negocio-10.6-pendencias-financeiras.mmd
 */

test.describe('Fluxo 10.6 — Pendências financeiras', () => {
  test('@flow tela de recebíveis carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/finance/receivables');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test('@flow tela de relatórios financeiros carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/finance/reports');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });
});
