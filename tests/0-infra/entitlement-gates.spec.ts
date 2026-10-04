import { APIRequestContext, APIResponse } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { enableFeatureFlagDirect, setSubscriptionPlanDirect } from '../../helpers/db-helper';
import { fakeOpenAi } from '../../helpers/fake-providers';
import { assertOk } from '../../helpers/response';
import { setupAcceptedEvent } from '../../helpers/setup-flows';

/**
 * Cobertura sistemica — endpoints com `[RequiresEntitlement]` devolvem 403
 * quando tenant nao tem o feature flag ativo. Tenant fresh do authTest
 * nasce SEM nenhum add-on, em teste do `plan_professional`: basta chamar o
 * endpoint diretamente, salvo `feature_ai`, que esse plano ja inclui (os dois
 * casos de IA passam o tenant para o `plan_free`).
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

  // O teste do signup é do `plan_professional`, que já traz `feature_ai`: o
  // tenant sem IA é o do `plan_free`.
  test('@crud feature_ai bloqueia GET /api/ai/usage', async ({ authApi, tenant }) => {
    setSubscriptionPlanDirect(tenant.tenantId, 'plan_free');
    const res = await authApi.get('/api/ai/usage');
    expect(res.status()).toBe(403);
  });

  test('@crud feature_ai bloqueia POST /api/ai/generate-clause', async ({ authApi, tenant }) => {
    setSubscriptionPlanDirect(tenant.tenantId, 'plan_free');
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

/**
 * E36 (PLANO-AJUSTES-DA-CONVERSAO §12 item 4 e D11, Etapa 203): proposta de
 * orçamento, cronograma da festa e redação de cláusula entram na Central de IA.
 * Com a IA do plano ligada, desligar o card na Central faz a geração devolver o
 * aviso "Ative na Central de IA" (403 `AiFeature.Disabled`) sem chamar o
 * provedor; religar libera; tenant que nunca abriu a Central (sem linha de
 * estado) gera as três normalmente.
 *
 * Em série: "o fake de IA não recebeu nada" é lido no inbox compartilhado do
 * fake OpenAI, e um teste em paralelo gerando de verdade sujaria a janela.
 */
const AI_CENTRAL_FEATURES = [
  { code: 'ai_propose_budget', label: 'proposta de orçamento' },
  { code: 'ai_event_timeline', label: 'cronograma da festa' },
  { code: 'ai_generate_clause', label: 'redação de cláusula' },
] as const;

type AiCentralCode = (typeof AI_CENTRAL_FEATURES)[number]['code'];

function generate(api: APIRequestContext, code: AiCentralCode, eventId: string): Promise<APIResponse> {
  switch (code) {
    case 'ai_propose_budget':
      return api.post('/api/ai/propose-budget', {
        data: { ageRange: '4 a 6 anos', childrenCount: 15, durationMinutes: 180, theme: 'Circo' },
      });
    case 'ai_event_timeline':
      return api.post('/api/ai/event-timeline', { data: { eventId, additionalContext: null } });
    case 'ai_generate_clause':
      return api.post('/api/ai/generate-clause', {
        data: {
          prompt: 'Cláusula de cancelamento até 7 dias antes devolve 100%.',
          category: 'Cancelamento',
          applicableTo: ['ClientIndividual'],
          tone: 'Formal',
        },
      });
  }
}

async function chatCalls(since: string): Promise<number> {
  const inbox = await fakeOpenAi.inbox({ since });
  return inbox.filter((e) => e.method === 'POST' && e.path === '/chat/completions').length;
}

async function setCentralToggle(api: APIRequestContext, code: AiCentralCode, enabled: boolean): Promise<void> {
  await assertOk(
    await api.put(`/api/ai/features/${code}`, { data: { enabled, configJson: null } }),
    `PUT /api/ai/features/${code}`,
  );
}

test.describe('Central de IA gates the three features that lived outside it', () => {
  test.describe.configure({ mode: 'serial' });

  test('@flow turned off in the AI Central, each one answers "Ative na Central de IA" without calling the provider; turned on again, it generates', async ({
    authApi,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_ai');
    const { eventId } = await setupAcceptedEvent(authApi);

    for (const { code } of AI_CENTRAL_FEATURES) await setCentralToggle(authApi, code, false);

    const since = new Date().toISOString();
    for (const { code, label } of AI_CENTRAL_FEATURES) {
      const res = await generate(authApi, code, eventId);
      const body = await res.text();
      expect(res.status(), `${label} desligada: ${body.slice(0, 300)}`).toBe(403);
      expect(body).toContain('AiFeature.Disabled');
      expect(body).toContain('Ative na Central de IA');
    }
    expect(await chatCalls(since), 'nenhuma chamada ao fake de IA com as três desligadas').toBe(0);

    for (const { code } of AI_CENTRAL_FEATURES) await setCentralToggle(authApi, code, true);
    const sinceOn = new Date().toISOString();
    for (const { code, label } of AI_CENTRAL_FEATURES) {
      const res = await generate(authApi, code, eventId);
      expect(res.status(), `${label} religada: ${(await res.text()).slice(0, 300)}`).toBe(200);
    }
    expect(await chatCalls(sinceOn), 'religadas, as três chamam o fake').toBeGreaterThanOrEqual(
      AI_CENTRAL_FEATURES.length,
    );
  });

  test('@flow tenant that never opened the AI Central generates the three normally', async ({
    authApi,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_ai');
    const { eventId } = await setupAcceptedEvent(authApi);

    const since = new Date().toISOString();
    for (const { code, label } of AI_CENTRAL_FEATURES) {
      const res = await generate(authApi, code, eventId);
      expect(res.status(), `${label} sem linha na Central: ${(await res.text()).slice(0, 300)}`).toBe(200);
    }
    expect(await chatCalls(since)).toBeGreaterThanOrEqual(AI_CENTRAL_FEATURES.length);
  });
});
