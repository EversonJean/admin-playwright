import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 2.3 — Tipos de evento
 * Diagrama: docs/fluxos/negocio-2.3-tipos-de-evento.mmd
 */

test.describe('Fluxo 2.3 — Tipos de evento', () => {
  test('@flow tela de listagem carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/event-categories');
  });

  test('@flow tela de criação carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/event-categories/new');
  });

  test('@crud cria categoria via UI e valida no back', async ({ authPage, authApi }) => {
    const nome = `Categoria E2E ${Date.now()}`;

    await authPage.goto('/app/settings/event-categories/new');
    await authPage.getByTestId('category-form-name').fill(nome);
    // group já vem com default 'Festa'; demais campos são opcionais
    await authPage.getByTestId('category-form-save').click();

    await authPage.waitForURL(/\/app\/settings\/event-categories(\?|$)/, { timeout: 10_000 });

    // Confirma no back que a entidade foi persistida no tenant
    const res = await authApi.get('/api/event-categories');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const items = body.data?.items ?? body.items ?? body.data ?? body;
    const list = Array.isArray(items) ? items : items.items ?? [];
    expect(list.some((c: { name?: string }) => c.name === nome)).toBe(true);
  });
});
