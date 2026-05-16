import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 9.2 — Templates de contrato
 * Diagrama: docs/fluxos/negocio-9.2-templates-de-contrato.mmd
 */

test.describe('Fluxo 9.2 — Templates de contrato', () => {
  test('@flow listagem de templates carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/contract-templates/list');
  });

  test('@flow criação de template carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/contract-templates/new');
  });

  test('@flow variáveis de contrato carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/contract-variables');
  });

  test('@crud cria template de contrato via UI e valida no back', async ({
    authPage,
    authApi,
  }) => {
    const nome = `Template E2E ${Date.now()}`;

    await authPage.goto('/app/contract-templates/new');
    await authPage.getByTestId('template-form-name').fill(nome);
    await authPage.getByTestId('template-form-description').fill('Descrição E2E');

    // Tipo (mat-select) — pega a primeira opção
    await authPage.getByTestId('template-form-type').click();
    await authPage.locator('mat-option').first().click();

    await authPage.getByTestId('template-form-header').fill('Cabeçalho de teste E2E.');
    await authPage.getByTestId('template-form-footer').fill('Rodapé de teste E2E.');

    // Layout default do front nem sempre coincide com a primeira key do catalog
    // do back — clicamos no primeiro card do picker pra garantir uma key válida.
    await authPage
      .locator('[data-testid="layout-picker"] [data-testid^="layout-option-"]')
      .first()
      .click();

    const respPromise = authPage.waitForResponse(
      (r) => r.url().includes('/api/contract-templates') && r.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await authPage.getByTestId('template-form-create').click();
    const resp = await respPromise;
    if (!resp.ok()) {
      throw new Error(`POST /api/contract-templates ${resp.status()}: ${await resp.text()}`);
    }

    // Após criar, redireciona pra /app/contract-templates/:id (edição em abas)
    await authPage.waitForURL(/\/app\/contract-templates\/[0-9a-f-]+/i, { timeout: 10_000 });

    const res = await authApi.get('/api/contract-templates');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const items = body.data?.items ?? body.items ?? body.data ?? body;
    const list = Array.isArray(items) ? items : items.items ?? [];
    expect(list.some((t: { name?: string }) => t.name === nome)).toBe(true);
  });
});
