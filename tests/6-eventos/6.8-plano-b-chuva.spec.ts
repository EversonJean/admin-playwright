import { randomUUID } from 'crypto';
import { APIRequestContext, Browser } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import {
  apiCompleteOnboarding,
  apiCreateCollaborator,
  apiCreateProduct,
  apiListNotifications,
  apiSetAiFeature,
  apiSetSettingParameter,
} from '../../helpers/api-entities';
import {
  apiAssignCollaborator,
  apiCompleteEvent,
  apiConfirmCollaborator,
  apiCreatePublicEvent,
  apiGetEvent,
  apiStartEvent,
} from '../../helpers/api-event-flow';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import {
  enableFeatureFlagDirect,
  getEventFormPublicTokenDirect,
  setSubscriptionPlanDirect,
} from '../../helpers/db-helper';
import { fakeOpenAi } from '../../helpers/fake-providers';
import {
  RainActivity,
  TRIGGER_TIMEOUT,
  apiActivateRainPlan,
  apiCreateRainActivity,
  apiGetMaterialChecklist,
  apiGetRainForecast,
  apiGetRainPlan,
  apiGetReadiness,
  apiPutRainPlan,
  apiSuggestRainPlan,
  apiTriggerDailyJob,
  openRainPlanTab,
  putRainPlan,
  rainPlanTab,
  setupConfirmedPortalCollaborator,
  setupRainParty,
  uniqueSuffix,
} from '../../helpers/rain-plan';
import { apiErrorCodes, assertOk, readJson } from '../../helpers/response';
import { loginAsRole, openSessionPage } from '../../helpers/setup-flows';
import { snack } from '../../helpers/ui';

/**
 * Fluxo: 6.8 — Plano B de chuva na festa
 * Plano: docs/implementados/PLANO-PLANO-B-DE-CHUVA.md (§2 a §7; Etapas 222 a 226).
 * Registro e2e: E1, E3, E4, E8, E14, E18, E19, E23, E24, E26, E28, E29, E33, E34, E35.
 *
 * Sem diagrama `.mmd`: verificação de plano.
 *
 * Clima: o fake do back chove só AMANHÃ (`Weather:FakeRainyDayOffsets = [1]`,
 * 85% das 12h às 18h), e a festa de `setupRainParty` é amanhã, das 14h às 18h.
 * IA: o fake da OpenAI casa a resposta roteirizada pelo TEXTO do prompt, e o
 * prompt do Plano B não leva o id da festa: o `match` é o id da atividade
 * contratada, que só esta festa tem.
 */

const RAIN_PLAN_AI = 'ai_rain_plan';

interface AiFeatureCard {
  code: string;
  enabled: boolean;
  tokensUsedThisMonth: number;
}

async function rainPlanAiCard(api: APIRequestContext): Promise<AiFeatureCard> {
  const res = await api.get('/api/ai/features');
  await assertOk(res, 'GET /api/ai/features');
  const body = await readJson<AiFeatureCard[] | { items: AiFeatureCard[] }>(res);
  const cards = Array.isArray(body) ? body : body.items;
  const card = cards.find((c) => c.code === RAIN_PLAN_AI);
  if (!card) throw new Error(`card ${RAIN_PLAN_AI} ausente da Central de IA`);
  return card;
}

/** Atividade para local fechado, ativa (a candidata padrão do Plano B). */
function indoorActivity(api: APIRequestContext, name: string, extra: Parameters<typeof apiCreateRainActivity>[2] = {}) {
  return apiCreateRainActivity(api, name, { indoorSuitability: 'Indoor', minSquareMetersPerChild: 2, ...extra });
}

/** Tenant novo, fora da fixture, com a API autenticada como o admin dele. */
async function otherTenant(): Promise<{ api: APIRequestContext; tenantId: string }> {
  const other = await signupNewTenant();
  return { api: await createBearerApiContext(other.accessToken), tenantId: other.tenantId };
}

/** Escala um líder confirmado (o `start` exige) e leva a festa a `Completed`. */
async function completeParty(api: APIRequestContext, eventId: string): Promise<void> {
  const leader = await apiCreateCollaborator(api);
  await apiAssignCollaborator(api, eventId, leader.id, { isLeader: true });
  await apiConfirmCollaborator(api, eventId, leader.id);
  await apiStartEvent(api, eventId);
  await apiCompleteEvent(api, eventId);
}

async function aiSuggestScript(match: string, payload: unknown): Promise<void> {
  await fakeOpenAi.scriptNext(match, JSON.stringify(payload));
}

async function openAsFinancial(browser: Browser, tenantId: string) {
  const financial = await loginAsRole(tenantId, 'Financial');
  const session = await openSessionPage(browser, financial.tokens);
  return {
    api: financial.api,
    page: session.page,
    close: async () => {
      await session.context.close();
      await financial.api.dispose();
    },
  };
}

test.describe('Fluxo 6.8 — Plano B de chuva', () => {
  // ───────────────────────────── PB-A (Etapa 222) ─────────────────────────────

  // E1 — §2.2 e §3 (Front 3 e 4): o cliente responde no formulário público.
  test('@crud E1: client says in the post-acceptance form the venue is uncovered with a 30 m² covered area; the event shows "Ao ar livre" and the area', async ({
    authApi,
    authPage,
    browser,
  }) => {
    await apiCompleteOnboarding(authApi);
    const party = await setupRainParty(authApi, { venue: 'None' });
    const token = getEventFormPublicTokenDirect(party.eventId);

    const publicContext = await browser.newContext({
      baseURL: process.env.FRONT_URL ?? 'http://localhost:4200',
      ignoreHTTPSErrors: true,
    });
    try {
      const page = await publicContext.newPage();
      await page.goto(`/event-form/${token}`);
      await expect(page.getByTestId('public-form-step1-next')).toBeVisible({ timeout: 20_000 });
      const fullName = page.getByTestId('public-form-clientFullName');
      if ((await fullName.inputValue()).trim() === '') await fullName.fill(`Cliente E2E ${party.suffix}`);
      await page.getByTestId('public-form-step1-next').click();

      // Local descoberto e externo: as duas caixas desmarcadas abrem a pergunta da chuva.
      await expect(page.getByTestId('public-form-rain-backup')).toBeVisible();
      await page.getByTestId('public-form-hasRainBackupArea-yes').click();
      await page.getByTestId('public-form-rainBackupAreaSquareMeters').fill('30');
      await page.getByTestId('public-form-rainBackupAreaDescription').fill('Garagem coberta');
      await page.getByTestId('public-form-step2-next').click();

      await page.getByTestId('public-form-confirm-btn').click();
      await expect(page.getByTestId('public-form-confirmed')).toBeVisible({ timeout: 20_000 });
    } finally {
      await publicContext.close();
    }

    const view = await apiGetRainPlan(authApi, party.eventId);
    expect(view.venueExposure).toBe('OpenAir');
    expect(view.hasRainBackupArea).toBe(true);
    expect(view.rainBackupAreaSquareMeters).toBe(30);

    await authPage.goto(`/app/events/${party.eventId}`);
    await expect(authPage.getByTestId('event-detail-venue-exposure')).toHaveText('Ao ar livre', { timeout: 20_000 });
    await authPage.getByRole('tab', { name: 'Dados do cliente', exact: true }).click();
    await expect(authPage.getByTestId('field-rainBackupAreaSquareMeters')).toHaveValue('30');
  });

  // E14 — §2.2, §3 item 3a: a primeira gravação do gestor passa (era 409).
  test('@crud E14: manager fills "Dados do cliente" of an event without form (uncovered, 40 m²); first save passes and list and detail show "Ao ar livre"; no events.update cannot edit; other tenant gets 404', async ({
    authApi,
    authPage,
    browser,
    tenant,
  }) => {
    test.setTimeout(180_000);
    await apiCompleteOnboarding(authApi);
    const party = await setupRainParty(authApi, { venue: 'None' });

    await authPage.goto(`/app/events/${party.eventId}`);
    // O `ng serve` frio recarrega a página quando otimiza dependência nova (visto
    // no trace: o detalhe montou e voltou ao spinner): clica até a aba abrir.
    await expect(async () => {
      await authPage.getByRole('tab', { name: 'Dados do cliente', exact: true }).click({ timeout: 5_000 });
      await expect(authPage.getByTestId('form-data-save-btn')).toBeVisible({ timeout: 5_000 });
    }).toPass({ timeout: 60_000 });
    await expect(authPage.getByTestId('form-data-rain-backup')).toBeVisible();
    await authPage.getByTestId('field-hasRainBackupArea-yes').click();
    await authPage.getByTestId('field-rainBackupAreaSquareMeters').fill('40');
    await authPage.getByTestId('form-data-save-btn').click();
    await expect(snack(authPage, 'Dados salvos com sucesso')).toBeVisible();

    const ev = (await apiGetEvent(authApi, party.eventId)) as unknown as { venueExposure: string };
    expect(ev.venueExposure).toBe('OpenAir');
    expect((await apiGetRainPlan(authApi, party.eventId)).rainBackupAreaSquareMeters).toBe(40);

    await authPage.reload();
    await expect(authPage.getByTestId('event-detail-venue-exposure')).toHaveText('Ao ar livre', { timeout: 20_000 });
    await authPage.goto('/app/events/list');
    await expect(authPage.getByTestId(`events-list-venue-exposure-${party.eventId}`)).toHaveText('Ao ar livre', {
      timeout: 20_000,
    });

    // Sem `events.update`: a aba fica só leitura e o PATCH é recusado.
    const financial = await openAsFinancial(browser, tenant.tenantId);
    try {
      await financial.page.goto(`/app/events/${party.eventId}`);
      await financial.page.getByRole('tab', { name: 'Dados do cliente', exact: true }).click();
      await expect(financial.page.getByTestId('field-isCovered')).toBeVisible({ timeout: 20_000 });
      await expect(financial.page.getByTestId('form-data-save-btn')).toHaveCount(0);
      const denied = await financial.api.patch(`/api/events/${party.eventId}/form-data`, { data: { isCovered: true } });
      expect(denied.status()).toBe(403);
    } finally {
      await financial.close();
    }

    const other = await otherTenant();
    try {
      expect((await other.api.get(`/api/events/${party.eventId}/form-data`)).status()).toBe(404);
      const patched = await other.api.patch(`/api/events/${party.eventId}/form-data`, {
        data: { isCovered: true, isIndoor: true },
      });
      expect(patched.status()).toBe(404);
    } finally {
      await other.api.dispose();
    }
    expect((await apiGetRainPlan(authApi, party.eventId)).venueExposure, 'nada mudou').toBe('OpenAir');
  });

  // ───────────────────────────── PB-B (Etapa 223) ─────────────────────────────

  // E3 — §4 "Sugestão por regra" (passos 2 a 4) e "Tela".
  test('@crud E3: rule suggestion for an open-air party of 26 children brings only indoor activities, the declared substitute first, with groups by area; accepting fills the list without saving, then saving', async ({
    authApi,
    authPage,
  }) => {
    test.setTimeout(120_000);
    await apiCompleteOnboarding(authApi);
    const s = uniqueSuffix();
    // Substituta cadastrada: "com adaptação" e de outra categoria, e ainda assim primeiro.
    const substitute = await apiCreateRainActivity(authApi, `Mímica ${s}`, {
      indoorSuitability: 'IndoorAdapted',
      minSquareMetersPerChild: 1.5,
      category: 'Teatro',
    });
    const indoor = await indoorActivity(authApi, `Oficina de massinha ${s}`);
    const outdoorOnly = await apiCreateRainActivity(authApi, `Futebol ${s}`, { indoorSuitability: 'OutdoorOnly' });
    const notInformed = await apiCreateRainActivity(authApi, `Pintura ${s}`, {});
    const party = await setupRainParty(authApi, {
      childrenCount: 26,
      areaSquareMeters: 30,
      contractedSubstitutes: [substitute.id],
    });

    await authPage.goto(`/app/events/${party.eventId}`);
    await rainPlanTab(authPage).click();
    await expect(authPage.getByTestId('rain-plan-empty')).toBeVisible({ timeout: 20_000 });
    await authPage.getByTestId('rain-plan-suggest').click();

    const panel = authPage.getByTestId('rain-plan-suggestions');
    await expect(panel).toBeVisible();
    const candidates = panel.locator('li[data-testid^="rain-plan-candidate-"]');
    await expect(candidates).toHaveCount(2);
    await expect(candidates.nth(0)).toHaveAttribute('data-testid', `rain-plan-candidate-${substitute.id}`);
    await expect(candidates.nth(1)).toHaveAttribute('data-testid', `rain-plan-candidate-${indoor.id}`);
    await expect(panel.getByTestId(`rain-plan-candidate-${outdoorOnly.id}`)).toHaveCount(0);
    await expect(panel.getByTestId(`rain-plan-candidate-${notInformed.id}`)).toHaveCount(0);
    // 30 m² ÷ 1,5 m² = 20 lugares para 26 crianças: 2 turmas de 13.
    await expect(candidates.nth(0)).toContainText('2 turmas de 13');
    await expect(candidates.nth(0)).toContainText(`substitui ${party.contracted.name}`);
    await expect(candidates.nth(0)).toContainText(`Substituta cadastrada de ${party.contracted.name}`);
    await expect(authPage.getByTestId('rain-plan-suggestions-summary')).toContainText('Área coberta de 30 m²');

    await authPage.getByTestId('rain-plan-suggestions-accept').click();
    await expect(authPage.getByTestId('rain-plan-item-title-0')).toContainText(substitute.name);
    await expect(authPage.getByTestId('rain-plan-status-new')).toBeVisible();
    expect((await apiGetRainPlan(authApi, party.eventId)).plan, 'aceitar não grava').toBeNull();

    await authPage.getByTestId('rain-plan-save').click();
    await expect(authPage.getByTestId('rain-plan-status')).toHaveText('Pronto');

    const plan = (await apiGetRainPlan(authApi, party.eventId)).plan!;
    expect(plan.status).toBe('Ready');
    const first = plan.items[0]!;
    expect(first.activityId).toBe(substitute.id);
    expect(first.source).toBe('Rule');
    expect(first.replacesActivityId).toBe(party.contracted.id);
    expect(first.groups).toBe(2);
  });

  // E4 — §4 "Testes" (quatro eixos).
  test('@crud E4: user without events.update sees the plan read-only; another company activity in the PUT is refused (400); another tenant gets 404 on GET, PUT, suggestions and DELETE without changes', async ({
    authApi,
    browser,
    tenant,
  }) => {
    test.setTimeout(180_000);
    await apiCompleteOnboarding(authApi);
    const s = uniqueSuffix();
    const indoor = await indoorActivity(authApi, `Mímica ${s}`);
    const party = await setupRainParty(authApi);
    await apiPutRainPlan(authApi, party.eventId, [{ activityId: indoor.id }], 'Usar a garagem');

    const financial = await openAsFinancial(browser, tenant.tenantId);
    try {
      const view = await readJson<{ canEdit: boolean; plan: unknown }>(
        await financial.api.get(`/api/events/${party.eventId}/rain-plan`),
      );
      expect(view.canEdit).toBe(false);
      expect(view.plan).not.toBeNull();
      expect((await putRainPlan(financial.api, party.eventId, [])).status()).toBe(403);
      expect((await financial.api.post(`/api/events/${party.eventId}/rain-plan/suggestions`)).status()).toBe(403);
      expect((await financial.api.delete(`/api/events/${party.eventId}/rain-plan`)).status()).toBe(403);

      await openRainPlanTab(financial.page, party.eventId);
      await expect(financial.page.getByTestId('rain-plan-list-readonly')).toContainText(indoor.name);
      await expect(financial.page.getByTestId('rain-plan-notes-readonly')).toContainText('Usar a garagem');
      for (const id of ['rain-plan-suggest', 'rain-plan-suggest-again', 'rain-plan-save', 'rain-plan-delete', 'rain-plan-add-free']) {
        await expect(financial.page.getByTestId(id), id).toHaveCount(0);
      }
    } finally {
      await financial.close();
    }

    const other = await otherTenant();
    try {
      const foreign = await indoorActivity(other.api, `Atividade de outra empresa ${s}`);
      const refused = await putRainPlan(authApi, party.eventId, [{ activityId: foreign.id }]);
      expect(refused.status()).toBe(400);
      expect(await apiErrorCodes(refused)).toContain('EventRainPlan.ActivityNotFound');

      const url = `/api/events/${party.eventId}/rain-plan`;
      expect((await other.api.get(url)).status()).toBe(404);
      expect((await putRainPlan(other.api, party.eventId, [{ title: 'Invasão' }])).status()).toBe(404);
      expect((await other.api.post(`${url}/suggestions`)).status()).toBe(404);
      expect((await other.api.delete(url)).status()).toBe(404);
    } finally {
      await other.api.dispose();
    }

    const after = (await apiGetRainPlan(authApi, party.eventId)).plan!;
    expect(after.items.map((i) => i.activityId)).toEqual([indoor.id]);
    expect(after.notes).toBe('Usar a garagem');
  });

  // E18 — §4 "Regras" (`EventNotCommercial`, `EventLocked`), decisão 3.
  test('@crud E18: public party and operational record have no "Plano B (chuva)" tab and the API refuses (409); completed or canceled party shows its plan without editing', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(240_000);
    await apiCompleteOnboarding(authApi);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_ticketing');

    const publicEvent = await apiCreatePublicEvent(authApi);
    const opRes = await authApi.post('/api/events/operational', {
      data: {
        kind: 'ExternalCommitment',
        eventDate: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10),
        startTime: '09:00',
        endTime: '12:00',
        location: 'Compromisso E2E',
        childrenCount: 10,
      },
    });
    await assertOk(opRes, 'POST /api/events/operational');
    const operational = await readJson<{ id: string }>(opRes);

    for (const id of [publicEvent.id, operational.id]) {
      const get = await authApi.get(`/api/events/${id}/rain-plan`);
      expect(get.status(), `GET ${id}`).toBe(409);
      expect(await apiErrorCodes(get)).toContain('EventRainPlan.EventNotCommercial');
      const put = await putRainPlan(authApi, id, [{ title: 'Estátua' }]);
      expect(put.status(), `PUT ${id}`).toBe(409);
      expect(await apiErrorCodes(put)).toContain('EventRainPlan.EventNotCommercial');

      await authPage.goto(`/app/events/${id}`);
      await expect(authPage.getByTestId('event-detail-tabs')).toBeVisible({ timeout: 20_000 });
      await expect(authPage.getByRole('tab', { name: 'Visão geral', exact: true })).toBeVisible();
      await expect(rainPlanTab(authPage)).toHaveCount(0);
    }

    const s = uniqueSuffix();
    const indoor = await indoorActivity(authApi, `Mímica ${s}`);

    const completed = await setupRainParty(authApi);
    await apiPutRainPlan(authApi, completed.eventId, [{ activityId: indoor.id }]);
    await completeParty(authApi, completed.eventId);

    const canceled = await setupRainParty(authApi);
    await apiPutRainPlan(authApi, canceled.eventId, [{ activityId: indoor.id }]);
    await assertOk(
      await authApi.post(`/api/events/${canceled.eventId}/cancel`, { data: { reason: 'Cliente desistiu (E2E)' } }),
      'POST cancel',
    );

    for (const eventId of [completed.eventId, canceled.eventId]) {
      const view = await apiGetRainPlan(authApi, eventId);
      expect(view.canEdit, eventId).toBe(false);
      expect(view.plan?.items.map((i) => i.activityId)).toEqual([indoor.id]);
      const put = await putRainPlan(authApi, eventId, [{ title: 'Estátua' }]);
      expect(put.status()).toBe(409);
      expect(await apiErrorCodes(put)).toContain('EventRainPlan.EventLocked');

      await openRainPlanTab(authPage, eventId);
      await expect(authPage.getByTestId('rain-plan-list-readonly')).toContainText(indoor.name);
      await expect(authPage.getByTestId('rain-plan-save')).toHaveCount(0);
      await expect(authPage.getByTestId('rain-plan-delete')).toHaveCount(0);
      await expect(authPage.getByTestId('rain-plan-activate')).toHaveCount(0);
    }
  });

  // E19 — §2.3 (PUT é estado completo) e §4 "Tela".
  test('@crud E19: manager builds the plan with a catalog item and a free game, saves, changes the list and saves again without conflict, deletes and builds another on the same party', async ({
    authApi,
    authPage,
  }) => {
    test.setTimeout(150_000);
    await apiCompleteOnboarding(authApi);
    const s = uniqueSuffix();
    const first = await indoorActivity(authApi, `Mímica ${s}`);
    const second = await indoorActivity(authApi, `Massinha ${s}`);
    const party = await setupRainParty(authApi);

    const addFromCatalog = async (activity: RainActivity) => {
      const input = authPage.getByTestId('rain-plan-add-activity');
      await input.fill(activity.name);
      await authPage.getByTestId(`rain-plan-add-activity-option-${activity.id}`).click();
    };

    await openRainPlanTab(authPage, party.eventId);
    await authPage.getByTestId('rain-plan-start-empty').click();
    await addFromCatalog(first);
    await authPage.getByTestId('rain-plan-add-free').click();
    await authPage.getByTestId('rain-plan-item-title-input-1').fill(`Estátua ${s}`);
    await authPage.getByTestId('rain-plan-notes').fill('Tirar os carros da garagem');
    await authPage.getByTestId('rain-plan-save').click();
    await expect(authPage.getByTestId('rain-plan-status')).toHaveText('Pronto');

    let plan = (await apiGetRainPlan(authApi, party.eventId)).plan!;
    expect(plan.items.map((i) => i.activityId ?? i.title)).toEqual([first.id, `Estátua ${s}`]);
    expect(plan.notes).toBe('Tirar os carros da garagem');
    const firstPlanId = plan.id;

    // Troca a lista e grava de novo: estado completo, sem 409 no segundo "Salvar".
    await authPage.getByTestId('rain-plan-item-remove-0').click();
    await addFromCatalog(second);
    // O botão também fica desabilitado durante o envio: só a resposta do PUT
    // garante que a leitura abaixo já vê a lista nova.
    const secondSave = authPage.waitForResponse(
      (r) => r.request().method() === 'PUT' && r.url().includes(`/api/events/${party.eventId}/rain-plan`),
    );
    await authPage.getByTestId('rain-plan-save').click();
    expect((await secondSave).ok(), 'segundo PUT sem conflito').toBe(true);
    await expect(authPage.getByTestId('rain-plan-save')).toBeDisabled();
    await expect(authPage.getByTestId('rain-plan-action-error')).toHaveCount(0);
    plan = (await apiGetRainPlan(authApi, party.eventId)).plan!;
    expect(plan.items.map((i) => i.activityId ?? i.title)).toEqual([`Estátua ${s}`, second.id]);

    await authPage.getByTestId('rain-plan-delete').click();
    await authPage.getByTestId('confirm-ok').click();
    await expect(authPage.getByTestId('rain-plan-empty')).toBeVisible();
    expect((await apiGetRainPlan(authApi, party.eventId)).plan).toBeNull();

    await authPage.getByTestId('rain-plan-start-empty').click();
    await addFromCatalog(first);
    await authPage.getByTestId('rain-plan-save').click();
    await expect(authPage.getByTestId('rain-plan-status')).toHaveText('Pronto');
    plan = (await apiGetRainPlan(authApi, party.eventId)).plan!;
    expect(plan.id).not.toBe(firstPlanId);
    expect(plan.items.map((i) => i.activityId)).toEqual([first.id]);
  });

  // ───────────────────────────── PB-C (Etapa 224) ─────────────────────────────

  // E23 — §2.4 e §5 itens 2 e 3.
  test('@flow E23: extra item on a rain-plan activity (manager or Portal) goes to the "Plano B (chuva)" group; removing the activity leaves it "no longer needed"; a plan activity that becomes contracted moves to the main list keeping what was checked; plan material does not count in readiness', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(180_000);
    const s = uniqueSuffix();
    const mainProduct = await apiCreateProduct(authApi, { name: `Bexiga ${s}` });
    const rainProduct = await apiCreateProduct(authApi, { name: `Lona ${s}` });
    const laterProduct = await apiCreateProduct(authApi, { name: `Massinha ${s}` });
    const rainActivity = await indoorActivity(authApi, `Mímica ${s}`, {
      activityProducts: [{ productId: rainProduct.id, qtyPerChild: 1, isChecklistOnly: false }],
    });
    const laterContracted = await indoorActivity(authApi, `Oficina ${s}`, {
      activityProducts: [{ productId: laterProduct.id, qtyPerChild: 1, isChecklistOnly: false }],
    });
    const party = await setupRainParty(authApi, {
      contractedProducts: [{ productId: mainProduct.id, qtyPerChild: 1, isChecklistOnly: false }],
    });
    const { portal } = await setupConfirmedPortalCollaborator(authApi, tenant.tenantId, party.eventId);

    try {
      await apiPutRainPlan(authApi, party.eventId, [{ activityId: rainActivity.id }, { activityId: laterContracted.id }]);

      let checklist = await apiGetMaterialChecklist(authApi, party.eventId);
      const rainGroup = checklist.groups.find((g) => g.activityId === rainActivity.id)!;
      expect(rainGroup.scope).toBe('RainPlan');
      expect(rainGroup.items.find((i) => i.productId === rainProduct.id)?.scope).toBe('RainPlan');

      const byManager = await authApi.post(`/api/events/${party.eventId}/material-checklist/items`, {
        data: { activityId: rainActivity.id, title: `Toalhas ${s}` },
      });
      await assertOk(byManager, 'item extra do gestor');
      const byPortal = await portal.api.post(`/api/portal/my-events/${party.eventId}/material-checklist/items`, {
        data: { activityId: rainActivity.id, title: `Pano de chão ${s}` },
      });
      await assertOk(byPortal, 'item extra do Portal');

      // "Materiais separados" só conta a lista principal: a principal conferida
      // atende o requisito com o material do Plano B ainda pendente.
      checklist = await apiGetMaterialChecklist(authApi, party.eventId);
      for (const title of [`Toalhas ${s}`, `Pano de chão ${s}`]) {
        const item = checklist.groups.flatMap((g) => g.items).find((i) => i.title === title);
        expect(item?.scope, title).toBe('RainPlan');
      }
      const mainItem = checklist.groups.flatMap((g) => g.items).find((i) => i.productId === mainProduct.id)!;
      expect(mainItem.scope).toBe('Main');
      await assertOk(
        await authApi.post(`/api/events/${party.eventId}/material-checklist/items/${mainItem.id}/check`, { data: {} }),
        'check principal',
      );
      const laterItem = checklist.groups.flatMap((g) => g.items).find((i) => i.productId === laterProduct.id)!;
      expect(laterItem.scope).toBe('RainPlan');
      await assertOk(
        await authApi.post(`/api/events/${party.eventId}/material-checklist/items/${laterItem.id}/check`, { data: {} }),
        'check do Plano B',
      );
      const materials = (await apiGetReadiness(authApi, party.eventId)).find((r) => r.key === 'material_checklist_done');
      expect(materials?.isMet, 'o Plano B pendente não segura "Materiais separados"').toBe(true);

      // Tira a atividade do plano: os itens que alguém acrescentou ficam "não precisa mais".
      await apiPutRainPlan(authApi, party.eventId, [{ activityId: laterContracted.id }]);
      checklist = await apiGetMaterialChecklist(authApi, party.eventId);
      const leftover = checklist.groups.find((g) => g.activityId === rainActivity.id);
      expect(leftover?.isInEvent).toBe(false);
      for (const title of [`Toalhas ${s}`, `Pano de chão ${s}`]) {
        const item = leftover?.items.find((i) => i.title === title);
        expect(item?.isStale, title).toBe(true);
      }

      // A atividade do plano passa a ser contratada: a linha vai para a principal, conferida.
      await assertOk(
        await authApi.post(`/api/events/${party.eventId}/pricing-items/from-source`, {
          data: {
            sourceType: 'Activity',
            sourceId: laterContracted.id,
            descriptionOverride: null,
            quantity: 1,
            unit: null,
            discountAmount: 0,
            additionalAmount: 0,
            notes: null,
          },
        }),
        'POST pricing-items/from-source',
      );
      checklist = await apiGetMaterialChecklist(authApi, party.eventId);
      const moved = checklist.groups.flatMap((g) => g.items).filter((i) => i.productId === laterProduct.id);
      expect(moved).toHaveLength(1);
      expect(moved[0]!.id).toBe(laterItem.id);
      expect(moved[0]!.scope).toBe('Main');
      expect(moved[0]!.status).toBe('Checked');
      const stale = (await apiGetRainPlan(authApi, party.eventId)).plan!.items.find(
        (i) => i.activityId === laterContracted.id,
      );
      expect(stale?.isStale).toBe(true);
      expect(stale?.staleReason).toBe('ActivityContracted');
    } finally {
      await portal.api.dispose();
    }
  });

  // ───────────────────────────── PB-D (Etapa 225) ─────────────────────────────

  // E24 — D1 e §6 "Settings".
  test('@flow E24: with RAIN_PLAN_REMINDER_ENABLED off, the rainy open-air party of tomorrow gets no warning and the card says the lookup is off (settings link only with settings.read); turned back on, warning and forecast return', async ({
    authApi,
    authPage,
    browser,
    tenant,
  }) => {
    test.setTimeout(3 * TRIGGER_TIMEOUT + 120_000);
    await apiCompleteOnboarding(authApi);
    const party = await setupRainParty(authApi);
    await apiSetSettingParameter(authApi, 'RAIN_PLAN_REMINDER_ENABLED', 'false');

    await apiTriggerDailyJob(authApi);
    const warned = async () =>
      (await apiListNotifications(authApi)).filter(
        (n) => n.type === 'RainPlanSuggested' && n.contextEntityId === party.eventId,
      ).length;
    expect(await warned(), 'desligado não avisa').toBe(0);

    const off = await apiGetRainForecast(authApi, party.eventId);
    expect(off.forecast).toBeNull();
    expect(off.unavailableReason).toBe('Disabled');

    await openRainPlanTab(authPage, party.eventId);
    await expect(authPage.getByTestId('rain-forecast-unavailable')).toContainText(
      'Consulta da previsão do tempo desligada',
    );
    await expect(authPage.getByTestId('rain-forecast-settings-link')).toBeVisible();

    const financial = await openAsFinancial(browser, tenant.tenantId);
    try {
      await openRainPlanTab(financial.page, party.eventId);
      await expect(financial.page.getByTestId('rain-forecast-unavailable')).toContainText(
        'Consulta da previsão do tempo desligada',
      );
      await expect(financial.page.getByTestId('rain-forecast-settings-link')).toHaveCount(0);
    } finally {
      await financial.close();
    }

    await apiSetSettingParameter(authApi, 'RAIN_PLAN_REMINDER_ENABLED', 'true');
    await apiTriggerDailyJob(authApi);
    await expect.poll(warned, { message: 'religado, o aviso volta' }).toBe(1);
    const on = await apiGetRainForecast(authApi, party.eventId);
    expect(on.forecast?.precipitationProbability).toBe(85);

    // A API já respondeu 85 acima; aqui a prova é o card. Reabre a festa até a
    // aba montar: com o 6.8 sozinho, E24 e E26 rodam lado a lado (os dois com o
    // job diário) e a recarga do detalhe frio já passou dos 20 s sem montar o
    // card (`element(s) not found`, nunca outro valor).
    await expect(async () => {
      await openRainPlanTab(authPage, party.eventId);
      await expect(authPage.getByTestId('rain-forecast-summary')).toContainText('85%', { timeout: 20_000 });
    }).toPass({ timeout: 90_000 });
  });

  // E26 — §6 "Notificações" (`ROUTE_BY_TYPE` → `?tab=rain-plan`).
  test('@flow E26: the "Chuva prevista" and the "Plano B ativado" notifications in the manager bell open the party on the "Plano B (chuva)" tab; a non-commercial party ignores the request', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(TRIGGER_TIMEOUT + 180_000);
    await apiCompleteOnboarding(authApi);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_ticketing');
    const s = uniqueSuffix();
    const indoor = await indoorActivity(authApi, `Mímica ${s}`);
    const party = await setupRainParty(authApi);
    await apiPutRainPlan(authApi, party.eventId, [{ activityId: indoor.id }]);

    await apiTriggerDailyJob(authApi);
    const manager = await loginAsRole(tenant.tenantId, 'Manager');
    try {
      // Quem ativa não é avisado: o Manager ativa, o sino do admin recebe.
      await apiActivateRainPlan(manager.api, party.eventId, 'Previsão de chuva');
    } finally {
      await manager.api.dispose();
    }

    const notifications = await apiListNotifications(authApi);
    const suggested = notifications.find((n) => n.type === 'RainPlanSuggested' && n.contextEntityId === party.eventId);
    const activated = notifications.find((n) => n.type === 'RainPlanActivated' && n.contextEntityId === party.eventId);
    expect(suggested, 'aviso de chuva no sino do admin').toBeTruthy();
    expect(activated, 'Plano B ativado no sino do admin').toBeTruthy();

    for (const notification of [suggested!, activated!]) {
      // O clique no sino é o que se prova; refaz o caminho inteiro se a página
      // ficar em `/app` (visto com o 6.8 sozinho: o detalhe frio, lazy, não
      // trocou a URL em 10 s), como o retry da aba na E14.
      await expect(async () => {
        await authPage.goto('/app');
        await authPage.getByTestId('notification-bell').click({ timeout: 10_000 });
        const open = authPage.getByTestId(`notification-open-${notification.id}`);
        await expect(open).toBeVisible({ timeout: 15_000 });
        await open.click({ timeout: 5_000 });
        await expect(authPage).toHaveURL(new RegExp(`/app/events/${party.eventId}\\?tab=rain-plan`), {
          timeout: 20_000,
        });
      }).toPass({ timeout: 90_000 });
      await expect(rainPlanTab(authPage)).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 });
      await expect(authPage.getByTestId('rain-plan-venue')).toBeVisible();
    }

    const publicEvent = await apiCreatePublicEvent(authApi);
    await authPage.goto(`/app/events/${publicEvent.id}?tab=rain-plan`);
    await expect(authPage.getByTestId('event-detail-tabs')).toBeVisible({ timeout: 20_000 });
    await expect(rainPlanTab(authPage)).toHaveCount(0);
    await expect(authPage.getByRole('tab', { name: 'Visão geral', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  // E28 — §6 "Prontidão" (`rain_plan_ready`).
  test('@flow E28: open-air party without a ready plan shows the recommended "rain_plan_ready" pending, met after saving the plan with an activity; a covered venue has no such requirement', async ({
    authApi,
  }) => {
    test.setTimeout(120_000);
    const s = uniqueSuffix();
    const indoor = await indoorActivity(authApi, `Mímica ${s}`);
    const openAir = await setupRainParty(authApi);

    let requirement = (await apiGetReadiness(authApi, openAir.eventId)).find((r) => r.key === 'rain_plan_ready');
    expect(requirement, 'ao ar livre mostra o requisito').toBeTruthy();
    expect(requirement!.level).toBe('Recommended');
    expect(requirement!.isMet).toBe(false);

    await apiPutRainPlan(authApi, openAir.eventId, [{ activityId: indoor.id }]);
    requirement = (await apiGetReadiness(authApi, openAir.eventId)).find((r) => r.key === 'rain_plan_ready');
    expect(requirement?.isMet).toBe(true);

    const covered = await setupRainParty(authApi, { venue: 'Sheltered' });
    expect((await apiGetReadiness(authApi, covered.eventId)).find((r) => r.key === 'rain_plan_ready')).toBeUndefined();
  });

  // E29 — §6, tabela "Ativação" (quatro eixos).
  test('@crud E29: without events.update there is no "Ativar"/"Desativar" and the API returns 403 unchanged; another tenant gets 404 on activate, deactivate and forecast; a Portal user gets 403 on forecast; a draft plan refuses activation', async ({
    authApi,
    browser,
    tenant,
  }) => {
    test.setTimeout(180_000);
    await apiCompleteOnboarding(authApi);
    const s = uniqueSuffix();
    const indoor = await indoorActivity(authApi, `Mímica ${s}`);
    const party = await setupRainParty(authApi);
    await apiPutRainPlan(authApi, party.eventId, [{ activityId: indoor.id }]);
    const url = `/api/events/${party.eventId}/rain-plan`;

    const financial = await openAsFinancial(browser, tenant.tenantId);
    try {
      expect((await financial.api.post(`${url}/activate`, { data: { reason: null } })).status()).toBe(403);
      expect((await apiGetRainPlan(authApi, party.eventId)).plan!.status).toBe('Ready');
      await openRainPlanTab(financial.page, party.eventId);
      await expect(financial.page.getByTestId('rain-plan-list-readonly')).toBeVisible();
      await expect(financial.page.getByTestId('rain-plan-activate')).toHaveCount(0);

      await apiActivateRainPlan(authApi, party.eventId);
      expect((await financial.api.post(`${url}/deactivate`)).status()).toBe(403);
      expect((await apiGetRainPlan(authApi, party.eventId)).plan!.status).toBe('Activated');
      await financial.page.reload();
      await expect(financial.page.getByTestId('rain-plan-active-banner')).toBeVisible({ timeout: 20_000 });
      await expect(financial.page.getByTestId('rain-plan-deactivate')).toHaveCount(0);
    } finally {
      await financial.close();
    }

    const other = await otherTenant();
    try {
      expect((await other.api.post(`${url}/activate`, { data: { reason: null } })).status()).toBe(404);
      expect((await other.api.post(`${url}/deactivate`)).status()).toBe(404);
      expect((await other.api.get(`${url}/forecast`)).status()).toBe(404);
    } finally {
      await other.api.dispose();
    }
    expect((await apiGetRainPlan(authApi, party.eventId)).plan!.status, 'nada mudou').toBe('Activated');

    const { portal } = await setupConfirmedPortalCollaborator(authApi, tenant.tenantId, party.eventId);
    try {
      expect((await portal.api.get(`${url}/forecast`)).status()).toBe(403);
    } finally {
      await portal.api.dispose();
    }

    const draft = await setupRainParty(authApi);
    await apiPutRainPlan(authApi, draft.eventId, []);
    expect((await apiGetRainPlan(authApi, draft.eventId)).plan!.status).toBe('Draft');
    const refused = await authApi.post(`/api/events/${draft.eventId}/rain-plan/activate`, { data: { reason: null } });
    expect(refused.ok()).toBe(false);
    expect(await apiErrorCodes(refused)).toContain('EventRainPlan.NotReady');
    expect((await apiGetRainPlan(authApi, draft.eventId)).plan!.status).toBe('Draft');
  });

  // ───────────────────────────── PB-E (Etapa 226) ─────────────────────────────

  // E8 — §7 itens 4 e 5, "Front".
  test('@flow E8: with the add-on and the "Plano B de chuva com IA" card on, "Sugerir com IA" drops an item with an unknown id, brings the free game with the "sugestão da IA" seal and the tips; saving stores the free item with source Ai and the seal goes away', async ({
    authApi,
    authPage,
  }) => {
    test.setTimeout(150_000);
    await apiCompleteOnboarding(authApi);
    await apiSetAiFeature(authApi, RAIN_PLAN_AI, true);
    const s = uniqueSuffix();
    const indoor = await indoorActivity(authApi, `Mímica ${s}`);
    const party = await setupRainParty(authApi);
    const invented = randomUUID();

    await aiSuggestScript(party.contracted.id, {
      items: [
        {
          activityId: indoor.id,
          title: indoor.name,
          description: 'Em roda, sentados',
          replacesActivityId: party.contracted.id,
          durationMinutes: 30,
          groups: 2,
        },
        { activityId: invented, title: `Inventada ${s}`, description: null, replacesActivityId: null, durationMinutes: 20, groups: 1 },
        {
          activityId: null,
          title: `Estátua ${s}`,
          description: 'A música para e todos congelam',
          replacesActivityId: null,
          durationMinutes: 20,
          groups: 1,
        },
      ],
      tips: [`Divida as crianças em duas estações ${s}`],
    });

    await openRainPlanTab(authPage, party.eventId);
    await authPage.getByTestId('rain-plan-suggest-ai').click();
    const panel = authPage.getByTestId('rain-plan-ai-suggestions');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.locator('li[data-testid^="rain-plan-ai-item-"]')).toHaveCount(2);
    await expect(panel).toContainText(indoor.name);
    await expect(panel).toContainText(`Estátua ${s}`);
    await expect(panel).not.toContainText(`Inventada ${s}`);

    await authPage.getByTestId('rain-plan-ai-suggestions-accept').click();
    await expect(authPage.locator('[data-testid^="rain-plan-item-ai-badge-"]')).toHaveCount(2);
    await expect(authPage.getByTestId('rain-plan-ai-tips')).toContainText(`Divida as crianças em duas estações ${s}`);

    await authPage.getByTestId('rain-plan-save').click();
    await expect(authPage.getByTestId('rain-plan-status')).toHaveText('Pronto');
    await expect(authPage.locator('[data-testid^="rain-plan-item-ai-badge-"]')).toHaveCount(0);

    const plan = (await apiGetRainPlan(authApi, party.eventId)).plan!;
    const free = plan.items.find((i) => i.activityId === null);
    expect(free?.title).toBe(`Estátua ${s}`);
    expect(free?.source).toBe('Ai');
    expect(plan.items.find((i) => i.activityId === indoor.id)).toBeTruthy();
    expect(plan.items.some((i) => i.title === `Inventada ${s}`)).toBe(false);
  });

  // E33 — §7.2 (gate do add-on e da Central).
  test('@flow E33: "Sugerir com IA" is hidden without the feature_ai add-on and with the card off (born off); turning the card on shows it beside "Sugerir Plano B"; without the add-on the AI endpoint gives the entitlement 403 and read, save and rule suggestion keep working', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(150_000);
    await apiCompleteOnboarding(authApi);
    const s = uniqueSuffix();
    const indoor = await indoorActivity(authApi, `Mímica ${s}`);
    const party = await setupRainParty(authApi);

    expect((await rainPlanAiCard(authApi)).enabled, 'o card nasce desligado').toBe(false);
    const centralLoaded = authPage.waitForResponse((r) => r.url().includes('/api/ai/features'));
    await openRainPlanTab(authPage, party.eventId);
    await centralLoaded;
    await expect(authPage.getByTestId('rain-plan-suggest')).toBeVisible();
    await expect(authPage.getByTestId('rain-plan-suggest-ai')).toHaveCount(0);

    await apiSetAiFeature(authApi, RAIN_PLAN_AI, true);
    await authPage.reload();
    await expect(authPage.getByTestId('rain-plan-suggest-ai')).toBeVisible({ timeout: 20_000 });
    await expect(authPage.getByTestId('rain-plan-suggest')).toBeVisible();

    // Sem o add-on (o teste do signup é do plano que já traz `feature_ai`).
    setSubscriptionPlanDirect(tenant.tenantId, 'plan_free');
    const ai = await authApi.post(`/api/events/${party.eventId}/rain-plan/suggestions/ai`);
    expect(ai.status()).toBe(403);
    expect(await apiErrorCodes(ai)).toContain('Entitlement.NotIncludedInPlan');

    expect((await apiGetRainPlan(authApi, party.eventId)).plan).toBeNull();
    expect((await apiSuggestRainPlan(authApi, party.eventId)).candidates.map((c) => c.activityId)).toContain(indoor.id);
    await apiPutRainPlan(authApi, party.eventId, [{ activityId: indoor.id }]);
    expect((await apiGetRainPlan(authApi, party.eventId)).plan!.status).toBe('Ready');

    await authPage.reload();
    await expect(authPage.getByTestId('rain-plan-suggest-again')).toBeVisible({ timeout: 20_000 });
    await expect(authPage.getByTestId('rain-plan-suggest-ai')).toHaveCount(0);
  });

  // E34 — §7.4 (fallback para a regra) e estado de erro do botão.
  test('@flow E34: AI answering only invented ids opens the rule suggestion with the warning and saves nothing; provider down shows the button message pointing to "Sugerir Plano B"', async ({
    authApi,
    authPage,
  }) => {
    test.setTimeout(150_000);
    await apiCompleteOnboarding(authApi);
    await apiSetAiFeature(authApi, RAIN_PLAN_AI, true);
    const s = uniqueSuffix();
    const indoor = await indoorActivity(authApi, `Mímica ${s}`);
    const party = await setupRainParty(authApi);

    await aiSuggestScript(party.contracted.id, {
      items: [
        { activityId: randomUUID(), title: `Inventada A ${s}`, description: null, replacesActivityId: null, durationMinutes: 20, groups: 1 },
        { activityId: randomUUID(), title: `Inventada B ${s}`, description: null, replacesActivityId: null, durationMinutes: 20, groups: 1 },
      ],
      tips: [],
    });

    await openRainPlanTab(authPage, party.eventId);
    await authPage.getByTestId('rain-plan-suggest-ai').click();
    const rulePanel = authPage.getByTestId('rain-plan-suggestions');
    await expect(rulePanel).toBeVisible({ timeout: 30_000 });
    await expect(authPage.getByTestId('rain-plan-ai-fallback-warning')).toContainText(
      'A IA não trouxe sugestões aproveitáveis',
    );
    await expect(rulePanel.getByTestId(`rain-plan-candidate-${indoor.id}`)).toBeVisible();
    await expect(authPage.getByTestId('rain-plan-ai-suggestions')).toHaveCount(0);
    expect((await apiGetRainPlan(authApi, party.eventId)).plan, 'nada gravado').toBeNull();

    await authPage.getByTestId('rain-plan-suggestions-close').click();
    await fakeOpenAi.failNext(party.contracted.id, 10);
    try {
      await authPage.getByTestId('rain-plan-suggest-ai').click();
      await expect(authPage.getByTestId('rain-plan-ai-error')).toHaveText(
        'A IA não respondeu agora. Tente de novo em instantes ou use "Sugerir Plano B", que não depende da IA.',
        { timeout: 30_000 },
      );
    } finally {
      await fakeOpenAi.failNext(party.contracted.id, 0);
    }
    expect((await apiGetRainPlan(authApi, party.eventId)).plan).toBeNull();
  });

  // E35 — §7 "Testes" (quatro eixos) e item 6 (uso registrado).
  test('@crud E35: AI suggestion axes: without events.update no button and 403; another tenant gets 404 without calling the provider; canceled party gets 409; the call shows in the card usage of the month', async ({
    authApi,
    browser,
    tenant,
  }) => {
    test.setTimeout(180_000);
    await apiCompleteOnboarding(authApi);
    await apiSetAiFeature(authApi, RAIN_PLAN_AI, true);
    const s = uniqueSuffix();
    const indoor = await indoorActivity(authApi, `Mímica ${s}`);
    const party = await setupRainParty(authApi);
    const url = `/api/events/${party.eventId}/rain-plan/suggestions/ai`;

    const financial = await openAsFinancial(browser, tenant.tenantId);
    try {
      expect((await financial.api.post(url)).status()).toBe(403);
      await openRainPlanTab(financial.page, party.eventId);
      await expect(financial.page.getByTestId('rain-plan-readonly-hint')).toBeVisible();
      await expect(financial.page.getByTestId('rain-plan-suggest-ai')).toHaveCount(0);
    } finally {
      await financial.close();
    }

    const since = new Date().toISOString();
    const other = await otherTenant();
    try {
      await apiSetAiFeature(other.api, RAIN_PLAN_AI, true);
      expect((await other.api.post(url)).status()).toBe(404);
    } finally {
      await other.api.dispose();
    }
    const prompts = (await fakeOpenAi.inbox({ path: '/chat/completions', since })).filter((e) =>
      JSON.stringify(e.body).includes(party.contracted.id),
    );
    expect(prompts, 'o outro tenant não chegou ao provedor').toHaveLength(0);

    const canceled = await setupRainParty(authApi);
    await assertOk(
      await authApi.post(`/api/events/${canceled.eventId}/cancel`, { data: { reason: 'Cliente desistiu (E2E)' } }),
      'POST cancel',
    );
    const locked = await authApi.post(`/api/events/${canceled.eventId}/rain-plan/suggestions/ai`);
    expect(locked.status()).toBe(409);
    expect(await apiErrorCodes(locked)).toContain('EventRainPlan.EventLocked');

    const usedBefore = (await rainPlanAiCard(authApi)).tokensUsedThisMonth;
    await aiSuggestScript(party.contracted.id, {
      items: [{ activityId: indoor.id, title: indoor.name, description: null, replacesActivityId: null, durationMinutes: 30, groups: 1 }],
      tips: [],
    });
    const ok = await authApi.post(url);
    await assertOk(ok, 'POST rain-plan/suggestions/ai');
    expect((await readJson<{ items: unknown[] }>(ok)).items).toHaveLength(1);
    expect((await rainPlanAiCard(authApi)).tokensUsedThisMonth).toBeGreaterThan(usedBefore);
  });
});
