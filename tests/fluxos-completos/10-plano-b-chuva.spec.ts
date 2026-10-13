import { APIRequestContext } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { twoTenantsTest } from '../../fixtures/two-tenants.fixture';
import { createApiContext, createBearerApiContext, loginViaApi } from '../../helpers/api-client';
import {
  apiCompleteOnboarding,
  apiCreateCollaborator,
  apiCreateProduct,
  apiListNotifications,
  apiSetAiFeature,
  apiSetCollaboratorStatus,
  apiSetSettingParameter,
} from '../../helpers/api-entities';
import {
  apiAssignCollaborator,
  apiCompleteEvent,
  apiConfirmCollaborator,
  apiCreatePublicEvent,
  apiStartEvent,
} from '../../helpers/api-event-flow';
import {
  enableFeatureFlagDirect,
  execSql,
  seedOpenAirFormDataDirect,
  seedWhatsappChannelDirect,
  setEventAddressDirect,
  setSubscriptionPlanDirect,
} from '../../helpers/db-helper';
import { fakeWhatsApp } from '../../helpers/fake-providers';
import {
  RainActivity,
  TRIGGER_TIMEOUT,
  apiActivateRainPlan,
  apiCreateRainActivity,
  apiDeactivateRainPlan,
  apiGetMaterialChecklist,
  apiGetRainPlan,
  apiPutRainPlan,
  apiSetOpenAirVenue,
  apiSetShelteredVenue,
  apiTriggerDailyJob,
  captureClipboard,
  copiedText,
  openRainPlanTab,
  rainyDay,
  setupConfirmedPortalCollaborator,
  setupRainParty,
  tenantDayPlus,
  uniqueSuffix,
} from '../../helpers/rain-plan';
import { apiErrorCodes, assertOk, readJson, unwrapList } from '../../helpers/response';
import { loginAsRole, openSessionPage } from '../../helpers/setup-flows';

/**
 * Fluxo completo 10 — Plano B de chuva, da montagem ao dia da festa
 * Plano: docs/implementados/PLANO-PLANO-B-DE-CHUVA.md (§5 PB-C, §6 PB-D, §8 PB-F;
 * Etapas 224, 225 e 227). Registro e2e: E5, E7, E9, E22, E25, E27, E36, E37, E38.
 *
 * Sem diagrama `.mmd`: verificação de plano.
 *
 * Clima: o fake do back chove só AMANHÃ (`Weather:FakeRainyDayOffsets = [1]`,
 * 85% das 12h às 18h); a festa de `setupRainParty` é amanhã, das 14h às 18h.
 * O aviso de chuva e o lembrete D-N do material rodam na varredura diária
 * (`POST /api/notifications/trigger-overdue`, o gatilho manual dela).
 *
 * Estoque (PB-F): material em "unidades por criança", com 10 crianças, para as
 * contas ficarem legíveis. Onde a projeção de demanda aplica o desperdício do
 * tenant, o spec compara com um produto só da lista principal (mesma conta).
 */

const SHOPPING_LIST_AI = 'ai_shopping_list';
const CONTROL_TOWER_AI = 'ai_control_tower';
const BRIEFING_AI = 'ai_collaborator_briefing';
const CHILDREN = 10;

interface StockProducts {
  shared: { id: string; name: string };
  mainOnly: { id: string; name: string };
  rainOnly: { id: string; name: string };
}

/**
 * Três produtos: um que a contratada e a do Plano B usam, um só da contratada
 * e um só da do Plano B. A contratada é "só ao ar livre"; a do Plano B, para
 * local fechado.
 */
async function stockCatalog(api: APIRequestContext): Promise<{
  products: StockProducts;
  contracted: RainActivity;
  rainActivity: RainActivity;
}> {
  const s = uniqueSuffix();
  const shared = await apiCreateProduct(api, { name: `Bexiga ${s}` });
  const mainOnly = await apiCreateProduct(api, { name: `Giz de calçada ${s}` });
  const rainOnly = await apiCreateProduct(api, { name: `Massinha ${s}` });
  const contracted = await apiCreateRainActivity(api, `Caça ao tesouro ${s}`, {
    indoorSuitability: 'OutdoorOnly',
    activityProducts: [
      { productId: shared.id, qtyPerChild: 1, isChecklistOnly: false },
      { productId: mainOnly.id, qtyPerChild: 1, isChecklistOnly: false },
    ],
  });
  const rainActivity = await apiCreateRainActivity(api, `Oficina de massinha ${s}`, {
    indoorSuitability: 'Indoor',
    minSquareMetersPerChild: 1,
    activityProducts: [
      { productId: shared.id, qtyPerChild: 1, isChecklistOnly: false },
      { productId: rainOnly.id, qtyPerChild: 1, isChecklistOnly: false },
    ],
  });
  return { products: { shared, mainOnly, rainOnly }, contracted, rainActivity };
}

/** Plano B pronto: a atividade do Plano B no lugar da contratada. */
function readyPlan(api: APIRequestContext, eventId: string, rainActivity: RainActivity, contracted: RainActivity) {
  return apiPutRainPlan(api, eventId, [{ activityId: rainActivity.id, replacesActivityId: contracted.id }]);
}

async function purchase(api: APIRequestContext, productId: string, quantity: number): Promise<void> {
  await assertOk(
    await api.post('/api/stock/movements', {
      data: { productId, type: 'Purchase', quantity, unitCost: 1.5, supplierName: 'Fornecedor E2E' },
    }),
    'POST /api/stock/movements',
  );
}

/**
 * A lista de compras só olha produto "rastreado" (com linha de saldo,
 * `ShoppingListInputRead`): uma unidade de cada, abaixo de toda demanda do teste.
 */
async function trackProducts(api: APIRequestContext, products: StockProducts): Promise<void> {
  for (const p of Object.values(products)) await purchase(api, p.id, 1);
}

interface Reservation {
  productId: string;
  eventId: string | null;
  status: string;
  quantity: number;
}

async function activeReservations(api: APIRequestContext, eventId: string): Promise<Map<string, number>> {
  const res = await api.get(`/api/stock/reservations?eventId=${eventId}&pageSize=100`);
  await assertOk(res, 'GET /api/stock/reservations');
  const rows = (await unwrapList<Reservation>(res)).filter((r) => r.status === 'Active' && r.eventId === eventId);
  const byProduct = new Map<string, number>();
  for (const r of rows) byProduct.set(r.productId, (byProduct.get(r.productId) ?? 0) + Number(r.quantity));
  return byProduct;
}

async function balanceOf(api: APIRequestContext, productId: string) {
  const res = await api.get(`/api/stock/balances/${productId}`);
  await assertOk(res, 'GET /api/stock/balances/{id}');
  const b = await readJson<{ currentBalance: number; reservedQuantity: number; availableQuantity: number }>(res);
  return {
    current: Number(b.currentBalance),
    reserved: Number(b.reservedQuantity),
    available: Number(b.availableQuantity),
  };
}

/** Painel de faltas do evento: o previsto por produto (coberto + faltando). */
async function shortagePredicted(api: APIRequestContext, eventId: string): Promise<Map<string, number>> {
  const res = await api.get(`/api/events/${eventId}/material-shortage`);
  await assertOk(res, 'GET material-shortage');
  const dto = await readJson<{
    covered: Array<{ productId: string; predictedQty: number; reservedByOthersQty: number }>;
    missing: Array<{ productId: string; predictedQty: number; reservedByOthersQty: number }>;
  }>(res);
  const map = new Map<string, number>();
  for (const line of [...dto.covered, ...dto.missing]) map.set(line.productId, Number(line.predictedQty));
  return map;
}

/** Consumo previsto do painel de estoque, por produto. */
async function dashboardPredicted(api: APIRequestContext): Promise<Map<string, number>> {
  const res = await api.get('/api/stock/dashboard');
  await assertOk(res, 'GET /api/stock/dashboard');
  const dto = await readJson<{ upcomingConsumption: Array<{ productId: string; predictedQuantity: number }> }>(res);
  return new Map(dto.upcomingConsumption.map((u) => [u.productId, Number(u.predictedQuantity)]));
}

/** Recalcula a lista de compras (uma vez por hora por tenant) e devolve a demanda por produto. */
async function shoppingDemand(api: APIRequestContext): Promise<Map<string, number>> {
  const res = await api.post('/api/ai/shopping-list/recalculate', { timeout: 120_000 });
  await assertOk(res, 'POST /api/ai/shopping-list/recalculate');
  const dto = await readJson<{ items: Array<{ productId: string; demand: number }> }>(res);
  return new Map(dto.items.map((i) => [i.productId, Number(i.demand)]));
}

/** Escala um líder confirmado, inicia e conclui a festa. */
async function runParty(api: APIRequestContext, eventId: string): Promise<void> {
  const leader = await apiCreateCollaborator(api);
  await apiAssignCollaborator(api, eventId, leader.id, { isLeader: true });
  await apiConfirmCollaborator(api, eventId, leader.id);
  await apiStartEvent(api, eventId);
  await apiCompleteEvent(api, eventId);
}

function ddMm(iso: string): string {
  const [, mm, dd] = iso.split('-');
  return `${dd}/${mm}`;
}

test.describe('Fluxo completo 10 — Plano B de chuva', () => {
  // ───────────────────────────── PB-C (Etapa 224) ─────────────────────────────

  // E5 — §5 itens 1 e 5, "Front".
  test('@flow E5: a rain-plan activity that uses material shows in the "Plano B (chuva)" group of the material list and in the Portal of the assigned collaborator', async ({
    authApi,
    authPage,
    browser,
    tenant,
  }) => {
    test.setTimeout(180_000);
    await apiCompleteOnboarding(authApi);
    const s = uniqueSuffix();
    const lona = await apiCreateProduct(authApi, { name: `Lona ${s}` });
    const rainActivity = await apiCreateRainActivity(authApi, `Mímica ${s}`, {
      indoorSuitability: 'Indoor',
      activityProducts: [{ productId: lona.id, qtyPerChild: 1, isChecklistOnly: false }],
    });
    const party = await setupRainParty(authApi);
    const { portal } = await setupConfirmedPortalCollaborator(authApi, tenant.tenantId, party.eventId);
    await apiPutRainPlan(authApi, party.eventId, [{ activityId: rainActivity.id }]);

    try {
      const checklist = await apiGetMaterialChecklist(authApi, party.eventId);
      const group = checklist.groups.find((g) => g.activityId === rainActivity.id);
      expect(group?.scope).toBe('RainPlan');
      expect(group?.items.map((i) => i.productId)).toContain(lona.id);

      await authPage.goto(`/app/events/${party.eventId}`);
      await authPage.getByRole('tab', { name: 'Checklist', exact: true }).click();
      const rainSection = authPage.getByTestId('material-checklist-rain-plan');
      await expect(rainSection).toBeVisible({ timeout: 20_000 });
      const toggle = authPage.getByTestId('material-checklist-rain-plan-toggle');
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
      await expect(
        authPage.getByTestId('material-checklist-rain-plan-groups').getByTestId(`material-checklist-group-${rainActivity.id}`),
      ).toContainText(lona.name);

      const portalRes = await portal.api.get(`/api/portal/my-events/${party.eventId}/material-checklist`);
      await assertOk(portalRes, 'GET portal material-checklist');
      const portalChecklist = await readJson<{ groups: Array<{ activityId: string; scope: string }> }>(portalRes);
      expect(portalChecklist.groups.find((g) => g.activityId === rainActivity.id)?.scope).toBe('RainPlan');

      const session = await openSessionPage(browser, portal.tokens);
      try {
        await session.page.goto(`/portal/events/${party.eventId}/material-checklist`);
        await expect(session.page.getByTestId('portal-material-rain-plan')).toBeVisible({ timeout: 20_000 });
        const portalToggle = session.page.getByTestId('portal-material-rain-plan-toggle');
        if ((await portalToggle.getAttribute('aria-expanded')) !== 'true') await portalToggle.click();
        await expect(session.page.getByTestId(`portal-material-group-${rainActivity.id}`)).toContainText(lona.name);
      } finally {
        await session.context.close();
      }
    } finally {
      await portal.api.dispose();
    }
  });

  // E22 — §5 item 4 (lembrete D-N com o bloco do Plano B).
  test('@flow E22: the D-2 material reminder of an open-air party with a ready plan reaches WhatsApp and the bell with "Leve também, para o caso de chuva"; with only plan material pending it still goes; covered venue or draft plan get no block', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(TRIGGER_TIMEOUT + 240_000);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_whatsapp');
    const phoneNumberId = seedWhatsappChannelDirect(tenant.tenantId);
    await apiSetSettingParameter(authApi, 'EVENT_MATERIAL_CHECKLIST_REMINDER_DAYS', 2);

    const s = uniqueSuffix();
    const mainProduct = await apiCreateProduct(authApi, { name: `Giz ${s}` });
    const rainProduct = await apiCreateProduct(authApi, { name: `Lona ${s}` });
    const contracted = await apiCreateRainActivity(authApi, `Caça ao tesouro ${s}`, {
      indoorSuitability: 'OutdoorOnly',
      activityProducts: [{ productId: mainProduct.id, qtyPerChild: 1, isChecklistOnly: false }],
    });
    const rainActivity = await apiCreateRainActivity(authApi, `Mímica ${s}`, {
      indoorSuitability: 'Indoor',
      activityProducts: [{ productId: rainProduct.id, qtyPerChild: 1, isChecklistOnly: false }],
    });
    const day = tenantDayPlus(2);

    // 1) Ao ar livre, plano pronto, a principal conferida: só o Plano B pendente.
    const openAir = await setupRainParty(authApi, { eventDate: day, contracted });
    await apiPutRainPlan(authApi, openAir.eventId, [{ activityId: rainActivity.id }]);
    // 2) Coberto, plano pronto, principal pendente.
    const covered = await setupRainParty(authApi, { eventDate: day, contracted, venue: 'Sheltered' });
    await apiPutRainPlan(authApi, covered.eventId, [{ activityId: rainActivity.id }]);
    // 3) Ao ar livre, plano em rascunho, principal pendente.
    const draft = await setupRainParty(authApi, { eventDate: day, contracted });
    await apiPutRainPlan(authApi, draft.eventId, []);

    const checklist = await apiGetMaterialChecklist(authApi, openAir.eventId);
    for (const item of checklist.groups.flatMap((g) => g.items).filter((i) => i.scope === 'Main')) {
      await assertOk(
        await authApi.post(`/api/events/${openAir.eventId}/material-checklist/items/${item.id}/check`, { data: {} }),
        'check principal',
      );
    }
    for (const id of [covered.eventId, draft.eventId]) await apiGetMaterialChecklist(authApi, id);

    // O recreador da festa ao ar livre falou com o número da empresa: a janela de
    // 24 h está aberta e o texto livre (com o bloco do Plano B) sai pelo WhatsApp.
    const phone = `+55419${String(Date.now()).slice(-7)}4`;
    const openAirTeam = await setupConfirmedPortalCollaborator(authApi, tenant.tenantId, openAir.eventId, { phone });
    const coveredTeam = await setupConfirmedPortalCollaborator(authApi, tenant.tenantId, covered.eventId);
    const draftTeam = await setupConfirmedPortalCollaborator(authApi, tenant.tenantId, draft.eventId);
    const hook = await fakeWhatsApp.triggerWebhook({ kind: 'inbound', phoneNumberId, phone, text: 'Oi, sou da equipe' });
    expect(hook.backStatus, `webhook inbound: ${hook.backBody}`).toBe(200);

    try {
      await apiTriggerDailyJob(authApi);

      const reminderOf = async (api: APIRequestContext, eventId: string) =>
        (await apiListNotifications(api)).find(
          (n) => n.type === 'MaterialChecklistPending' && n.contextEntityId === eventId,
        );

      await expect.poll(async () => (await reminderOf(openAirTeam.portal.api, openAir.eventId))?.message ?? '').toContain(
        `Leve também, para o caso de chuva: ${rainProduct.name}`,
      );
      expect((await reminderOf(openAirTeam.portal.api, openAir.eventId))!.message).toContain(
        'A lista de materiais está conferida.',
      );

      const coveredReminder = await reminderOf(coveredTeam.portal.api, covered.eventId);
      expect(coveredReminder, 'coberto: o lembrete sai pela lista principal').toBeTruthy();
      expect(coveredReminder!.message).not.toContain('Leve também, para o caso de chuva');
      const draftReminder = await reminderOf(draftTeam.portal.api, draft.eventId);
      expect(draftReminder, 'rascunho: o lembrete sai pela lista principal').toBeTruthy();
      expect(draftReminder!.message).not.toContain('Leve também, para o caso de chuva');

      const digits = phone.replace(/\D/g, '');
      await expect
        .poll(async () =>
          (await fakeWhatsApp.inbox({ path: '/messages' }))
            .map((e) => JSON.stringify(e.body))
            .filter((body) => body.includes(digits) && body.includes('Leve também, para o caso de chuva')).length,
        )
        .toBeGreaterThan(0);
    } finally {
      for (const team of [openAirTeam, coveredTeam, draftTeam]) await team.portal.api.dispose();
    }
  });

  // ───────────────────────────── PB-D (Etapa 225) ─────────────────────────────

  // E7 — §6 "Previsão e aviso", "Ativação", "Tela", decisão 8.
  test('@flow E7: rainy forecast for tomorrow open-air party with a ready plan warns managers once a day, the party without plan gets "monte agora"; manager activates with reason, the assigned collaborator is told and sees "Plano B ativo desde"; header label, stale playbook and client message', async ({
    authApi,
    authPage,
    browser,
    tenant,
  }) => {
    test.setTimeout(2 * TRIGGER_TIMEOUT + 300_000);
    await apiCompleteOnboarding(authApi);
    await apiSetAiFeature(authApi, BRIEFING_AI, true);
    const s = uniqueSuffix();
    const indoor = await apiCreateRainActivity(authApi, `Mímica ${s}`, { indoorSuitability: 'Indoor' });
    const ready = await setupRainParty(authApi);
    const withoutPlan = await setupRainParty(authApi);
    await apiPutRainPlan(
      authApi,
      ready.eventId,
      [{ activityId: indoor.id, replacesActivityId: ready.contracted.id, groups: 2 }],
      'Usar a garagem',
    );
    const team = await setupConfirmedPortalCollaborator(authApi, tenant.tenantId, ready.eventId);

    // Roteiro publicado antes da chuva: a ativação o marca desatualizado.
    await assertOk(
      await authApi.post(`/api/events/${ready.eventId}/playbook/generate`, { timeout: 120_000 }),
      'POST playbook/generate',
    );
    await assertOk(await authApi.post(`/api/events/${ready.eventId}/playbook/publish`), 'POST playbook/publish');
    const playbook = async () =>
      readJson<{ status: string; isStale: boolean }>(await authApi.get(`/api/events/${ready.eventId}/playbook`));
    expect((await playbook()).status).toBe('Published');
    expect((await playbook()).isStale).toBe(false);

    try {
      await apiTriggerDailyJob(authApi);
      await apiTriggerDailyJob(authApi);

      const warnings = async (eventId: string) =>
        (await apiListNotifications(authApi)).filter(
          (n) => n.type === 'RainPlanSuggested' && n.contextEntityId === eventId,
        );
      await expect.poll(async () => (await warnings(ready.eventId)).length).toBe(1);
      const readyWarning = (await warnings(ready.eventId))[0]!;
      expect(readyWarning.message).toContain('85%');
      expect(readyWarning.message).toContain('Plano B pronto: ative se precisar.');
      const missing = await warnings(withoutPlan.eventId);
      expect(missing, 'um disparo a mais não repete').toHaveLength(1);
      expect(missing[0]!.message).toContain('ainda sem Plano B: monte agora.');

      await captureClipboard(authPage);
      await openRainPlanTab(authPage, ready.eventId);
      await expect(authPage.getByTestId('rain-forecast-summary')).toContainText('85%', { timeout: 20_000 });
      await expect(authPage.getByTestId('rain-forecast-summary')).toContainText(/\d{1,2}h/);
      await expect(authPage.getByTestId('rain-plan-risk-notified')).toBeVisible();

      await authPage.getByTestId('rain-plan-activate').click();
      await authPage.getByTestId('activate-rain-plan-reason').fill('Previsão de 85% de chuva');
      await authPage.getByTestId('activate-rain-plan-confirm').click();
      await expect(authPage.getByTestId('rain-plan-active-since')).toContainText('Plano B ativo desde');
      await expect(authPage.getByTestId('rain-plan-active-reason')).toContainText('Previsão de 85% de chuva');
      await expect(authPage.getByTestId('event-detail-rain-plan-active')).toContainText('Plano B ativo');

      expect((await playbook()).isStale, 'o roteiro publicado fica desatualizado').toBe(true);

      await authPage.getByTestId('rain-plan-copy-client-message').click();
      await expect.poll(() => copiedText(authPage)).toContain(indoor.name);
      const message = await copiedText(authPage);
      expect(message).toContain(`no lugar de ${ready.contracted.name}`);
      expect(message).toContain(ddMm(rainyDay()));
      expect(message).toContain('Usar a garagem');

      await expect
        .poll(async () =>
          (await apiListNotifications(team.portal.api)).some(
            (n) => n.type === 'RainPlanActivated' && n.contextEntityId === ready.eventId,
          ),
        )
        .toBe(true);
      const session = await openSessionPage(browser, team.portal.tokens);
      try {
        await session.page.goto(`/portal/events/${ready.eventId}`);
        await expect(session.page.getByTestId('portal-event-detail-rain-plan-activated-at')).toContainText(
          'Plano B ativo desde',
          { timeout: 20_000 },
        );
      } finally {
        await session.context.close();
      }
    } finally {
      await team.portal.api.dispose();
    }
  });

  // E25 — §6 "Ativação" (desativar) e A17 (auditoria).
  test('@flow E25: deactivating the active plan tells the assigned Portal team and the other managers "Plano B cancelado, segue o plano original", not who deactivated; header and Portal stop showing it; audit has activated and deactivated', async ({
    authApi,
    authPage,
    browser,
    tenant,
  }) => {
    test.setTimeout(180_000);
    await apiCompleteOnboarding(authApi);
    const s = uniqueSuffix();
    const indoor = await apiCreateRainActivity(authApi, `Mímica ${s}`, { indoorSuitability: 'Indoor' });
    const party = await setupRainParty(authApi);
    await apiPutRainPlan(authApi, party.eventId, [{ activityId: indoor.id }]);
    const team = await setupConfirmedPortalCollaborator(authApi, tenant.tenantId, party.eventId);
    const manager = await loginAsRole(tenant.tenantId, 'Manager');

    try {
      await apiActivateRainPlan(authApi, party.eventId, 'Chuva forte');

      await openRainPlanTab(authPage, party.eventId);
      await expect(authPage.getByTestId('event-detail-rain-plan-active')).toBeVisible();
      await authPage.getByTestId('rain-plan-deactivate').click();
      await authPage.getByTestId('confirm-ok').click();
      await expect(authPage.getByTestId('rain-plan-active-banner')).toHaveCount(0);
      await expect(authPage.getByTestId('event-detail-rain-plan-active')).toHaveCount(0);
      expect((await apiGetRainPlan(authApi, party.eventId)).plan!.status).toBe('Ready');

      const canceledTo = async (api: APIRequestContext) =>
        (await apiListNotifications(api)).filter(
          (n) =>
            n.type === 'RainPlanActivated' &&
            n.contextEntityId === party.eventId &&
            n.message.includes('Plano B cancelado, segue o plano original'),
        ).length;
      await expect.poll(() => canceledTo(manager.api), { message: 'outro gestor' }).toBe(1);
      await expect.poll(() => canceledTo(team.portal.api), { message: 'equipe escalada' }).toBe(1);
      expect(await canceledTo(authApi), 'quem desativou não é avisado').toBe(0);

      const session = await openSessionPage(browser, team.portal.tokens);
      try {
        await session.page.goto(`/portal/events/${party.eventId}`);
        await expect(session.page.getByTestId('portal-event-detail-rain-plan')).toBeVisible({ timeout: 20_000 });
        await expect(session.page.getByTestId('portal-event-detail-rain-plan-activated-at')).toHaveCount(0);
        await expect(session.page.getByTestId('portal-event-detail-rain-plan-status')).toHaveText('Se chover');
      } finally {
        await session.context.close();
      }

      const audit = await authApi.get(`/api/audit-logs?entityId=${party.eventId}&pageSize=100`);
      await assertOk(audit, 'GET /api/audit-logs');
      const actions = (await unwrapList<{ action: string }>(audit)).map((l) => l.action);
      expect(actions).toContain('event.rain_plan_activated');
      expect(actions).toContain('event.rain_plan_deactivated');
    } finally {
      await team.portal.api.dispose();
      await manager.api.dispose();
    }
  });

  // Revisão pós-merge do plano B (2026-10-13, `EventRainPlanDayAppService`): o
  // colaborador inativado mantém o usuário do Portal ativo, e o aviso o alcançava.
  test('@flow activating the plan tells the assigned team but not a collaborator inactivated after being assigned', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(180_000);
    const s = uniqueSuffix();
    const indoor = await apiCreateRainActivity(authApi, `Mímica ${s}`, { indoorSuitability: 'Indoor' });
    const party = await setupRainParty(authApi);
    await apiPutRainPlan(authApi, party.eventId, [{ activityId: indoor.id }]);
    const kept = await setupConfirmedPortalCollaborator(authApi, tenant.tenantId, party.eventId);
    const gone = await setupConfirmedPortalCollaborator(authApi, tenant.tenantId, party.eventId, { isLeader: false });

    const activatedTo = async (api: APIRequestContext) =>
      (await apiListNotifications(api)).filter(
        (n) => n.type === 'RainPlanActivated' && n.contextEntityId === party.eventId,
      ).length;

    try {
      await apiSetCollaboratorStatus(authApi, gone.collaboratorId, 'Inactive');
      // O desligamento é assíncrono (troca o SecurityStamp): esperar que termine,
      // para a sessão aberta depois da reativação não cair no meio da conferência.
      await expect
        .poll(async () => (await gone.portal.api.get('/api/notifications?pageSize=1')).status(), {
          message: 'o desligamento troca o SecurityStamp',
          timeout: 60_000,
          intervals: [1_000, 2_000],
        })
        .toBe(401);

      await apiActivateRainPlan(authApi, party.eventId, 'Chuva forte');

      // Barreira: o escalado ativo recebe o aviso; o do inativo já teria saído junto.
      await expect.poll(() => activatedTo(kept.portal.api), { message: 'escalado ativo' }).toBe(1);

      // Reativado só para ler o próprio sino: nenhum "Plano B ativado" da festa.
      await apiSetCollaboratorStatus(authApi, gone.collaboratorId, 'Active');
      const anon = await createApiContext();
      const tokens = await loginViaApi(anon, gone.portal.email, 'Dev12345!').finally(() => anon.dispose());
      const goneApi = await createBearerApiContext(tokens.accessToken);
      try {
        expect(await activatedTo(goneApi), 'colaborador inativado no momento da ativação').toBe(0);
      } finally {
        await goneApi.dispose();
      }
    } finally {
      await kept.portal.api.dispose();
      await gone.portal.api.dispose();
    }
  });

  // E27 — §6 "Torre de Controle", decisão 6.
  test('@flow E27: Control Tower: the rainy open-air party of tomorrow shows the weather signal with "Plano B pronto." or "Sem Plano B." at the same severity; a rainy public event has no rain-plan text', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(240_000);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_ticketing');
    await apiSetAiFeature(authApi, CONTROL_TOWER_AI, true);
    const s = uniqueSuffix();
    const indoor = await apiCreateRainActivity(authApi, `Mímica ${s}`, { indoorSuitability: 'Indoor' });
    const ready = await setupRainParty(authApi);
    await apiPutRainPlan(authApi, ready.eventId, [{ activityId: indoor.id }]);
    const withoutPlan = await setupRainParty(authApi);

    const publicEvent = await apiCreatePublicEvent(authApi, {
      eventDate: rainyDay(),
      startTime: '14:00',
      endTime: '18:00',
    });
    setEventAddressDirect(publicEvent.id, 'Curitiba', 'PR');
    seedOpenAirFormDataDirect(publicEvent.id);

    const res = await authApi.post('/api/ai/control-tower/refresh', { timeout: 180_000 });
    await assertOk(res, 'POST /api/ai/control-tower/refresh');
    const tower = await readJson<{ signals: Array<{ eventId: string; kind: string; severity: string; fact: string }> }>(res);
    const rainSignal = (eventId: string) =>
      tower.signals.find((sig) => sig.eventId === eventId && sig.fact.includes('chance de chuva'));

    const readySignal = rainSignal(ready.eventId);
    const missingSignal = rainSignal(withoutPlan.eventId);
    const publicSignal = rainSignal(publicEvent.id);
    expect(readySignal, 'sinal de clima da festa com plano').toBeTruthy();
    expect(missingSignal, 'sinal de clima da festa sem plano').toBeTruthy();
    expect(publicSignal, 'sinal de clima do evento público').toBeTruthy();
    expect(readySignal!.fact).toContain('Plano B pronto.');
    expect(missingSignal!.fact).toContain('Sem Plano B.');
    expect(readySignal!.severity, 'mesma severidade (decisão 6)').toBe(missingSignal!.severity);
    expect(publicSignal!.fact).not.toContain('Plano B');
  });

  // ───────────────────────────── PB-F (Etapa 227) ─────────────────────────────

  // E9 — §8 itens 3 e 4.
  test('@flow E9: with stock, a ready plan makes the product reservation include the plan material; completing without activation consumes only the party part and releases the plan part; completing with the plan active consumes the plan material and not the replaced activity material', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(300_000);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_stock');
    const { products, contracted, rainActivity } = await stockCatalog(authApi);
    for (const p of Object.values(products)) await purchase(authApi, p.id, 100);

    const notActivated = await setupRainParty(authApi, { contracted, childrenCount: CHILDREN });
    await readyPlan(authApi, notActivated.eventId, rainActivity, contracted);
    const reserved = await activeReservations(authApi, notActivated.eventId);
    expect(reserved.get(products.shared.id), 'principal + Plano B na mesma linha').toBeCloseTo(2 * CHILDREN, 3);
    expect(reserved.get(products.mainOnly.id)).toBeCloseTo(CHILDREN, 3);
    expect(reserved.get(products.rainOnly.id), 'material só do Plano B reservado').toBeCloseTo(CHILDREN, 3);

    await runParty(authApi, notActivated.eventId);
    expect((await balanceOf(authApi, products.shared.id)).current).toBeCloseTo(100 - CHILDREN, 3);
    expect((await balanceOf(authApi, products.mainOnly.id)).current).toBeCloseTo(100 - CHILDREN, 3);
    expect((await balanceOf(authApi, products.rainOnly.id)).current, 'Plano B não ativado: não baixa').toBeCloseTo(100, 3);
    expect((await activeReservations(authApi, notActivated.eventId)).size, 'o resto da reserva é liberado').toBe(0);

    const activated = await setupRainParty(authApi, { contracted, childrenCount: CHILDREN });
    await readyPlan(authApi, activated.eventId, rainActivity, contracted);
    await apiActivateRainPlan(authApi, activated.eventId, 'Chuva');
    const before = {
      shared: (await balanceOf(authApi, products.shared.id)).current,
      mainOnly: (await balanceOf(authApi, products.mainOnly.id)).current,
      rainOnly: (await balanceOf(authApi, products.rainOnly.id)).current,
    };
    await runParty(authApi, activated.eventId);
    expect(before.shared - (await balanceOf(authApi, products.shared.id)).current).toBeCloseTo(CHILDREN, 3);
    expect(
      before.mainOnly - (await balanceOf(authApi, products.mainOnly.id)).current,
      'a atividade substituída não baixa',
    ).toBeCloseTo(0, 3);
    expect(before.rainOnly - (await balanceOf(authApi, products.rainOnly.id)).current, 'o Plano B ativo baixa').toBeCloseTo(
      CHILDREN,
      3,
    );
  });

  // E36 — §8 item 5, decisão 7 (com o aviso de chuva).
  test('@flow E36: with the plan only ready, shortage panel, stock dashboard and shopping list count demand WITHOUT the plan part; after the rain warning they count it; the product Available counts the whole reservation in both', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(TRIGGER_TIMEOUT + 240_000);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_stock');
    await apiSetAiFeature(authApi, SHOPPING_LIST_AI, true);
    const { products, contracted, rainActivity } = await stockCatalog(authApi);
    await trackProducts(authApi, products);
    const party = await setupRainParty(authApi, { contracted, childrenCount: CHILDREN });
    await readyPlan(authApi, party.eventId, rainActivity, contracted);

    let shortage = await shortagePredicted(authApi, party.eventId);
    expect(shortage.get(products.shared.id)).toBeCloseTo(shortage.get(products.mainOnly.id)!, 3);
    expect(shortage.has(products.rainOnly.id), 'só o Plano B usa: fora da demanda').toBe(false);
    let dashboard = await dashboardPredicted(authApi);
    expect(dashboard.get(products.shared.id)).toBeCloseTo(dashboard.get(products.mainOnly.id)!, 3);
    expect(dashboard.get(products.rainOnly.id) ?? 0).toBeCloseTo(0, 3);
    const shopping = await shoppingDemand(authApi);
    expect(shopping.get(products.shared.id)).toBeCloseTo(shopping.get(products.mainOnly.id)!, 3);
    expect(shopping.get(products.rainOnly.id) ?? 0).toBeCloseTo(0, 3);
    let balance = await balanceOf(authApi, products.shared.id);
    expect(balance.reserved, 'o comprometido conta a reserva cheia').toBeCloseTo(2 * CHILDREN, 3);
    expect(balance.available).toBeCloseTo(balance.current - 2 * CHILDREN, 3);

    // Aviso de chuva da varredura diária: grava o `RainRiskNotifiedOn` do plano.
    await apiTriggerDailyJob(authApi);
    await expect.poll(async () => (await apiGetRainPlan(authApi, party.eventId)).plan?.rainRiskNotifiedOn ?? null).not.toBeNull();

    shortage = await shortagePredicted(authApi, party.eventId);
    expect(shortage.get(products.shared.id)).toBeCloseTo(2 * shortage.get(products.mainOnly.id)!, 3);
    expect(shortage.get(products.rainOnly.id)).toBeCloseTo(shortage.get(products.mainOnly.id)!, 3);
    dashboard = await dashboardPredicted(authApi);
    expect(dashboard.get(products.shared.id)).toBeCloseTo(2 * dashboard.get(products.mainOnly.id)!, 3);
    expect(dashboard.get(products.rainOnly.id)).toBeCloseTo(dashboard.get(products.mainOnly.id)!, 3);
    balance = await balanceOf(authApi, products.shared.id);
    expect(balance.reserved).toBeCloseTo(2 * CHILDREN, 3);
  });

  // E36 — o mesmo com a ativação (a lista de compras recalcula uma vez por hora: tenant próprio).
  test('@flow E36: after activation, shortage panel, stock dashboard and shopping list count the plan part', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(240_000);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_stock');
    await apiSetAiFeature(authApi, SHOPPING_LIST_AI, true);
    const { products, contracted, rainActivity } = await stockCatalog(authApi);
    await trackProducts(authApi, products);
    const party = await setupRainParty(authApi, { contracted, childrenCount: CHILDREN });
    await readyPlan(authApi, party.eventId, rainActivity, contracted);
    await apiActivateRainPlan(authApi, party.eventId, 'Chuva');

    const shortage = await shortagePredicted(authApi, party.eventId);
    expect(shortage.get(products.shared.id)).toBeCloseTo(2 * shortage.get(products.mainOnly.id)!, 3);
    expect(shortage.get(products.rainOnly.id)).toBeCloseTo(shortage.get(products.mainOnly.id)!, 3);
    const dashboard = await dashboardPredicted(authApi);
    expect(dashboard.get(products.shared.id)).toBeCloseTo(2 * dashboard.get(products.mainOnly.id)!, 3);
    expect(dashboard.get(products.rainOnly.id)).toBeCloseTo(dashboard.get(products.mainOnly.id)!, 3);
    const shopping = await shoppingDemand(authApi);
    expect(shopping.get(products.shared.id)).toBeCloseTo(2 * shopping.get(products.mainOnly.id)!, 3);
    expect(shopping.get(products.rainOnly.id)).toBeCloseTo(shopping.get(products.mainOnly.id)!, 3);
    const balance = await balanceOf(authApi, products.shared.id);
    expect(balance.reserved).toBeCloseTo(2 * CHILDREN, 3);
  });

  // E37 — §8 itens 3 e 6.
  test('@flow E37: activating and deactivating reconverge the reservation right away; covered venue or draft plan do not reserve the plan material', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(240_000);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_stock');
    const { products, contracted, rainActivity } = await stockCatalog(authApi);

    // Coberto com plano pronto: só a principal.
    const party = await setupRainParty(authApi, { contracted, childrenCount: CHILDREN, venue: 'Sheltered' });
    await readyPlan(authApi, party.eventId, rainActivity, contracted);
    let reserved = await activeReservations(authApi, party.eventId);
    expect(reserved.get(products.shared.id), 'coberto: sem a parte do Plano B').toBeCloseTo(CHILDREN, 3);
    expect(reserved.has(products.rainOnly.id)).toBe(false);

    // O local vira ao ar livre (o formulário não reconverge a reserva); a
    // ativação reconverge na hora, sem o worker.
    await apiSetOpenAirVenue(authApi, party.eventId);
    await apiActivateRainPlan(authApi, party.eventId, 'Chuva');
    reserved = await activeReservations(authApi, party.eventId);
    expect(reserved.get(products.shared.id), 'ativar reconverge').toBeCloseTo(2 * CHILDREN, 3);
    expect(reserved.get(products.rainOnly.id)).toBeCloseTo(CHILDREN, 3);

    await apiSetShelteredVenue(authApi, party.eventId);
    await apiDeactivateRainPlan(authApi, party.eventId);
    reserved = await activeReservations(authApi, party.eventId);
    expect(reserved.get(products.shared.id), 'desativar reconverge').toBeCloseTo(CHILDREN, 3);
    expect(reserved.has(products.rainOnly.id)).toBe(false);

    // Ao ar livre com plano em rascunho: nada do Plano B.
    const draft = await setupRainParty(authApi, { contracted, childrenCount: CHILDREN });
    await apiPutRainPlan(authApi, draft.eventId, []);
    reserved = await activeReservations(authApi, draft.eventId);
    expect(reserved.get(products.shared.id)).toBeCloseTo(CHILDREN, 3);
    expect(reserved.has(products.rainOnly.id)).toBe(false);
  });

  // E37 — tenant sem `feature_stock` (no-op pelo entitlement).
  test('@flow E37: a tenant without feature_stock builds, activates and deactivates the plan with no error and no reservation', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(180_000);
    // O teste do signup é do plano que já traz o estoque: o tenant sem
    // `feature_stock` é o do `plan_free` (achado deste spec: o GET de reservas
    // respondia 200 no tenant recém-criado).
    setSubscriptionPlanDirect(tenant.tenantId, 'plan_free');
    const { contracted, rainActivity } = await stockCatalog(authApi);
    const party = await setupRainParty(authApi, { contracted, childrenCount: CHILDREN });
    await readyPlan(authApi, party.eventId, rainActivity, contracted);
    await apiActivateRainPlan(authApi, party.eventId, 'Chuva');
    await apiDeactivateRainPlan(authApi, party.eventId);
    expect((await apiGetRainPlan(authApi, party.eventId)).plan!.status).toBe('Ready');

    const stock = await authApi.get('/api/stock/reservations');
    expect(stock.status()).toBe(403);
    expect(await apiErrorCodes(stock)).toContain('Entitlement.NotIncludedInPlan');
    const rows = execSql(`SELECT COUNT(*) FROM "StockReservations" WHERE "EventId" = '${party.eventId}';`);
    expect(Number(rows), 'nenhuma reserva').toBe(0);
  });
});

// E38 — §8 "Testes" (isolamento).
twoTenantsTest.describe('Fluxo completo 10 — Plano B de chuva: isolamento do estoque', () => {
  twoTenantsTest(
    '@flow E38: reservation and rain plan of another company on the same date stay out of the shortage panel and the shopping list demand; the reservation stays in the event tenant',
    async ({ apiA, apiB, tenantA, tenantB }) => {
      twoTenantsTest.setTimeout(300_000);
      for (const t of [tenantA, tenantB]) enableFeatureFlagDirect(t.tenantId, 'feature_stock');
      await apiSetAiFeature(apiA, SHOPPING_LIST_AI, true);

      const a = await stockCatalog(apiA);
      await trackProducts(apiA, a.products);
      const partyA = await setupRainParty(apiA, { contracted: a.contracted, childrenCount: CHILDREN });
      await readyPlan(apiA, partyA.eventId, a.rainActivity, a.contracted);

      const b = await stockCatalog(apiB);
      const partyB = await setupRainParty(apiB, { contracted: b.contracted, childrenCount: CHILDREN });
      await readyPlan(apiB, partyB.eventId, b.rainActivity, b.contracted);
      await apiActivateRainPlan(apiB, partyB.eventId, 'Chuva');

      const bProducts = Object.values(b.products).map((p) => p.id);
      const shortageRes = await apiA.get(`/api/events/${partyA.eventId}/material-shortage`);
      await assertOk(shortageRes, 'GET material-shortage A');
      const shortage = await readJson<{
        covered: Array<{ productId: string; reservedByOthersQty: number }>;
        missing: Array<{ productId: string; reservedByOthersQty: number }>;
      }>(shortageRes);
      const lines = [...shortage.covered, ...shortage.missing];
      expect(lines.some((l) => bProducts.includes(l.productId)), 'produto de B no painel de A').toBe(false);
      expect(lines.find((l) => l.productId === a.products.shared.id)?.reservedByOthersQty ?? 0).toBeCloseTo(0, 3);

      const shopping = await shoppingDemand(apiA);
      expect([...shopping.keys()].some((id) => bProducts.includes(id)), 'demanda de B na lista de A').toBe(false);

      const reservedB = await activeReservations(apiB, partyB.eventId);
      expect(reservedB.get(b.products.rainOnly.id), 'a reserva sai no tenant do evento').toBeCloseTo(CHILDREN, 3);
      const listA = await apiA.get(`/api/stock/reservations?eventId=${partyB.eventId}&pageSize=100`);
      await assertOk(listA, 'GET /api/stock/reservations (A, evento de B)');
      expect(await unwrapList(listA)).toHaveLength(0);
    },
  );
});
