import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';

/**
 * Fluxo: 4.1 — Captura de lead
 * Diagrama: docs/fluxos/negocio-4.1-captura-de-lead.mmd
 *
 * CRM/Leads é add-on com `[RequiresEntitlement]` em endpoints e
 * `feature_leads` no tenant.
 */

test.describe('Fluxo 4.1 — Captura de lead', () => {
  test('@flow tela de leads carrega autenticada (com ou sem add-on)', async ({ authPage }) => {
    const res = await authPage.goto('/app/leads');
    expect(res?.status() ?? 0).toBeLessThan(500);
    await expect(authPage.getByText(/erro interno|500/i)).toHaveCount(0);
  });

  test('@crud cria lead via API (com feature_leads) e valida no back', async ({
    authApi,
    tenant,
  }) => {
    // Habilita o entitlement direto no banco — o backend resolve em tempo
    // real. O front guard cacheia entitlements no boot e por isso não vê o
    // novo addon sem hard reload; teste via API contorna isso e valida que
    // o gate de entitlement no endpoint (`[RequiresEntitlement]`) abre.
    enableFeatureFlagDirect(tenant.tenantId, 'feature_leads');

    const nome = `Lead E2E ${Date.now()}`;
    const createRes = await authApi.post('/api/leads', {
      data: {
        name: nome,
        whatsAppPhone: '41999998888',
        email: `${Date.now()}@e2e.test`,
        source: 'WhatsApp',
        isRecurring: false,
      },
    });
    if (!createRes.ok()) {
      throw new Error(`POST /api/leads ${createRes.status()}: ${await createRes.text()}`);
    }

    const listRes = await authApi.get('/api/leads');
    expect(listRes.ok()).toBe(true);
    const body = await listRes.json();
    const items = body.data?.items ?? body.items ?? body.data ?? body;
    const list = Array.isArray(items) ? items : items.items ?? [];
    expect(list.some((l: { name?: string }) => l.name === nome)).toBe(true);
  });
});
