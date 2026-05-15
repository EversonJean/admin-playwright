import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 5.4 — Versionamento do orçamento
 * Diagrama: docs/fluxos/negocio-5.4-versionamento-orcamento.mmd
 *
 * Cada update do Budget cria nova versão (versions endpoint). Validar
 * inteiramente exige criar Budget + atualizar. Aqui smoke da rota de detalhe.
 */

test.describe('Fluxo 5.4 — Versionamento', () => {
  test('@flow listagem de orçamentos carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/budgets/list');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });
});
