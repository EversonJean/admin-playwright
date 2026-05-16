import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 9.1 — Biblioteca de cláusulas
 * Diagrama: docs/fluxos/negocio-9.1-biblioteca-de-clausulas.mmd
 */

test.describe('Fluxo 9.1 — Biblioteca de cláusulas', () => {
  test('@flow tela de listagem carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/clauses/list');
  });

  test('@flow tela de criação carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/clauses/new');
  });

  test('@crud cria clausula via UI e valida no back', async ({ authPage, authApi }) => {
    const titulo = `Clausula E2E ${Date.now()}`;

    await authPage.goto('/app/clauses/new');
    await authPage.getByTestId('clause-form-title').fill(titulo);

    // Categoria — pega a primeira opção do mat-select
    await authPage.getByTestId('clause-form-category').click();
    await authPage.locator('mat-option').first().click();

    // Aplicável a (multi-select) — pega a primeira opção e fecha o painel
    await authPage.getByTestId('clause-form-applicability').click();
    await authPage.locator('mat-option').first().click();
    await authPage.keyboard.press('Escape');

    // Corpo da cláusula — contenteditable
    const editor = authPage.getByTestId('clause-editor-editor');
    await editor.click();
    await authPage.keyboard.type(
      'Corpo da cláusula de teste E2E. Sujeito a {evento.data}.',
    );

    await authPage.getByTestId('clause-form-submit').click();
    await authPage.waitForURL(/\/app\/clauses(\/|$)/, { timeout: 10_000 });

    const res = await authApi.get('/api/clauses');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const items = body.data?.items ?? body.items ?? body.data ?? body;
    const list = Array.isArray(items) ? items : items.items ?? [];
    expect(list.some((c: { title?: string }) => c.title === titulo)).toBe(true);
  });
});
