import { APIRequestContext, Page } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { twoTenantsTest } from '../../fixtures/two-tenants.fixture';
import {
  apiAddCollaboratorSkill,
  apiCompleteOnboarding,
  apiCreateActivity,
  apiCreateCollaborator,
  apiFindOrCreateSkill,
  apiSetAiFeature,
} from '../../helpers/api-entities';
import { enableFeatureFlagDirect, seedWhatsappChannelDirect, setSubscriptionPlanDirect } from '../../helpers/db-helper';
import {
  type FakeGooglePlaces,
  type FakeLatLng,
  fakeGoogleMaps,
  fakeOpenAi,
  fakeWhatsApp,
  uniquePointNear,
} from '../../helpers/fake-providers';
import { assertOk, readJson } from '../../helpers/response';
import { loginPortalCollaborator, portalDeclineEvent, setupAcceptedEvent } from '../../helpers/setup-flows';
import { WEEK_STAFFING_ROUTE as ROUTE, addressAt, escapeRegExp, nextSaturday } from '../../helpers/week-staffing';

/**
 * Fluxo: 7.6 — Proposta da semana por IA, rascunho e aplicar em lote
 * Diagrama: docs/fluxos/negocio-7.6-proposta-da-semana.mmd
 * Plano: docs/implementados/PLANO-ESCALACAO-DA-SEMANA.md §7 (ESC-C, Etapa 216),
 * §13 registro e2e E8, E9 e E10.
 *
 * O sistema aloca (solver determinístico, escassez primeiro) e a IA só
 * explica: uma frase por festa, os 3 maiores riscos e as descobertas. O
 * rascunho mora no servidor; aplicar passa pelo assign de sempre, entrada por
 * entrada, e pede confirmação a cada pessoa pelo canal que ela tem.
 *
 * Gate: `feature_ai` + o card `ai_optimal_staffing` ligado (decisão 11).
 * O fake da OpenAI responde roteirizado / fora do ar só para a chamada cujo
 * prompt contém o id de uma festa do teste (`fakeOpenAi.scriptNext/failNext`).
 */

const FEATURE = 'ai_optimal_staffing';
const API = '/api/events/staffing/week';

interface Week {
  /** Sobrenome comum dos três nomes do teste ("Carla <suffix>"): nunca sobe para o prompt. */
  suffix: string;
  carla: { id: string; name: string };
  bruno: { id: string; name: string };
  diego: { id: string; name: string };
  facePaintingId: string;
  eventA: string;
  eventB: string;
  eventD: string;
}

/**
 * Cenário base (§13): A sáb 13:00-16:00 e B sáb 17:30-20:30 exigem Pintura
 * facial, que só a Carla tem (A->B 20 min: a cadeia cabe); D sáb 17:30-20:30
 * sem exigência (A->D 50 min). Uma vaga em A e B, duas em D: o solver só tem a
 * Carla para A e B, e Bruno e Diego para D.
 */
async function seedWeek(
  api: APIRequestContext,
  places: FakeGooglePlaces,
  opts: { brunoPhone?: string } = {},
): Promise<Week> {
  const suffix = Date.now().toString(36);
  const saturday = nextSaturday();
  const pA = uniquePointNear(places.batel);
  const pB = uniquePointNear(places.aguaVerde);
  const pD = uniquePointNear(places.colombo);
  const homes = [uniquePointNear(places.centro), uniquePointNear(places.centro), uniquePointNear(places.centro)];
  await fakeGoogleMaps.putDistances([
    { from: pA, to: pB, minutes: 20 },
    { from: pA, to: pD, minutes: 50 },
    { from: pB, to: pD, minutes: 55 },
    ...homes.flatMap((h) => [
      { from: h, to: pA, minutes: 12 },
      { from: h, to: pB, minutes: 15 },
      { from: h, to: pD, minutes: 40 },
    ]),
  ]);

  const facePainting = await apiFindOrCreateSkill(api, 'Pintura facial');
  const painting = await apiCreateActivity(api, { name: `Pintura facial ${suffix}` });
  await assertOk(
    await api.post(`/api/activities/${painting.id}/skill-requirements`, {
      data: { skillId: facePainting.id, isRequired: true },
    }),
    'POST activity skill-requirement',
  );

  const carla = await apiCreateCollaborator(api, { name: `Carla ${suffix}`, address: addressAt(homes[0]!, 'Centro') });
  await apiAddCollaboratorSkill(api, carla.id, facePainting.id);
  const bruno = await apiCreateCollaborator(api, {
    name: `Bruno ${suffix}`,
    address: addressAt(homes[1]!, 'Centro'),
    ...(opts.brunoPhone ? { phone: opts.brunoPhone } : {}),
  });
  const diego = await apiCreateCollaborator(api, { name: `Diego ${suffix}`, address: addressAt(homes[2]!, 'Centro') });

  const party = async (start: string, end: string, point: FakeLatLng, place: string, teamSize: number, activityIds?: string[]) =>
    (
      await setupAcceptedEvent(api, {
        activityIds,
        budget: {
          eventDate: saturday,
          startTime: start,
          endTime: end,
          teamSize,
          eventLocation: place,
          address: addressAt(point, place),
        },
      })
    ).eventId;

  const eventA = await party('13:00', '16:00', pA, 'Batel', 1, [painting.id]);
  const eventB = await party('17:30', '20:30', pB, 'Água Verde', 1, [painting.id]);
  const eventD = await party('17:30', '20:30', pD, 'Colombo', 2);

  return {
    suffix,
    carla: { id: carla.id, name: `Carla ${suffix}` },
    bruno: { id: bruno.id, name: `Bruno ${suffix}` },
    diego: { id: diego.id, name: `Diego ${suffix}` },
    facePaintingId: facePainting.id,
    eventA,
    eventB,
    eventD,
  };
}

/** O chip do rascunho de uma pessoa numa festa (os chips levam colaborador e festa). */
function draftChip(page: Page, collaboratorId: string, eventId: string) {
  return page.locator(
    `[data-testid^="week-staffing-draft-entry-"][data-collaborator-id="${collaboratorId}"][data-event-id="${eventId}"]`,
  );
}

/** Clica em "Propor" (ou "Gerar de novo", que pede confirmação) e espera o POST generate. */
async function propose(page: Page, regenerate = false): Promise<void> {
  const generated = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `${API}/generate`,
  );
  await page.getByTestId('week-staffing-propose').click();
  if (regenerate) await page.getByTestId('confirm-ok').click();
  expect((await generated).status(), 'POST generate').toBe(200);
}

test.describe('Fluxo 7.6 — Proposta da semana por IA, rascunho e aplicar em lote', () => {
  // --- E8 ---
  test('@flow E8: "Propor escala da semana (IA)" puts the board in draft mode; Carla goes where she is irreplaceable; the AI reading degrades without hiding the proposal', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_ai');
    await apiSetAiFeature(authApi, FEATURE, true);
    const week = await seedWeek(authApi, await fakeGoogleMaps.places());
    await apiCompleteOnboarding(authApi);

    // A leitura roteirizada cita a Carla no risco 1 (o prompt só leva o primeiro nome).
    await fakeOpenAi.scriptNext(
      week.eventB,
      JSON.stringify({
        perEvent: [{ eventId: week.eventB, text: 'Carla é a única com pintura facial e vem da festa do Batel.' }],
        risks: [
          {
            rank: 1,
            text: 'Carla é a única com pintura facial e faz duas festas no sábado.',
            askBefore: 'confirme com a Carla se ela fica até as 20h30',
          },
        ],
        uncovered: [],
      }),
    );

    await authPage.goto(ROUTE);
    await expect(authPage.getByTestId(`week-staffing-row-${week.eventB}`)).toBeVisible();
    const proposeButton = authPage.getByTestId('week-staffing-propose');
    await expect(proposeButton).toHaveText(/Propor escala da semana \(IA\)/);
    const proposedSince = new Date().toISOString();
    await propose(authPage);

    // Modo rascunho: a Carla proposta em B (escassez), nunca em D.
    await expect(authPage.getByTestId('week-staffing-draft-header')).toBeVisible();
    const carlaInB = draftChip(authPage, week.carla.id, week.eventB);
    await expect(carlaInB).toBeVisible();
    await expect(carlaInB).toHaveAttribute('data-state', 'Proposed');
    await expect(carlaInB).toContainText(week.carla.name);
    await expect(draftChip(authPage, week.carla.id, week.eventD)).toHaveCount(0);
    // Proposta não é escala: a equipe real de B continua vazia.
    await expect(authPage.getByTestId(`week-staffing-member-${week.eventB}-${week.carla.id}`)).toHaveCount(0);

    await expect(authPage.getByTestId('week-staffing-ai-reading')).toBeVisible();
    await expect(authPage.getByTestId('week-staffing-ai-risk-1')).toContainText('Carla');
    await expect(authPage.getByTestId('week-staffing-draft-ai-degraded')).toHaveCount(0);

    // LGPD (§7.1 item 4): o prompt que chegou ao fake leva só o primeiro nome.
    // Só as chamadas deste teste: as que citam o id de B (o fake é compartilhado).
    const prompts = (await fakeOpenAi.inbox({ path: '/chat/completions', since: proposedSince }))
      .map((e) => JSON.stringify(e.body))
      .filter((body) => body.includes(week.eventB));
    expect(prompts.length, 'a proposta chamou a IA com as festas da semana').toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt, 'o primeiro nome sobe para o prompt').toContain('Carla');
      expect(prompt, 'o sobrenome nunca sobe para o prompt').not.toContain(week.suffix);
    }

    // Provider fora: a mesma proposta, com a faixa âmbar e sem o painel.
    await fakeOpenAi.failNext(week.eventB, 10);
    try {
      await propose(authPage, true);
      await expect(authPage.getByTestId('week-staffing-draft-ai-degraded')).toHaveText(
        'Não foi possível gerar a leitura — a proposta abaixo continua válida.',
      );
      await expect(authPage.getByTestId('week-staffing-ai-reading')).toHaveCount(0);
      await expect(draftChip(authPage, week.carla.id, week.eventB)).toBeVisible();
      await expect(draftChip(authPage, week.carla.id, week.eventD)).toHaveCount(0);
    } finally {
      await fakeOpenAi.failNext(week.eventB, 0);
    }
  });

  // --- E9 ---
  test('@flow E9: applying the accepted proposals asks everyone to confirm, reports per person, and a decline in the Portal reopens the slot', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_ai');
    enableFeatureFlagDirect(tenant.tenantId, 'feature_whatsapp');
    const phoneNumberId = seedWhatsappChannelDirect(tenant.tenantId);
    await apiSetAiFeature(authApi, FEATURE, true);

    // Bruno falou com o número da empresa (janela de 24 h aberta): o pedido de
    // confirmação sai pelo WhatsApp. Carla tem Portal. Diego não tem nenhum dos dois.
    const brunoPhone = `+55419${String(Date.now()).slice(-7)}4`;
    const week = await seedWeek(authApi, await fakeGoogleMaps.places(), { brunoPhone });
    const hook = await fakeWhatsApp.triggerWebhook({
      kind: 'inbound',
      phoneNumberId,
      phone: brunoPhone,
      text: 'Oi, é o Bruno',
    });
    expect(hook.backStatus, `webhook inbound: ${hook.backBody}`).toBe(200);
    const carlaPortal = await loginPortalCollaborator(tenant.tenantId, week.carla.id);
    await apiCompleteOnboarding(authApi);

    try {
      await authPage.goto(ROUTE);
      await expect(authPage.getByTestId(`week-staffing-row-${week.eventB}`)).toBeVisible();
      await propose(authPage);

      await authPage.getByTestId('week-staffing-draft-accept-all').click();
      const applyButton = authPage.getByTestId('week-staffing-apply-button');
      await expect(applyButton).toHaveText(/Aplicar 4 aceitas/);
      await expect(authPage.getByTestId('week-staffing-apply-request-confirmation').locator('input')).toBeChecked();

      await applyButton.click();
      const message = authPage.getByTestId('confirm-message');
      await expect(message).toBeVisible();
      for (const name of [week.carla.name, week.bruno.name, week.diego.name]) {
        await expect(message, `o diálogo lista ${name}`).toContainText(name);
      }
      // E as festas: um trecho por festa, "{dia} {HH:mm} · {cliente}: {pessoas}"
      // (`applyConfirmMessage` do front). A às 13:00 com a Carla; B e D às 17:30,
      // uma com a Carla e a outra com Bruno e Diego.
      const messageText = (await message.innerText()).replace(/\s+/g, ' ');
      expect(messageText.match(/\d{2}:\d{2} · /g) ?? [], 'uma festa por trecho').toHaveLength(3);
      expect(messageText).toMatch(new RegExp(`13:00 · [^·]*?: [^·]*${escapeRegExp(week.carla.name)}`));
      expect(messageText).toMatch(new RegExp(`17:30 · [^·]*?: [^·]*${escapeRegExp(week.carla.name)}`));
      for (const name of [week.bruno.name, week.diego.name]) {
        expect(messageText, `${name} numa festa das 17:30`).toMatch(
          new RegExp(`17:30 · [^·]*?: [^·]*${escapeRegExp(name)}`),
        );
      }
      const applied = authPage.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/draft\/[^/]+\/apply$/.test(new URL(r.url()).pathname),
      );
      await authPage.getByTestId('confirm-ok').click();
      expect((await applied).status(), 'POST apply').toBe(200);

      // Relatório por pessoa.
      await expect(authPage.getByTestId('week-staffing-apply-report')).toBeVisible();
      const lineOf = (collaboratorId: string, eventId: string) =>
        authPage.locator(
          `[data-testid^="week-staffing-apply-line-"][data-collaborator-id="${collaboratorId}"][data-event-id="${eventId}"]`,
        );

      for (const eventId of [week.eventA, week.eventB]) {
        const line = lineOf(week.carla.id, eventId);
        await expect(line).toHaveAttribute('data-outcome', 'applied');
        await expect(line.locator('[data-testid^="week-staffing-apply-reminded-"]')).toHaveAttribute(
          'data-channel',
          'inApp',
        );
        await expect(line).toContainText('avisada no portal');
      }

      const brunoLine = lineOf(week.bruno.id, week.eventD);
      await expect(brunoLine).toHaveAttribute('data-outcome', 'applied');
      await expect(brunoLine.locator('[data-testid^="week-staffing-apply-reminded-"]')).toHaveAttribute(
        'data-channel',
        'whatsapp',
      );
      await expect(brunoLine).toContainText('avisada pelo WhatsApp');

      const diegoLine = lineOf(week.diego.id, week.eventD);
      await expect(diegoLine).toHaveAttribute('data-outcome', 'applied');
      await expect(diegoLine.locator('[data-testid^="week-staffing-apply-unreachable-"]')).toContainText('sem canal');

      // O WhatsApp saiu de verdade, pelo fake, para o telefone do Bruno.
      const digits = brunoPhone.replace(/\D/g, '');
      await expect
        .poll(async () =>
          (await fakeWhatsApp.inbox({ path: '/messages' })).filter((e) => JSON.stringify(e.body).includes(digits))
            .length,
        )
        .toBeGreaterThan(0);

      // A equipe real mudou: Carla em A e B.
      await expect(authPage.getByTestId(`week-staffing-member-${week.eventA}-${week.carla.id}`)).toBeVisible();
      await expect(authPage.getByTestId(`week-staffing-member-${week.eventB}-${week.carla.id}`)).toBeVisible();

      // O Portal da Carla mostra as duas escalações.
      const myEvents = await carlaPortal.api.get('/api/portal/my-events');
      await assertOk(myEvents, 'GET /api/portal/my-events');
      const myEventsText = JSON.stringify(await readJson(myEvents));
      expect(myEventsText).toContain(week.eventA);
      expect(myEventsText).toContain(week.eventB);

      // Carla recusa B no Portal: a linha de B volta a ter a vaga e a pintura descoberta.
      await portalDeclineEvent(carlaPortal.api, week.eventB, 'Não consigo ficar até a noite');
      await authPage.goto(ROUTE);
      await expect(authPage.getByTestId(`week-staffing-slots-${week.eventB}`)).toHaveText(/0\/1 vagas/);
      await expect(
        authPage.getByTestId(`week-staffing-requirement-${week.eventB}-${week.facePaintingId}`),
      ).toHaveAttribute('data-state', 'missing');
      await expect(
        authPage.getByTestId(`week-staffing-requirement-${week.eventA}-${week.facePaintingId}`),
      ).toHaveAttribute('data-state', 'covered');
    } finally {
      await carlaPortal.api.dispose();
    }
  });

  // --- E10 ---
  test('@flow E10: without feature_ai the button does not render and the board still escalates inline', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    // O signup nasce em teste do `plan_professional`, que já traz `feature_ai`:
    // o tenant "sem IA" é o do `plan_free`.
    setSubscriptionPlanDirect(tenant.tenantId, 'plan_free');
    const suffix = Date.now().toString(36);
    const ana = await apiCreateCollaborator(authApi, { name: `Ana ${suffix}` });
    const { eventId } = await setupAcceptedEvent(authApi, {
      budget: { eventDate: nextSaturday(), startTime: '13:00', endTime: '16:00', teamSize: 2 },
    });
    await apiCompleteOnboarding(authApi);

    await authPage.goto(ROUTE);
    await expect(authPage.getByTestId(`week-staffing-row-${eventId}`)).toBeVisible();
    await expect(authPage.getByTestId('week-staffing-propose')).toHaveCount(0);
    await expect(authPage.getByTestId('ai-feature-off-state')).toHaveCount(0);

    await authPage.getByTestId(`week-staffing-toggle-${eventId}`).click();
    await authPage.getByTestId(`week-staffing-escalate-${ana.id}`).click();
    await expect(authPage.getByTestId(`week-staffing-member-${eventId}-${ana.id}`)).toBeVisible();
  });

  test('@flow E10: with the toggle off, the off-state shows as a block below the header and the button does not render', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_ai');
    await apiSetAiFeature(authApi, FEATURE, false);
    const suffix = Date.now().toString(36);
    const ana = await apiCreateCollaborator(authApi, { name: `Ana ${suffix}` });
    const { eventId } = await setupAcceptedEvent(authApi, {
      budget: { eventDate: nextSaturday(), startTime: '13:00', endTime: '16:00', teamSize: 2 },
    });
    await apiCompleteOnboarding(authApi);

    await authPage.goto(ROUTE);
    await expect(authPage.getByTestId(`week-staffing-row-${eventId}`)).toBeVisible();
    const offState = authPage.getByTestId('ai-feature-off-state');
    await expect(offState).toBeVisible();
    await expect(authPage.getByTestId('week-staffing-propose')).toHaveCount(0);
    await expect(authPage.getByTestId('week-staffing-ai-toolbar')).toHaveCount(0);

    // Em bloco ABAIXO do cabeçalho (não dentro da barra de ações).
    const title = await authPage.getByTestId('week-staffing-title').boundingBox();
    const block = await offState.boundingBox();
    expect(title && block, 'título e off-state renderizados').toBeTruthy();
    expect(block!.y, 'o off-state começa abaixo do título').toBeGreaterThanOrEqual(title!.y + title!.height);

    // O quadro continua escalando sem IA.
    await authPage.getByTestId(`week-staffing-toggle-${eventId}`).click();
    await authPage.getByTestId(`week-staffing-escalate-${ana.id}`).click();
    await expect(authPage.getByTestId(`week-staffing-member-${eventId}-${ana.id}`)).toBeVisible();
  });
});

twoTenantsTest.describe('Fluxo 7.6 — isolamento do rascunho', () => {
  twoTenantsTest(
    '@flow E10: the draft id of another tenant is 404 in GET draft and in every action',
    async ({ apiA, apiB, tenantA }) => {
      enableFeatureFlagDirect(tenantA.tenantId, 'feature_ai');
      await apiSetAiFeature(apiA, FEATURE, true);
      const suffix = Date.now().toString(36);
      await apiCreateCollaborator(apiA, { name: `Ana ${suffix}` });
      await setupAcceptedEvent(apiA, {
        budget: { eventDate: nextSaturday(), startTime: '13:00', endTime: '16:00', teamSize: 2 },
      });

      const generated = await apiA.post(`${API}/generate`);
      await assertOk(generated, 'POST generate (tenant A)');
      const draft = await readJson<{
        id: string;
        horizonStart: string;
        horizonEnd: string;
        entries: Array<{ id: string; collaboratorId: string; eventId: string }>;
      }>(generated);
      expect(draft.entries.length, 'o rascunho de A tem ao menos uma entrada').toBeGreaterThan(0);
      const entry = draft.entries[0]!;
      const range = `from=${draft.horizonStart}&to=${draft.horizonEnd}`;

      // Sanidade: A enxerga o próprio rascunho.
      expect((await apiA.get(`${API}/draft?${range}`)).status()).toBe(200);

      // B não enxerga nem age sobre o rascunho de A.
      const attempts: Array<[string, () => Promise<{ status: () => number }>]> = [
        ['GET draft', () => apiB.get(`${API}/draft?${range}`)],
        ['accept', () => apiB.post(`${API}/draft/${draft.id}/entries/${entry.id}/accept`, { data: {} })],
        ['reject', () => apiB.post(`${API}/draft/${draft.id}/entries/${entry.id}/reject`)],
        [
          'replace',
          () =>
            apiB.put(`${API}/draft/${draft.id}/entries/${entry.id}`, {
              data: { collaboratorId: entry.collaboratorId, isLeader: false },
            }),
        ],
        [
          'add',
          () =>
            apiB.post(`${API}/draft/${draft.id}/entries`, {
              data: { eventId: entry.eventId, collaboratorId: entry.collaboratorId, isLeader: false },
            }),
        ],
        ['apply', () => apiB.post(`${API}/draft/${draft.id}/apply`, { data: { onlyAccepted: true, requestConfirmation: false } })],
        ['discard', () => apiB.post(`${API}/draft/${draft.id}/discard`)],
      ];
      for (const [label, call] of attempts) {
        expect((await call()).status(), `${label} com o rascunho de outro tenant`).toBe(404);
      }

      // E o rascunho de A continua intacto.
      const after = await readJson<{ id: string; entries: Array<{ id: string; state: string }> }>(
        await apiA.get(`${API}/draft?${range}`),
      );
      expect(after.id).toBe(draft.id);
      expect(after.entries.find((e) => e.id === entry.id)?.state).toBe('Proposed');
    },
  );
});
