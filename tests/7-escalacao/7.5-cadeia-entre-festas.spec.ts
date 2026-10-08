import { APIRequestContext, Page } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import {
  apiCompleteOnboarding,
  apiCreateActivity,
  apiCreateCollaborator,
  apiCreateProduct,
  apiSetEventDepartureLocation,
  apiSetSettingParameter,
  apiUpdateStockLocation,
} from '../../helpers/api-entities';
import { apiAssignCollaborator } from '../../helpers/api-event-flow';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';
import { type FakeGooglePlaces, type FakeLatLng, fakeGoogleMaps, uniquePointNear } from '../../helpers/fake-providers';
import { assertOk, readJson } from '../../helpers/response';
import {
  loginPortalCollaborator,
  portalDeclareUnavailable,
  setupAcceptedEvent,
} from '../../helpers/setup-flows';
import { WEEK_STAFFING_ROUTE as ROUTE, addressAt, escapeRegExp, nextSaturday } from '../../helpers/week-staffing';

/**
 * Fluxo: 7.5 — Deslocamento entre festas e material a bordo
 * Diagrama: docs/fluxos/negocio-7.5-cadeia-entre-festas.mmd
 * Plano: docs/implementados/PLANO-ESCALACAO-DA-SEMANA.md §6 (ESC-B, Etapa 220),
 * §13 registro e2e E4, E5, E6 e E7.
 *
 * Regra da cadeia (decisão 15): entre duas festas do mesmo dia a perna A->B
 * conta uma vez e o intervalo real é `(início de B - chegada) - (fim de A +
 * desmontagem) - perna(A->B)`; abaixo do mínimo é H2 (duro). Sem coordenada o
 * deslocamento vira I4 (Info, nunca no POST). Fora da disponibilidade
 * declarada é S6 (Soft); material que ninguém da equipe busca a tempo é S7.
 *
 * Coordenadas: um ponto ÚNICO por teste perto de cada lugar da tabela do fake
 * (`uniquePointNear`), com os minutos do cenário base gravados por
 * `putDistances`. Os workers não disputam a tabela, e o cache de 24 h do back
 * por par nunca viu esses pontos.
 */

// Defaults do tenant (§6.1, exemplo do plano): chegada 15, desmontagem 15,
// intervalo mínimo 30. A 13:00-16:00 e B 17:30 com perna 20 => 40 min.
const MIN_GAP_KEY = 'COLLABORATOR_MIN_GAP_MINUTES';

interface Scenario {
  pA: FakeLatLng;
  pB: FakeLatLng;
  pD: FakeLatLng;
}

/** Pontos únicos do cenário base e os minutos de §13 entre eles. */
async function baseScenario(places: FakeGooglePlaces): Promise<Scenario> {
  const pA = uniquePointNear(places.batel);
  const pB = uniquePointNear(places.aguaVerde);
  const pD = uniquePointNear(places.colombo);
  await fakeGoogleMaps.putDistances([
    { from: pA, to: pB, minutes: 20 },
    { from: pA, to: pD, minutes: 50 },
    { from: pB, to: pD, minutes: 55 },
  ]);
  return { pA, pB, pD };
}

/** Casa única com os minutos até cada festa do cenário (fora da tabela cairia no hash do fake). */
async function homeNear(base: FakeLatLng, legs: Array<{ to: FakeLatLng; minutes: number }>): Promise<FakeLatLng> {
  const home = uniquePointNear(base);
  await fakeGoogleMaps.putDistances(legs.map((l) => ({ from: home, to: l.to, minutes: l.minutes })));
  return home;
}

async function partyAt(
  api: APIRequestContext,
  input: {
    date: string;
    start: string;
    end: string;
    point: FakeLatLng;
    place: string;
    teamSize?: number;
    activityIds?: string[];
  },
): Promise<string> {
  const { eventId } = await setupAcceptedEvent(api, {
    activityIds: input.activityIds,
    budget: {
      eventDate: input.date,
      startTime: input.start,
      endTime: input.end,
      teamSize: input.teamSize ?? 2,
      eventLocation: input.place,
      address: addressAt(input.point, input.place),
    },
  });
  return eventId;
}

/** Abre o painel de candidatos da festa e devolve o card do colaborador nele. */
async function candidateCard(page: Page, eventId: string, collaboratorId: string) {
  await page.getByTestId(`week-staffing-toggle-${eventId}`).click();
  const panel = page.getByTestId(`week-staffing-candidates-${eventId}`);
  const card = panel.getByTestId(`week-staffing-candidate-${collaboratorId}`);
  await expect(card).toBeVisible();
  return card;
}

/**
 * A perna que CHEGA nesta festa no card ("… → esta festa · intervalo …"). A
 * direção vem do atributo `data-direction` (`arriving` | `leaving`), não do
 * texto: a frase muda de redação sem mudar de sentido.
 */
function arrivingLeg(page: Page, eventId: string, collaboratorId: string) {
  return page
    .getByTestId(`week-staffing-candidates-${eventId}`)
    .locator(`[data-testid="week-staffing-chain-${collaboratorId}"][data-direction="arriving"]`);
}

/**
 * Reserva o material da festa e devolve o Local Principal. O aceite PÚBLICO
 * (anônimo) não reserva no e2e; a troca do local de saída, autenticada, roda o
 * mesmo `SyncAsync` da reserva, que provisiona o Principal (só a escrita o cria)
 * e reserva o consumível nele.
 */
async function primaryLocationAfterReserving(
  api: APIRequestContext,
  eventId: string,
): Promise<{ id: string; name: string }> {
  await apiSetEventDepartureLocation(api, eventId, null);
  const res = await api.get('/api/stock/locations');
  await assertOk(res, 'GET /api/stock/locations');
  const body = await readJson<
    Array<{ id: string; name: string; isPrimary: boolean }> | { items: Array<{ id: string; name: string; isPrimary: boolean }> }
  >(res);
  const items = Array.isArray(body) ? body : body.items;
  const primary = items.find((l) => l.isPrimary);
  expect(primary, 'o tenant com feature_stock tem o Local Principal').toBeTruthy();
  return { id: primary!.id, name: primary!.name };
}

/** Atividade com um consumível: com `feature_stock`, o aceite reserva o material da festa. */
async function materialActivity(api: APIRequestContext): Promise<string> {
  const product = await apiCreateProduct(api, { isReusable: false });
  const activity = await apiCreateActivity(api, {
    activityProducts: [{ productId: product.id, qtyPerChild: 1, isChecklistOnly: false }],
  });
  return activity.id;
}

test.describe('Fluxo 7.5 — Deslocamento entre festas e material a bordo', () => {
  // --- E4 ---
  test('@flow E4: the chain leg A->B shows the real interval, the tenant minimum governs, and the Team tab says where she comes from', async ({
    authApi,
    authPage,
  }) => {
    const suffix = Date.now().toString(36);
    const saturday = nextSaturday();
    const places = await fakeGoogleMaps.places();
    const { pA, pB, pD } = await baseScenario(places);

    const carlaHome = await homeNear(places.centro, [
      { to: pA, minutes: 12 },
      { to: pB, minutes: 15 },
      { to: pD, minutes: 40 },
    ]);
    const carla = await apiCreateCollaborator(authApi, {
      name: `Carla ${suffix}`,
      address: addressAt(carlaHome, 'Centro'),
    });

    const eventA = await partyAt(authApi, { date: saturday, start: '13:00', end: '16:00', point: pA, place: 'Batel' });
    const eventB = await partyAt(authApi, {
      date: saturday,
      start: '17:30',
      end: '20:30',
      point: pB,
      place: 'Água Verde',
    });
    const eventD = await partyAt(authApi, {
      date: saturday,
      start: '17:30',
      end: '20:30',
      point: pD,
      place: 'Colombo',
    });
    await apiAssignCollaborator(authApi, eventA, carla.id);
    await apiCompleteOnboarding(authApi);

    // B: 17:15 - 16:15 - 20 = 40 min, acima do mínimo de 30 => verde.
    await authPage.goto(ROUTE);
    await candidateCard(authPage, eventB, carla.id);
    const legB = arrivingLeg(authPage, eventB, carla.id);
    await expect(legB).toHaveCount(1);
    await expect(legB).toHaveText(/Batel 13:00[–-]16:00 → 20 min de deslocamento → esta festa · intervalo 40 min\s*$/);
    await expect(legB).toHaveAttribute('data-verdict', 'fits');
    await expect(authPage.getByTestId(`week-staffing-escalate-${carla.id}`)).toBeEnabled();

    // D: 60 - 50 = 10 min < 30 => H2, vermelho, Escalar desabilitado.
    const cardD = await candidateCard(authPage, eventD, carla.id);
    const legD = arrivingLeg(authPage, eventD, carla.id);
    await expect(legD).toHaveText(/→ 50 min de deslocamento → esta festa · intervalo 10 min, abaixo do mínimo\s*$/);
    await expect(legD).toHaveAttribute('data-verdict', 'blocked');
    await expect(cardD.locator('[data-testid="conflict-viewer-item"][data-code="H2"]')).toHaveAttribute(
      'data-severity',
      'Hard',
    );
    await expect(cardD.getByTestId(`week-staffing-escalate-${carla.id}`)).toBeDisabled();

    // Intervalo mínimo 60 nas Configurações => os 40 min de B também viram H2.
    await apiSetSettingParameter(authApi, MIN_GAP_KEY, 60);
    await authPage.goto(ROUTE);
    const cardB60 = await candidateCard(authPage, eventB, carla.id);
    const legB60 = arrivingLeg(authPage, eventB, carla.id);
    await expect(legB60).toHaveText(/→ 20 min de deslocamento → esta festa · intervalo 40 min, abaixo do mínimo\s*$/);
    await expect(legB60).toHaveAttribute('data-verdict', 'blocked');
    await expect(cardB60.getByTestId(`week-staffing-escalate-${carla.id}`)).toBeDisabled();

    // De volta ao padrão, escala em B pelo quadro.
    await apiSetSettingParameter(authApi, MIN_GAP_KEY, 30);
    await authPage.goto(ROUTE);
    const cardB = await candidateCard(authPage, eventB, carla.id);
    await cardB.getByTestId(`week-staffing-escalate-${carla.id}`).click();
    await expect(authPage.getByTestId(`week-staffing-member-${eventB}-${carla.id}`)).toBeVisible();

    // Aba Equipe de B: a coluna "Chegada" diz de onde ela vem (derivada na leitura).
    await authPage.goto(`/app/events/${eventB}`);
    await authPage.getByRole('tab', { name: 'Equipe', exact: true }).click();
    await expect(authPage.getByTestId(`event-detail-team-arrival-${carla.id}`)).toHaveText(
      /vem da festa das 13:00[–-]16:00.*, 20 min\s*$/,
    );
  });

  // --- E5 ---
  test('@flow E5: a collaborator without coordinates gets the grey "Deslocamento não estimado" badge and the assign asks for no justification', async ({
    authApi,
    authPage,
  }) => {
    const suffix = Date.now().toString(36);
    const places = await fakeGoogleMaps.places();
    const pB = uniquePointNear(places.aguaVerde);

    // Endereço padrão do helper: sem latitude/longitude.
    const noCoordinates = await apiCreateCollaborator(authApi, { name: `Sem coordenada ${suffix}` });
    const eventB = await partyAt(authApi, {
      date: nextSaturday(),
      start: '17:30',
      end: '20:30',
      point: pB,
      place: 'Água Verde',
    });
    await apiCompleteOnboarding(authApi);

    await authPage.goto(ROUTE);
    const card = await candidateCard(authPage, eventB, noCoordinates.id);
    const notice = card.locator(`[data-testid="week-staffing-notice-${noCoordinates.id}"][data-code="I4"]`);
    await expect(notice).toHaveText(/Deslocamento não estimado/);
    // §6 do plano: I4 "em cinza" (o tom neutro do quadro).
    await expect(notice).toHaveAttribute('data-tone', 'neutral');
    // Info não é conflito: nada de bloco no conflict-viewer.
    await expect(card.locator('[data-testid="conflict-viewer-item"]')).toHaveCount(0);

    const assign = authPage.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/events/${eventB}/collaborators`,
    );
    await card.getByTestId(`week-staffing-escalate-${noCoordinates.id}`).click();
    const res = await assign;
    expect(res.status(), 'Info nunca vem no POST: o assign passa direto').toBeLessThan(300);
    expect(res.request().postDataJSON()).not.toHaveProperty('overrideReason');
    await expect(authPage.getByTestId(`week-staffing-override-reason-${noCoordinates.id}`)).toHaveCount(0);
    await expect(authPage.getByTestId(`week-staffing-member-${eventB}-${noCoordinates.id}`)).toBeVisible();
  });

  // --- E6 ---
  test('@flow E6: Diego declared himself unavailable in the Portal (S6 asks for a justification); Ana never declared and is assigned straight', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    const suffix = Date.now().toString(36);
    const saturday = nextSaturday();
    const places = await fakeGoogleMaps.places();
    const pB = uniquePointNear(places.aguaVerde);

    const diego = await apiCreateCollaborator(authApi, { name: `Diego ${suffix}` });
    const ana = await apiCreateCollaborator(authApi, { name: `Ana ${suffix}` });
    const eventB = await partyAt(authApi, {
      date: saturday,
      start: '17:30',
      end: '20:30',
      point: pB,
      place: 'Água Verde',
      teamSize: 3,
    });

    const portal = await loginPortalCollaborator(tenant.tenantId, diego.id);
    try {
      await portalDeclareUnavailable(portal.api, saturday, 'Aniversário da família');
    } finally {
      await portal.api.dispose();
    }
    await apiCompleteOnboarding(authApi);

    await authPage.goto(ROUTE);
    const diegoCard = await candidateCard(authPage, eventB, diego.id);
    await expect(authPage.getByTestId(`week-staffing-outside-declared-${diego.id}`)).toBeVisible();
    await expect(diegoCard.locator('[data-testid="conflict-viewer-item"][data-code="S6"]')).toHaveAttribute(
      'data-severity',
      'Soft',
    );

    // Ana nunca declarou: "não declarado" não pune, o assign passa direto.
    const anaCard = authPage.getByTestId(`week-staffing-candidate-${ana.id}`);
    await expect(anaCard).toBeVisible();
    await expect(authPage.getByTestId(`week-staffing-outside-declared-${ana.id}`)).toHaveCount(0);
    await expect(anaCard.locator('[data-testid="conflict-viewer-item"][data-code="S6"]')).toHaveCount(0);
    await anaCard.getByTestId(`week-staffing-escalate-${ana.id}`).click();
    await expect(authPage.getByTestId(`week-staffing-override-reason-${ana.id}`)).toHaveCount(0);
    await expect(authPage.getByTestId(`week-staffing-member-${eventB}-${ana.id}`)).toBeVisible();

    // Diego: o Escalar abre a justificativa (Soft), e sem ela não confirma.
    await authPage.getByTestId(`week-staffing-escalate-${diego.id}`).click();
    const reason = authPage.getByTestId(`week-staffing-override-reason-${diego.id}`);
    await expect(reason).toBeVisible();
    const confirm = authPage.getByTestId(`week-staffing-confirm-escalate-${diego.id}`);
    await expect(confirm).toBeDisabled();
    await reason.fill('Combinado com ele por telefone');
    await confirm.click();
    await expect(authPage.getByTestId(`week-staffing-member-${eventB}-${diego.id}`)).toBeVisible();
  });

  // --- E7 ---
  test('@flow E7: with the material leaving from the primary location, the row suggests who carries it and how much detour it costs', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_stock');
    const suffix = Date.now().toString(36);
    const places = await fakeGoogleMaps.places();
    const pB = uniquePointNear(places.aguaVerde);
    const pL = uniquePointNear(places.centro);
    // Bruno sai de casa: casa->L 10 + parada 20 + L->B 15 = 45; direto 12 => +33.
    const brunoHome = uniquePointNear(places.batel);
    await fakeGoogleMaps.putDistances([
      { from: brunoHome, to: pL, minutes: 10 },
      { from: pL, to: pB, minutes: 15 },
      { from: brunoHome, to: pB, minutes: 12 },
    ]);

    const bruno = await apiCreateCollaborator(authApi, {
      name: `Bruno ${suffix}`,
      address: addressAt(brunoHome, 'Batel'),
    });
    const eventB = await partyAt(authApi, {
      date: nextSaturday(),
      start: '17:30',
      end: '20:30',
      point: pB,
      place: 'Água Verde',
      activityIds: [await materialActivity(authApi)],
    });
    // Depois do aceite: a reserva do material é o que garante o Local Principal.
    const primary = await primaryLocationAfterReserving(authApi, eventB);
    await apiUpdateStockLocation(authApi, primary.id, { address: addressAt(pL, 'Centro') });
    await apiSetEventDepartureLocation(authApi, eventB, primary.id);
    await apiAssignCollaborator(authApi, eventB, bruno.id);
    await apiCompleteOnboarding(authApi);

    await authPage.goto(ROUTE);
    await expect(authPage.getByTestId(`week-staffing-material-${eventB}`)).toHaveText(
      new RegExp(`material sai de ${escapeRegExp(primary.name)}\\s*$`),
    );
    const carrier = authPage.getByTestId(`week-staffing-carrier-${eventB}`);
    await expect(carrier).toContainText(`portador sugerido: Bruno ${suffix} (vem de casa, +33 min de desvio)`);
    await expect(authPage.getByTestId(`week-staffing-carrier-fix-${eventB}`)).toHaveText(
      'não é assim? defina o local de saída',
    );
    await expect(authPage.getByTestId(`week-staffing-carrier-unreachable-${eventB}`)).toHaveCount(0);
  });

  test('@flow E7: with every member measured and none reaching the departure in time, the row says so and the next assign asks for a justification (S7)', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_stock');
    const suffix = Date.now().toString(36);
    const saturday = nextSaturday();
    const places = await fakeGoogleMaps.places();
    const { pA, pB } = await baseScenario(places);
    const pL = uniquePointNear(places.centro);
    // Da festa A, passando em L: 40 + parada 20 + 15 = 75 > 60 de folga => ninguém chega.
    await fakeGoogleMaps.putDistances([
      { from: pA, to: pL, minutes: 40 },
      { from: pL, to: pB, minutes: 15 },
    ]);

    const carlaHome = await homeNear(places.centro, [{ to: pA, minutes: 12 }, { to: pB, minutes: 15 }, { to: pL, minutes: 5 }]);
    const eduHome = await homeNear(places.centro, [{ to: pA, minutes: 14 }, { to: pB, minutes: 16 }, { to: pL, minutes: 6 }]);
    const carla = await apiCreateCollaborator(authApi, { name: `Carla ${suffix}`, address: addressAt(carlaHome, 'Centro') });
    const edu = await apiCreateCollaborator(authApi, { name: `Edu ${suffix}`, address: addressAt(eduHome, 'Centro') });

    const eventA = await partyAt(authApi, { date: saturday, start: '13:00', end: '16:00', point: pA, place: 'Batel' });
    const eventB = await partyAt(authApi, {
      date: saturday,
      start: '17:30',
      end: '20:30',
      point: pB,
      place: 'Água Verde',
      teamSize: 3,
      activityIds: [await materialActivity(authApi)],
    });
    const primary = await primaryLocationAfterReserving(authApi, eventB);
    await apiUpdateStockLocation(authApi, primary.id, { address: addressAt(pL, 'Centro') });
    await apiSetEventDepartureLocation(authApi, eventB, primary.id);
    await apiAssignCollaborator(authApi, eventA, carla.id);
    await apiAssignCollaborator(authApi, eventA, edu.id);
    // Carla vem de A: a cadeia A->B cabe (40 min), mas passar em L não. Sozinha
    // na equipe de B, já é o S7 — justificado aqui, na pré-condição.
    await apiAssignCollaborator(authApi, eventB, carla.id, { overrideReason: 'Pré-condição do E2E' });
    await apiCompleteOnboarding(authApi);

    await authPage.goto(ROUTE);
    await expect(authPage.getByTestId(`week-staffing-carrier-${eventB}`)).toHaveCount(0);
    await expect(authPage.getByTestId(`week-staffing-carrier-unreachable-${eventB}`)).toContainText(
      `ninguém da equipe passa em ${primary.name} a tempo`,
    );

    // Edu também vem de A: com ele a equipe continua sem portador => S7, Soft.
    const eduCard = await candidateCard(authPage, eventB, edu.id);
    await eduCard.getByTestId(`week-staffing-escalate-${edu.id}`).click();
    const reason = authPage.getByTestId(`week-staffing-override-reason-${edu.id}`);
    await expect(reason).toBeVisible();
    await expect(eduCard.locator('[data-testid="conflict-viewer-item"][data-code="S7"]')).toHaveAttribute(
      'data-severity',
      'Soft',
    );
    await expect(authPage.getByTestId(`week-staffing-member-${eventB}-${edu.id}`)).toHaveCount(0);
    await reason.fill('Bruno passa no depósito antes');
    await authPage.getByTestId(`week-staffing-confirm-escalate-${edu.id}`).click();
    await expect(authPage.getByTestId(`week-staffing-member-${eventB}-${edu.id}`)).toBeVisible();
  });
});
