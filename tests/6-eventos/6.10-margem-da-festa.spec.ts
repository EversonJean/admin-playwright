import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCompleteOnboarding } from '../../helpers/api-entities';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';
import {
  MARGIN_CHILDREN,
  activeReservationOf,
  adjustMarginInUi,
  adminChecklistUrl,
  apiGetMaterialLines,
  apiGetMaterialMargin,
  apiPurchase,
  apiShortageOf,
  checklistItemOf,
  openChecklistTab,
  openMaterialsTab,
  portalChecklistUrl,
  putMaterialMargin,
  setupMarginParty,
} from '../../helpers/material-margin';
import { setupConfirmedPortalCollaborator } from '../../helpers/rain-plan';
import { openSessionPage } from '../../helpers/setup-flows';
import { snack } from '../../helpers/ui';

/**
 * Fluxo: 6.10 — Margem de crianças a mais nesta festa
 * Diagrama: — (o plano é a fonte: PLANO-ESTOQUE-DO-RECREADOR §6.1 regras 3, 4,
 * 7 e 9; §6.2 itens 2 a 4; ER-D, Etapa 334)
 *
 * E14: o gestor ajusta a margem só desta festa ("Ajustar nesta festa": 5
 * crianças a mais, depois "sem margem"): a faixa, a coluna "Levar", a reserva e
 * a lista "o que levar" com "+5 crianças" mudam no admin; o recreador escalado
 * vê a mesma marca no Portal, sem poder editar; o painel de faltas diz que
 * inclui a margem; o custo da aba segue no previsto.
 *
 * A empresa fica sem margem (percentual padrão 0): o que muda vem só do ajuste
 * da festa. Consumível a 1 un. por criança, R$ 1,50 a unidade (custo de 20 =
 * R$ 30,00).
 */

const EXTRA = 5;
const WITH_MARGIN = MARGIN_CHILDREN + EXTRA;

test.describe('Fluxo 6.10 — Margem da festa', () => {
  test('@flow E14: "Ajustar nesta festa" with 5 extra children, then "sem margem", changes the strip, the "Levar" column, the reservation and the "+5 crianças" mark in the admin; the assigned collaborator sees the same mark in the Portal without editing; the shortage panel says it includes the margin; the tab cost stays on the forecast', async ({
    authApi,
    authPage,
    browser,
    tenant,
  }) => {
    test.setTimeout(300_000);
    await apiCompleteOnboarding(authApi);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_stock');
    const party = await setupMarginParty(authApi);
    const productId = party.product.id;
    await apiPurchase(authApi, productId, 100);
    const ana = await setupConfirmedPortalCollaborator(authApi, tenant.tenantId, party.eventId);

    try {
      // Sem margem na empresa: a faixa diz 20 e não há coluna "Levar".
      await openMaterialsTab(authPage, party.eventId);
      const strip = authPage.getByTestId('material-margin-strip');
      await expect(strip).toContainText(`Levando material para ${MARGIN_CHILDREN} crianças`);
      await expect(strip).toContainText('(sem margem)');
      await expect(authPage.getByRole('columnheader', { name: 'Levar', exact: true })).toHaveCount(0);
      await expect
        .poll(() => activeReservationOf(authApi, party.eventId, productId), { timeout: 30_000 })
        .toBeCloseTo(MARGIN_CHILDREN, 3);

      // "Ajustar nesta festa": 5 crianças a mais.
      await adjustMarginInUi(authPage, EXTRA);
      await expect(snack(authPage, 'Margem de crianças a mais atualizada.')).toBeVisible({ timeout: 20_000 });
      await expect(strip).toContainText(`Levando material para ${WITH_MARGIN} crianças`);
      await expect(strip).toContainText(`(${MARGIN_CHILDREN} + ${EXTRA} de margem, ajustada nesta festa)`);
      expect(await apiGetMaterialMargin(authApi, party.eventId)).toMatchObject({
        childrenCount: MARGIN_CHILDREN,
        extraChildren: EXTRA,
        marginSource: 'Event',
        extraChildrenOverride: EXTRA,
      });

      // Coluna "Levar" com 25; o custo continua sobre o previsto de 20 (regra 4).
      const line = (await apiGetMaterialLines(authApi, party.eventId)).find((l) => l.productId === productId)!;
      expect(line.predictedQty).toBeCloseTo(MARGIN_CHILDREN, 3);
      expect(line.marginQty).toBeCloseTo(EXTRA, 3);
      expect(line.qtyToTake).toBeCloseTo(WITH_MARGIN, 3);
      expect(line.totalCost, 'custo sobre o previsto').toBeCloseTo(MARGIN_CHILDREN * 1.5, 2);
      await expect(authPage.getByRole('columnheader', { name: 'Levar', exact: true })).toBeVisible();
      await expect(authPage.getByTestId(`materials-qty-to-take-${line.id}`)).toContainText(`${WITH_MARGIN}`);
      await expect(authPage.getByTestId('materials-total-cost')).toContainText(/R\$\s*30,00/);
      await expect(authPage.getByTestId('materials-cost-without-margin')).toBeVisible();

      // A reserva e o painel de faltas contam a margem, e o painel diz isso.
      await expect
        .poll(() => activeReservationOf(authApi, party.eventId, productId), { timeout: 30_000 })
        .toBeCloseTo(WITH_MARGIN, 3);
      const shortage = await apiShortageOf(authApi, party.eventId, productId);
      expect(shortage.extraChildren).toBe(EXTRA);
      expect(shortage.predictedQty).toBeCloseTo(WITH_MARGIN, 3);
      await expect(authPage.getByTestId('event-stock-includes-margin')).toContainText(
        `Inclui margem de crianças a mais (+${EXTRA} crianças)`,
      );

      // A lista "o que levar" do admin: 25 com "+5 crianças".
      await expect
        .poll(async () => (await checklistItemOf(authApi, adminChecklistUrl(party.eventId), productId))?.marginChildren ?? null, {
          timeout: 30_000,
        })
        .toBe(EXTRA);
      const item = (await checklistItemOf(authApi, adminChecklistUrl(party.eventId), productId))!;
      expect(Number(item.quantity)).toBeCloseTo(WITH_MARGIN, 3);
      await openChecklistTab(authPage, party.eventId, item.id);
      await expect(authPage.getByTestId(`material-checklist-item-qty-${item.id}`)).toContainText(`${WITH_MARGIN}`);
      await expect(authPage.getByTestId(`material-checklist-item-margin-${item.id}`)).toHaveText(`+${EXTRA} crianças`);

      // O recreador escalado vê a mesma marca no Portal e não edita a margem.
      const portalItem = (await checklistItemOf(ana.portal.api, portalChecklistUrl(party.eventId), productId))!;
      expect(portalItem.marginChildren).toBe(EXTRA);
      expect(Number(portalItem.quantity)).toBeCloseTo(WITH_MARGIN, 3);
      const view = await openSessionPage(browser, ana.portal.tokens);
      try {
        await view.page.goto(`/portal/events/${party.eventId}/material-checklist`);
        await expect(view.page.getByTestId(`portal-material-item-${portalItem.id}`)).toBeVisible({ timeout: 20_000 });
        await expect(view.page.getByTestId(`portal-material-item-qty-${portalItem.id}`)).toContainText(`${WITH_MARGIN}`);
        await expect(view.page.getByTestId(`portal-material-item-margin-${portalItem.id}`)).toHaveText(
          `+${EXTRA} crianças`,
        );
        await expect(view.page.getByTestId('material-margin-adjust')).toHaveCount(0);
      } finally {
        await view.context.close();
      }
      const byPortal = await putMaterialMargin(ana.portal.api, party.eventId, 0);
      expect(byPortal.ok(), `o Portal não altera a margem (${byPortal.status()})`).toBe(false);
      expect((await apiGetMaterialMargin(authApi, party.eventId)).extraChildrenOverride).toBe(EXTRA);

      // "Sem margem nesta festa": tudo volta ao previsto de 20.
      await openMaterialsTab(authPage, party.eventId);
      await adjustMarginInUi(authPage, 'none');
      await expect(snack(authPage, 'Margem de crianças a mais atualizada.')).toBeVisible({ timeout: 20_000 });
      await expect(strip).toContainText(`Levando material para ${MARGIN_CHILDREN} crianças`);
      await expect(strip).toContainText('(sem margem nesta festa)');
      expect(await apiGetMaterialMargin(authApi, party.eventId)).toMatchObject({
        extraChildren: 0,
        extraChildrenOverride: 0,
      });
      await expect(authPage.getByRole('columnheader', { name: 'Levar', exact: true })).toHaveCount(0);
      await expect(authPage.getByTestId('event-stock-includes-margin')).toHaveCount(0);
      await expect
        .poll(() => activeReservationOf(authApi, party.eventId, productId), { timeout: 30_000 })
        .toBeCloseTo(MARGIN_CHILDREN, 3);
      expect((await apiShortageOf(authApi, party.eventId, productId)).extraChildren).toBe(0);
      await expect
        .poll(async () => {
          const i = await checklistItemOf(authApi, adminChecklistUrl(party.eventId), productId);
          return { margin: i?.marginChildren ?? null, quantity: Number(i?.quantity) };
        }, { timeout: 30_000 })
        .toEqual({ margin: null, quantity: MARGIN_CHILDREN });
      await openChecklistTab(authPage, party.eventId, item.id);
      await expect(authPage.getByTestId(`material-checklist-item-margin-${item.id}`)).toHaveCount(0);
    } finally {
      await ana.portal.api.dispose();
    }
  });
});
