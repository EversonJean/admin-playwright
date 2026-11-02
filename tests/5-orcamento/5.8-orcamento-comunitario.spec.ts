import { APIRequestContext, Page, Route } from '@playwright/test';

import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import {
  apiCompleteOnboarding,
  apiCreateActivity,
  apiCreateClient,
  apiCreateCollaboratorLevel,
} from '../../helpers/api-entities';
import {
  apiCreateBudget,
  apiGetBudget,
  apiGetPublicBudget,
  apiSendBudget,
  apiUpdateBudget,
  budgetRequestBody,
  createPublicApiContext,
  CreateBudgetInput,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';
import { compactText, pdfText } from '../../helpers/pdf-text';
import { apiErrorCodes, assertOk } from '../../helpers/response';
import { loginAsRole } from '../../helpers/setup-flows';
import { isoDate, tenantToday } from '../../helpers/week-staffing';

/**
 * Fluxo: 5.8 — Orçamento comunitário (ação sem cobrança)
 * Diagrama: — (cenários E2, E3 e E7 do registro e2e de
 * `docs/implementar/PLANO-EVENTO-COMUNITARIO.md`)
 *
 * Fonte do comportamento: PLANO-EVENTO-COMUNITARIO §2.3 (códigos e status) e §3
 * (EC-A: trava de margem, permission `budgets.community`, proposta pública com
 * dado mínimo). O spec afirma o plano; divergência é falha de código, não de
 * asserção.
 *
 * [DECISAO] "Role customizada que edita orçamento sem `budgets.community`" não
 * existe no produto: os papéis são o enum fixo e todo papel com
 * `budgets.update` (Owner, Admin, Manager) nasce com `budgets.community`
 * (`Permissions.ForRole`; `Domain/Auth/Role.cs`). A TELA recebe a lista de
 * permissions sem `budgets.community` (molde do E62 do `17.6`); as chamadas
 * diretas vão com o usuário Financial DE VERDADE, o papel real sem
 * `budgets.community`, que leva 403 nas quatro portas.
 */

const DAY_MS = 86_400_000;

function tenantDay(days = 0): string {
  return isoDate(new Date(tenantToday().getTime() + days * DAY_MS));
}

function uid(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** `1234.5` -> `1.234,50` (o número como a proposta e o PDF o escreveriam). */
function ptBrNumber(value: number): string {
  return value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A tela recebe a lista de permissions sem os códigos dados (molde do E62 do `17.6`). */
async function withoutPermissions(page: Page, codes: string[]): Promise<void> {
  await page.route('**/api/me/permissions', async (route: Route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { data?: { permissions: string[] }; permissions?: string[] };
    const holder = body.data ?? body;
    holder.permissions = (holder.permissions ?? []).filter((p) => !codes.includes(p));
    await route.fulfill({ response, json: body });
  });
}

async function withPublicApi<T>(fn: (api: APIRequestContext) => Promise<T>): Promise<T> {
  const api = await createPublicApiContext();
  try {
    return await fn(api);
  } finally {
    await api.dispose();
  }
}

interface BudgetView {
  id: string;
  status: string;
  chargeMode: string;
  subtotal: number;
  teamCost: number;
  displacementFee: number;
  total: number;
  items: Array<{ unitPrice: number; totalPrice: number }>;
}

test.describe('Fluxo 5.8 — Orçamento comunitário', () => {
  test('E2 @flow comunitário com custo acima de zero é enviado sem a trava de margem; o mesmo orçamento como pago é barrado (409 Budget.NegativeMargin)', async ({
    authApi,
  }) => {
    test.setTimeout(180_000);
    // Custo de equipe conhecido e alto (2 × 5.000): a estimativa fica completa
    // e o custo passa do preço do orçamento pago.
    await apiCreateCollaboratorLevel(authApi, { baseValue: 5000 });
    const client = await apiCreateClient(authApi, { name: `Escola E2E ${uid()}` });
    const activity = await apiCreateActivity(authApi);
    const input: CreateBudgetInput = {
      clientId: client.id,
      activityIds: [activity.id],
      eventDate: tenantDay(20),
    };
    const budget = await apiCreateBudget(authApi, input);

    // Pago: a trava de margem negativa barra o envio.
    const charged = await authApi.post(`/api/budgets/${budget.id}/send`);
    expect(charged.status(), 'envio do orçamento pago no prejuízo').toBe(409);
    expect(await apiErrorCodes(charged)).toContain('Budget.NegativeMargin');

    // O mesmo orçamento como comunitário: o custo é o investimento, sem trava.
    await apiUpdateBudget(authApi, budget.id, { ...input, chargeMode: 'Community' });
    const draft = (await apiGetBudget(authApi, budget.id)) as unknown as BudgetView;
    expect(draft.chargeMode).toBe('Community');
    expect(draft.total, 'cobrado zero').toBe(0);
    expect(draft.subtotal, 'valor de referência').toBeGreaterThan(0);

    const sent = await authApi.post(`/api/budgets/${budget.id}/send`);
    expect(sent.status(), 'envio do comunitário').toBe(200);
    expect(((await apiGetBudget(authApi, budget.id)) as unknown as BudgetView).status).toBe('Sent');
  });

  test('E3 @flow sem budgets.community: toggle, "Confirmar ação" e "Fechar orçamento" somem, o comunitário abre só para leitura e sem "Duplicar" na lista; a API dá 403, e outro tenant 404', async ({
    authPage,
    authApi,
    tenant,
  }) => {
    test.setTimeout(180_000);
    await apiCompleteOnboarding(authApi);
    const client = await apiCreateClient(authApi, { name: `Escola E2E ${uid()}` });
    const activity = await apiCreateActivity(authApi);
    const communityInput: CreateBudgetInput = {
      clientId: client.id,
      activityIds: [activity.id],
      eventDate: tenantDay(20),
      chargeMode: 'Community',
    };
    const community = await apiCreateBudget(authApi, communityInput);
    const charged = await apiCreateBudget(authApi, { clientId: client.id, activityIds: [activity.id] });

    // §3 front 3 — a tela de quem edita orçamento e não tem `budgets.community`.
    await withoutPermissions(authPage, ['budgets.community']);

    await authPage.goto(`/app/budgets/${community.id}`);
    await expect(authPage.getByTestId('budget-form-locked')).toContainText(
      'Só quem tem a permissão de ação comunitária edita este orçamento',
    );
    await expect(authPage.getByTestId('budget-form-community'), 'sem o toggle').toHaveCount(0);
    await expect(authPage.getByTestId('budget-form-confirm-community'), 'sem "Confirmar ação"').toHaveCount(0);
    await expect(authPage.getByTestId('budget-form-accept'), 'sem "Fechar orçamento"').toHaveCount(0);
    await expect(authPage.getByTestId('budget-form-save'), 'só leitura').toBeDisabled();

    await authPage.goto('/app/budgets/list');
    await expect(authPage.getByTestId(`budgets-community-chip-${community.id}`)).toHaveText(/Comunitário/);
    await expect(authPage.getByTestId(`budgets-duplicate-${charged.id}`), 'o pago segue com "Duplicar"').toBeVisible();
    await expect(authPage.getByTestId(`budgets-duplicate-${community.id}`), 'o comunitário sem "Duplicar"').toHaveCount(0);

    // As chamadas diretas, com um usuário real sem `budgets.community`.
    const body = budgetRequestBody(communityInput);
    delete body.clientId;
    const financial = await loginAsRole(tenant.tenantId, 'Financial');
    try {
      const calls: Array<[string, () => ReturnType<APIRequestContext['post']>]> = [
        ['confirm-community', () => financial.api.post(`/api/budgets/${community.id}/confirm-community`)],
        ['accept', () => financial.api.post(`/api/budgets/${community.id}/accept`)],
        ['PUT', () => financial.api.put(`/api/budgets/${community.id}`, { data: body })],
        ['duplicate', () => financial.api.post(`/api/budgets/${community.id}/duplicate`)],
      ];
      for (const [label, call] of calls) {
        expect((await call()).status(), `${label} sem budgets.community`).toBe(403);
      }
    } finally {
      await financial.api.dispose();
    }
    expect(((await apiGetBudget(authApi, community.id)) as unknown as BudgetView).status, 'nada mudou').toBe('Draft');

    // Orçamento de outro tenant: 404.
    const other = await signupNewTenant();
    const otherApi = await createBearerApiContext(other.accessToken);
    try {
      const calls: Array<[string, () => ReturnType<APIRequestContext['post']>]> = [
        ['GET', () => otherApi.get(`/api/budgets/${community.id}`)],
        ['confirm-community', () => otherApi.post(`/api/budgets/${community.id}/confirm-community`)],
        ['accept', () => otherApi.post(`/api/budgets/${community.id}/accept`)],
        ['PUT', () => otherApi.put(`/api/budgets/${community.id}`, { data: body })],
        ['duplicate', () => otherApi.post(`/api/budgets/${community.id}/duplicate`)],
      ];
      for (const [label, call] of calls) {
        expect((await call()).status(), `${label} de outro tenant`).toBe(404);
      }
    } finally {
      await otherApi.dispose();
    }
  });

  test('E7 @flow link público do comunitário mostra "sem custo para vocês"; a resposta e o PDF não trazem subtotal, equipe, deslocamento nem valor por item', async ({
    authApi,
    page,
  }) => {
    test.setTimeout(180_000);
    const client = await apiCreateClient(authApi, { name: `Escola Estadual E2E ${uid()}` });
    // Valores com centavos próprios, para a busca no PDF não casar por acaso.
    const activity = await apiCreateActivity(authApi, { pricePerChild: 13.37 });
    const budget = await apiCreateBudget(authApi, {
      clientId: client.id,
      activityIds: [activity.id],
      eventDate: tenantDay(20),
      chargeMode: 'Community',
      displacementFee: 87.35,
      teamPricePerCollaborator: 211.11,
    });
    const internal = (await apiGetBudget(authApi, budget.id)) as unknown as BudgetView;
    expect(internal.subtotal, 'o valor de referência existe por dentro').toBeGreaterThan(0);
    expect(internal.teamCost).toBeGreaterThan(0);
    expect(internal.displacementFee).toBeCloseTo(87.35, 2);
    const itemPrices = internal.items.map((i) => i.unitPrice).filter((v) => v > 0);
    const hidden = [internal.subtotal, internal.teamCost, internal.displacementFee, ...itemPrices];

    const sent = await apiSendBudget(authApi, budget.id);
    const token = extractTokenFromPublicUrl(sent.publicUrl);

    // §3 item 6 — a resposta da rota anônima sai com todo valor zerado.
    const pub = (await withPublicApi((api) => apiGetPublicBudget(api, token))) as unknown as Record<string, unknown> & {
      isCommunity: boolean;
      items: Array<{ lineTotal: number }>;
    };
    expect(pub.isCommunity).toBe(true);
    for (const field of [
      'packageTotal',
      'itemsTotal',
      'teamCost',
      'displacementFee',
      'subtotal',
      'discountApplied',
      'additionalTotal',
      'total',
      'totalPerOccurrence',
    ]) {
      expect(pub[field], `${field} na resposta pública`).toBe(0);
    }
    expect(pub.items.length, 'as linhas continuam listadas').toBeGreaterThan(0);
    for (const item of pub.items) expect(item.lineTotal, 'valor da linha').toBe(0);

    // A página mostra "sem custo para vocês" e nenhum dos valores.
    await page.goto(`/budgets/${token}`);
    await expect(page.getByTestId('public-budget-community')).toContainText('sem custo para vocês');
    const pageText = compactText(await page.locator('body').innerText());
    for (const value of hidden) {
      expect(pageText, `a página não traz ${ptBrNumber(value)}`).not.toContain(compactText(ptBrNumber(value)));
    }

    // O PDF (público e interno) renderiza o mesmo DTO: sem os valores.
    const publicPdf = await withPublicApi(async (api) => {
      const res = await api.get(`/api/public/budgets/${token}/pdf`);
      await assertOk(res, 'GET /api/public/budgets/{token}/pdf');
      return res.body();
    });
    const internalPdfRes = await authApi.get(`/api/budgets/${budget.id}/pdf`);
    await assertOk(internalPdfRes, 'GET /api/budgets/{id}/pdf');
    const internalPdf = await internalPdfRes.body();
    for (const [label, pdf] of [['público', publicPdf], ['interno', internalPdf]] as const) {
      const text = compactText(pdfText(pdf));
      expect(text, `PDF ${label} legível (traz o cliente)`).toContain(compactText(client.name as string));
      for (const value of hidden) {
        expect(text, `PDF ${label} sem ${ptBrNumber(value)}`).not.toContain(compactText(ptBrNumber(value)));
      }
    }
  });
});
