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

  test('@crud cria atividade via UI e valida no back', async ({ authPage, authApi }) => {
    const nome = `Atividade E2E ${Date.now()}`;

    await authPage.goto('/app/activities/new');
    await authPage.getByTestId('activity-form-name').fill(nome);
    await authPage.getByTestId('activity-form-category').fill('Recreação');
    await authPage.getByTestId('activity-form-price').fill('45');
    await authPage.getByTestId('activity-form-duration').fill('60');
    await authPage.getByTestId('activity-form-minAge').fill('3');
    await authPage.getByTestId('activity-form-maxAge').fill('12');
    await authPage.getByTestId('activity-form-minChildren').fill('5');
    await authPage.getByTestId('activity-form-maxChildren').fill('30');
    await authPage.getByTestId('activity-form-save').click();

    await authPage.waitForURL(/\/app\/activities\/list(\?|$)/, { timeout: 10_000 });

    const res = await authApi.get('/api/activities');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const items = body.data?.items ?? body.items ?? body.data ?? body;
    const list = Array.isArray(items) ? items : items.items ?? [];
    expect(list.some((a: { name?: string }) => a.name === nome)).toBe(true);
  });
});
