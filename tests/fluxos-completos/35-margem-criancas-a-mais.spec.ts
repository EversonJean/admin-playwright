import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCompleteOnboarding, apiSetAiFeature, apiSetSettingParameter } from '../../helpers/api-entities';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';
import {
  MARGIN_CHILDREN,
  MATERIAL_MARGIN_SETTING_KEY,
  activeReservationOf,
  adminChecklistUrl,
  apiGetMaterialLines,
  apiGetMaterialMargin,
  apiPurchase,
  apiShortageOf,
  apiStockBalance,
  checklistItemOf,
  completeWithLeader,
  openChecklistTab,
  openMaterialsTab,
  setupMarginParty,
} from '../../helpers/material-margin';
import { assertOk, readJson } from '../../helpers/response';

/**
 * Fluxo completo 31 — Margem de crianças a mais, da reserva à baixa
 * Diagrama: — (o plano é a fonte: PLANO-ESTOQUE-DO-RECREADOR §6.1 regras 3 e 5,
 * §6.2 itens 2 e 3; ER-D, Etapa 334)
 *
 * E6: com 10% de margem da empresa, a festa de 20 crianças reserva material
 * para 22 e a lista de compras sobe junto; o que levar mostra "+2 crianças"; ao
 * concluir, debita só o de 20 e a margem volta ao disponível.
 *
 * Material: consumível a 1 un. por criança, perda 0. Dois produtos na mesma
 * atividade: um com estoque (reserva e baixa) e um com 1 unidade só, para
 * entrar na lista de compras (que só lista produto rastreado e em falta).
 */

const SHOPPING_LIST_AI = 'ai_shopping_list';
const PERCENT = 10;
const EXTRA = Math.ceil((MARGIN_CHILDREN * PERCENT) / 100); // 2

test.describe('Fluxo completo 31 — Margem de crianças a mais', () => {
  test('@flow E6: with a 10% company margin, the 20-children party reserves material for 22 and the shopping list follows; the list shows "+2 crianças"; completing deducts only the 20 and the margin returns to available', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(300_000);
    await apiCompleteOnboarding(authApi);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_stock');
    await apiSetAiFeature(authApi, SHOPPING_LIST_AI, true);
    await apiSetSettingParameter(authApi, MATERIAL_MARGIN_SETTING_KEY, PERCENT);

    const party = await setupMarginParty(authApi, { extraProducts: 1 });
    const stocked = party.product;
    const toBuy = party.extraProducts[0]!;
    await apiPurchase(authApi, stocked.id, 100);
    await apiPurchase(authApi, toBuy.id, 1);

    // A margem da festa vem do percentual da empresa: ceil(20 x 10%) = 2.
    const margin = await apiGetMaterialMargin(authApi, party.eventId);
    expect(margin).toMatchObject({
      childrenCount: MARGIN_CHILDREN,
      extraChildren: EXTRA,
      marginSource: 'Tenant',
      extraChildrenOverride: null,
      tenantPercent: PERCENT,
    });

    // Previsto x levar: o previsto segue em 20, o que levar sobe para 22.
    const line = (await apiGetMaterialLines(authApi, party.eventId)).find((l) => l.productId === stocked.id)!;
    expect(line.predictedQty).toBeCloseTo(MARGIN_CHILDREN, 3);
    expect(line.marginQty).toBeCloseTo(EXTRA, 3);
    expect(line.qtyToTake).toBeCloseTo(MARGIN_CHILDREN + EXTRA, 3);

    // A reserva conta a margem (regra 3).
    await expect
      .poll(() => activeReservationOf(authApi, party.eventId, stocked.id), { timeout: 30_000 })
      .toBeCloseTo(MARGIN_CHILDREN + EXTRA, 3);
    const reserved = await apiStockBalance(authApi, stocked.id);
    expect(reserved.current).toBeCloseTo(100, 3);
    expect(reserved.reserved).toBeCloseTo(MARGIN_CHILDREN + EXTRA, 3);
    expect(reserved.available).toBeCloseTo(100 - MARGIN_CHILDREN - EXTRA, 3);

    // O painel de faltas também.
    const shortage = await apiShortageOf(authApi, party.eventId, stocked.id);
    expect(shortage.extraChildren).toBe(EXTRA);
    expect(shortage.predictedQty).toBeCloseTo(MARGIN_CHILDREN + EXTRA, 3);

    // A lista de compras sobe junto: a demanda do produto é a de 22 crianças.
    const recalc = await authApi.post('/api/ai/shopping-list/recalculate', { timeout: 120_000 });
    await assertOk(recalc, 'POST /api/ai/shopping-list/recalculate');
    const shopping = await readJson<{ items: Array<{ productId: string; demand: number }> }>(recalc);
    const demand = shopping.items.find((i) => i.productId === toBuy.id);
    expect(demand, 'o produto em falta entra na lista de compras').toBeDefined();
    expect(Number(demand!.demand)).toBeCloseTo(MARGIN_CHILDREN + EXTRA, 3);

    // A lista "o que levar" leva 22 e marca "+2 crianças".
    const item = await checklistItemOf(authApi, adminChecklistUrl(party.eventId), stocked.id);
    expect(item, 'item do material na lista principal').toBeDefined();
    expect(Number(item!.quantity)).toBeCloseTo(MARGIN_CHILDREN + EXTRA, 3);
    expect(item!.marginChildren).toBe(EXTRA);

    await openMaterialsTab(authPage, party.eventId);
    await expect(authPage.getByTestId('material-margin-strip')).toContainText(
      `Levando material para ${MARGIN_CHILDREN + EXTRA} crianças`,
    );
    await expect(authPage.getByTestId('material-margin-strip')).toContainText(
      `(${MARGIN_CHILDREN} + ${EXTRA} de margem, ${PERCENT}% da empresa)`,
    );
    await expect(authPage.getByTestId(`materials-qty-to-take-${line.id}`)).toContainText(`${MARGIN_CHILDREN + EXTRA}`);

    await openChecklistTab(authPage, party.eventId, item!.id);
    await expect(authPage.getByTestId(`material-checklist-item-qty-${item!.id}`)).toContainText(
      `${MARGIN_CHILDREN + EXTRA}`,
    );
    await expect(authPage.getByTestId(`material-checklist-item-margin-${item!.id}`)).toHaveText(`+${EXTRA} crianças`);

    // Concluir debita só o previsto (20) e solta a reserva inteira, margem junto (regra 5).
    await completeWithLeader(authApi, party.eventId);
    const after = await apiStockBalance(authApi, stocked.id);
    expect(after.current, 'baixa só do previsto').toBeCloseTo(100 - MARGIN_CHILDREN, 3);
    expect(after.reserved, 'a margem sai da reserva').toBeCloseTo(0, 3);
    expect(after.available, 'a margem volta ao disponível').toBeCloseTo(100 - MARGIN_CHILDREN, 3);
    expect(await activeReservationOf(authApi, party.eventId, stocked.id)).toBeCloseTo(0, 3);
  });
});
