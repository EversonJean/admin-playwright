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

    // mat-select: focus + Enter abre painel; ArrowDown + Enter seleciona
    // primeira opcao. Evita click() que mat-label intercepta.
    const category = authPage.getByTestId('clause-form-category');
    await category.focus();
    await authPage.keyboard.press('Enter');
    await authPage.locator('mat-option:not([aria-disabled="true"])').first().waitFor({ state: 'visible' });
    await authPage.locator('mat-option:not([aria-disabled="true"])').first().click();

    // Multi-select aplicabilidade
    const applic = authPage.getByTestId('clause-form-applicability');
    await applic.focus();
    await authPage.keyboard.press('Enter');
    await authPage.locator('mat-option:not([aria-disabled="true"])').first().waitFor({ state: 'visible' });
    await authPage.locator('mat-option:not([aria-disabled="true"])').first().click();
    await authPage.keyboard.press('Escape');

    // Corpo (contenteditable)
    const editor = authPage.getByTestId('clause-editor-editor');
    await editor.click();
    await authPage.keyboard.type(
      'Corpo da cláusula de teste E2E. Sujeito a {evento.data}.',
    );

    // Submit + espera a chamada POST terminar (200/201) antes de validar
    const [postResp] = await Promise.all([
      authPage.waitForResponse(
        (r) => r.url().endsWith('/api/clauses') && r.request().method() === 'POST',
        { timeout: 10_000 },
      ),
      authPage.getByTestId('clause-form-submit').click(),
    ]);
    expect(postResp.status(), 'POST /api/clauses deve retornar 2xx').toBeLessThan(300);
    await authPage.waitForURL(/\/app\/clauses(\/|$)/, { timeout: 10_000 });

    // GET lista clausulas — back deve devolver a recem-criada
    const res = await authApi.get('/api/clauses');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const items = body.data?.items ?? body.items ?? body.data ?? body;
    const list = Array.isArray(items) ? items : items.items ?? [];
    expect(list.some((c: { title?: string }) => c.title === titulo)).toBe(true);
  });
});
