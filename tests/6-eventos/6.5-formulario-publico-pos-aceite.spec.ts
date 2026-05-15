import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 6.5 — Formulário público pós-aceite
 * Diagrama: docs/fluxos/negocio-6.5-formulario-publico-pos-aceite.mmd
 *
 * Rota pública anônima `/event-form/:token`. Validação inteira exige
 * criar Event + gerar token. Aqui smoke da rota (token inválido).
 */

test.describe('Fluxo 6.5 — Formulário público pós-aceite', () => {
  test('@flow rota /event-form/:token responde sem 500', async ({ page }) => {
    const res = await page.goto('/event-form/token-invalido-teste');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });
});
