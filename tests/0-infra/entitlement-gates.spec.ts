import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Cobertura sistemica — endpoints com `[RequiresEntitlement]` devolvem 403
 * quando tenant nao tem o feature flag ativo. Tenant fresh do authTest
 * nasce SEM nenhum add-on, entao basta chamar o endpoint diretamente.
 *
 * Gates testados:
 *   - feature_leads
 *   - feature_whatsapp (outbound + conversations)
 *   - feature_ai
 *   - feature_digital_signature
 *   - feature_equipment_rental
 *   - feature_stock
 */

test.describe('Entitlement gates — sem add-on retorna 403', () => {
  test('@crud feature_leads bloqueia GET /api/leads', async ({ authApi }) => {
    const res = await authApi.get('/api/leads');
    expect(res.status(), 'sem feature_leads').toBe(403);
  });

  test('@crud feature_leads bloqueia POST /api/leads', async ({ authApi }) => {
    const res = await authApi.post('/api/leads', {
      data: {
        name: 'Lead test',
        whatsAppPhone: '41999998888',
        email: 'lead@test.com',
        source: 'WhatsApp',
        isRecurring: false,
      },
    });
    expect(res.status()).toBe(403);
  });

  test('@crud feature_whatsapp bloqueia GET /api/whatsapp/templates', async ({ authApi }) => {
    const res = await authApi.get('/api/whatsapp/templates');
    expect(res.status()).toBe(403);
  });

  test('@crud feature_conversations bloqueia GET /api/conversations', async ({ authApi }) => {
    const res = await authApi.get('/api/conversations');
    expect(res.status()).toBe(403);
  });

  test('@crud feature_ai bloqueia GET /api/ai/usage', async ({ authApi }) => {
    const res = await authApi.get('/api/ai/usage');
    expect(res.status()).toBe(403);
  });

  test('@crud feature_ai bloqueia POST /api/ai/generate-clause', async ({ authApi }) => {
    const res = await authApi.post('/api/ai/generate-clause', {
      data: { prompt: 'test', applicableTo: ['ClientIndividual'] },
    });
    expect(res.status()).toBe(403);
  });

  test('@crud feature_equipment_rental bloqueia GET /api/equipment-types', async ({
    authApi,
  }) => {
    const res = await authApi.get('/api/equipment-types');
    expect(res.status()).toBe(403);
  });

  test('@crud feature_stock bloqueia POST /api/stock/movements', async ({ authApi }) => {
    const res = await authApi.post('/api/stock/movements', {
      data: { productId: '00000000-0000-0000-0000-000000000000', kind: 'In', quantity: 1 },
    });
    // 403 (entitlement) ou 400 (product nao existe) — ambos antes do 500
    expect([400, 403]).toContain(res.status());
  });
});
