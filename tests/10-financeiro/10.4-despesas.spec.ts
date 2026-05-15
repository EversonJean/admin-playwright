import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 10.4 — Despesas
 * Diagrama: docs/fluxos/negocio-10.4-despesas.mmd
 *
 * Despesas têm endpoint /api/expenses. Smoke do endpoint + tela de relatórios.
 */

test.describe('Fluxo 10.4 — Despesas', () => {
  test('@flow GET /api/expenses responde sem 500', async ({ authApi }) => {
    const res = await authApi.get('/api/expenses');
    expect(res.status()).toBeLessThan(500);
  });

  test('@flow tela de relatórios financeiros carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/finance/reports');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });
});
