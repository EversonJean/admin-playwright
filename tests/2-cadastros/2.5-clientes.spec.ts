import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { apiCreateClient, apiListClients } from '../../helpers/api-entities';

/**
 * Fluxo: 2.5 — Clientes
 * Diagrama: docs/fluxos/negocio-2.5-clientes.mmd
 */

test.describe('Fluxo 2.5 — Clientes', () => {
  test('@flow tela de listagem carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/clients/list');
  });

  test('@flow tela de criação carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/clients/new');
  });

  test('@flow criar cliente via API + aparece na listagem', async ({ authApi }) => {
    const created = await apiCreateClient(authApi);
    expect(created.id).toBeTruthy();
    const list = await apiListClients(authApi);
    const items = (list as { items?: unknown[] }).items ?? (list as unknown as { data?: { items?: unknown[] } }).data?.items ?? [];
    expect(items.length).toBeGreaterThan(0);
  });

  test('@crud cria cliente via UI e valida no back', async ({ authPage, authApi }) => {
    const nome = `Cliente E2E ${Date.now()}`;
    // CPF válido de teste (algoritmo Mod 11 OK)
    const cpf = '11144477735';

    await authPage.goto('/app/clients/new');
    // type já tem default 'PF', status já tem default 'Active'
    await authPage.getByTestId('client-form-name').fill(nome);
    await authPage.getByTestId('client-form-document').fill(cpf);
    await authPage.getByTestId('client-form-save').click();

    await authPage.waitForURL(/\/app\/clients\/list(\?|$)/, { timeout: 10_000 });

    const res = await authApi.get('/api/clients');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const items = body.data?.items ?? body.items ?? body.data ?? body;
    const list = Array.isArray(items) ? items : items.items ?? [];
    expect(list.some((c: { name?: string }) => c.name === nome)).toBe(true);
  });
});
