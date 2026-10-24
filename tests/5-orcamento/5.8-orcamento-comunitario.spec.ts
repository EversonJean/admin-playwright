import { APIRequestContext } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { twoTenantsTest } from '../../fixtures/two-tenants.fixture';
import { apiCompleteOnboarding, apiCreateActivity, apiCreateCollaboratorLevel } from '../../helpers/api-entities';
import {
  apiCreateBudget,
  apiGetPublicBudget,
  apiSendBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';
import {
  ChargeMode,
  apiCreateSchoolClient,
  apiGetBudgetView,
  apiTryConfirmCommunity,
  brl,
} from '../../helpers/community-event';
import { compactText, pdfText } from '../../helpers/pdf-text';
import { tenantDayPlus } from '../../helpers/rain-plan';
import { apiErrorCodes } from '../../helpers/response';
import { loginAsRole } from '../../helpers/setup-flows';
import { stripUiPermissions } from '../../helpers/ui';

/**
 * Fluxo 5.8 — Orçamento comunitário (ação sem cobrança)
 * Plano: docs/implementados/PLANO-EVENTO-COMUNITARIO.md §3 (EC-A, Etapa 247),
 * decisões 6 e 7. Registro e2e: E2, E3 e E7.
 *
 *   E2. O orçamento comunitário com custo maior que zero é enviado sem a trava
 *       de margem negativa (§3 back 3: a exceção é SÓ pelo modo); o mesmo
 *       orçamento como pago, com o desconto que o zera, é barrado por
 *       `Budget.NegativeMargin` (Etapa 236).
 *   E3. Sem `budgets.community` o toggle, o "Confirmar ação" e o "Fechar
 *       orçamento" não aparecem e o orçamento comunitário abre só para leitura
 *       (§3 front 3); a chamada direta ao `confirm-community`, ao `accept` e ao
 *       `PUT` dá 403 (§3 back 4 e 5); de outro tenant, 404.
 *   E7. O link público do comunitário mostra "sem custo para vocês" e nem a
 *       resposta anônima nem o PDF trazem valor (§3 back 6, decisão 6).
 *
 * Papel sem `budgets.community`: os perfis são fixos e o mapa papel ->
 * permissions é global no back, e todo perfil padrão que edita orçamento
 * (Owner, Admin, Manager) recebe `budgets.community`. A tela é vista pelo Owner
 * com a permission retirada da lista que o front recebe (`stripUiPermissions`,
 * molde do 17.6); a API é exercida com o único perfil padrão sem ela, o
 * Financial (que também não tem `budgets.update`). O `Budget.CommunityForbidden`
 * de quem tem `budgets.update` sem `budgets.community` fica no teste de Api do
 * back (`BudgetCommunityEndpointTests`, papel customizado por decorador).
 *
 * Sem diagrama `.mmd`: verificação de plano.
 */

/** Números do DTO público que NÃO são dinheiro: contagens e duração. */
const NON_MONEY = new Set(['childrenCount', 'teamSize', 'occurrenceCount', 'quantity', 'durationMinutes', 'celebrantAge']);

function moneyNumbers(value: unknown, path: string): Array<{ path: string; value: number }> {
  if (Array.isArray(value)) return value.flatMap((item, i) => moneyNumbers(item, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) =>
      typeof inner === 'number'
        ? NON_MONEY.has(key)
          ? []
          : [{ path: `${path}.${key}`, value: inner }]
        : moneyNumbers(inner, `${path}.${key}`),
    );
  }
  return [];
}

/** Valores de tabela "estranhos" para o PDF: nenhum se confunde com data ou contagem. */
const PRICES = { perChild: 12.34, teamPricePerCollaborator: 345.67, displacementFee: 52.31 };

async function priceCatalog(api: APIRequestContext) {
  const client = await apiCreateSchoolClient(api);
  const activity = await apiCreateActivity(api, { status: 'Active', pricePerChild: PRICES.perChild });
  return { client, activity };
}

async function createBudget(
  api: APIRequestContext,
  catalog: Awaited<ReturnType<typeof priceCatalog>>,
  chargeMode: ChargeMode,
  discountPercentage?: number,
) {
  return apiCreateBudget(api, {
    clientId: catalog.client.id,
    activityIds: [catalog.activity.id],
    eventDate: tenantDayPlus(20),
    eventLocation: `Escola E2E ${catalog.client.name}`,
    childrenCount: 15,
    teamSize: 2,
    teamPricePerCollaborator: PRICES.teamPricePerCollaborator,
    displacementFee: PRICES.displacementFee,
    chargeMode,
    discountPercentage,
  });
}

/** Corpo completo do `PUT /api/budgets/{id}` (estado completo). */
function updateBody(activityId: string, chargeMode: ChargeMode): Record<string, unknown> {
  return {
    eventDate: tenantDayPlus(20),
    eventStartTime: '14:00',
    eventEndTime: '18:00',
    eventLocation: 'Escola E2E',
    childrenCount: 20,
    validUntil: tenantDayPlus(10),
    packageId: null,
    teamSize: 2,
    teamPricePerCollaborator: 200,
    displacementFee: 0,
    discountAmount: null,
    discountPercentage: null,
    discountReason: null,
    internalNotes: null,
    items: [{ activityId, quantity: 1 }],
    chargeMode,
  };
}

test.describe('Fluxo 5.8 — community budget', () => {
  test('E2 @flow a community budget with cost above zero is sent without the negative-margin lock; the same budget as charged is blocked', async ({
    authApi,
  }) => {
    // Custo de equipe estimável: sem nível com valor base o termo fica
    // indisponível, a estimativa não fecha e a trava nem avalia (pré-condição).
    await apiCreateCollaboratorLevel(authApi, 150);
    const catalog = await priceCatalog(authApi);

    const community = await createBudget(authApi, catalog, 'Community');
    const communityView = await apiGetBudgetView(authApi, community.id);
    expect(communityView.chargeMode).toBe('Community');
    expect(communityView.subtotal, 'valor de referência').toBeGreaterThan(0);
    expect(communityView.discountApplied, 'o desconto comunitário é o subtotal inteiro').toBeCloseTo(
      communityView.subtotal,
      2,
    );
    expect(communityView.total).toBe(0);
    expect(communityView.costEstimate?.isComplete, 'estimativa completa (pré-condição)').toBe(true);
    expect(communityView.costEstimate!.totalCost, 'a ação tem custo').toBeGreaterThan(0);

    const sent = await authApi.post(`/api/budgets/${community.id}/send`);
    expect(sent.status(), (await sent.text()).slice(0, 300)).toBe(200);
    expect((await apiGetBudgetView(authApi, community.id)).status).toBe('Sent');

    // O mesmo orçamento como PAGO, zerado por desconto de 100%: a mesma conta
    // de custo, e o envio continua travado (a exceção nunca é o total zero).
    const charged = await createBudget(authApi, catalog, 'Charged', 100);
    const chargedView = await apiGetBudgetView(authApi, charged.id);
    expect(chargedView.chargeMode).toBe('Charged');
    expect(chargedView.total).toBe(0);
    expect(chargedView.costEstimate?.isComplete).toBe(true);
    expect(chargedView.costEstimate!.marginAmount, 'margem negativa (pré-condição)').toBeLessThan(0);

    const blocked = await authApi.post(`/api/budgets/${charged.id}/send`);
    expect(blocked.status()).toBe(409);
    expect(await apiErrorCodes(blocked)).toContain('Budget.NegativeMargin');
    expect((await apiGetBudgetView(authApi, charged.id)).status).toBe('Draft');
  });

  test('E3 @flow without budgets.community the screen hides the toggle and the confirmation and opens the community budget read-only', async ({
    authApi,
    authPage,
  }) => {
    const catalog = await priceCatalog(authApi);
    const community = await createBudget(authApi, catalog, 'Community');
    const charged = await createBudget(authApi, catalog, 'Charged');

    await apiCompleteOnboarding(authApi);
    await stripUiPermissions(authPage, ['budgets.community']);

    // Orçamento comunitário em rascunho: só leitura, sem as ações que o fecham.
    await authPage.goto(`/app/budgets/${community.id}`);
    await expect(authPage.getByTestId('budget-form')).toBeVisible({ timeout: 20_000 });
    await expect(authPage.getByTestId('budget-form-locked')).toContainText(
      'Só quem tem a permissão de ação comunitária edita este orçamento.',
    );
    await expect(authPage.getByTestId('budget-form-community-readonly')).toBeVisible();
    await expect(authPage.getByTestId('budget-form-isCommunity')).toHaveCount(0);
    await expect(authPage.getByTestId('budget-form-confirm-community')).toHaveCount(0);
    await expect(authPage.getByTestId('budget-form-accept')).toHaveCount(0);
    await expect(authPage.getByTestId('budget-form-save')).toBeDisabled();
    // "Enviar ao cliente" segue com `budgets.send`.
    await expect(authPage.getByTestId('budget-form-send')).toBeVisible();

    // Orçamento pago: nada muda para quem não tem a permission nova.
    await authPage.goto(`/app/budgets/${charged.id}`);
    await expect(authPage.getByTestId('budget-form')).toBeVisible({ timeout: 20_000 });
    await expect(authPage.getByTestId('budget-form-accept')).toBeVisible();
    await expect(authPage.getByTestId('budget-form-isCommunity')).toHaveCount(0);

    // Orçamento novo, inclusive pelo atalho "Nova ação comunitária": sem toggle.
    await authPage.goto('/app/budgets/quick?community=1');
    await expect(authPage.getByTestId('budget-form-clientId')).toBeVisible({ timeout: 20_000 });
    await expect(authPage.getByTestId('budget-form-isCommunity')).toHaveCount(0);
    await expect(authPage.getByTestId('budget-form-community')).toHaveCount(0);
  });

  test('E3 @flow a user without budgets.community gets 403 on confirm-community, accept and PUT of a community budget', async ({
    authApi,
    tenant,
  }) => {
    const catalog = await priceCatalog(authApi);
    const community = await createBudget(authApi, catalog, 'Community');

    const financial = await loginAsRole(tenant.tenantId, 'Financial');
    try {
      const confirm = await apiTryConfirmCommunity(financial.api, community.id);
      expect(confirm.status(), 'confirm-community').toBe(403);

      const accept = await financial.api.post(`/api/budgets/${community.id}/accept`);
      expect(accept.status(), 'accept').toBe(403);

      const put = await financial.api.put(`/api/budgets/${community.id}`, {
        data: updateBody(catalog.activity.id, 'Community'),
      });
      expect(put.status(), 'PUT').toBe(403);

      const unmark = await financial.api.put(`/api/budgets/${community.id}`, {
        data: updateBody(catalog.activity.id, 'Charged'),
      });
      expect(unmark.status(), 'PUT de volta a pago').toBe(403);
    } finally {
      await financial.api.dispose();
    }

    const after = await apiGetBudgetView(authApi, community.id);
    expect(after.status, 'nada foi confirmado').toBe('Draft');
    expect(after.chargeMode).toBe('Community');
    const events = await authApi.get(`/api/events?clientId=${catalog.client.id}`);
    expect(events.ok()).toBe(true);
    expect(((await events.json()).data?.items ?? []).length, 'nenhum evento nasceu').toBe(0);
  });

  test('E7 @flow the public link of a community budget says "sem custo para vocês" and neither the API nor the PDF carry any value', async ({
    authApi,
    page,
  }) => {
    const catalog = await priceCatalog(authApi);
    const community = await createBudget(authApi, catalog, 'Community');
    const view = await apiGetBudgetView(authApi, community.id);
    // Os números de tabela que o cliente NÃO pode ver (valor de referência).
    const hidden = [
      view.subtotal,
      view.teamCost,
      view.itemsTotal,
      view.displacementFee,
      PRICES.teamPricePerCollaborator,
      PRICES.perChild,
    ];
    for (const value of hidden) expect(value, 'valores de referência existem (pré-condição)').toBeGreaterThan(0);

    const sent = await apiSendBudget(authApi, community.id);
    const token = extractTokenFromPublicUrl(sent.publicUrl);

    const publicApi = await createPublicApiContext();
    try {
      const dto = (await apiGetPublicBudget(publicApi, token)) as Record<string, unknown>;
      expect(dto.isCommunity).toBe(true);
      for (const field of [
        'packageTotal',
        'itemsTotal',
        'teamCost',
        'displacementFee',
        'subtotal',
        'discountApplied',
        'total',
        'totalPerOccurrence',
        'additionalTotal',
      ]) {
        expect(dto[field], `${field} zerado na rota anônima`).toBe(0);
      }
      const items = dto.items as Array<{ lineTotal: number }>;
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) expect(item.lineTotal, 'valor por item zerado').toBe(0);
      // Varredura: um campo de valor novo que esquecesse o zero apareceria aqui.
      expect(moneyNumbers(dto, 'data').filter((n) => n.value !== 0)).toEqual([]);

      const pdfRes = await publicApi.get(`/api/public/budgets/${token}/pdf`);
      expect(pdfRes.ok()).toBe(true);
      const publicPdf = compactText(pdfText(await pdfRes.body()));
      for (const value of hidden) {
        expect(publicPdf, `PDF público sem ${brl(value)}`).not.toContain(compactText(brl(value)));
      }
    } finally {
      await publicApi.dispose();
    }

    // O PDF interno renderiza o mesmo DTO; o par de controle (orçamento pago com
    // o mesmo conteúdo) prova que o "não contém" não passa por um PDF sem valor.
    const internalPdf = await authApi.get(`/api/budgets/${community.id}/pdf`);
    expect(internalPdf.ok()).toBe(true);
    const internalText = compactText(pdfText(await internalPdf.body()));
    for (const value of hidden) {
      expect(internalText, `PDF interno sem ${brl(value)}`).not.toContain(compactText(brl(value)));
    }
    const charged = await createBudget(authApi, catalog, 'Charged');
    const chargedView = await apiGetBudgetView(authApi, charged.id);
    expect(chargedView.subtotal).toBeCloseTo(view.subtotal, 2);
    const chargedPdf = await authApi.get(`/api/budgets/${charged.id}/pdf`);
    expect(compactText(pdfText(await chargedPdf.body())), 'controle: o pago imprime o subtotal').toContain(
      compactText(brl(view.subtotal)),
    );

    // A página pública: "sem custo para vocês", nenhum bloco de valor.
    await page.goto(`/budgets/${token}`);
    const communityCard = page.getByTestId('public-budget-community');
    await expect(communityCard).toBeVisible({ timeout: 20_000 });
    await expect(communityCard).toContainText('Ação comunitária, sem custo para vocês');
    await expect(page.getByTestId('public-budget-total')).toHaveCount(0);
    await expect(page.getByTestId('public-budget-accept')).toBeVisible();
    const bodyText = compactText(await page.locator('body').innerText());
    for (const value of hidden) expect(bodyText, `página sem ${brl(value)}`).not.toContain(compactText(brl(value)));
    expect(bodyText, 'nenhum valor em reais na página').not.toContain('R$');
  });
});

twoTenantsTest.describe('Fluxo 5.8 — community budget: tenant isolation', () => {
  twoTenantsTest('E3 @flow a community budget of another tenant returns 404 on confirm-community, accept, PUT and GET', async ({
    apiA,
    apiB,
    tenantA,
    tenantB,
  }) => {
    expect(tenantB.tenantId, 'dois tenants distintos').not.toBe(tenantA.tenantId);
    const catalogB = await priceCatalog(apiB);
    const budgetB = await createBudget(apiB, catalogB, 'Community');

    const confirm = await apiTryConfirmCommunity(apiA, budgetB.id);
    expect(confirm.status(), 'confirm-community').toBe(404);
    const accept = await apiA.post(`/api/budgets/${budgetB.id}/accept`);
    expect(accept.status(), 'accept').toBe(404);
    const put = await apiA.put(`/api/budgets/${budgetB.id}`, { data: updateBody(catalogB.activity.id, 'Community') });
    expect(put.status(), 'PUT').toBe(404);
    const get = await apiA.get(`/api/budgets/${budgetB.id}`);
    expect(get.status(), 'GET').toBe(404);

    const after = await apiGetBudgetView(apiB, budgetB.id);
    expect(after.status, 'o orçamento de B continua em rascunho').toBe('Draft');
  });
});
