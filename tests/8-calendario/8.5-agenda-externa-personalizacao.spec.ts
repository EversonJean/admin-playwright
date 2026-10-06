import { APIRequestContext } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import {
  apiCompleteOnboarding,
  apiCreateActivity,
  apiCreateClient,
  apiCreateCollaborator,
  apiCreatePackage,
} from '../../helpers/api-entities';
import {
  createApiContext,
  createBearerApiContext,
  loginViaApi,
  openPageWithTokens,
  signupNewTenant,
} from '../../helpers/api-client';
import {
  apiAcceptPublicBudget,
  apiAssignCollaborator,
  apiCompleteEvent,
  apiConfirmCollaborator,
  apiCreateBudget,
  apiSendBudget,
  apiStartEvent,
  createPublicApiContext,
  CreateBudgetInput,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';
import { backdateEventCreatedAtDirect, seedUserWithRoleDirect } from '../../helpers/db-helper';
import { setupAcceptedEvent } from '../../helpers/setup-flows';
import { fakeAddress, fakeClient } from '../../helpers/test-data';
import { fakeGoogleCalendar } from '../../helpers/fake-providers';
import {
  apiConnectGoogleCalendar,
  apiGetEventCalendarPreferences,
  apiGetExternalCalendarStatus,
  apiGetGoogleConnection,
  apiGetGooglePendingSummary,
  apiListGooglePending,
  apiSetExternalCalendarDefault,
  ExternalCalendarSyncRun,
  isActiveSyncRun,
  liveGoogleEventFor,
  moveEvent,
  waitConnectionStatus,
  waitForGoogleSyncIdle,
  waitForGoogleSyncRun,
  waitForLiveGoogleEvent,
} from '../../helpers/external-calendar';
import { apiErrorCodes } from '../../helpers/response';
import { snack } from '../../helpers/ui';
import { SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD } from '../../fixtures/super-admin.fixture';

/**
 * Fluxo: 8.5 — Agenda externa: personalização (cores, lembretes, o que espelhar, título e descrição)
 * Plano: docs/implementar/PLANO-AGENDAS-EXTERNAS.md §6a (GC-C), §3.3 (`StartAsync` é gancho desde a 217),
 *        §3.4 (tradução Google: `colorId`, `reminders`), §3.7 (`CalendarLink.*`), §8.1 item 8 (lista fechada);
 *        registro e2e §12 (E14, E31, E32, E33, E34)
 * Diagrama: docs/fluxos/negocio-8.5-agenda-externa-personalizacao.mmd
 *
 * Integração pelo fake `fake-providers/google-calendar` (porta 1517); cada
 * teste usa um tenant e uma conta Google próprios no fake. Os padrões se gravam
 * pela API de parâmetros (`PUT api/settings/parameters/{key}`); com conta
 * conectada, a mudança cria um run "Padrões alterados" (`DefaultsChanged`) que
 * sai do Outbox, então o spec espera o run terminar antes de olhar o fake.
 * Padrão gravado ANTES de conectar não cria run (não há conexão): é a forma
 * barata de montar a pré-condição quando o cenário não é a reaplicação.
 */

const CALENDAR_ROUTE = '/app/schedule/calendar';
const SETTINGS_ROUTE = '/app/settings/external-calendars';
const PENDING_ROUTE = '/app/settings/external-calendars/pendencias';

/**
 * `colorId` do Google por cor lógica (plano §3.4: "colorId 1–11, mapa 1:1"; é a
 * tabela de cores de evento do próprio Google Agenda).
 */
const GOOGLE_COLOR_ID = {
  Lavender: '1',
  Sage: '2',
  Grape: '3',
  Flamingo: '4',
  Banana: '5',
  Tangerine: '6',
  Peacock: '7',
  Graphite: '8',
  Blueberry: '9',
  Basil: '10',
  Tomato: '11',
} as const;

const ALL_KINDS = 'Commercial,PublicEvent,ExternalCommitment,ScheduleBlock';
const KINDS_WITHOUT_BLOCK = 'Commercial,PublicEvent,ExternalCommitment';

/** CNPJ de teste válido (o mesmo do `2.8-parceiros`). */
const PARTNER_CNPJ = '11222333000181';

function todayPlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function reminderMinutesOf(ev: { reminders: { useDefault?: boolean; overrides?: Array<{ minutes: number }> } | null }) {
  return (ev.reminders?.overrides ?? []).map((o) => o.minutes).sort((a, b) => a - b);
}

/** Orçamento único → enviado → aceite público; devolve o evento criado. */
async function acceptNewBudget(api: APIRequestContext, input: CreateBudgetInput): Promise<string> {
  const budget = await apiCreateBudget(api, input);
  const sent = await apiSendBudget(api, budget.id);
  const publicApi = await createPublicApiContext();
  try {
    const accepted = await apiAcceptPublicBudget(publicApi, extractTokenFromPublicUrl(sent.publicUrl));
    return accepted.eventId;
  } finally {
    await publicApi.dispose();
  }
}

/** POST /api/events/operational — "Bloqueio de agenda". */
async function createScheduleBlock(api: APIRequestContext, eventDate: string): Promise<string> {
  const res = await api.post('/api/events/operational', {
    data: {
      kind: 'ScheduleBlock',
      eventDate,
      startTime: '08:00',
      endTime: '12:00',
      location: 'Manutenção E2E',
      childrenCount: 0,
    },
  });
  expect(res.ok(), `POST operational: ${res.status()} ${await res.text()}`).toBe(true);
  const body = (await res.json()) as { data?: { id: string } };
  return body.data!.id;
}

/** Espera um run "Padrões alterados" terminado, diferente de `previous` (quando dado). */
function waitDefaultsChangedRun(
  api: APIRequestContext,
  description: string,
  previous?: ExternalCalendarSyncRun | null,
): Promise<ExternalCalendarSyncRun | null> {
  return waitForGoogleSyncRun(
    api,
    (r) => r?.trigger === 'DefaultsChanged' && r.id !== previous?.id && !isActiveSyncRun(r),
    { timeoutMs: 120_000, intervalMs: 2_000, description },
  );
}

const MISSING_LINKS_ALERT = 'integration:external-calendar:missing-links:google';

/**
 * Quantos eventos o alerta `missing-links` do Google conta na plataforma
 * inteira (0 sem o alerta). Global: o spec compara antes e depois, nunca o absoluto.
 */
async function missingLinksAlertCount(superApi: APIRequestContext): Promise<number> {
  const res = await superApi.get('/api/super-admin/observability/metrics');
  expect(res.ok(), `GET observability/metrics: ${res.status()}`).toBe(true);
  const body = (await res.json()) as { data?: { alerts?: Array<{ id: string; title: string }> } };
  const alert = (body.data?.alerts ?? []).find((a) => a.id === MISSING_LINKS_ALERT);
  if (!alert) return 0;
  const match = /com (\d+) evento/.exec(alert.title);
  if (!match) throw new Error(`título do alerta missing-links fora do formato: ${alert.title}`);
  return Number(match[1]);
}

/** O SuperAdmin semeado no E2E (o mesmo do `superAdminTest`). */
async function openSuperAdminApi(): Promise<APIRequestContext> {
  const anonymous = await createApiContext();
  try {
    const tokens = await loginViaApi(anonymous, SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD);
    return await createBearerApiContext(tokens.accessToken);
  } finally {
    await anonymous.dispose();
  }
}

test.describe('Fluxo 8.5 — Agenda externa: personalização', () => {
  // E14 — plano §6a.1 itens 1 a 3, §6a.2 itens 1 e 2, §6a.1 item 2 (aba "Não espelhados de propósito"), §3.4.
  test('@flow E14 cor das festas na Personalização reaplica pelo run "Padrões alterados"; override do evento (cor e lembrete) vence o tipo; "Não espelhar" remove e "Voltar a espelhar" recria com o override', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(420_000);
    await apiCompleteOnboarding(authApi);
    const connected = await apiConnectGoogleCalendar(authApi, tenant.password);
    await waitForGoogleSyncIdle(authApi, { description: 'run AfterConnect do connect' });

    const { eventId } = await setupAcceptedEvent(authApi);
    const first = await waitForLiveGoogleEvent(connected.sub, eventId, (e) => e !== undefined, {
      description: 'festa espelhada',
    });
    expect(first!.colorId, 'festa nasce Mirtilo (default do tipo Comercial)').toBe(GOOGLE_COLOR_ID.Blueberry);

    // Personalização: a cor das festas passa a Tomate.
    await authPage.goto(SETTINGS_ROUTE);
    const commercialColor = authPage.getByTestId('external-calendars-customization-color-Commercial');
    await expect(commercialColor).toBeVisible({ timeout: 20_000 });
    await expect(commercialColor).toContainText('Mirtilo');
    await commercialColor.click();
    await authPage.getByTestId('external-calendars-customization-color-Commercial-option-Tomato').click();
    await authPage.getByTestId('external-calendars-customization-save').click();
    await expect(snack(authPage, 'reaplicando nos eventos futuros')).toBeVisible({ timeout: 15_000 });

    const run = await waitDefaultsChangedRun(authApi, 'run "Padrões alterados" da cor das festas');
    await waitForLiveGoogleEvent(connected.sub, eventId, (e) => e?.colorId === GOOGLE_COLOR_ID.Tomato, {
      description: 'festa reaplicada em Tomate',
    });
    await authPage.goto(SETTINGS_ROUTE);
    await expect(authPage.getByTestId(`external-calendars-run-${run!.id}`)).toContainText('Padrões alterados', {
      timeout: 20_000,
    });

    // Painel "Agenda externa" do evento: cor Uva e lembrete de 2 h.
    await authPage.goto(`/app/events/${eventId}`);
    const preferences = authPage.getByTestId('event-external-calendar-preferences');
    await expect(preferences).toBeVisible({ timeout: 20_000 });
    await preferences.locator('mat-expansion-panel-header').click();
    const color = authPage.getByTestId('event-external-calendar-color');
    await expect(color).toBeVisible({ timeout: 15_000 });
    await expect(color, 'a opção zero mostra a cor do tipo').toContainText('Tomate');
    await color.click();
    await authPage.getByTestId('event-external-calendar-color-option-Grape').click();
    await authPage.getByTestId('event-external-calendar-reminders-default').getByRole('checkbox').click();
    await authPage.getByTestId('event-external-calendar-reminders-preset-120').click();
    await authPage.getByTestId('event-external-calendar-preferences-save').click();
    await expect(snack(authPage, 'Preferências salvas')).toBeVisible({ timeout: 15_000 });

    const overridden = await waitForLiveGoogleEvent(
      connected.sub,
      eventId,
      (e) => e?.colorId === GOOGLE_COLOR_ID.Grape && e.reminders?.useDefault === false,
      { description: 'override do evento (Uva, lembrete) no Google' },
    );
    expect(reminderMinutesOf(overridden!)).toEqual([120]);

    // "Não espelhar este evento": confirmação, sai do Google.
    await authPage.getByTestId('event-external-calendar-exclude-toggle').getByRole('switch').click();
    await expect(authPage.getByTestId('confirm-message')).toContainText('removido das agendas conectadas');
    await authPage.getByTestId('confirm-ok').click();
    await expect(snack(authPage, 'não será mais espelhado')).toBeVisible({ timeout: 15_000 });
    await waitForLiveGoogleEvent(connected.sub, eventId, (e) => e === undefined, {
      description: 'evento removido do Google',
    });
    expect((await apiGetEventCalendarPreferences(authApi, eventId)).isExcluded).toBe(true);

    // Central: aba "Não espelhados de propósito" e "Voltar a espelhar".
    await authPage.goto(`${PENDING_ROUTE}?tab=Excluded`);
    await expect(authPage.getByRole('tab', { name: 'Não espelhados de propósito (1)' })).toHaveAttribute(
      'aria-selected',
      'true',
      { timeout: 20_000 },
    );
    await expect(authPage.getByTestId(`external-calendar-pending-row-${eventId}`)).toBeVisible();
    const back = authPage.getByTestId(`external-calendar-pending-resend-${eventId}`);
    await expect(back).toHaveText('Voltar a espelhar');
    await back.click();

    const restored = await waitForLiveGoogleEvent(connected.sub, eventId, (e) => e !== undefined, {
      description: 'evento de volta ao Google',
    });
    expect(restored!.colorId, 'override de cor mantido').toBe(GOOGLE_COLOR_ID.Grape);
    expect(restored!.reminders?.useDefault).toBe(false);
    expect(reminderMinutesOf(restored!), 'override de lembrete mantido').toEqual([120]);
    const prefs = await apiGetEventCalendarPreferences(authApi, eventId);
    expect(prefs.isExcluded).toBe(false);
    expect(prefs.color).toBe('Grape');
    expect(prefs.reminderMinutes).toEqual([120]);
  });

  // E31 — plano §6a.1 item 1 (`EXTERNAL_CALENDAR_SYNC_KINDS`), item 2 (aviso GC-F: tipo fora da lista não é
  // `Missing`), item 3 (reaplicação), §6a.3 item 2 (`SyncKinds_SemScheduleBlock_RemoveBlocosJaEspelhados`),
  // §5b.1 item 10 (alerta `missing-links`).
  test('@flow E31 tirar "Bloqueio de agenda" dos tipos remove os bloqueios do Google, tira-os de "Nunca espelhados", do chip e do alerta missing-links; devolver o tipo volta a espelhá-los', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(540_000);
    await apiCompleteOnboarding(authApi);
    const connected = await apiConnectGoogleCalendar(authApi, tenant.password);
    await waitForGoogleSyncIdle(authApi, { description: 'run AfterConnect do connect' });

    // Bloqueio A: espelhado.
    const blockA = await createScheduleBlock(authApi, todayPlus(40));
    await waitForLiveGoogleEvent(connected.sub, blockA, (e) => e !== undefined, {
      description: 'bloqueio A espelhado',
    });

    // Bloqueio B: nasce com a conta desconectada (token revogado), então nunca é espelhado.
    const party = await setupAcceptedEvent(authApi);
    await waitForLiveGoogleEvent(connected.sub, party.eventId, (e) => e !== undefined, {
      description: 'festa espelhada',
    });
    await fakeGoogleCalendar.revokeAccount(connected.sub);
    await moveEvent(authApi, party.eventId, 15);
    await waitConnectionStatus(authApi, 'TokenRevoked');
    const blockB = await createScheduleBlock(authApi, todayPlus(41));
    await apiConnectGoogleCalendar(authApi, tenant.password, { sub: connected.sub, email: connected.email });
    await waitForGoogleSyncRun(authApi, (r) => r?.trigger === 'Reconnected' && !isActiveSyncRun(r), {
      timeoutMs: 120_000,
      intervalMs: 2_000,
      description: 'run "Ao reconectar" terminado',
    });

    // Com o tipo espelhado, B é "Nunca espelhado": central, chip âmbar e alerta da plataforma.
    await expect
      .poll(async () => (await apiListGooglePending(authApi, 'Missing')).map((i) => i.eventId), {
        timeout: 30_000,
        intervals: [2_000],
        message: 'bloqueio B em "Nunca espelhados"',
      })
      .toContain(blockB);
    expect((await apiGetGoogleConnection(authApi))?.pendingCount).toBeGreaterThanOrEqual(1);
    await authPage.goto(CALENDAR_ROUTE);
    await expect(authPage.getByTestId('external-calendar-chip-google')).toHaveAttribute('data-tone', 'warn', {
      timeout: 20_000,
    });

    // O alerta ignora os criados nos últimos 15 min (ainda no Outbox): B fica "antigo".
    backdateEventCreatedAtDirect(blockB, 60);
    const superApi = await openSuperAdminApi();
    try {
      const withBlock = await missingLinksAlertCount(superApi);
      expect(withBlock, 'o alerta missing-links conta o bloqueio B').toBeGreaterThanOrEqual(1);

      // Tira "Bloqueio de agenda" dos tipos espelhados.
      await apiSetExternalCalendarDefault(authApi, 'EXTERNAL_CALENDAR_SYNC_KINDS', KINDS_WITHOUT_BLOCK);
      const offRun = await waitDefaultsChangedRun(authApi, 'run "Padrões alterados" sem bloqueios');

      // A sai do Google; a festa fica.
      await waitForLiveGoogleEvent(connected.sub, blockA, (e) => e === undefined, {
        description: 'bloqueio A removido do Google',
      });
      expect(await liveGoogleEventFor(connected.sub, party.eventId), 'a festa continua no Google').toBeDefined();

      // B sai de "Nunca espelhados", do chip e do alerta da plataforma.
      expect((await apiListGooglePending(authApi, 'Missing')).map((i) => i.eventId)).not.toContain(blockB);
      expect((await apiGetGooglePendingSummary(authApi)).missing).toBe(0);
      expect((await apiGetGoogleConnection(authApi))?.pendingCount).toBe(0);
      await authPage.goto(CALENDAR_ROUTE);
      await expect(authPage.getByTestId('external-calendar-chip-google')).toHaveAttribute('data-tone', 'ok', {
        timeout: 20_000,
      });
      await expect(authPage.getByTestId('external-calendar-pending-google')).toHaveCount(0);
      await expect
        .poll(() => missingLinksAlertCount(superApi), {
          timeout: 60_000,
          intervals: [3_000],
          message: 'o alerta missing-links deixa de contar o bloqueio B',
        })
        .toBe(withBlock - 1);

      // Devolve o tipo à lista: os bloqueios voltam a ser espelhados.
      await apiSetExternalCalendarDefault(authApi, 'EXTERNAL_CALENDAR_SYNC_KINDS', ALL_KINDS);
      await waitDefaultsChangedRun(authApi, 'run "Padrões alterados" com bloqueios', offRun);
      await waitForLiveGoogleEvent(connected.sub, blockA, (e) => e !== undefined, {
        description: 'bloqueio A de volta ao Google',
      });

      // E B, que nunca foi espelhado, volta a ser visível: ou o run o espelhou
      // ("cria o que falta", §5.1 item 2), ou ele volta para "Nunca espelhados"
      // (o tipo voltou à lista, §6a.1 item 2) e para o chip âmbar. Sumir dos dois é o defeito.
      let blockBDestination = 'nenhum';
      await expect
        .poll(
          async () => {
            if (await liveGoogleEventFor(connected.sub, blockB)) blockBDestination = 'espelhado';
            else if ((await apiListGooglePending(authApi, 'Missing')).some((i) => i.eventId === blockB))
              blockBDestination = 'nunca-espelhado';
            else blockBDestination = 'nenhum';
            return blockBDestination;
          },
          { timeout: 60_000, intervals: [2_000], message: 'destino do bloqueio B com o tipo de volta à lista' },
        )
        .toMatch(/^(espelhado|nunca-espelhado)$/);
      if (blockBDestination === 'nunca-espelhado') {
        expect((await apiGetGoogleConnection(authApi))?.pendingCount, 'B de volta ao chip âmbar').toBeGreaterThanOrEqual(1);
      }
    } finally {
      await superApi.dispose();
    }
  });

  // E32 — plano §6a.1 item 1 (`EXTERNAL_CALENDAR_COLOR_BY`: InProgress Banana, Completed Basil), §3.3
  // (`StartAsync` é gancho desde a 217; a linha "Status: {status}" da descrição), §3.4.
  test('@flow E32 com "colorir pelo status", iniciar a festa a pinta de Banana e concluir de Manjericão; a linha "Status:" da descrição acompanha', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(300_000);
    await apiCompleteOnboarding(authApi);
    // Antes de conectar: sem conexão, o padrão não cria run.
    await apiSetExternalCalendarDefault(authApi, 'EXTERNAL_CALENDAR_COLOR_BY', 'Status');
    const connected = await apiConnectGoogleCalendar(authApi, tenant.password);
    await waitForGoogleSyncIdle(authApi, { description: 'run AfterConnect do connect' });

    const { eventId } = await setupAcceptedEvent(authApi);
    const collaborator = await apiCreateCollaborator(authApi);
    await apiAssignCollaborator(authApi, eventId, collaborator.id, { isLeader: true });
    await apiConfirmCollaborator(authApi, eventId, collaborator.id);

    const scheduled = await waitForLiveGoogleEvent(connected.sub, eventId, (e) => e !== undefined, {
      description: 'festa agendada espelhada',
    });
    expect(scheduled!.description ?? '').toContain('Status:');
    expect(scheduled!.description ?? '').not.toContain('Status: Em andamento');
    expect(scheduled!.colorId).not.toBe(GOOGLE_COLOR_ID.Banana);
    expect(scheduled!.colorId).not.toBe(GOOGLE_COLOR_ID.Basil);

    await apiStartEvent(authApi, eventId);
    await waitForLiveGoogleEvent(
      connected.sub,
      eventId,
      (e) => e?.colorId === GOOGLE_COLOR_ID.Banana && (e.description ?? '').includes('Status: Em andamento'),
      { description: 'festa iniciada: Banana e "Status: Em andamento"' },
    );

    await apiCompleteEvent(authApi, eventId);
    await waitForLiveGoogleEvent(
      connected.sub,
      eventId,
      (e) => e?.colorId === GOOGLE_COLOR_ID.Basil && (e.description ?? '').includes('Status: Concluído'),
      { description: 'festa concluída: Manjericão e "Status: Concluído"' },
    );
  });

  // E33 — plano §6a.3 item 5 (RBAC e cross-tenant), §6a.2 itens 1 e 2 (só leitura sem permissão), §3.7.
  test('@flow E33 Financial vê a Personalização e o painel do evento só leitura, lê e recebe 403 no PUT preferences; Manager recebe 403 ao salvar um padrão; preferences de outro tenant dá 404', async ({
    authApi,
    tenant,
    browser,
  }) => {
    test.setTimeout(300_000);
    await apiCompleteOnboarding(authApi);
    const connected = await apiConnectGoogleCalendar(authApi, tenant.password);
    await waitForGoogleSyncIdle(authApi, { description: 'run AfterConnect do connect' });
    const { eventId } = await setupAcceptedEvent(authApi);
    await waitForLiveGoogleEvent(connected.sub, eventId, (e) => e !== undefined, { description: 'festa espelhada' });

    const manager = seedUserWithRoleDirect({ tenantId: tenant.tenantId, role: 'Manager', emailPrefix: 'manager-pers' });
    const financial = seedUserWithRoleDirect({
      tenantId: tenant.tenantId,
      role: 'Financial',
      emailPrefix: 'financial-pers',
    });
    const managerTokens = await loginViaApi(authApi, manager.email, manager.password);
    const financialTokens = await loginViaApi(authApi, financial.email, financial.password);
    const managerApi = await createBearerApiContext(managerTokens.accessToken);
    const financialApi = await createBearerApiContext(financialTokens.accessToken);
    const financialPage = await openPageWithTokens(browser, financialTokens);
    const other = await signupNewTenant();
    const otherApi = await createBearerApiContext(other.accessToken);

    const override = { color: 'Grape', reminderMinutes: null, visibility: null, showAs: null, isExcluded: false };
    try {
      // Financial: a Personalização aparece, só leitura.
      await financialPage.goto(SETTINGS_ROUTE);
      await expect(financialPage.getByTestId('external-calendars-customization')).toBeVisible({ timeout: 20_000 });
      await expect(financialPage.getByTestId('external-calendars-customization-readonly')).toBeVisible();
      await expect(financialPage.getByTestId('external-calendars-customization-save')).toHaveCount(0);
      await expect(
        financialPage.getByTestId('external-calendars-customization-client-contact').getByRole('switch'),
      ).toBeDisabled();

      // Financial: o painel do evento, só leitura.
      await financialPage.goto(`/app/events/${eventId}`);
      const preferences = financialPage.getByTestId('event-external-calendar-preferences');
      await expect(preferences).toBeVisible({ timeout: 20_000 });
      await preferences.locator('mat-expansion-panel-header').click();
      await expect(financialPage.getByTestId('event-external-calendar-preferences-readonly')).toBeVisible({
        timeout: 15_000,
      });
      await expect(financialPage.getByTestId('event-external-calendar-preferences-save')).toHaveCount(0);
      await expect(
        financialPage.getByTestId('event-external-calendar-exclude-toggle').getByRole('switch'),
      ).toBeDisabled();

      // Financial (`events.read`): lê `GET preferences`, 403 no `PUT`.
      const read = await financialApi.get(`/api/calendar/events/${eventId}/preferences`);
      expect(read.status()).toBe(200);
      const denied = await financialApi.put(`/api/calendar/events/${eventId}/preferences`, { data: override });
      expect(denied.status()).toBe(403);

      // Manager (sem `settings.update`): 403 ao salvar um padrão; nada muda.
      const managerSave = await managerApi.put('/api/settings/parameters/EXTERNAL_CALENDAR_COLOR_BY', {
        data: { value: 'Status' },
      });
      expect(managerSave.status()).toBe(403);
      expect((await apiGetExternalCalendarStatus(authApi)).defaults?.colorBy).toBe('Kind');

      // Outro tenant: `GET`/`PUT preferences` do evento daqui dá 404 `CalendarLink.NotFound`.
      const crossGet = await otherApi.get(`/api/calendar/events/${eventId}/preferences`);
      expect(crossGet.status()).toBe(404);
      expect(await apiErrorCodes(crossGet)).toContain('CalendarLink.NotFound');
      const crossPut = await otherApi.put(`/api/calendar/events/${eventId}/preferences`, { data: override });
      expect(crossPut.status()).toBe(404);
      expect(await apiErrorCodes(crossPut)).toContain('CalendarLink.NotFound');

      // Nenhum dos PUT recusados mexeu no evento.
      const prefs = await apiGetEventCalendarPreferences(authApi, eventId);
      expect(prefs.color).toBeNull();
      expect(prefs.isExcluded).toBe(false);
    } finally {
      await financialPage.context().close();
      await managerApi.dispose();
      await financialApi.dispose();
      await otherApi.dispose();
    }
  });

  // E34 — plano §6a.1 item 1 (`EXTERNAL_CALENDAR_INCLUDE_CLIENT_CONTACT`, `TITLE_TEMPLATE` com `{pacote}`),
  // §8.1 item 8 (lista fechada: nunca telefone, documento nem contato do parceiro), §3.4 (`Summary` da venda
  // via parceiro: "{parceiro} — {família}").
  test('@flow E34 com "e-mail do cliente na descrição", o Google leva só o e-mail (nunca telefone nem documento); venda via parceiro sem contato e com título "parceiro — família"; modelo de título com {pacote} chega com o nome do pacote', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(420_000);
    await apiCompleteOnboarding(authApi);
    // Antes de conectar: sem conexão, o padrão não cria run.
    await apiSetExternalCalendarDefault(authApi, 'EXTERNAL_CALENDAR_INCLUDE_CLIENT_CONTACT', 'true');
    const connected = await apiConnectGoogleCalendar(authApi, tenant.password);
    await waitForGoogleSyncIdle(authApi, { description: 'run AfterConnect do connect' });

    const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const activity = await apiCreateActivity(authApi);
    const pkg = await apiCreatePackage(authApi, { activityIds: [activity.id], name: `Pacote Festa ${unique}` });

    // Venda direta, com pacote: o cliente tem e-mail, telefone e CPF.
    const clientData = fakeClient();
    const client = await apiCreateClient(authApi, clientData);
    const directEventId = await acceptNewBudget(authApi, {
      clientId: client.id,
      activityIds: [activity.id],
      packageId: pkg.id,
      childrenCount: 15,
    });
    const direct = await waitForLiveGoogleEvent(connected.sub, directEventId, (e) => e !== undefined, {
      description: 'venda direta espelhada',
    });
    expect(direct!.summary).toBe(`${clientData.name} — 15 crianças`);
    const directDescription = direct!.description ?? '';
    expect(directDescription, 'só o e-mail do cliente').toContain(clientData.email);
    expect(directDescription.replace(/\D/g, ''), 'nunca o telefone').not.toContain(clientData.phone);
    expect(directDescription.replace(/\D/g, ''), 'nunca o documento').not.toContain(clientData.document);

    // Venda via parceiro: o salão tem e-mail, telefone e CNPJ; a família não leva contato.
    const partnerName = `Buffet Parceiro ${unique}`;
    const partnerEmail = `parceiro-${unique}@e2e.test`;
    const partnerPhone = '41977776666';
    const family = `Família Souza ${unique}`;
    const celebrant = `Aniversariante${unique}`;
    const partnerRes = await authApi.post('/api/clients', {
      data: {
        type: 'PJ',
        name: partnerName,
        document: PARTNER_CNPJ,
        email: partnerEmail,
        phone: partnerPhone,
        address: fakeAddress(),
        isPartner: true,
        partnerCategory: 'Buffet',
      },
    });
    expect(partnerRes.ok(), `POST parceiro: ${partnerRes.status()} ${await partnerRes.text()}`).toBe(true);
    const partnerId = ((await partnerRes.json()) as { data: { id: string } }).data.id;
    const partnerEventId = await acceptNewBudget(authApi, {
      clientId: partnerId,
      activityIds: [activity.id],
      partnerSale: { endCustomerName: family, celebrantName: celebrant, celebrantAge: 5 },
    });
    const partner = await waitForLiveGoogleEvent(connected.sub, partnerEventId, (e) => e !== undefined, {
      description: 'venda via parceiro espelhada',
    });
    expect(partner!.summary).toBe(`${partnerName} — ${family}`);
    const partnerDescription = partner!.description ?? '';
    expect(partnerDescription, 'nenhum e-mail na venda via parceiro').not.toContain('@');
    expect(partnerDescription.replace(/\D/g, ''), 'nunca o telefone do salão').not.toContain(partnerPhone);
    expect(partnerDescription.replace(/\D/g, ''), 'nunca o CNPJ do salão').not.toContain(PARTNER_CNPJ);
    expect(partnerDescription, 'nunca o aniversariante').not.toContain(celebrant);

    // Modelo de título com {pacote}: reaplicado pelo run "Padrões alterados".
    await apiSetExternalCalendarDefault(authApi, 'EXTERNAL_CALENDAR_TITLE_TEMPLATE', '{pacote} — {cliente}');
    await waitDefaultsChangedRun(authApi, 'run "Padrões alterados" do modelo de título');
    await waitForLiveGoogleEvent(
      connected.sub,
      directEventId,
      (e) => e?.summary === `${pkg.name} — ${clientData.name}`,
      { description: 'título com o nome do pacote' },
    );
  });
});
