import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 4.1 — Captura de lead
 * Diagrama: docs/fluxos/negocio-4.1-captura-de-lead.mmd
 *
 * CRM/Leads é add-on com `[RequiresEntitlement]` em endpoints e
 * `feature_leads` no tenant. Pra tenants sem o feature, rota leads
 * responde com módulo bloqueado. Aqui validamos comportamento default
 * (sem o add-on ligado): rota carrega sem 500.
 */

test.describe('Fluxo 4.1 — Captura de lead', () => {
  test('@flow tela de leads carrega autenticada (com ou sem add-on)', async ({ authPage }) => {
    const res = await authPage.goto('/app/leads');
    expect(res?.status() ?? 0).toBeLessThan(500);
    await expect(authPage.getByText(/erro interno|500/i)).toHaveCount(0);
  });
});
