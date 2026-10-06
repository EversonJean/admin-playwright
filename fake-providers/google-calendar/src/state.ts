import { randomBytes } from 'node:crypto';

/**
 * Estado em memória do fake Google Agenda: contas (identificadas pelo `sub`
 * do id_token), grants OAuth, agendas e eventos. Some quando o processo cai —
 * nada persiste entre execuções.
 *
 * Isolamento entre specs paralelos: cada spec autoriza uma conta PRÓPRIA
 * (`sub` único). Agenda, evento, revogação e modo de falha são da conta, então
 * dois specs nunca se enxergam. `reset()` limpa tudo de todos: só em depuração.
 */

export type FailureMode =
  /** API e token respondem 500 (`backendError`): o back classifica como Transient. */
  | '500'
  /** API responde 429 (`rateLimitExceeded`): RateLimited. */
  | '429'
  /** API responde 401 e o refresh responde 400 `invalid_grant`: token revogado. */
  | 'invalid_grant'
  /** Só a API responde 401; o refresh funciona (exercita a renovação do access token). */
  | '401'
  /** As agendas da conta respondem 404 (como se apagadas), sem apagar o estado. */
  | '404calendar';

export interface AccountFailure {
  mode: FailureMode;
  /** Quantas requisições ainda falham; `null` = até limpar. */
  remaining: number | null;
}

export interface FakeAccount {
  sub: string;
  email: string;
  failure: AccountFailure | null;
}

export interface FakeGrant {
  id: string;
  sub: string;
  clientId: string;
  scope: string;
  refreshToken: string | null;
  revoked: boolean;
  createdAt: string;
}

export interface PendingCode {
  code: string;
  sub: string;
  email: string;
  scope: string;
  omitRefreshToken: boolean;
  omitIdToken: boolean;
  idTokenAudience: string | null;
  used: boolean;
}

export interface FakeCalendar {
  id: string;
  sub: string;
  summary: string;
  timeZone: string;
  description: string | null;
  /** Apagada (pela API ou "à mão" no `/_control`): 404 em tudo. */
  deleted: boolean;
  createdAt: string;
}

export interface EventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

export interface FakeEvent {
  id: string;
  calendarId: string;
  /** `confirmed` ou `cancelled` (lixeira do Google: insert do mesmo id dá 409, PATCH restaura). */
  status: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  start: EventDateTime | null;
  end: EventDateTime | null;
  colorId: string | null;
  reminders: unknown;
  visibility: string | null;
  transparency: string | null;
  source: unknown;
  extendedProperties: { private?: Record<string, string>; shared?: Record<string, string> } | null;
  htmlLink: string;
  /** Criado pela API (back) ou "à mão" no `/_control`. */
  origin: 'api' | 'manual';
  sequence: number;
  created: string;
  updated: string;
}

const accounts = new Map<string, FakeAccount>();
const grants = new Map<string, FakeGrant>();
const codes = new Map<string, PendingCode>();
const accessTokens = new Map<string, string>(); // token -> grantId
const refreshTokens = new Map<string, string>(); // token -> grantId
const calendars = new Map<string, FakeCalendar>();
const events = new Map<string, FakeEvent>(); // `${calendarId}\n${eventId}` -> evento

let sequence = 0;

function token(prefix: string): string {
  return `${prefix}-${randomBytes(18).toString('base64url')}`;
}

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}${Date.now().toString(36)}${sequence.toString(36)}`;
}

function eventKey(calendarId: string, eventId: string): string {
  return `${calendarId}\n${eventId}`;
}

export function reset(): void {
  accounts.clear();
  grants.clear();
  codes.clear();
  accessTokens.clear();
  refreshTokens.clear();
  calendars.clear();
  events.clear();
}

export function ensureAccount(sub: string, email: string): FakeAccount {
  let account = accounts.get(sub);
  if (!account) {
    account = { sub, email, failure: null };
    accounts.set(sub, account);
  } else {
    account.email = email;
  }
  return account;
}

export function getAccount(sub: string): FakeAccount | undefined {
  return accounts.get(sub);
}

// ─── OAuth ───────────────────────────────────────────────────────────────────

export function createCode(input: Omit<PendingCode, 'code' | 'used'>): PendingCode {
  ensureAccount(input.sub, input.email);
  const pending: PendingCode = { ...input, code: token('fake-code'), used: false };
  codes.set(pending.code, pending);
  return pending;
}

export function getCode(code: string): PendingCode | undefined {
  return codes.get(code);
}

export function createGrant(input: { sub: string; clientId: string; scope: string; withRefreshToken: boolean }): {
  grant: FakeGrant;
  accessToken: string;
} {
  const grant: FakeGrant = {
    id: nextId('grant'),
    sub: input.sub,
    clientId: input.clientId,
    scope: input.scope,
    refreshToken: input.withRefreshToken ? token('fake-rt') : null,
    revoked: false,
    createdAt: new Date().toISOString(),
  };
  grants.set(grant.id, grant);
  if (grant.refreshToken) refreshTokens.set(grant.refreshToken, grant.id);
  const accessToken = token('fake-at');
  accessTokens.set(accessToken, grant.id);
  return { grant, accessToken };
}

export function grantByRefreshToken(refreshToken: string): FakeGrant | undefined {
  const id = refreshTokens.get(refreshToken);
  return id ? grants.get(id) : undefined;
}

export function grantByAccessToken(accessToken: string): FakeGrant | undefined {
  const id = accessTokens.get(accessToken);
  return id ? grants.get(id) : undefined;
}

export function issueAccessToken(grant: FakeGrant): string {
  const accessToken = token('fake-at');
  accessTokens.set(accessToken, grant.id);
  return accessToken;
}

/** Revogar access OU refresh token anula o grant inteiro, como no Google. */
export function revokeByToken(value: string): boolean {
  const grant = grantByAccessToken(value) ?? grantByRefreshToken(value);
  if (!grant) return false;
  grant.revoked = true;
  return true;
}

/** "Remover acesso" em myaccount.google.com: todos os grants da conta. */
export function revokeAccount(sub: string): number {
  let count = 0;
  for (const grant of grants.values()) {
    if (grant.sub === sub && !grant.revoked) {
      grant.revoked = true;
      count += 1;
    }
  }
  return count;
}

export function grantsOf(sub: string): FakeGrant[] {
  return [...grants.values()].filter((g) => g.sub === sub);
}

// ─── Modos de falha ──────────────────────────────────────────────────────────

export function setFailure(sub: string, mode: FailureMode, times: number | null): AccountFailure {
  const account = accounts.get(sub) ?? ensureAccount(sub, `${sub}@example.com`);
  account.failure = { mode, remaining: times };
  return account.failure;
}

export function clearFailure(sub: string): void {
  const account = accounts.get(sub);
  if (account) account.failure = null;
}

/**
 * Consome uma falha da conta se o modo vale para o tipo de chamada. `api` =
 * Calendar API; `token` = endpoint de token. Devolve o modo aplicado ou null.
 */
export function takeFailure(sub: string, target: 'api' | 'token'): FailureMode | null {
  const account = accounts.get(sub);
  const failure = account?.failure;
  if (!account || !failure) return null;

  // Na API todo modo vale (`invalid_grant` vira 401 lá); no endpoint de token,
  // só o que o Google de fato devolve nele: 5xx e `invalid_grant`.
  const applies = target === 'api' || failure.mode === '500' || failure.mode === 'invalid_grant';
  if (!applies) return null;

  if (failure.remaining !== null) {
    failure.remaining -= 1;
    if (failure.remaining <= 0) account.failure = null;
  }
  return failure.mode;
}

// ─── Agendas ─────────────────────────────────────────────────────────────────

export function createCalendar(input: {
  sub: string;
  summary: string;
  timeZone: string;
  description: string | null;
}): FakeCalendar {
  const calendar: FakeCalendar = {
    id: `${nextId('fakecal')}@group.calendar.google.com`,
    sub: input.sub,
    summary: input.summary,
    timeZone: input.timeZone,
    description: input.description,
    deleted: false,
    createdAt: new Date().toISOString(),
  };
  calendars.set(calendar.id, calendar);
  return calendar;
}

export function getCalendar(id: string): FakeCalendar | undefined {
  return calendars.get(id);
}

export function calendarsOf(sub: string): FakeCalendar[] {
  return [...calendars.values()].filter((c) => c.sub === sub);
}

export function deleteCalendar(id: string): boolean {
  const calendar = calendars.get(id);
  if (!calendar || calendar.deleted) return false;
  calendar.deleted = true;
  return true;
}

// ─── Eventos ─────────────────────────────────────────────────────────────────

export function getEvent(calendarId: string, eventId: string): FakeEvent | undefined {
  return events.get(eventKey(calendarId, eventId));
}

export function eventsOf(calendarId: string): FakeEvent[] {
  return [...events.values()].filter((e) => e.calendarId === calendarId);
}

function htmlLinkOf(calendarId: string, eventId: string): string {
  const eid = Buffer.from(`${eventId} ${calendarId}`).toString('base64url');
  return `https://www.google.com/calendar/event?eid=${eid}`;
}

const EDITABLE = [
  'summary',
  'description',
  'location',
  'start',
  'end',
  'colorId',
  'reminders',
  'visibility',
  'transparency',
  'source',
  'extendedProperties',
  'status',
] as const;

export function insertEvent(
  calendarId: string,
  body: Record<string, unknown>,
  origin: 'api' | 'manual',
): FakeEvent {
  const id = typeof body.id === 'string' && body.id.length > 0 ? body.id : nextId('fakeevt');
  const now = new Date().toISOString();
  const ev: FakeEvent = {
    id,
    calendarId,
    status: 'confirmed',
    summary: null,
    description: null,
    location: null,
    start: null,
    end: null,
    colorId: null,
    reminders: null,
    visibility: null,
    transparency: null,
    source: null,
    extendedProperties: null,
    htmlLink: htmlLinkOf(calendarId, id),
    origin,
    sequence: 0,
    created: now,
    updated: now,
  };
  applyFields(ev, body);
  if (!ev.status) ev.status = 'confirmed';
  events.set(eventKey(calendarId, id), ev);
  return ev;
}

export function patchEvent(ev: FakeEvent, body: Record<string, unknown>): FakeEvent {
  applyFields(ev, body);
  ev.sequence += 1;
  ev.updated = new Date().toISOString();
  return ev;
}

function applyFields(ev: FakeEvent, body: Record<string, unknown>): void {
  for (const field of EDITABLE) {
    if (!(field in body)) continue;
    // Campo nulo no corpo apaga o valor (o back manda todos, inclusive nulos).
    (ev as unknown as Record<string, unknown>)[field] = body[field] ?? null;
  }
  if (ev.status === null) ev.status = 'confirmed';
}

/** Exclusão: vai para a lixeira (`cancelled`) ou some de vez (`purge`). */
export function deleteEvent(ev: FakeEvent, purge: boolean): void {
  if (purge) {
    events.delete(eventKey(ev.calendarId, ev.id));
    return;
  }
  ev.status = 'cancelled';
  ev.updated = new Date().toISOString();
}

/** Converte `dateTime` local + `timeZone` (ou com offset) em epoch ms UTC. */
export function toUtcMs(value: EventDateTime | null): number | null {
  if (!value) return null;
  if (value.date) return Date.parse(`${value.date}T00:00:00Z`);
  const raw = value.dateTime;
  if (!raw) return null;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) return Date.parse(raw);

  const asUtc = Date.parse(`${raw}Z`);
  if (Number.isNaN(asUtc) || !value.timeZone) return asUtc;
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: value.timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(asUtc)).map((p) => [p.type, p.value]));
  const zonedAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - (zonedAsUtc - asUtc);
}
