import { twoTenantsTest as test, expect } from '../../fixtures/two-tenants.fixture';
import { apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import { apiCreateBudget } from '../../helpers/api-event-flow';

/**
 * Cobertura sistemica — Tenant A nao pode acessar recursos do Tenant B.
 * Categoria mais critica em SaaS multi-tenant.
 *
 * Estrategia: 2 tenants frescos (apiA e apiB). Cria entidades em A,
 * tenta ler/escrever pelo B — deve retornar 404 (nao 200, nao 403 vazando
 * existencia).
 */

test.describe('Multi-tenant isolation — recursos do tenant A invisiveis pro B', () => {
  test('@crud GET /api/clients/:id de outro tenant -> 4xx (nao vaza dados)', async ({
    apiA,
    apiB,
  }) => {
    const clienteA = await apiCreateClient(apiA);
    const resB = await apiB.get(`/api/clients/${clienteA.id}`);
    // Back pode retornar 404 (semantico) ou 400 (filtro de tenant rejeita).
    // O QUE NAO pode: 200 (vazamento) ou 500.
    expect([400, 404], `tenant B status: ${resB.status()}`).toContain(resB.status());
  });

  test('@crud GET /api/activities/:id de outro tenant -> 404', async ({ apiA, apiB }) => {
    const ativA = await apiCreateActivity(apiA);
    const resB = await apiB.get(`/api/activities/${ativA.id}`);
    expect([404, 400], `status: ${resB.status()}`).toContain(resB.status());
  });

  test('@crud GET /api/budgets/:id de outro tenant -> 4xx', async ({ apiA, apiB }) => {
    const clienteA = await apiCreateClient(apiA);
    const ativA = await apiCreateActivity(apiA);
    const orcamentoA = await apiCreateBudget(apiA, {
      clientId: clienteA.id,
      activityIds: [ativA.id],
    });
    const resB = await apiB.get(`/api/budgets/${orcamentoA.id}`);
    expect([400, 404], `tenant B status: ${resB.status()}`).toContain(resB.status());
  });

  test('@crud listagem /api/clients NAO inclui clients de outro tenant', async ({
    apiA,
    apiB,
  }) => {
    const clienteA = await apiCreateClient(apiA);
    const listB = await apiB.get('/api/clients');
    expect(listB.ok()).toBe(true);
    const body = await listB.json();
    const items = body.data?.items ?? body.items ?? body.data ?? body;
    const arr: Array<{ id: string }> = Array.isArray(items) ? items : [];
    expect(
      arr.find((c) => c.id === clienteA.id),
      'client do tenant A NAO deve aparecer na lista do B',
    ).toBeFalsy();
  });

  test('@crud PUT /api/clients/:id de outro tenant -> 404', async ({ apiA, apiB }) => {
    const clienteA = await apiCreateClient(apiA);
    const resB = await apiB.put(`/api/clients/${clienteA.id}`, {
      data: {
        type: 'PF',
        name: 'Hijacked by B',
        document: '11144477735',
      },
    });
    expect([404, 400], `status: ${resB.status()}`).toContain(resB.status());
  });

  test('@crud DELETE /api/clients/:id de outro tenant -> 404', async ({ apiA, apiB }) => {
    const clienteA = await apiCreateClient(apiA);
    const resB = await apiB.delete(`/api/clients/${clienteA.id}`);
    expect([404, 400, 405], `status: ${resB.status()}`).toContain(resB.status());
  });
});
