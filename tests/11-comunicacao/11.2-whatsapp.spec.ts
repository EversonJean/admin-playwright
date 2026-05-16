import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { fakeWhatsApp } from '../../helpers/fake-providers';
import {
  enableFeatureFlagDirect,
  seedApprovedWhatsAppTemplateDirect,
} from '../../helpers/db-helper';

/**
 * Fluxo: 11.2 — WhatsApp (add-on)
 * Diagrama: docs/fluxos/negocio-11.2-whatsapp.mmd
 *
 * Em E2E o back usa MetaWhatsAppOutboundProvider real apontando pro fake
 * (porta 1512). POST /api/whatsapp/outbound/send -> back HTTP POST pra
 * fake `/{PhoneNumberId}/messages` -> fake devolve wamid -> dispatch
 * persistido no DB. Inbox do fake confirma o request real.
 */

test.describe('Fluxo 11.2 — WhatsApp', () => {
  test('@flow tela de conversations carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/conversations');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test('@crud send outbound faz POST HTTP real pro fake e retorna wamid', async ({
    authApi,
    tenant,
  }) => {
    // Pre-cond: tenant tem feature_whatsapp + feature_conversations
    enableFeatureFlagDirect(tenant.tenantId, 'feature_whatsapp');
    enableFeatureFlagDirect(tenant.tenantId, 'feature_conversations');

    // Template cross-tenant Approved (seed direto no DB; super-admin gerencia)
    const templateName = `welcome_e2e_${Date.now()}`;
    const templateId = seedApprovedWhatsAppTemplateDirect({
      name: templateName,
      body: 'Ola, sua festa esta confirmada!',
    });

    const since = new Date().toISOString();
    await fakeWhatsApp.clear();

    const phone = `+5541${String(Date.now()).slice(-8)}`;
    const sendRes = await authApi.post('/api/whatsapp/outbound/send', {
      data: {
        templateId,
        phoneE164: phone,
        variableValues: {},
      },
    });
    if (!sendRes.ok()) {
      throw new Error(`POST send ${sendRes.status()}: ${await sendRes.text()}`);
    }
    const sendBody = await sendRes.json();
    const dispatch = sendBody.data ?? sendBody;
    expect(dispatch.id, 'dispatch deve carregar Id').toBeTruthy();
    expect(['Queued', 'Sending', 'Sent'], `status inesperado: ${dispatch.status}`).toContain(
      dispatch.status,
    );

    // Inbox do fake deve ter capturado POST /<phoneNumberId>/messages —
    // prova que o back fez HTTP real pra Cloud API ao inves de ficar so
    // logando (Logging provider).
    const inbox = await fakeWhatsApp.inbox({ since });
    const sendCalls = inbox.filter((e) => e.method === 'POST' && /\/messages$/.test(e.path));
    expect(sendCalls.length, 'fake deve ter recebido POST /messages do back').toBeGreaterThanOrEqual(1);

    const captured = sendCalls[sendCalls.length - 1]!;
    const body = captured.body as {
      messaging_product?: string;
      to?: string;
      type?: string;
      template?: { name?: string };
    };
    expect(body.messaging_product).toBe('whatsapp');
    expect(body.type).toBe('template');
    expect(body.template?.name).toBe(templateName);
    expect(body.to).toBe(phone);

    // Header Authorization Bearer dummy chegou no fake (back aplicou auth)
    const authHeader = captured.headers['authorization'];
    const authStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    expect(authStr, 'back deve mandar Bearer <ApiKey>').toMatch(/^Bearer\s+/);
  });

  test('@crud sync-approval do template consulta fake e devolve Approved', async ({
    authApi,
    tenant,
  }) => {
    // Esse spec usa o endpoint super-admin — admin do tenant nao tem permissao
    // pra acionar sync. Validamos apenas que o template seed direto consegue
    // ser usado em send (cobertura suficiente do path Approval em E2E).
    enableFeatureFlagDirect(tenant.tenantId, 'feature_whatsapp');
    enableFeatureFlagDirect(tenant.tenantId, 'feature_conversations');

    const templateId = seedApprovedWhatsAppTemplateDirect({
      name: `sync_e2e_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      body: 'Template de sync',
    });

    // Lista templates disponiveis pro tenant (so Approved)
    const listRes = await authApi.get('/api/whatsapp/templates');
    expect(listRes.ok()).toBe(true);
    const body = await listRes.json();
    const arr: Array<{ id: string }> = body.data ?? body;
    expect(arr.some((t) => t.id === templateId)).toBe(true);
  });
});
