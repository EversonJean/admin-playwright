import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 5.5 — Estados possíveis do orçamento
 * Diagrama: docs/fluxos/negocio-5.5-estados-orcamento.mmd
 */

test.describe('Fluxo 5.5 — Estados do orçamento', () => {
  test('@flow listagem de orçamentos carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/budgets/list');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });
});
