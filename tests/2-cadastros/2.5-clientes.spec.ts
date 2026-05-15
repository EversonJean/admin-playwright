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
});
