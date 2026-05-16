import { APIRequestContext, request as playwrightRequest } from '@playwright/test';

/**
 * Endpoints internos do back (`/api/_e2e/*`) habilitados em
 * `ASPNETCORE_ENVIRONMENT=E2E`. Permitem inspecionar o que os Logging*Providers
 * enviaram (email, WhatsApp) e disparar callbacks de webhook externos sem
 * precisar montar HMAC ou abrir socket.
 *
 * Esses endpoints NÃO existem em produção (`E2E:Endpoints:Enabled=false` →
 * middleware no Program.cs devolve 404 antes do controller responder).
 */

export interface E2EEmailEntry {
  tenantId: string | null;
  capturedAtUtc: string;
  to: string;
  subject: string;
  bodyHtml: string;
  bodyText: string | null;
}

export interface E2EWhatsAppEntry {
  tenantId: string | null;
  capturedAtUtc: string;
  toPhone: string;
  templateName: string;
  renderedBody: string;
}

/** Contexto anônimo (sem Bearer) — endpoints `_e2e/*` são `[AllowAnonymous]`. */
async function publicCtx(): Promise<APIRequestContext> {
  return playwrightRequest.newContext({
    baseURL: process.env.BACK_URL ?? 'https://localhost:1501',
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { 'Content-Type': 'application/json' },
  });
}

export async function e2eListEmails(tenantId?: string): Promise<E2EEmailEntry[]> {
  const api = await publicCtx();
  try {
    const url = tenantId ? `/api/_e2e/email-outbox?tenantId=${tenantId}` : '/api/_e2e/email-outbox';
    const res = await api.get(url);
    if (!res.ok()) {
      throw new Error(`GET email-outbox ${res.status()}: ${await res.text()}`);
    }
    return (await res.json()) as E2EEmailEntry[];
  } finally {
    await api.dispose();
  }
}

export async function e2eClearEmails(): Promise<void> {
  const api = await publicCtx();
  try {
    await api.delete('/api/_e2e/email-outbox');
  } finally {
    await api.dispose();
  }
}

export async function e2eListWhatsApp(tenantId?: string): Promise<E2EWhatsAppEntry[]> {
  const api = await publicCtx();
  try {
    const url = tenantId
      ? `/api/_e2e/whatsapp-outbox?tenantId=${tenantId}`
      : '/api/_e2e/whatsapp-outbox';
    const res = await api.get(url);
    if (!res.ok()) {
      throw new Error(`GET whatsapp-outbox ${res.status()}: ${await res.text()}`);
    }
    return (await res.json()) as E2EWhatsAppEntry[];
  } finally {
    await api.dispose();
  }
}

/**
 * Dispara o `DigitalSignatureWebhookProcessor` simulando que ClickSign acabou
 * de notificar `sign` pra um envelope. Equivalente ao webhook real chegar.
 */
export async function e2eSimulateClicksignSigned(
  providerDocumentKey: string,
  signerKey?: string,
): Promise<void> {
  const api = await publicCtx();
  try {
    const res = await api.post('/api/_e2e/clicksign/simulate-signed', {
      data: { providerDocumentKey, signerKey: signerKey ?? null },
    });
    if (!res.ok()) {
      throw new Error(`simulateClicksignSigned ${res.status()}: ${await res.text()}`);
    }
  } finally {
    await api.dispose();
  }
}

export async function e2eSimulateAsaasPaid(
  asaasPaymentId: string,
  value: number,
  customerId?: string,
  externalReference?: string,
): Promise<void> {
  const api = await publicCtx();
  try {
    const res = await api.post('/api/_e2e/asaas/simulate-paid', {
      data: {
        asaasPaymentId,
        value,
        customerId: customerId ?? null,
        externalReference: externalReference ?? null,
      },
    });
    if (!res.ok()) {
      throw new Error(`simulateAsaasPaid ${res.status()}: ${await res.text()}`);
    }
  } finally {
    await api.dispose();
  }
}
