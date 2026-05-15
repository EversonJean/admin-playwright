import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 9.6 — IA em cláusulas (add-on)
 * Diagrama: docs/fluxos/negocio-9.6-ia-em-clausulas.mmd
 *
 * Add-on `feature_ai` gera/refina cláusulas via LLM. Validação E2E completa
 * exige mockar o provider de IA (fora de escopo local). Smoke da rota AI.
 *
 * TODO E2E: cobrir quando o time decidir como mockar o provider de IA.
 */

test.describe('Fluxo 9.6 — IA em cláusulas', () => {
  test('@flow tela de AI carrega autenticada (com ou sem add-on)', async ({ authPage }) => {
    const res = await authPage.goto('/app/ai');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });
});
