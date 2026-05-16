import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import { apiCreateBudget, apiGetBudget } from '../../helpers/api-event-flow';

/**
 * Fluxo: 5.1 — Montagem do orçamento
 * Diagrama: docs/fluxos/negocio-5.1-montagem-orcamento.mmd
 */

test.describe('Fluxo 5.1 — Montagem do orçamento', () => {
  test('@flow tela de listagem carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/budgets/list');
  });

  test('@flow tela de criação rápida carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/budgets/quick');
  });

  test('@crud cria orcamento via API com items + valida total/status Draft', async ({ authApi }) => {
    const cliente = await apiCreateClient(authApi);
    const atividade = await apiCreateActivity(authApi);
    const orcamento = await apiCreateBudget(authApi, {
      clientId: cliente.id,
      activityIds: [atividade.id],
    });
    expect(orcamento.id).toBeTruthy();

    const fetched = (await apiGetBudget(authApi, orcamento.id)) as {
      id: string;
      status: string;
      items?: Array<{ activityId: string; quantity: number }>;
      total?: number;
    };
    expect(fetched.status).toBe('Draft');
    expect(fetched.items?.length).toBeGreaterThanOrEqual(1);
    expect(fetched.total ?? 0).toBeGreaterThan(0);
  });

  test('@crud orcamento aparece na listagem com status Draft', async ({ authApi }) => {
    const cliente = await apiCreateClient(authApi);
    const atividade = await apiCreateActivity(authApi);
    const orcamento = await apiCreateBudget(authApi, {
      clientId: cliente.id,
      activityIds: [atividade.id],
    });

    const listRes = await authApi.get('/api/budgets');
    expect(listRes.ok()).toBe(true);
    const body = await listRes.json();
    const items = body.data?.items ?? body.items ?? body.data ?? body;
    const arr = Array.isArray(items) ? items : items.items ?? [];
    const found = arr.find((b: { id: string }) => b.id === orcamento.id);
    expect(found, 'novo orcamento deve aparecer na lista').toBeTruthy();
    expect(found.status).toBe('Draft');
  });
});
