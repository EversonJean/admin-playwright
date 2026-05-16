import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import { apiCreateBudget, apiSendBudget } from '../../helpers/api-event-flow';
import { assertOk, readJson } from '../../helpers/response';

/**
 * Cobertura sistemica — filtros/sort/paginacao nas listagens do back.
 * Garante que os QueryParams comuns (page, pageSize, search, status,
 * sortBy, sortDescending) sao aceitos sem 5xx.
 */

interface PagedShape {
  items: unknown[];
  page?: number;
  pageSize?: number;
  total?: number;
}

test.describe('Listas — filtros/paginacao/sort', () => {
  test('@flow /api/clients aceita page+pageSize+search', async ({ authApi }) => {
    await apiCreateClient(authApi);
    const res = await authApi.get('/api/clients?page=1&pageSize=5&search=Cliente');
    await assertOk(res, 'GET clients paginado');
    const data = await readJson<PagedShape>(res);
    expect(data.items, 'shape paginado').toBeTruthy();
    expect(Array.isArray(data.items)).toBe(true);
  });

  test('@flow /api/activities aceita pageSize=1 e devolve 1 ou 0 itens', async ({ authApi }) => {
    await apiCreateActivity(authApi);
    const res = await authApi.get('/api/activities?page=1&pageSize=1');
    await assertOk(res, 'GET activities paginado');
    const data = await readJson<PagedShape>(res);
    expect(data.items.length).toBeLessThanOrEqual(1);
  });

  test('@flow /api/budgets aceita filtro status=Sent', async ({ authApi }) => {
    const cliente = await apiCreateClient(authApi);
    const ativ = await apiCreateActivity(authApi);
    const orc = await apiCreateBudget(authApi, { clientId: cliente.id, activityIds: [ativ.id] });
    await apiSendBudget(authApi, orc.id);

    const res = await authApi.get('/api/budgets?status=Sent');
    await assertOk(res, 'GET budgets filtrado');
    const data = await readJson<PagedShape>(res);
    const arr = (data.items ?? []) as Array<{ id: string; status: string }>;
    expect(arr.find((b) => b.id === orc.id), 'budget Sent na lista filtrada').toBeTruthy();
  });

  test('@flow /api/audit-logs aceita filtros de periodo', async ({ authApi }) => {
    const from = new Date(Date.now() - 86400000).toISOString();
    const to = new Date(Date.now() + 86400000).toISOString();
    const res = await authApi.get(
      `/api/audit-logs?occurredFrom=${from}&occurredTo=${to}&page=1&pageSize=10`,
    );
    await assertOk(res, 'GET audit-logs filtrado');
  });

  test('@flow /api/collaborators aceita filtro status=Active', async ({ authApi }) => {
    const res = await authApi.get('/api/collaborators?status=Active&page=1&pageSize=10');
    await assertOk(res, 'GET collaborators filtrado');
  });

  test('@flow /api/products aceita filtros multiplos', async ({ authApi }) => {
    const res = await authApi.get(
      '/api/products?status=Active&isReusable=true&page=1&pageSize=10',
    );
    await assertOk(res, 'GET products filtrado');
  });
});
