import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';

/**
 * Fluxo: 4.3 — Conversas / WhatsApp
 * Diagrama: docs/fluxos/negocio-4.3-conversas-whatsapp.mmd
 *
 * Conversations + WhatsApp passivo são add-ons gated. Validação completa do
 * webhook está fora de escopo local — aqui validamos o gate de entitlement:
 * sem feature, /api/conversations devolve 403; com `feature_whatsapp`, 200.
 */

test.describe('Fluxo 4.3 — Conversas / WhatsApp', () => {
  test('@flow tela de conversas carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/conversations');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test('@flow sem feature_whatsapp: /api/conversations responde 403 Entitlement', async ({
    authApi,
  }) => {
    const res = await authApi.get('/api/conversations');
    expect(res.status()).toBe(403);
  });

  test('@crud com feature_whatsapp habilitado: /api/conversations responde 200', async ({
    authApi,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_whatsapp');
    const res = await authApi.get('/api/conversations');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const data = body.data ?? body;
    // Tenant novo: lista vazia
    const items = data.items ?? data;
    expect(Array.isArray(items) ? items.length : items.items?.length ?? 0).toBe(0);
  });
});
