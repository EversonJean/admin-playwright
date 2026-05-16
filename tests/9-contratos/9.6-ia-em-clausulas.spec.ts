import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';
import { fakeOpenAi } from '../../helpers/fake-providers';

/**
 * Fluxo: 9.6 — IA em cláusulas (add-on)
 * Diagrama: docs/fluxos/negocio-9.6-ia-em-clausulas.mmd
 *
 * Add-on `feature_ai` gera/refina cláusulas via LLM. Em E2E o back tem
 * `Ai:Provider=OpenAi` apontando pro fake (porta 1514). Aqui validamos
 * gate de entitlement + chamada HTTP real ponta a ponta.
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
    expect(data.tokensUsedThisMonth ?? data.tokensUsed ?? 0).toBe(0);
  });

  test('@crud generate-clause chama fake OpenAI e devolve clausula gerada', async ({
    authApi,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_ai');
    const since = new Date().toISOString();

    const res = await authApi.post('/api/ai/generate-clause', {
      data: {
        prompt: 'Clausula de cancelamento ate 7 dias antes devolve 100%.',
        category: 'Cancelamento',
        applicableTo: ['ClientIndividual'],
        tone: 'Formal',
      },
    });
    if (!res.ok()) {
      throw new Error(`POST generate-clause ${res.status()}: ${await res.text()}`);
    }
    const body = await res.json();
    const dto = body.data ?? body;
    expect(dto.bodyHtml, 'fake OpenAI deve devolver bodyHtml').toBeTruthy();
    expect(dto.bodyHtml).toContain('Clausula gerada (fake)');

    // Inbox do fake OpenAI: deve ter capturado o POST /chat/completions
    // com Bearer header
    const inbox = await fakeOpenAi.inbox({ since });
    const calls = inbox.filter(
      (e) => e.method === 'POST' && e.path === '/chat/completions',
    );
    expect(calls.length, 'fake OpenAI deve ter recebido chamada').toBeGreaterThanOrEqual(1);

    const captured = calls[calls.length - 1]!;
    const authHeader = captured.headers['authorization'];
    const authStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    expect(authStr).toMatch(/^Bearer\s+fake-openai-key-e2e$/);

    // Body manda model + messages + response_format
    const reqBody = captured.body as {
      model?: string;
      messages?: Array<{ role?: string; content?: string }>;
      response_format?: { type?: string };
    };
    expect(reqBody.model).toBe('fake-gpt-4-e2e');
    expect(Array.isArray(reqBody.messages)).toBe(true);
    expect(reqBody.response_format?.type).toBe('json_object');
  });
});
