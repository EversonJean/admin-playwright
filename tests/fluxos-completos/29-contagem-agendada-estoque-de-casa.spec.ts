import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiListNotifications, apiSetSettingParameter } from '../../helpers/api-entities';
import { enableFeatureFlagDirect, seedWhatsappChannelDirect } from '../../helpers/db-helper';
import { fakeWhatsApp } from '../../helpers/fake-providers';
import {
  MyStockCount,
  apiApproveAllPending,
  apiGetMyStock,
  apiGetStockCount,
  apiGetStockLocationItem,
  apiListStockCounts,
  backdateStockLocationCreatedAtDirect,
  setupHomeStock,
} from '../../helpers/home-stock';
import { TRIGGER_TIMEOUT, apiTriggerDailyJob, tenantDayPlus } from '../../helpers/rain-plan';
import { readJson } from '../../helpers/response';
import { openSessionPage } from '../../helpers/setup-flows';

/**
 * Fluxo: 29 — Contagem agendada do estoque de casa pelo ciclo diário de avisos
 * Diagrama: — (o plano é a fonte: PLANO-ESTOQUE-DO-RECREADOR §4.1, ER-B;
 * regras 2, 4 e 5; decisões 3 e 11)
 *
 * E8: com o intervalo ligado, o ciclo diário de avisos abre a contagem da casa
 * do recreador com material e acesso ao Portal; ele recebe o aviso no sino e o
 * WhatsApp pelo fake, responde pelo Portal com uma diferença e envia; o gestor
 * recebe o aviso, revisa e o saldo da casa muda; a casa de quem não tem Portal
 * não abre contagem.
 */

const INTERVAL_DAYS = 30;
const DUE_DAYS = 7;

test.describe('Fluxo 29 — Contagem agendada do estoque de casa', () => {
  test('@flow E8: with the interval on, the daily cycle opens the count of the home with stock and Portal access, notifies by bell and WhatsApp; the collaborator answers a difference in the Portal and sends; the manager is notified, reviews and the home balance changes; the home of a collaborator without Portal gets no count', async ({
    authApi,
    browser,
    tenant,
  }) => {
    test.setTimeout(TRIGGER_TIMEOUT + 300_000);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_whatsapp');
    const phoneNumberId = seedWhatsappChannelDirect(tenant.tenantId);
    await apiSetSettingParameter(authApi, 'STOCK_HOME_COUNT_INTERVAL_DAYS', INTERVAL_DAYS);
    await apiSetSettingParameter(authApi, 'STOCK_HOME_COUNT_DUE_DAYS', DUE_DAYS);

    // A casa com Portal e a casa sem Portal, as duas com saldo e sem contagem há mais que o intervalo.
    const phone = `+55419${String(Date.now()).slice(-7)}7`;
    const ana = await setupHomeStock(authApi, tenant.tenantId, {
      firstName: 'Ana',
      phone,
      products: [{ quantity: 5, isReusable: true, unitCost: 20 }],
    });
    const bia = await setupHomeStock(authApi, tenant.tenantId, { firstName: 'Bia', withPortal: false });
    for (const h of [ana, bia]) backdateStockLocationCreatedAtDirect(h.locationId, INTERVAL_DAYS + 1);
    const ball = ana.products[0]!;
    const portal = ana.portal!;

    // A recreadora já falou com o número da empresa: a janela de 24 h está aberta e o texto livre sai.
    const hook = await fakeWhatsApp.triggerWebhook({ kind: 'inbound', phoneNumberId, phone, text: 'Oi, sou da equipe' });
    expect(hook.backStatus, `webhook inbound: ${hook.backBody}`).toBe(200);

    try {
      expect((await portal.api.get('/api/portal/my-stock/counts/current')).status(), 'antes do ciclo').toBe(204);

      // §4.1 regra 2: o ciclo diário abre a contagem (`Origin = Schedule`, prazo hoje + DUE_DAYS).
      await apiTriggerDailyJob(authApi);

      const currentRes = await portal.api.get('/api/portal/my-stock/counts/current');
      expect(currentRes.status(), 'a contagem aberta pelo ciclo').toBe(200);
      const current = await readJson<MyStockCount>(currentRes);
      expect(current.kind).toBe('FullCount');
      expect(current.status).toBe('Open');
      expect(current.dueOn).toBe(tenantDayPlus(DUE_DAYS));
      expect(current.lines.map((l) => l.productId)).toEqual([ball.id]);
      expect(current.lines[0]!.countedQuantity).toBeNull();
      expect(current.lines[0]!.currentSystemQuantity, 'decisão 3: o saldo do sistema à vista').toBe(5);
      expect((await apiGetStockCount(authApi, current.id)).origin).toBe('Schedule');

      // O aviso no sino do Portal...
      await expect
        .poll(async () =>
          (await apiListNotifications(portal.api)).filter(
            (n) => n.type === 'StockCountRequested' && n.contextEntityId === current.id,
          ).length,
        )
        .toBe(1);
      const requested = (await apiListNotifications(portal.api)).find(
        (n) => n.type === 'StockCountRequested' && n.contextEntityId === current.id,
      )!;
      expect(requested.message).toContain('Hora de conferir o material que está com você. Prazo:');

      // ... e o WhatsApp pelo fake, no telefone da recreadora.
      const digits = phone.replace(/\D/g, '');
      await expect
        .poll(async () =>
          (await fakeWhatsApp.inbox({ path: '/messages' }))
            .map((e) => JSON.stringify(e.body))
            .filter((body) => body.includes(digits) && body.includes('Hora de conferir o material')).length,
        )
        .toBeGreaterThan(0);

      // A casa de quem não tem Portal não abre contagem.
      expect(await apiListStockCounts(authApi, { status: 'Open', locationId: bia.locationId })).toHaveLength(0);
      const biaLocation = await apiGetStockLocationItem(authApi, bia.locationId);
      expect(biaLocation.activeCountId).toBeNull();
      expect(biaLocation.collaboratorHasPortal).toBe(false);

      // §4.2 item 2: a recreadora responde pelo Portal com uma diferença e envia.
      const view = await openSessionPage(browser, portal.tokens);
      try {
        await view.page.goto(`/portal/my-stock/count/${current.id}`);
        await expect(view.page.getByTestId(`portal-my-stock-count-row-${ball.id}`)).toBeVisible({ timeout: 20_000 });
        await view.page.getByTestId(`portal-my-stock-count-different-${ball.id}`).click();
        await view.page.getByTestId(`portal-my-stock-count-counted-${ball.id}`).fill('4');
        await view.page.getByTestId(`portal-my-stock-count-reason-${ball.id}`).click();
        await view.page.getByRole('option', { name: 'Perdi', exact: true }).click();
        const submit = view.page.getByTestId('portal-my-stock-count-submit');
        await expect(submit).toBeEnabled({ timeout: 20_000 });
        await submit.click();
        await expect(view.page.getByTestId('portal-my-stock-count-sent')).toContainText(
          `Contagem #${current.number} enviada ao gestor.`,
          { timeout: 20_000 },
        );
      } finally {
        await view.context.close();
      }

      // §4.1 regra 5: o aviso 40 ao gestor, com o número de diferenças.
      await expect
        .poll(async () =>
          (await apiListNotifications(authApi)).filter(
            (n) => n.type === 'StockCorrectionSubmitted' && n.contextEntityId === current.id,
          ).length,
        )
        .toBe(1);
      const submittedNotice = (await apiListNotifications(authApi)).find(
        (n) => n.type === 'StockCorrectionSubmitted' && n.contextEntityId === current.id,
      )!;
      expect(submittedNotice.message).toContain(`${ana.firstName} enviou a contagem do estoque de casa: 1 diferença.`);

      const submitted = await apiGetStockCount(authApi, current.id);
      expect(submitted.status).toBe('Submitted');
      const line = submitted.lines.find((l) => l.productId === ball.id)!;
      expect(line.difference).toBe(-1);
      expect(line.reason).toBe('Lost');
      expect((await apiGetMyStock(portal.api)).items.find((i) => i.productId === ball.id)!.quantity).toBe(5);

      // O gestor revisa e o saldo da casa muda.
      const reviewed = await apiApproveAllPending(authApi, current.id);
      expect(reviewed.status).toBe('Reviewed');
      expect(reviewed.lines.find((l) => l.id === line.id)!.appliedQuantity).toBe(1);
      expect((await apiGetMyStock(portal.api)).items.find((i) => i.productId === ball.id)!.quantity).toBe(4);
      expect((await apiGetStockLocationItem(authApi, ana.locationId)).lastReviewedCountAt).toBeTruthy();

      await expect
        .poll(async () =>
          (await apiListNotifications(portal.api)).filter(
            (n) => n.type === 'StockCorrectionReviewed' && n.contextEntityId === current.id,
          ).length,
        )
        .toBe(1);
      const reviewedNotice = (await apiListNotifications(portal.api)).find(
        (n) => n.type === 'StockCorrectionReviewed' && n.contextEntityId === current.id,
      )!;
      expect(reviewedNotice.message).toContain('O gestor revisou sua contagem: 1 aprovada.');
    } finally {
      await portal.api.dispose();
    }
  });
});
