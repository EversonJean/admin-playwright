import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 12.2 — Relatórios
 * Diagrama: docs/fluxos/negocio-12.2-relatorios.mmd
 */

test.describe('Fluxo 12.2 — Relatórios', () => {
  test('@flow tela de relatórios financeiros carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/finance/reports');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });
});
