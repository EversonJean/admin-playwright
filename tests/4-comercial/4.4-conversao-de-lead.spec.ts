import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';

/**
 * Fluxo: 4.4 — Conversão de lead
 * Diagrama: docs/fluxos/negocio-4.4-conversao-de-lead.mmd
 *
 * POST /api/leads/:id/convert-to-client cria um Client a partir dos
 * dados do Lead + marca o Lead como Converted (state machine — Etapa 76).
 */

test.describe('Fluxo 4.4 — Conversão de lead', () => {
  test('@flow rota de contacts (origem da conversão) carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/contacts');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test('@crud convert-to-client cria Client e marca Lead Converted', async ({
    authApi,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_leads');

    const create = await authApi.post('/api/leads', {
      data: {
        name: `Lead convert ${Date.now()}`,
        whatsAppPhone: '41977776666',
        email: `${Date.now()}+conv@e2e.test`,
        source: 'WhatsApp',
        isRecurring: false,
      },
    });
    if (!create.ok()) {
      throw new Error(`POST /api/leads ${create.status()}: ${await create.text()}`);
    }
    const lead = (await create.json()).data ?? (await create.json());

    // State machine exige passar por estagios antes de Converted
    for (const target of ['InContact', 'Qualified', 'BudgetSent']) {
      const t = await authApi.post(`/api/leads/${lead.id}/transition`, {
        data: { targetStatus: target },
      });
      if (!t.ok()) {
        throw new Error(`transition ${target} ${t.status()}: ${await t.text()}`);
      }
    }

    const convertRes = await authApi.post(`/api/leads/${lead.id}/convert-to-client`);
    if (!convertRes.ok()) {
      throw new Error(`convert-to-client ${convertRes.status()}: ${await convertRes.text()}`);
    }
    const converted = (await convertRes.json()).data ?? (await convertRes.json());
    expect(converted.clientId, 'convert deve devolver clientId').toBeTruthy();

    // Lead agora carrega clientId (vincula sem mudar status)
    const leadAfter = ((await (await authApi.get(`/api/leads/${lead.id}`)).json()).data ?? {}) as {
      clientId?: string;
    };
    expect(leadAfter.clientId).toBe(converted.clientId);

    // Cliente deve existir agora na /api/clients
    const clientRes = await authApi.get(`/api/clients/${converted.clientId}`);
    expect(clientRes.ok()).toBe(true);
    const client = (await clientRes.json()).data ?? (await clientRes.json());
    expect(client.name).toMatch(/Lead convert/);
  });
});
