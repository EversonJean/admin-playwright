import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 5.3 — Aceite pelo cliente
 * Diagrama: docs/fluxos/negocio-5.3-aceite-pelo-cliente.mmd
 *
 * Aceite acontece via página pública anônima `/budgets/:token`. Pra testar
 * completamente exige criar Budget → enviar (gera token) → abrir token → aceitar.
 * Aqui validamos que a rota pública responde (mesmo com token inválido).
 */

test.describe('Fluxo 5.3 — Aceite pelo cliente', () => {
  test('@flow rota pública /budgets/:token responde (sem auth)', async ({ page }) => {
    const res = await page.goto('/budgets/token-invalido-teste');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });
});
