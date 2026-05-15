import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 9.4 — Aditivos de contrato
 * Diagrama: docs/fluxos/negocio-9.4-aditivos.mmd
 *
 * Aditivos partem do detalhe do contrato dentro do Event. Cobertura
 * completa exige criar Event + contrato. Smoke do drill-down.
 */

test.describe('Fluxo 9.4 — Aditivos', () => {
  test('@flow listagem de eventos carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/events/list');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });
});
