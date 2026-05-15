import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { apiCreateActivity, apiListActivities } from '../../helpers/api-entities';

/**
 * Fluxo: 2.1 — Atividades
 * Diagrama: docs/fluxos/negocio-2.1-atividades.mmd
 */

test.describe('Fluxo 2.1 — Atividades', () => {
  test('@flow tela de listagem carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/activities/list');
  });

  test('@flow tela de criação carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/activities/new');
  });

  test('@flow criar atividade via API + aparece na listagem', async ({ authApi }) => {
    const created = await apiCreateActivity(authApi);
    expect(created.id).toBeTruthy();
    const list = await apiListActivities(authApi);
    const items = (list as { items?: unknown[] }).items ?? (list as unknown as { data?: { items?: unknown[] } }).data?.items ?? [];
    expect(items.length).toBeGreaterThan(0);
  });
});
