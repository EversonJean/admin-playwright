import { authTest as test, expect } from '../../fixtures/auth.fixture';
import {
  apiCompleteOnboarding,
  apiCreateActivity,
  createInBatches,
} from '../../helpers/api-entities';
import { apiCreateBudget } from '../../helpers/api-event-flow';
import { assertOk, readJson } from '../../helpers/response';

/**
 * Fluxo: 2.8.1 — Ficha do parceiro com abas paginadas
 * Plano: docs/implementar/PLANO-AJUSTES-DA-CONVERSAO.md §5 item 4 (AJ-F,
 * Etapa 195). Registro e2e: E2.
 *
 * A ficha pedia `pageSize: 50` uma vez e mostrava só isso. Agora cada aba
 * pagina no servidor (20 por página): o parceiro com 25 orçamentos vê 20 na
 * página 1 e os 5 seguintes na página 2, sem repetir nenhum e sem faltar
 * nenhum.
 *
 * Sem diagrama `.mmd`: verificação de plano de ajustes, não fluxo novo.
 */

const BUDGET_COUNT = 25;
const CNPJ = '11222333000181';

test.describe('Fluxo 2.8.1 — partner detail tabs are paginated', () => {
  test('@flow Budgets tab shows 20 on page 1 and the next 5 on page 2', async ({
    authApi,
    authPage,
  }) => {
    test.setTimeout(120_000);
    await apiCompleteOnboarding(authApi);

    const run = Date.now().toString(36);
    const created = await authApi.post('/api/clients', {
      data: {
        type: 'PJ',
        name: `Buffet Paginado ${run}`,
        document: CNPJ,
        phone: '41988887777',
        isPartner: true,
        partnerCategory: 'Buffet',
      },
    });
    await assertOk(created, 'criar parceiro');
    const partner = await readJson<{ id: string }>(created);

    // O local distingue cada orçamento na linha da tabela.
    const activity = await apiCreateActivity(authApi);
    const locations = Array.from(
      { length: BUDGET_COUNT },
      (_, k) => `Local ${run} ${String(k + 1).padStart(2, '0')}`,
    );
    await createInBatches(BUDGET_COUNT, (i) =>
      apiCreateBudget(authApi, {
        clientId: partner.id,
        activityIds: [activity.id],
        eventLocation: locations[i - 1],
      }),
    );

    await authPage.goto(`/app/partners/${partner.id}`);
    await expect(authPage.getByTestId('partner-detail-name')).toBeVisible({ timeout: 15_000 });
    await authPage.getByRole('tab', { name: 'Orçamentos', exact: true }).click();

    const table = authPage.getByTestId('partner-budgets-table');
    const rows = table.locator('tr.mat-mdc-row');
    const locationCells = table.locator('td.mat-column-location');
    const paginator = authPage.getByTestId('partner-budgets-paginator');

    await expect(rows).toHaveCount(20, { timeout: 15_000 });
    await expect(paginator).toContainText(/1\s*[–-]\s*20 de 25/);
    const page1 = (await locationCells.allTextContents()).map((t) => t.trim());

    await paginator.getByRole('button', { name: 'Próxima página' }).click();
    await expect(rows).toHaveCount(5, { timeout: 15_000 });
    await expect(paginator).toContainText(/21\s*[–-]\s*25 de 25/);
    const page2 = (await locationCells.allTextContents()).map((t) => t.trim());

    // Os seguintes: nenhum repetido da página 1, e as duas juntas são todos.
    expect(page2.filter((l) => page1.includes(l))).toEqual([]);
    expect([...page1, ...page2].sort()).toEqual([...locations].sort());
  });
});
