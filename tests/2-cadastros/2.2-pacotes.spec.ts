import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { apiCreateActivity } from '../../helpers/api-entities';

/**
 * Fluxo: 2.2 — Pacotes
 * Diagrama: docs/fluxos/negocio-2.2-pacotes.mmd
 */

test.describe('Fluxo 2.2 — Pacotes', () => {
  test('@flow tela de listagem carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/packages/list');
  });

  test('@flow tela de criação carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/packages/new');
  });

  test('@crud cria pacote via UI (pricing Calculated) e valida no back', async ({
    authPage,
    authApi,
  }) => {
    // Pacote precisa de pelo menos 1 atividade no catálogo — cria via API.
    await apiCreateActivity(authApi);

    const nome = `Pacote E2E ${Date.now()}`;

    await authPage.goto('/app/packages/new');
    await authPage.getByTestId('package-form-name').fill(nome);
    await authPage.getByTestId('package-form-collaborators').fill('2');
    await authPage.getByTestId('package-form-minChildren').fill('5');
    await authPage.getByTestId('package-form-maxChildren').fill('30');

    // Adiciona a primeira (e única) atividade — botão habilita após catálogo carregar
    await expect(authPage.getByTestId('package-form-add-activity')).toBeEnabled({ timeout: 10_000 });
    await authPage.getByTestId('package-form-add-activity').click();

    // Seleciona a atividade no select (mat-select abre painel)
    await authPage.getByTestId('package-form-activity-0').click();
    await authPage.locator('mat-option').first().click();

    await authPage.getByTestId('package-form-quantity-0').fill('1');

    // Estratégia Calculated com desconto 0 (default já é Calculated)
    await authPage.getByTestId('package-form-discount').fill('0');

    await authPage.getByTestId('package-form-save').click();
    await authPage.waitForURL(/\/app\/packages\/list(\?|$)/, { timeout: 10_000 });

    const res = await authApi.get('/api/packages');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const items = body.data?.items ?? body.items ?? body.data ?? body;
    const list = Array.isArray(items) ? items : items.items ?? [];
    expect(list.some((p: { name?: string }) => p.name === nome)).toBe(true);
  });
});
