import { request as createApiRequest, APIRequestContext } from '@playwright/test';

/**
 * Helpers pra interagir com os fake providers Node (pasta `fake-providers/`).
 * Cada provider expoe o mesmo contrato `_control/*` definido em
 * `fake-providers/shared/src/server-base.ts`.
 *
 * IMPORTANTE: `clearInbox()` deve ser chamado no `beforeEach` dos specs que
 * inspecionam outbound (especs paralelos rodam contra o MESMO fake server).
 */

const URLS = {
  asaas: process.env.FAKE_ASAAS_URL ?? 'http://localhost:1510',
  clicksign: process.env.FAKE_CLICKSIGN_URL ?? 'http://localhost:1511',
  whatsapp: process.env.FAKE_WHATSAPP_URL ?? 'http://localhost:1512',
  email: process.env.FAKE_EMAIL_URL ?? 'http://localhost:1513',
  openai: process.env.FAKE_OPENAI_URL ?? 'http://localhost:1514',
  anthropic: process.env.FAKE_ANTHROPIC_URL ?? 'http://localhost:1515',
  googleMaps: process.env.FAKE_GOOGLE_MAPS_URL ?? 'http://localhost:1516',
  googleCalendar: process.env.FAKE_GOOGLE_CALENDAR_URL ?? 'http://localhost:1517',
} as const;

export type FakeProvider = keyof typeof URLS;

export interface InboxEntry {
  capturedAt: string;
  tenantId: string | null;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  response: { status: number; body: unknown };
}

async function ctx(): Promise<APIRequestContext> {
  return await createApiRequest.newContext({ ignoreHTTPSErrors: true });
}

async function fetchInbox(
  provider: FakeProvider,
  filter?: { tenantId?: string; path?: string; since?: string },
): Promise<InboxEntry[]> {
  const api = await ctx();
  try {
    const params = new URLSearchParams();
    if (filter?.tenantId) params.set('tenantId', filter.tenantId);
    if (filter?.path) params.set('path', filter.path);
    if (filter?.since) params.set('since', filter.since);
    const qs = params.toString() ? `?${params.toString()}` : '';
    const res = await api.get(`${URLS[provider]}/_control/inbox${qs}`);
    if (!res.ok()) throw new Error(`fake ${provider} inbox: ${res.status()}`);
    const body = (await res.json()) as { items: InboxEntry[]; total: number };
    return body.items;
  } finally {
    await api.dispose();
  }
}

async function clearInbox(provider: FakeProvider): Promise<void> {
  const api = await ctx();
  try {
    await api.delete(`${URLS[provider]}/_control/inbox`);
  } finally {
    await api.dispose();
  }
}

async function triggerWebhook<T>(provider: FakeProvider, body: T): Promise<{ backStatus: number; backBody: string }> {
  const api = await ctx();
  try {
    const res = await api.post(`${URLS[provider]}/_control/trigger-webhook`, { data: body });
    if (!res.ok()) {
      throw new Error(`trigger-webhook ${provider} ${res.status()}: ${await res.text()}`);
    }
    return (await res.json()) as { backStatus: number; backBody: string };
  } finally {
    await api.dispose();
  }
}

// ─── Google Maps ────────────────────────────────────────────────────────────

export const fakeGoogleMaps = {
  baseUrl: URLS.googleMaps,
  inbox: (filter?: { tenantId?: string; path?: string; since?: string }) =>
    fetchInbox('googleMaps', filter),
  clear: () => clearInbox('googleMaps'),
};

// ─── OpenAI / Anthropic ─────────────────────────────────────────────────────

export const fakeOpenAi = {
  baseUrl: URLS.openai,
  inbox: (filter?: { tenantId?: string; path?: string; since?: string }) =>
    fetchInbox('openai', filter),
  clear: () => clearInbox('openai'),
};

export const fakeAnthropic = {
  baseUrl: URLS.anthropic,
  inbox: (filter?: { tenantId?: string; path?: string; since?: string }) =>
    fetchInbox('anthropic', filter),
  clear: () => clearInbox('anthropic'),
};

// ─── Email (HTTP REST) ──────────────────────────────────────────────────────

export interface FakeEmailEntry {
  id: string;
  receivedAt: string;
  to: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  from?: string;
  fromName?: string;
}

export const fakeEmail = {
  baseUrl: URLS.email,
  inbox: (filter?: { tenantId?: string; path?: string; since?: string }) =>
    fetchInbox('email', filter),
  /** Lista emails parseados (helper especifico do fake email). */
  emails: async (filter?: { to?: string; subject?: string }): Promise<FakeEmailEntry[]> => {
    const api = await ctx();
    try {
      const params = new URLSearchParams();
      if (filter?.to) params.set('to', filter.to);
      if (filter?.subject) params.set('subject', filter.subject);
      const qs = params.toString() ? `?${params.toString()}` : '';
      const res = await api.get(`${URLS.email}/_control/emails${qs}`);
      if (!res.ok()) throw new Error(`fake email list: ${res.status()}`);
      const body = (await res.json()) as { items: FakeEmailEntry[]; total: number };
      return body.items;
    } finally {
      await api.dispose();
    }
  },
  clear: () => clearInbox('email'),
  resetState: async (): Promise<void> => {
    const api = await ctx();
    try {
      await api.delete(`${URLS.email}/_control/state`);
    } finally {
      await api.dispose();
    }
  },
};

// ─── WhatsApp Meta ──────────────────────────────────────────────────────────

export const fakeWhatsApp = {
  baseUrl: URLS.whatsapp,
  inbox: (filter?: { tenantId?: string; path?: string; since?: string }) =>
    fetchInbox('whatsapp', filter),
  clear: () => clearInbox('whatsapp'),
  resetState: async (): Promise<void> => {
    const api = await ctx();
    try {
      await api.delete(`${URLS.whatsapp}/_control/state`);
    } finally {
      await api.dispose();
    }
  },
  /**
   * Pre-cadastra um template no fake com status especifico — usado pra
   * cobrir cenarios de Rejected/Paused (GET /:id devolve esse status em
   * vez de auto-criar como Approved).
   */
  seedTemplate: async (input: {
    id: string;
    name: string;
    status: 'APPROVED' | 'PENDING' | 'REJECTED' | 'PAUSED';
    rejectedReason?: string;
  }) => {
    const api = await ctx();
    try {
      await api.post(`${URLS.whatsapp}/_control/template`, { data: input });
    } finally {
      await api.dispose();
    }
  },
  /**
   * Dispara webhook do WhatsApp (status update ou inbound) com HMAC
   * SHA-256 calculado a partir do WebhookAppSecret. POSTa em
   * /api/webhooks/whatsapp com header X-Hub-Signature-256.
   */
  triggerWebhook: (body: {
    kind: 'status' | 'inbound';
    phone: string;
    messageId?: string;
    status?: 'sent' | 'delivered' | 'read' | 'failed';
    text?: string;
    /** Status: `timestamp` da Meta em segundos; fixo, o replay e byte a byte. */
    timestamp?: number;
    /** Status `failed`: motivo no formato da Meta. */
    errors?: Array<{ code: number; title: string; message?: string; error_data?: { details?: string } }>;
  }) => triggerWebhook('whatsapp', body),
};

// ─── ClickSign ──────────────────────────────────────────────────────────────

export const fakeClicksign = {
  baseUrl: URLS.clicksign,
  inbox: (filter?: { tenantId?: string; path?: string; since?: string }) =>
    fetchInbox('clicksign', filter),
  clear: () => clearInbox('clicksign'),
  resetState: async (): Promise<void> => {
    const api = await ctx();
    try {
      await api.delete(`${URLS.clicksign}/_control/state`);
    } finally {
      await api.dispose();
    }
  },
  /**
   * Dispara webhook real (HTTP) pro back em /api/webhooks/clicksign com
   * HMAC SHA-256 calculado a partir do WebhookSecret. Eventos: `sign`,
   * `auto_close`, `cancel`, `refuse`, etc.
   */
  triggerWebhook: (body: {
    event: string;
    providerDocumentKey: string;
    providerSignerKey?: string;
    occurredAt?: string;
    reason?: string;
  }) => triggerWebhook('clicksign', body),
};

// ─── Asaas ──────────────────────────────────────────────────────────────────

export const fakeAsaas = {
  baseUrl: URLS.asaas,
  inbox: (filter?: { tenantId?: string; path?: string; since?: string }) =>
    fetchInbox('asaas', filter),
  clear: () => clearInbox('asaas'),
  resetState: async (): Promise<void> => {
    const api = await ctx();
    try {
      await api.delete(`${URLS.asaas}/_control/state`);
    } finally {
      await api.dispose();
    }
  },
  /**
   * Muda o status do payment no fake SEM webhook (o webhook perdido da
   * reconciliacao, Etapa 201): o back so ve a mudanca pelo GET /payments/:id.
   */
  setPaymentStatus: async (paymentId: string, status: 'PENDING' | 'RECEIVED' | 'CONFIRMED' | 'OVERDUE') => {
    const api = await ctx();
    try {
      const res = await api.post(`${URLS.asaas}/_control/payment-status`, { data: { paymentId, status } });
      if (!res.ok()) throw new Error(`fake asaas payment-status ${res.status()}: ${await res.text()}`);
    } finally {
      await api.dispose();
    }
  },
  /**
   * Dispara webhook real (HTTP) pro back em /api/webhooks/asaas. Pode
   * referenciar paymentId ja existente no fake (criado via outbound do
   * back) OU criar payment ad-hoc com `payment: {...}`.
   */
  triggerWebhook: (body: {
    event: string;
    paymentId?: string;
    payment?: {
      customer?: string;
      value?: number;
      billingType?: string;
      dueDate?: string;
      externalReference?: string;
      status?: string;
      description?: string;
    };
    /** Mesmo eventId em 2 triggers exercita idempotencia do processor. */
    eventId?: string;
    accessToken?: string;
  }) => triggerWebhook('asaas', body),
};

// ─── Google Agenda (PLANO-AGENDAS-EXTERNAS) ─────────────────────────────────

/** Modos de falha por conta (`fake-providers/google-calendar/src/state.ts`). */
export type FakeGoogleCalendarFailure = '500' | '429' | 'invalid_grant' | '401' | '404calendar';

export interface FakeGoogleCalendarEvent {
  id: string;
  calendarId: string;
  /** `confirmed` ou `cancelled` (lixeira). */
  status: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  start: { dateTime?: string; date?: string; timeZone?: string } | null;
  end: { dateTime?: string; date?: string; timeZone?: string } | null;
  colorId: string | null;
  reminders: { useDefault?: boolean; overrides?: Array<{ method: string; minutes: number }> } | null;
  visibility: string | null;
  transparency: string | null;
  extendedProperties: { private?: Record<string, string> } | null;
  htmlLink: string;
  origin: 'api' | 'manual';
  sequence: number;
}

export interface FakeGoogleCalendarCalendar {
  id: string;
  sub: string;
  summary: string;
  timeZone: string;
  deleted: boolean;
  events: FakeGoogleCalendarEvent[];
}

export interface FakeGoogleCalendarAccount {
  sub: string;
  email: string;
  failure: { mode: FakeGoogleCalendarFailure; remaining: number | null } | null;
  grants: Array<{ id: string; scope: string; revoked: boolean; hasRefreshToken: boolean }>;
  calendars: FakeGoogleCalendarCalendar[];
}

async function googleCalendarCall<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, data?: unknown): Promise<T> {
  const api = await ctx();
  try {
    const res = await api.fetch(`${URLS.googleCalendar}${path}`, { method, data });
    if (!res.ok()) throw new Error(`fake google-calendar ${method} ${path}: ${res.status()} ${await res.text()}`);
    return (await res.json()) as T;
  } finally {
    await api.dispose();
  }
}

/**
 * Fake Google Agenda (porta 1517). Cada spec usa uma CONTA própria (`sub`
 * único, de `authorize`): agendas, eventos, revogação e falhas são da conta,
 * então specs paralelos não se enxergam. `resetState` limpa todas as contas:
 * só para depuração local, nunca num spec.
 */
export const fakeGoogleCalendar = {
  baseUrl: URLS.googleCalendar,
  inbox: (filter?: { tenantId?: string; path?: string; since?: string }) =>
    fetchInbox('googleCalendar', filter),
  clear: () => clearInbox('googleCalendar'),
  resetState: () => googleCalendarCall<{ reset: boolean }>('DELETE', '/_control/state'),

  /**
   * O "popup" do GIS: código de autorização de uso único para a conta, que o
   * spec entrega ao `POST api/calendar/google/connect`. Sem `sub`, o fake cria
   * uma conta nova. `scope` default inclui `calendar.app.created`.
   */
  authorize: (input: {
    sub?: string;
    email?: string;
    scope?: string;
    omitRefreshToken?: boolean;
    omitIdToken?: boolean;
    idTokenAudience?: string;
  } = {}) =>
    googleCalendarCall<{ code: string; sub: string; email: string; scope: string }>(
      'POST',
      '/_control/authorize',
      input,
    ),

  /** Conta com grants, falha ativa, agendas e TODOS os eventos (inclusive os da lixeira). */
  account: (sub: string) =>
    googleCalendarCall<FakeGoogleCalendarAccount>('GET', `/_control/accounts/${encodeURIComponent(sub)}`),

  /** Eventos vivos (não `cancelled`) de todas as agendas não apagadas da conta. */
  liveEvents: async (sub: string): Promise<FakeGoogleCalendarEvent[]> => {
    const account = await fakeGoogleCalendar.account(sub);
    return account.calendars
      .filter((c) => !c.deleted)
      .flatMap((c) => c.events)
      .filter((e) => e.status !== 'cancelled');
  },

  /** O evento que o back espelhou para `eventId` (pelo marcador privado), em qualquer status; ou undefined. */
  eventFor: async (sub: string, eventId: string): Promise<FakeGoogleCalendarEvent | undefined> => {
    const account = await fakeGoogleCalendar.account(sub);
    return account.calendars
      .flatMap((c) => c.events)
      .find((e) => e.extendedProperties?.private?.recreativoEventId === eventId);
  },

  /** "Remover acesso" em myaccount.google.com: revoga todos os grants da conta. */
  revokeAccount: (sub: string) =>
    googleCalendarCall<{ revoked: number }>('POST', `/_control/accounts/${encodeURIComponent(sub)}/revoke`),

  /**
   * Liga um modo de falha para a conta: `500` (Google fora), `429`,
   * `invalid_grant` (API 401 + refresh recusado), `401` (só a API),
   * `404calendar`. `times` = quantas requisições falham (sem = até `clearFailure`).
   */
  setFailure: (sub: string, mode: FakeGoogleCalendarFailure, times?: number) =>
    googleCalendarCall('PUT', `/_control/accounts/${encodeURIComponent(sub)}/failure`, { mode, times: times ?? null }),

  clearFailure: (sub: string) =>
    googleCalendarCall('DELETE', `/_control/accounts/${encodeURIComponent(sub)}/failure`),

  calendar: (calendarId: string) =>
    googleCalendarCall<FakeGoogleCalendarCalendar>('GET', `/_control/calendars/${encodeURIComponent(calendarId)}`),

  /** O gestor apaga a agenda dedicada à mão no Google. */
  deleteCalendarByHand: (calendarId: string) =>
    googleCalendarCall<{ deleted: boolean }>('DELETE', `/_control/calendars/${encodeURIComponent(calendarId)}`),

  /** Evento criado à mão na agenda; sem `extendedProperties`, sem o nosso marcador. */
  createEventByHand: (calendarId: string, event: Record<string, unknown>) =>
    googleCalendarCall<FakeGoogleCalendarEvent>(
      'POST',
      `/_control/calendars/${encodeURIComponent(calendarId)}/events`,
      event,
    ),

  /** Evento apagado à mão: lixeira (PATCH restaura, insert do mesmo id dá 409) ou, com `purge`, some de vez (404). */
  deleteEventByHand: (calendarId: string, eventId: string, purge = false) =>
    googleCalendarCall<{ deleted: boolean; purged: boolean }>(
      'DELETE',
      `/_control/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}${purge ? '?purge=true' : ''}`,
    ),
};
