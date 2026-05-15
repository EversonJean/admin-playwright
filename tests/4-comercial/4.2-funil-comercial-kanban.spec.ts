import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 4.2 — Funil comercial (Kanban)
 * Diagrama: docs/fluxos/negocio-4.2-funil-comercial-kanban.mmd
 *
 * Funil comercial é parte do add-on Leads/CRM. Mesma estratégia do 4.1:
 * valida que a rota carrega sem 500.
 */

test.describe('Fluxo 4.2 — Funil comercial (Kanban)', () => {
  test('@flow tela de funil/leads carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/leads');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });
});
