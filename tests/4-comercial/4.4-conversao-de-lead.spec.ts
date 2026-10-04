import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';
import {
  apiCompleteOnboarding,
  apiCreateClient,
  createInBatches,
} from '../../helpers/api-entities';
import { assertOk, readJson } from '../../helpers/response';

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

  /**
   * E10 do PLANO-AJUSTES-DA-CONVERSAO (revisão pós-entrega da Etapa 195, §5):
   * o formulário do lead carrega só os 100 primeiros clientes por nome (o
   * catálogo da sugestão por telefone). O lead vinculado a um cliente fora
   * desses 100 abria com o campo vazio: o nome vinha por GET pontual, mas a
   * tela `OnPush` não reavaliava o `[selectedLabel]`. Agora o campo mostra o
   * nome do cliente vinculado.
   */
  test('@flow lead linked to a client outside the first 100 opens with the client name', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(180_000);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_leads');
    await apiCompleteOnboarding(authApi);

    // 100 clientes que vêm antes por nome; o vinculado fica em 101º.
    const run = Date.now().toString(36);
    await createInBatches(100, (i) =>
      apiCreateClient(authApi, { name: `AAA Cliente ${run} ${String(i).padStart(3, '0')}` }),
    );
    const linked = await apiCreateClient(authApi, { name: `ZZZ Cliente vinculado ${run}` });

    const create = await authApi.post('/api/leads', {
      data: {
        name: `Lead vinculado ${run}`,
        whatsAppPhone: '41966665555',
        email: null,
        source: 'WhatsApp',
        isRecurring: true,
        clientId: linked.id,
      },
    });
    await assertOk(create, 'POST /api/leads');
    const lead = await readJson<{ id: string; clientId?: string | null }>(create);
    expect(lead.clientId).toBe(linked.id);

    await authPage.goto(`/app/leads/${lead.id}`);
    await expect(authPage.getByTestId('lead-form-client')).toHaveValue(
      `ZZZ Cliente vinculado ${run}`,
      { timeout: 15_000 },
    );
  });
});
