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
    accessToken?: string;
  }) => triggerWebhook('asaas', body),
};
