import { APIRequestContext, APIResponse, expect } from '@playwright/test';
import { apiStepUp } from './api-client';
import { fakeGoogleCalendar, FakeGoogleCalendarEvent } from './fake-providers';
import { assertOk, readJson } from './response';

/**
 * Agenda externa (PLANO-AGENDAS-EXTERNAS) pela API, contra o fake
 * `google-calendar` (porta 1517).
 *
 * O popup do GIS não roda no E2E (plano §12): a conexão é o `connect-intent`
 * do back, o código que o fake emite em `/_control/authorize` e o `connect` com
 * o token de step-up no header (`external_calendar.connect`, plano §8.1 item 4).
 */

export interface ExternalCalendarConnectionStatus {
  provider: string;
  status: 'Connected' | 'TokenRevoked' | 'Disconnected' | 'CalendarNotFound';
  accountEmail: string;
  calendarName: string;
  connectedAt: string;
  connectedByName: string | null;
  lastSuccessfulSyncAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  pendingLinks: number;
  failedLinks: number;
  pendingCount: number;
}

export interface ExternalCalendarStatus {
  providers: Array<{ provider: string; configured: boolean }>;
  connections: ExternalCalendarConnectionStatus[];
  /** Padrões da "Personalização" já parseados (Etapa 217, plano §6a.1 item 5). */
  defaults?: {
    syncKinds: string[];
    colorBy: 'Kind' | 'Status' | 'None';
    commercialColor: string | null;
    reminderMinutes: number[];
    visibility: string;
    titleTemplate: string;
    descriptionTemplate: string;
    includeClientContact: boolean;
    includeTeam: boolean;
  };
}

export interface ConnectedGoogleCalendar {
  /** Conta no fake: é por ela que o spec lê agendas, eventos e liga falhas. */
  sub: string;
  email: string;
  /** Id da agenda dedicada criada no fake. */
  calendarId: string;
  status: ExternalCalendarStatus;
}

export const STEP_UP_HEADER = 'X-Step-Up-Token';

async function readData<T>(res: APIResponse, op: string): Promise<T> {
  await assertOk(res, op);
  return readJson<T>(res);
}

/** POST /api/calendar/google/connect-intent — o nonce de uso único que o `connect` exige. */
export async function apiCreateGoogleConnectIntent(api: APIRequestContext): Promise<string> {
  const res = await api.post('/api/calendar/google/connect-intent');
  const intent = await readData<{ nonce: string; expiresAt: string }>(res, 'POST connect-intent');
  return intent.nonce;
}

/**
 * Conecta o Google do tenant como o front faria: intent → código do fake →
 * step-up com a senha → `connect`. Devolve a conta do fake e a agenda criada.
 * `account` escolhe a conta Google (sem ela, o fake cria uma conta nova).
 */
export async function apiConnectGoogleCalendar(
  api: APIRequestContext,
  password: string,
  account: { sub?: string; email?: string } = {},
): Promise<ConnectedGoogleCalendar> {
  const nonce = await apiCreateGoogleConnectIntent(api);
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const authorized = await fakeGoogleCalendar.authorize({
    sub: account.sub ?? `e2e-sub-${unique}`,
    email: account.email ?? `agenda-${unique}@example.com`,
  });
  const stepUpToken = await apiStepUp(api, password);

  const res = await api.post('/api/calendar/google/connect', {
    data: { code: authorized.code, nonce },
    headers: { [STEP_UP_HEADER]: stepUpToken },
  });
  const status = await readData<ExternalCalendarStatus>(res, 'POST /api/calendar/google/connect');

  const fakeAccount = await fakeGoogleCalendar.account(authorized.sub);
  const calendar = fakeAccount.calendars.filter((c) => !c.deleted).at(-1);
  if (!calendar) {
    throw new Error(`connect respondeu ok mas o fake não tem agenda para a conta ${authorized.sub}`);
  }
  return { sub: authorized.sub, email: authorized.email, calendarId: calendar.id, status };
}

/** GET /api/calendar/status */
export async function apiGetExternalCalendarStatus(api: APIRequestContext): Promise<ExternalCalendarStatus> {
  return readData<ExternalCalendarStatus>(await api.get('/api/calendar/status'), 'GET /api/calendar/status');
}

/** A conexão do Google no status do tenant, ou undefined. */
export async function apiGetGoogleConnection(
  api: APIRequestContext,
): Promise<ExternalCalendarConnectionStatus | undefined> {
  const status = await apiGetExternalCalendarStatus(api);
  return status.connections.find((c) => c.provider === 'google');
}

/** Espera a conexão do Google chegar a `status` (o back descobre revogação e agenda apagada pelo Outbox). */
export async function waitConnectionStatus(
  api: APIRequestContext,
  status: ExternalCalendarConnectionStatus['status'],
): Promise<void> {
  await expect
    .poll(async () => (await apiGetGoogleConnection(api))?.status, {
      timeout: 60_000,
      intervals: [2_000],
      message: `conexão do Google em ${status}`,
    })
    .toBe(status);
}

/**
 * PATCH /api/events/{id} mudando só o horário (`startHour` até `startHour + 4`):
 * o payload muda e o gancho tenta espelhar de novo.
 */
export async function moveEvent(api: APIRequestContext, eventId: string, startHour: number): Promise<void> {
  const pad = (n: number) => String(n).padStart(2, '0');
  const res = await api.patch(`/api/events/${eventId}`, {
    data: { startTime: `${pad(startHour)}:00:00`, endTime: `${pad(startHour + 4)}:00:00` },
  });
  await assertOk(res, `PATCH /api/events/${eventId}`);
}

// ─── Sincronização completa (GC-B, plano §5) ────────────────────────────────

export type ExternalCalendarSyncRunStatus =
  | 'Queued'
  | 'Running'
  | 'Completed'
  | 'CompletedWithErrors'
  | 'Failed'
  | 'Canceled';

/** O que o run olha (Etapa 216, plano §5b.1 item 3). */
export type ExternalCalendarSyncScope = 'FutureAll' | 'FailedOnly' | 'MissingOnly';

/** `ExternalCalendarSyncRunDto` (plano §5.1 item 3; `scope` desde a GC-F). */
export interface ExternalCalendarSyncRun {
  id: string;
  provider: string;
  status: ExternalCalendarSyncRunStatus;
  trigger: string;
  scope: ExternalCalendarSyncScope;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Eventos que o run vai olhar, contados quando ele começa (o "37/120" do botão). */
  total: number | null;
  scanned: number;
  created: number;
  updated: number;
  removed: number;
  unchanged: number;
  failed: number;
  error: string | null;
  requestedByName: string | null;
}

export function isActiveSyncRun(run: ExternalCalendarSyncRun | null | undefined): boolean {
  return run?.status === 'Queued' || run?.status === 'Running';
}

/** GET /api/calendar/google/sync-runs/latest — `null` quando o tenant nunca sincronizou. */
export async function apiGetLatestGoogleSyncRun(api: APIRequestContext): Promise<ExternalCalendarSyncRun | null> {
  const res = await api.get('/api/calendar/google/sync-runs/latest');
  await assertOk(res, 'GET sync-runs/latest');
  // `data: null` é resposta válida: não dá para cair no envelope como o `readData`.
  const body = (await res.json()) as { data?: ExternalCalendarSyncRun | null };
  return body.data ?? null;
}

/** GET /api/calendar/sync-runs — os últimos runs do tenant ("Últimas sincronizações"). */
export async function apiListSyncRuns(api: APIRequestContext): Promise<ExternalCalendarSyncRun[]> {
  return readData<ExternalCalendarSyncRun[]>(await api.get('/api/calendar/sync-runs'), 'GET /api/calendar/sync-runs');
}

/**
 * Espera o último run do Google satisfazer `predicate` (o run anda pelo Outbox,
 * uma página por mensagem). Devolve o run; estoura com o último estado visto.
 */
export async function waitForGoogleSyncRun(
  api: APIRequestContext,
  predicate: (run: ExternalCalendarSyncRun | null) => boolean,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<ExternalCalendarSyncRun | null> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  let last: ExternalCalendarSyncRun | null = null;
  for (;;) {
    last = await apiGetLatestGoogleSyncRun(api);
    if (predicate(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(
        `waitForGoogleSyncRun(${options.description ?? 'run'}) venceu em ${timeoutMs} ms; último run: ${JSON.stringify(last)}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Nenhum run ativo do Google (o `AfterConnect` do connect terminou, por exemplo). */
export function waitForGoogleSyncIdle(
  api: APIRequestContext,
  options: { timeoutMs?: number; description?: string } = {},
): Promise<ExternalCalendarSyncRun | null> {
  return waitForGoogleSyncRun(api, (run) => !isActiveSyncRun(run), {
    description: options.description ?? 'sem run ativo',
    timeoutMs: options.timeoutMs,
  });
}

export interface EventListItemWithMirror {
  id: string;
  externalCalendars: Array<{ provider: string; status: string }> | null;
}

/** GET /api/events?syncStatus=<status> — a lista filtrada "Agenda externa: com falha" (plano §5.2 item 3). */
export async function apiListEventsBySyncStatus(
  api: APIRequestContext,
  syncStatus: 'Pending' | 'Synced' | 'Failed' | 'Deleted' | 'Excluded',
): Promise<EventListItemWithMirror[]> {
  const page = await readData<{ items: EventListItemWithMirror[] }>(
    await api.get(`/api/events?syncStatus=${syncStatus}&pageSize=100`),
    `GET /api/events?syncStatus=${syncStatus}`,
  );
  return page.items;
}

// ─── Central de pendências (GC-F, plano §5b) ────────────────────────────────

export type ExternalCalendarPendingState = 'Failed' | 'Missing' | 'Pending' | 'Excluded';

/** `ExternalCalendarPendingSummaryDto` (plano §5b.1 item 5). */
export interface ExternalCalendarPendingSummary {
  provider: string;
  connectionStatus: ExternalCalendarConnectionStatus['status'] | null;
  accountEmail: string | null;
  calendarName: string | null;
  failed: number;
  missing: number;
  pending: number;
  excluded: number;
  syncedFuture: number;
  oldestFailureAt: string | null;
  byCause: Array<{ errorKind: string; count: number }>;
  runningRunId: string | null;
  lastRunFinishedAt: string | null;
}

/** `ExternalCalendarPendingItemDto` (plano §3.6, `PendingItem`). */
export interface ExternalCalendarPendingItem {
  eventId: string;
  state: ExternalCalendarPendingState;
  errorKind: string | null;
  firstFailureAt: string | null;
  attempts: number;
}

/** GET /api/calendar/google/pending/summary */
export async function apiGetGooglePendingSummary(api: APIRequestContext): Promise<ExternalCalendarPendingSummary> {
  return readData<ExternalCalendarPendingSummary>(
    await api.get('/api/calendar/google/pending/summary'),
    'GET /api/calendar/google/pending/summary',
  );
}

/** GET /api/calendar/google/pending?state= — a aba da central (primeira página de 100). */
export async function apiListGooglePending(
  api: APIRequestContext,
  state: ExternalCalendarPendingState,
): Promise<ExternalCalendarPendingItem[]> {
  const page = await readData<{ items: ExternalCalendarPendingItem[] }>(
    await api.get(`/api/calendar/google/pending?state=${state}&page=1&pageSize=100`),
    `GET /api/calendar/google/pending?state=${state}`,
  );
  return page.items;
}

// ─── Personalização (GC-C, plano §6a) ───────────────────────────────────────

/** Chaves do grupo `EXTERNAL_CALENDAR` gravadas pela API de parâmetros (plano §6a.1 item 1). */
export type ExternalCalendarSettingKey =
  | 'EXTERNAL_CALENDAR_SYNC_KINDS'
  | 'EXTERNAL_CALENDAR_COLOR_COMMERCIAL'
  | 'EXTERNAL_CALENDAR_COLOR_PUBLIC_EVENT'
  | 'EXTERNAL_CALENDAR_COLOR_EXTERNAL_COMMITMENT'
  | 'EXTERNAL_CALENDAR_COLOR_SCHEDULE_BLOCK'
  | 'EXTERNAL_CALENDAR_COLOR_BY'
  | 'EXTERNAL_CALENDAR_REMINDERS'
  | 'EXTERNAL_CALENDAR_VISIBILITY'
  | 'EXTERNAL_CALENDAR_TITLE_TEMPLATE'
  | 'EXTERNAL_CALENDAR_DESCRIPTION_TEMPLATE'
  | 'EXTERNAL_CALENDAR_INCLUDE_CLIENT_CONTACT'
  | 'EXTERNAL_CALENDAR_INCLUDE_TEAM';

/**
 * PUT /api/settings/parameters/{key} (`settings.update`) — um padrão por vez.
 * Com conta conectada, a mudança que muda o payload cria um run `DefaultsChanged`.
 */
export async function apiSetExternalCalendarDefault(
  api: APIRequestContext,
  key: ExternalCalendarSettingKey,
  value: string,
): Promise<void> {
  const res = await api.put(`/api/settings/parameters/${key}`, { data: { value } });
  await assertOk(res, `PUT settings/parameters/${key}`);
}

/** `EventCalendarPreferencesDto` (plano §6a.1 item 2). */
export interface EventCalendarPreferences {
  eventId: string;
  color: string | null;
  reminderMinutes: number[] | null;
  visibility: string | null;
  showAs: string | null;
  isExcluded: boolean;
  kindMirrored: boolean;
  defaultColor: string | null;
  defaultReminderMinutes: number[];
  defaultVisibility: string;
}

/** GET /api/calendar/events/{eventId}/preferences */
export async function apiGetEventCalendarPreferences(
  api: APIRequestContext,
  eventId: string,
): Promise<EventCalendarPreferences> {
  return readData<EventCalendarPreferences>(
    await api.get(`/api/calendar/events/${eventId}/preferences`),
    `GET /api/calendar/events/${eventId}/preferences`,
  );
}

/**
 * O espelho VIVO (não `cancelled`) do evento nas agendas não apagadas da conta,
 * pelo marcador; undefined se não há. Diferente do `eventFor`, que devolve
 * também o que está na lixeira e serve para "removido".
 */
export async function liveGoogleEventFor(sub: string, eventId: string): Promise<FakeGoogleCalendarEvent | undefined> {
  return (await fakeGoogleCalendar.liveEvents(sub)).find(
    (e) => e.extendedProperties?.private?.recreativoEventId === eventId,
  );
}

/**
 * Espera o espelho do evento no fake satisfazer `predicate` (o Outbox entrega
 * em segundos, com retry). Devolve o evento do fake; estoura com o último
 * estado visto se o prazo vencer.
 */
export async function waitForGoogleEvent(
  sub: string,
  eventId: string,
  predicate: (ev: FakeGoogleCalendarEvent | undefined) => boolean,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<FakeGoogleCalendarEvent | undefined> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  let last: FakeGoogleCalendarEvent | undefined;
  for (;;) {
    last = await fakeGoogleCalendar.eventFor(sub, eventId);
    if (predicate(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(
        `waitForGoogleEvent(${options.description ?? eventId}) venceu em ${timeoutMs} ms; último estado no fake: ${JSON.stringify(last)}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Como o `waitForGoogleEvent`, mas olhando só o espelho VIVO (`liveGoogleEventFor`):
 * `undefined` = nenhum espelho vivo (removido, ou ainda não criado).
 */
export async function waitForLiveGoogleEvent(
  sub: string,
  eventId: string,
  predicate: (ev: FakeGoogleCalendarEvent | undefined) => boolean,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<FakeGoogleCalendarEvent | undefined> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const intervalMs = options.intervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  let last: FakeGoogleCalendarEvent | undefined;
  for (;;) {
    last = await liveGoogleEventFor(sub, eventId);
    if (predicate(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(
        `waitForLiveGoogleEvent(${options.description ?? eventId}) venceu em ${timeoutMs} ms; último espelho vivo: ${JSON.stringify(last)}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
