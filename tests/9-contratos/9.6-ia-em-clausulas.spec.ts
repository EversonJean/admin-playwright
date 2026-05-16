import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';

/**
 * Fluxo: 9.6 — IA em cláusulas (add-on)
 * Diagrama: docs/fluxos/negocio-9.6-ia-em-clausulas.mmd
 *
 * Add-on `feature_ai` gera/refina cláusulas via LLM. Validação completa do
 * provider IA está fora de escopo local — aqui validamos o gate de
 * entitlement: sem o feature, /api/ai/usage devolve 403; com o feature,
 * devolve 200 (usage atual = 0 em tenant novo).
 */

test.describe('Fluxo 9.6 — IA em cláusulas', () => {
  test('@flow tela de AI carrega autenticada (com ou sem add-on)', async ({ authPage }) => {
    const res = await authPage.goto('/app/ai');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test('@flow sem feature_ai: /api/ai/usage responde 403 Entitlement', async ({ authApi }) => {
    const res = await authApi.get('/api/ai/usage');
    expect(res.status()).toBe(403);
  });

  test('@crud com feature_ai habilitado: /api/ai/usage responde 200', async ({
    authApi,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_ai');
    const res = await authApi.get('/api/ai/usage');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const data = body.data ?? body;
    // Tenant novo: usage corrente = 0
    expect(data.tokensUsedThisMonth ?? data.tokensUsed ?? 0).toBe(0);
  });
});
