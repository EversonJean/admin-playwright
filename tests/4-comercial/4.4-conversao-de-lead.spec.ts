import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 4.4 — Conversão de lead
 * Diagrama: docs/fluxos/negocio-4.4-conversao-de-lead.mmd
 *
 * Conversão lead → cliente faz parte do add-on Leads/CRM. Pra um tenant
 * sem `feature_leads`, a rota responde com módulo bloqueado.
 */

test.describe('Fluxo 4.4 — Conversão de lead', () => {
  test('@flow rota de contacts (origem da conversão) carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/contacts');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });
});
