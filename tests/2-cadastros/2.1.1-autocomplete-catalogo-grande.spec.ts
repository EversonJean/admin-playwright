import { authTest as test, expect } from '../../fixtures/auth.fixture';
import {
  apiCompleteOnboarding,
  apiCreateProduct,
  createInBatches,
} from '../../helpers/api-entities';
import { assertOk, readJson } from '../../helpers/response';

/**
 * Fluxo: 2.1.1 — Autocomplete sobre catálogo maior que uma página
 * Plano: docs/implementar/PLANO-AJUSTES-DA-CONVERSAO.md §5 (AJ-F, Etapa 195),
 * decisões D12 (pageSize acima do máximo é limitado ao máximo) e D18
 * (`app-remote-autocomplete`). Registro e2e: E1.
 *
 * Antes da Etapa 195 o formulário da atividade montava um `mat-select` sobre a
 * primeira página de produtos: do 101º em diante o produto não existia para a
 * tela. E pedir `pageSize=200` caía no default de 20. O spec prova os dois
 * lados: o 150º produto é achado e vinculado pela busca no servidor, e a API
 * devolve 100 itens (o teto) com `pageSize=100` na resposta.
 *
 * Sem diagrama `.mmd`: verificação de plano de ajustes, não fluxo novo.
 */

const CATALOG_SIZE = 150;

interface PagedProducts {
  items: Array<{ id: string; name: string }>;
  total: number;
  page: number;
  pageSize: number;
}

test.describe('Fluxo 2.1.1 — autocomplete over a catalog larger than one page', () => {
  test('@crud activity form finds and links the 150th product; pageSize=200 returns 100', async ({
    authApi,
    authPage,
  }) => {
    test.setTimeout(180_000);
    await apiCompleteOnboarding(authApi);

    // Zero à esquerda: a ordem por nome é a ordem de criação, e o 150º é o
    // último em qualquer das duas.
    const run = Date.now().toString(36);
    const products = await createInBatches(CATALOG_SIZE, (i) =>
      apiCreateProduct(authApi, { name: `Catalogo E2E ${run} ${String(i).padStart(3, '0')}` }),
    );
    const last = products[CATALOG_SIZE - 1]!;
    expect(last.name).toBe(`Catalogo E2E ${run} 150`);

    // D12: acima do máximo vale o máximo, não o default.
    const pageRes = await authApi.get('/api/products?pageSize=200');
    await assertOk(pageRes, 'GET /api/products?pageSize=200');
    const page = await readJson<PagedProducts>(pageRes);
    expect(page.items).toHaveLength(100);
    expect(page.pageSize).toBe(100);
    // O tenant novo já nasce com produtos semeados: o total passa de 150.
    expect(page.total).toBeGreaterThanOrEqual(CATALOG_SIZE);

    // UI: atividade nova com o 150º produto escolhido pela busca.
    const activityName = `Atividade catalogo ${run}`;
    await authPage.goto('/app/activities/new');
    await authPage.getByTestId('activity-form-name').fill(activityName);
    await authPage.getByTestId('activity-form-category').fill('Recreação');
    await authPage.getByTestId('activity-form-price').fill('45');
    await authPage.getByTestId('activity-form-duration').fill('60');
    await authPage.getByTestId('activity-form-minAge').fill('3');
    await authPage.getByTestId('activity-form-maxAge').fill('12');
    await authPage.getByTestId('activity-form-minChildren').fill('5');
    await authPage.getByTestId('activity-form-maxChildren').fill('30');

    await authPage.getByTestId('activity-form-product-add').click();
    const productInput = authPage.getByTestId('activity-form-product-input-0');
    await productInput.click();
    await productInput.fill(last.name);
    const option = authPage.getByTestId(`activity-form-product-input-0-option-${last.id}`);
    await expect(option).toBeVisible({ timeout: 10_000 });
    await option.click();
    await expect(productInput).toHaveValue(last.name);

    await authPage.getByTestId('activity-form-save').click();
    await authPage.waitForURL(/\/app\/activities\/list(\?|$)/, { timeout: 15_000 });

    // O back gravou o vínculo com o produto que estava fora da 1ª página.
    const listRes = await authApi.get(
      `/api/activities?search=${encodeURIComponent(activityName)}`,
    );
    await assertOk(listRes, 'GET /api/activities?search');
    const activities = await readJson<{ items: Array<{ id: string; name: string }> }>(listRes);
    const created = activities.items.find((a) => a.name === activityName);
    expect(created, 'atividade criada pela UI').toBeTruthy();

    const detailRes = await authApi.get(`/api/activities/${created!.id}`);
    await assertOk(detailRes, 'GET /api/activities/{id}');
    const detail = await readJson<{ activityProducts: Array<{ productId: string }> }>(detailRes);
    expect(detail.activityProducts.map((p) => p.productId)).toEqual([last.id]);
  });
});
