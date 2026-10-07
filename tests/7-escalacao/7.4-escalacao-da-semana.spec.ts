import { Page } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import {
  apiAddCollaboratorSkill,
  apiCompleteOnboarding,
  apiCreateActivity,
  apiCreateClient,
  apiCreateCollaborator,
  apiCreateProduct,
  apiFindOrCreateSkill,
  apiSetEventDepartureLocation,
} from '../../helpers/api-entities';
import { apiCreateBudget, apiGetEvent } from '../../helpers/api-event-flow';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';
import { type FakeLatLng, fakeGoogleMaps, uniquePointNear } from '../../helpers/fake-providers';
import { assertOk, readJson } from '../../helpers/response';
import { loginAsRole, openSessionPage, setupAcceptedEvent } from '../../helpers/setup-flows';
import {
  WEEK_STAFFING_ROUTE as ROUTE,
  addressAt,
  homeWeekendDay,
  isoDate,
  nextSaturday,
  tenantToday,
} from '../../helpers/week-staffing';

/**
 * Fluxo: 7.4 — Escalação da semana
 * Diagrama: docs/fluxos/negocio-7.4-escalacao-da-semana.mmd
 * Plano: docs/implementados/PLANO-ESCALACAO-DA-SEMANA.md §5 (ESC-A, Etapa 214),
 * §13 registro e2e E1, E2, E3 e E12.
 *
 * O quadro `/app/events/week-staffing` mostra as festas da semana (hoje ->
 * domingo, no fuso do tenant) com vagas, habilidades exigidas e candidatos.
 * Ler e escalar exigem `events.update`; o Financial não vê o item nem passa
 * pela rota. Escalar reusa o assign de sempre e recarrega só a linha da festa.
 *
 * Cenário base (§13): A sáb 13:00-16:00 no Batel, B sáb 17:30-20:30 na Água
 * Verde; Pintura facial exigida em A e B e só a Carla a tem. As coordenadas
 * são as da tabela fixa do fake do Google (`/_control/distances`).
 */

/**
 * Coordenada fora da tabela fixa e nunca medida antes: o cache de 24 h do back
 * por par não responde por ela, então a matriz é chamada de verdade.
 */
function unmeasuredPoint(): FakeLatLng {
  // 5 casas exatas: o fake casa a coordenada do `fail-next` com 5 casas, e um
  // valor no meio do arredondamento poderia cair do outro lado depois do banco.
  return uniquePointNear({ lat: -25.36, lng: -49.36 });
}

// --- navegação ---
/** Abre o grupo do menu lateral (fechado na Home, exceto o Painel). */
async function openNavGroup(page: Page, group: string, witnessRoute: string): Promise<void> {
  // O submenu fechado continua no DOM com caixa (a animação só recolhe a
  // altura): "visível" não diz se está aberto. Quem diz é a classe `open` do
  // `<li class="group">`.
  const groupItem = page.getByTestId(`nav-group-${group}`);
  if (!/\bopen\b/.test((await groupItem.getAttribute('class')) ?? '')) {
    await page.getByTestId(`nav-group-toggle-${group}`).click();
  }
  await expect(groupItem).toHaveClass(/\bopen\b/);
  await expect(groupItem.getByTestId(`nav-sub-${witnessRoute}`)).toBeVisible();
}

/** Score exibido no card ("0,75") como número. */
async function scoreOf(page: Page, collaboratorId: string): Promise<number> {
  const text = (await page.getByTestId(`week-staffing-candidate-score-${collaboratorId}`).innerText()).trim();
  return Number(text.replace(/\./g, '').replace(',', '.'));
}

// Os três grupos que apontam para o quadro, com um item que todo perfil do
// teste vê (prova que o grupo certo foi aberto).
const NAV_GROUPS: ReadonlyArray<{ group: string; witness: string }> = [
  { group: 'Eventos', witness: '/app/events/list' },
  { group: 'Equipe', witness: '/app/collaborators/list' },
  { group: 'Agenda', witness: '/app/schedule/calendar' },
];

test.describe('Fluxo 7.4 — Escalação da semana', () => {
  // --- E1 ---
  test('@smoke E1: the "Escalação da semana" item of Eventos, Equipe and Agenda opens the same board', async ({
    authApi,
    authPage,
  }) => {
    await apiCompleteOnboarding(authApi);

    for (const { group, witness } of NAV_GROUPS) {
      await authPage.goto('/app');
      await expect(authPage.getByTestId('home-page')).toBeVisible();
      await openNavGroup(authPage, group, witness);

      const item = authPage.getByTestId(`nav-group-${group}`).getByTestId(`nav-sub-${ROUTE}`);
      await expect(item, `item no grupo ${group}`).toHaveText(/Escalação da semana/);
      await item.click();

      await expect(authPage).toHaveURL(/\/app\/events\/week-staffing(\?|$)/);
      await expect(authPage.getByTestId('week-staffing-title')).toBeVisible();
    }
  });

  test('@flow E1: Financial (no events.update) sees no item in any group, and the guard and the API refuse the board', async ({
    authApi,
    browser,
    tenant,
  }) => {
    await apiCompleteOnboarding(authApi);
    const financial = await loginAsRole(tenant.tenantId, 'Financial');
    const { page, context } = await openSessionPage(browser, financial.tokens);
    try {
      const res = await financial.api.get('/api/events/staffing/week');
      expect(res.status(), 'GET do quadro sem events.update').toBe(403);

      await page.goto('/app');
      await expect(page.getByTestId('home-page')).toBeVisible();
      for (const { group, witness } of NAV_GROUPS) {
        await openNavGroup(page, group, witness);
        await expect(
          page.getByTestId(`nav-group-${group}`).getByTestId(`nav-sub-${ROUTE}`),
          `Financial não vê o item em ${group}`,
        ).toHaveCount(0);
      }

      // Digitando a URL, o permissionGuard manda para a página de acesso negado.
      await page.goto(ROUTE);
      await expect(page).toHaveURL(/\/auth\/403/);
      await expect(page.getByTestId('week-staffing-title')).toHaveCount(0);
    } finally {
      await context.close();
      await financial.api.dispose();
    }
  });

  // --- E2 ---
  test('@crud E2: scarce skill chip, escalating Carla reloads only the row, a hold asks for a justification', async ({
    authApi,
    authPage,
  }) => {
    const suffix = Date.now().toString(36);
    const places = await fakeGoogleMaps.places();
    const saturday = nextSaturday();

    const facePainting = await apiFindOrCreateSkill(authApi, 'Pintura facial');
    const paintingActivity = await apiCreateActivity(authApi, { name: `Pintura facial ${suffix}` });
    await assertOk(
      await authApi.post(`/api/activities/${paintingActivity.id}/skill-requirements`, {
        data: { skillId: facePainting.id, isRequired: true },
      }),
      'POST activity skill-requirement',
    );

    const carla = await apiCreateCollaborator(authApi, { name: `Carla ${suffix}` });
    await apiAddCollaboratorSkill(authApi, carla.id, facePainting.id);
    const bruno = await apiCreateCollaborator(authApi, { name: `Bruno ${suffix}` });

    const { eventId: eventA } = await setupAcceptedEvent(authApi, {
      activityIds: [paintingActivity.id],
      budget: {
        eventDate: saturday,
        startTime: '13:00',
        endTime: '16:00',
        teamSize: 2,
        address: addressAt(places.batel, 'Batel'),
      },
    });
    const { eventId: eventB } = await setupAcceptedEvent(authApi, {
      activityIds: [paintingActivity.id],
      budget: {
        eventDate: saturday,
        startTime: '17:30',
        endTime: '20:30',
        teamSize: 2,
        address: addressAt(places.aguaVerde, 'Água Verde'),
      },
    });

    // Bruno reservado (hold) por outro orçamento no mesmo horário de A: S1, suave.
    const otherBudget = await apiCreateBudget(authApi, {
      clientId: (await apiCreateClient(authApi)).id,
      activityIds: [(await apiCreateActivity(authApi)).id],
      eventDate: saturday,
      startTime: '13:00',
      endTime: '16:00',
    });
    await assertOk(
      await authApi.post(`/api/budgets/${otherBudget.id}/holds`, { data: { collaboratorIds: [bruno.id] } }),
      'POST /api/budgets/{id}/holds',
    );
    await apiCompleteOnboarding(authApi);

    await authPage.goto(ROUTE);
    const rowA = authPage.getByTestId(`week-staffing-row-${eventA}`);
    await expect(rowA).toBeVisible();
    await expect(authPage.getByTestId(`week-staffing-row-${eventB}`)).toBeVisible();

    // W1: uma pintora para duas festas — conta pessoas na semana, não pares.
    const scarce = authPage.getByTestId(`week-staffing-scarce-${facePainting.id}`);
    await expect(scarce).toHaveText(/Pintura facial: 1 livre para 2 festas/);
    await expect(scarce).toHaveAttribute('data-tone', 'amber');
    await expect(authPage.getByTestId(`week-staffing-requirement-${eventA}-${facePainting.id}`)).toHaveAttribute(
      'data-state',
      'missing',
    );
    await expect(authPage.getByTestId(`week-staffing-slots-${eventA}`)).toHaveText(/0\/2 vagas/);

    // Painel de candidatos de A (lazy).
    await authPage.getByTestId(`week-staffing-toggle-${eventA}`).click();
    const carlaCard = authPage.getByTestId(`week-staffing-candidate-${carla.id}`);
    await expect(carlaCard).toBeVisible();

    // A partir daqui, nenhuma carga do quadro inteiro: só a linha de A.
    const boardLoads: string[] = [];
    authPage.on('request', (req) => {
      if (req.method() === 'GET' && new URL(req.url()).pathname === '/api/events/staffing/week') {
        boardLoads.push(req.url());
      }
    });
    const rowReload = authPage.waitForResponse(
      (r) =>
        r.request().method() === 'GET' && new URL(r.url()).pathname === `/api/events/staffing/week/events/${eventA}`,
    );
    await authPage.getByTestId(`week-staffing-escalate-${carla.id}`).click();
    expect((await rowReload).status()).toBe(200);

    await expect(authPage.getByTestId(`week-staffing-member-${eventA}-${carla.id}`)).toBeVisible();
    await expect(authPage.getByTestId(`week-staffing-requirement-${eventA}-${facePainting.id}`)).toHaveAttribute(
      'data-state',
      'covered',
    );
    await expect(authPage.getByTestId(`week-staffing-slots-${eventA}`)).toHaveText(/1\/2 vagas/);
    // A linha de B não foi recarregada: a pintura facial continua descoberta lá.
    await expect(authPage.getByTestId(`week-staffing-requirement-${eventB}-${facePainting.id}`)).toHaveAttribute(
      'data-state',
      'missing',
    );
    expect(boardLoads, 'escalar não recarrega o quadro inteiro').toEqual([]);

    // Bruno tem hold de outro orçamento: o Escalar abre a justificativa (S1).
    const brunoCard = authPage.getByTestId(`week-staffing-candidate-${bruno.id}`);
    await expect(brunoCard).toBeVisible();
    await authPage.getByTestId(`week-staffing-escalate-${bruno.id}`).click();
    const reason = authPage.getByTestId(`week-staffing-override-reason-${bruno.id}`);
    await expect(reason).toBeVisible();
    await expect(brunoCard.locator('[data-testid="conflict-viewer-item"][data-code="S1"]')).toHaveAttribute(
      'data-severity',
      'Soft',
    );
    const confirm = authPage.getByTestId(`week-staffing-confirm-escalate-${bruno.id}`);
    await expect(confirm, 'sem justificativa não confirma').toBeDisabled();
    await reason.fill('O outro orçamento não vai fechar');
    await confirm.click();

    await expect(authPage.getByTestId(`week-staffing-member-${eventA}-${bruno.id}`)).toBeVisible();
    await expect(authPage.getByTestId(`week-staffing-slots-${eventA}`)).toHaveText(/2\/2 vagas/);
    expect(boardLoads, 'escalar não recarrega o quadro inteiro').toEqual([]);

    const ev = (await apiGetEvent(authApi, eventA)) as unknown as { collaborators: Array<{ collaboratorId: string }> };
    expect(ev.collaborators.map((c) => c.collaboratorId).sort()).toEqual([bruno.id, carla.id].sort());
  });

  // --- E3 ---
  test('@flow E3: the Home weekend card says "Escalar a semana" with events.update and "Ver disponibilidade" without it', async ({
    authApi,
    authPage,
    browser,
    tenant,
  }) => {
    // No domingo o card conta só hoje: a festa vai para o fim da noite, para não
    // depender de a tarde já ter passado quando o spec roda. Festa de hoje não
    // nasce por orçamento (a validade não cabe antes dela): o `setupAcceptedEvent`
    // a cria numa data futura e a move para hoje com `PATCH /api/events/{id}`.
    const weekendDay = homeWeekendDay();
    const lateSlot = weekendDay === isoDate(tenantToday());
    await setupAcceptedEvent(authApi, {
      budget: {
        eventDate: weekendDay,
        startTime: lateSlot ? '23:00' : '13:00',
        endTime: lateSlot ? '23:50' : '16:00',
        teamSize: 2,
      },
    });
    await apiCompleteOnboarding(authApi);

    // Gestor (events.update): o "ver todos" leva ao quadro.
    const ownerHome = await readJson<{ weekendStaffing: { route: string } | null }>(await authApi.get('/api/home'));
    expect(ownerHome.weekendStaffing?.route).toBe(ROUTE);

    await authPage.goto('/app');
    const ownerLink = authPage.getByTestId('home-card-see-all-weekend-staffing');
    await expect(ownerLink).toContainText('Escalar a semana');
    await expect(ownerLink).toHaveAttribute('href', ROUTE);
    await ownerLink.click();
    await expect(authPage).toHaveURL(/\/app\/events\/week-staffing(\?|$)/);
    await expect(authPage.getByTestId('week-staffing-title')).toBeVisible();

    // Financial (events.read + collaborators.read, sem events.update): o card
    // continua, mas leva à disponibilidade da equipe.
    const financial = await loginAsRole(tenant.tenantId, 'Financial');
    const { page, context } = await openSessionPage(browser, financial.tokens);
    try {
      const financialHome = await readJson<{ weekendStaffing: { route: string } | null }>(
        await financial.api.get('/api/home'),
      );
      expect(financialHome.weekendStaffing?.route).toBe('/app/collaborators/availability');

      await page.goto('/app');
      const financialLink = page.getByTestId('home-card-see-all-weekend-staffing');
      await expect(financialLink).toContainText('Ver disponibilidade');
      await expect(financialLink).not.toContainText('Escalar a semana');
      await expect(financialLink).toHaveAttribute('href', '/app/collaborators/availability');
      await financialLink.click();
      await expect(page).toHaveURL(/\/app\/collaborators\/availability(\?|$)/);
      await expect(page.getByTestId('availability-title')).toBeVisible();
    } finally {
      await context.close();
      await financial.api.dispose();
    }
  });

  // --- E12 ---
  // A falha do fake é armada só para a coordenada do colaborador medido
  // (`failNext(…, { coord })`): os workers em paralelo não a gastam.
  test.describe('E12 — distances from the fake Google', () => {
    test('@flow E12: candidate card shows km and minutes from the fake; an event with an active reservation shows where the material leaves from', async ({
      authApi,
      authPage,
      tenant,
    }) => {
      enableFeatureFlagDirect(tenant.tenantId, 'feature_stock');
      const suffix = Date.now().toString(36);
      const places = await fakeGoogleMaps.places();

      // Consumível ligado à atividade: o aceite reserva o material do evento.
      const product = await apiCreateProduct(authApi, { isReusable: false });
      const activity = await apiCreateActivity(authApi, {
        activityProducts: [{ productId: product.id, qtyPerChild: 1, isChecklistOnly: false }],
      });
      // Centro -> Batel = 12 min na tabela fixa do fake (~6 km).
      const near = await apiCreateCollaborator(authApi, {
        name: `Perto ${suffix}`,
        address: addressAt(places.centro, 'Centro'),
      });
      const noCoordinates = await apiCreateCollaborator(authApi, { name: `Sem coordenada ${suffix}` });

      const { eventId } = await setupAcceptedEvent(authApi, {
        activityIds: [activity.id],
        budget: {
          eventDate: nextSaturday(),
          startTime: '13:00',
          endTime: '16:00',
          teamSize: 2,
          address: addressAt(places.batel, 'Batel'),
        },
      });

      // O aceite PÚBLICO (anônimo) não reserva no e2e; a troca do local de saída
      // (autenticada) roda o mesmo `SyncAsync` da reserva, que provisiona o
      // Local Principal e reserva o consumível nele.
      await apiSetEventDepartureLocation(authApi, eventId, null);

      const locationsRes = await authApi.get('/api/stock/locations');
      await assertOk(locationsRes, 'GET /api/stock/locations');
      const locationsBody = await readJson<Array<{ name: string }> | { items: Array<{ name: string }> }>(locationsRes);
      const locationNames = (Array.isArray(locationsBody) ? locationsBody : locationsBody.items).map((l) => l.name);
      expect(locationNames.length, 'o aceite reservou num local de estoque').toBeGreaterThan(0);

      await apiCompleteOnboarding(authApi);
      await authPage.goto(ROUTE);
      await expect(authPage.getByTestId(`week-staffing-row-${eventId}`)).toBeVisible();

      const material = authPage.getByTestId(`week-staffing-material-${eventId}`);
      await expect(material).toBeVisible();
      const materialText = (await material.innerText()).replace(/\s+/g, ' ').trim();
      expect(materialText).toMatch(/^material sai de /);
      expect(locationNames).toContain(materialText.replace(/^material sai de /, ''));

      await expect(authPage.getByTestId('week-staffing-distances-unavailable')).toHaveCount(0);

      await authPage.getByTestId(`week-staffing-toggle-${eventId}`).click();
      await expect(authPage.getByTestId(`week-staffing-candidate-${near.id}`)).toBeVisible();
      await expect(authPage.getByTestId(`week-staffing-distance-${near.id}`)).toHaveText(/^6 km$/);
      await expect(authPage.getByTestId(`week-staffing-travel-${near.id}`)).toHaveText(/12 min de casa/);
      await expect(authPage.getByTestId(`week-staffing-no-coordinates-${noCoordinates.id}`)).toBeVisible();

      // Distância medida e curta pesa a favor; a desconhecida fica no neutro.
      expect(await scoreOf(authPage, near.id)).toBeGreaterThan(await scoreOf(authPage, noCoordinates.id));
    });

    test('@flow E12: with the fake failing, the header says "distâncias indisponíveis" once and the score does not penalize', async ({
      authApi,
      authPage,
    }) => {
      const suffix = Date.now().toString(36);
      const places = await fakeGoogleMaps.places();

      const home = unmeasuredPoint();
      const measured = await apiCreateCollaborator(authApi, {
        name: `Com coordenada ${suffix}`,
        address: addressAt(home, 'Bigorrilho'),
      });
      const noCoordinates = await apiCreateCollaborator(authApi, { name: `Sem coordenada ${suffix}` });
      const { eventId } = await setupAcceptedEvent(authApi, {
        budget: {
          eventDate: nextSaturday(),
          startTime: '13:00',
          endTime: '16:00',
          teamSize: 2,
          address: addressAt(places.batel, 'Batel'),
        },
      });
      await apiCompleteOnboarding(authApi);

      // Folga para o quadro e o painel de candidatos (cada um pede a matriz).
      await fakeGoogleMaps.failNext(10, { coord: home });
      try {
        await authPage.goto(ROUTE);
        await expect(authPage.getByTestId(`week-staffing-row-${eventId}`)).toBeVisible();
        await expect(authPage.getByTestId('week-staffing-distances-unavailable')).toHaveCount(1);
        await expect(authPage.getByTestId('week-staffing-distances-unavailable')).toHaveText(/distâncias indisponíveis/);

        await authPage.getByTestId(`week-staffing-toggle-${eventId}`).click();
        const card = authPage.getByTestId(`week-staffing-candidate-${measured.id}`);
        await expect(card).toBeVisible();
        await expect(authPage.getByTestId(`week-staffing-candidate-${noCoordinates.id}`)).toBeVisible();

        // O aviso é do cabeçalho, uma vez: nada de distância nem "indisponível" no card.
        await expect(authPage.getByTestId(`week-staffing-distance-${measured.id}`)).toHaveCount(0);
        await expect(authPage.getByTestId(`week-staffing-travel-${measured.id}`)).toHaveCount(0);
        await expect(card).not.toContainText('distância indisponível');
        await expect(card.locator('[data-code="I4"]')).toHaveCount(0);
        await expect(authPage.getByText('distâncias indisponíveis')).toHaveCount(1);

        // Sem penalidade: quem tem coordenada e não foi medido empata com quem não tem.
        expect(await scoreOf(authPage, measured.id)).toBe(await scoreOf(authPage, noCoordinates.id));
      } finally {
        await fakeGoogleMaps.failNext(0, { coord: home });
      }
    });
  });
});
