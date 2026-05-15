import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 15.1 — Locação de equipamentos
 * Diagrama: docs/fluxos/negocio-15.1-locacao-de-equipamentos.mmd
 *
 * Stock + Rentals são add-ons gated (`feature_stock_advanced`). Sem o
 * entitlement ligado, rotas respondem com módulo bloqueado.
 */

test.describe('Fluxo 15.1 — Locação de equipamentos', () => {
  test('@flow rota /stock carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/stock');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test('@flow rota /rentals carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/rentals');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });
});
