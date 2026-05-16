import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';

/**
 * Fluxo: 4.2 — Funil comercial (Kanban)
 * Diagrama: docs/fluxos/negocio-4.2-funil-comercial-kanban.mmd
 *
 * Funil expoe transicao de status via POST /api/leads/:id/transition.
 * State machine: New -> InContact -> Qualified -> BudgetSent -> Converted.
 */

test.describe('Fluxo 4.2 — Funil comercial (Kanban)', () => {
  test('@flow tela de funil/leads carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/leads');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test('@crud transition New -> InContact -> Qualified valida e atualiza status', async ({
    authApi,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_leads');

    const create = await authApi.post('/api/leads', {
      data: {
        name: `Lead funil ${Date.now()}`,
        whatsAppPhone: '41999998888',
        email: `${Date.now()}@e2e.test`,
        source: 'WhatsApp',
        isRecurring: false,
      },
    });
    if (!create.ok()) {
      throw new Error(`POST /api/leads ${create.status()}: ${await create.text()}`);
    }
    const lead = (await create.json()).data ?? (await create.json());
    expect(lead.status).toBe('New');

    const t1 = await authApi.post(`/api/leads/${lead.id}/transition`, {
      data: { targetStatus: 'InContact' },
    });
    if (!t1.ok()) {
      throw new Error(`transition InContact ${t1.status()}: ${await t1.text()}`);
    }
    // Re-busca via GET pra confirmar status (transition pode retornar body vazio).
    const after1 = (await (await authApi.get(`/api/leads/${lead.id}`)).json()).data as {
      status?: string;
    };
    expect(after1.status).toBe('InContact');

    const t2 = await authApi.post(`/api/leads/${lead.id}/transition`, {
      data: { targetStatus: 'Qualified' },
    });
    expect(t2.ok()).toBe(true);
    const after2 = (await (await authApi.get(`/api/leads/${lead.id}`)).json()).data as {
      status?: string;
    };
    expect(after2.status).toBe('Qualified');
  });

  test('@crud transition invalida (New -> Converted) eh rejeitada', async ({
    authApi,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_leads');

    const create = await authApi.post('/api/leads', {
      data: {
        name: `Lead invalido ${Date.now()}`,
        whatsAppPhone: '41888887777',
        email: `${Date.now()}+inv@e2e.test`,
        source: 'WhatsApp',
        isRecurring: false,
      },
    });
    const lead = (await create.json()).data ?? (await create.json());

    const res = await authApi.post(`/api/leads/${lead.id}/transition`, {
      data: { targetStatus: 'Converted' },
    });
    expect(
      [400, 409, 422],
      `state machine deve rejeitar New->Converted direto; got ${res.status()}`,
    ).toContain(res.status());
  });
});
