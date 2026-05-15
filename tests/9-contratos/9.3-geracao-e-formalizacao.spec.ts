import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 9.3 — Geração e formalização de contrato
 * Diagrama: docs/fluxos/negocio-9.3-geracao-e-formalizacao.mmd
 *
 * Contrato é gerado dentro de Event. Assinatura via Clicksign (add-on
 * gated). Validação completa requer mockar Clicksign — fora de escopo
 * local. Smoke da listagem cliente-final.
 */

test.describe('Fluxo 9.3 — Geração e formalização', () => {
  test('@flow listagem de eventos (origem do contrato) carrega', async ({ authPage }) => {
    const res = await authPage.goto('/app/events/list');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });
});
