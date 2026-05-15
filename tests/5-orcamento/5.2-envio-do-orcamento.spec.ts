import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 5.2 — Envio do orçamento
 * Diagrama: docs/fluxos/negocio-5.2-envio-do-orcamento.mmd
 *
 * O envio gera link público e dispara email. Aqui validamos que listagem
 * carrega (orçamentos enviados aparecem por status); fluxo completo de
 * envio exige criar Budget + Client primeiro, coberto incrementalmente.
 */

test.describe('Fluxo 5.2 — Envio do orçamento', () => {
  test('@flow listagem de orçamentos carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/budgets/list');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });
});
