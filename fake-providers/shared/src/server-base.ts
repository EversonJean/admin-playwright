import Fastify, { FastifyInstance, FastifyRequest } from 'fastify';
import { tenantFromRequest } from './tenant.js';
import { WebhookDispatcher } from './webhook-dispatcher.js';

export interface InboxEntry {
  capturedAt: string;
  tenantId: string | null;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  /** Snapshot da resposta retornada — útil pra spec validar Status/Id devolvido */
  response: { status: number; body: unknown };
}

export interface InboxFilter {
  tenantId?: string;
  path?: string;
  since?: string;
}

export interface FakeServerOptions {
  /** Nome curto pra log ([asaas] starting on 1510) */
  name: string;
  /** Porta na qual escuta */
  port: number;
  /**
   * Registro de rotas específicas do provider. Recebe a instância já com
   * `addCapturedResponse` plumbed — basta `app.post('/v3/...', handler)` e
   * retornar o body. Toda request/response passa pelo inbox via onSend hook.
   */
  registerRoutes: (app: FastifyInstance, dispatcher: WebhookDispatcher) => void;
}

export interface FakeServerHandle {
  app: FastifyInstance;
  port: number;
  inbox: InboxEntry[];
  stop: () => Promise<void>;
}

const MAX_INBOX = 500;

/**
 * Sobe um fake server provider com inbox in-memory + control endpoints.
 *
 * O back faz HTTP real contra esse server (em E2E o `appsettings.E2E.json`
 * aponta BaseUrl do provider pra `http://localhost:<port>`). Cada request
 * é capturada com tenantId/path/body/headers/resposta — os specs leem via
 * `GET /_control/inbox`.
 *
 * Pra webhooks de volta (provider → back), o spec POSTa em
 * `/_control/trigger-webhook` e o server dispara HTTP real pro back (HMAC
 * deve ser implementado por cada provider antes de chamar `dispatcher.send`).
 */
export async function createFakeServer(
  opts: FakeServerOptions,
): Promise<FakeServerHandle> {
  const app = Fastify({ logger: false });
  const inbox: InboxEntry[] = [];
  const dispatcher = new WebhookDispatcher();

  // Captura toda request+response e enfileira no inbox. `onSend` roda depois
  // do handler ter setado o status, antes do byte sair na rede.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/_control')) return payload;
    let parsedBody: unknown = payload;
    if (typeof payload === 'string') {
      try {
        parsedBody = JSON.parse(payload);
      } catch {
        parsedBody = payload;
      }
    }
    const entry: InboxEntry = {
      capturedAt: new Date().toISOString(),
      tenantId: tenantFromRequest(req),
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: req.body ?? null,
      response: { status: reply.statusCode, body: parsedBody },
    };
    inbox.push(entry);
    if (inbox.length > MAX_INBOX) {
      inbox.splice(0, inbox.length - MAX_INBOX);
    }
    return payload;
  });

  app.get('/_control/health', async () => ({
    name: opts.name,
    port: opts.port,
    inbox: inbox.length,
    uptimeMs: process.uptime() * 1000,
  }));

  app.get<{ Querystring: InboxFilter }>('/_control/inbox', async (req) => {
    let items = inbox.slice();
    const { tenantId, path, since } = req.query;
    if (tenantId) items = items.filter((e) => e.tenantId === tenantId);
    if (path) items = items.filter((e) => e.path.includes(path));
    if (since) {
      const cut = Date.parse(since);
      if (!Number.isNaN(cut)) {
        items = items.filter((e) => Date.parse(e.capturedAt) >= cut);
      }
    }
    return { items, total: items.length };
  });

  app.delete('/_control/inbox', async () => {
    inbox.length = 0;
    return { cleared: true };
  });

  opts.registerRoutes(app, dispatcher);

  await app.listen({ port: opts.port, host: '0.0.0.0' });
  // eslint-disable-next-line no-console
  console.log(`[${opts.name}] fake provider listening on http://localhost:${opts.port}`);

  return {
    app,
    port: opts.port,
    inbox,
    stop: async () => {
      await app.close();
    },
  };
}

/**
 * Helper pra registrar `POST /_control/trigger-webhook` em providers que
 * precisam disparar callback pro back. Cada provider passa um `buildRequest`
 * que recebe o body do controle e devolve `{ url, payload, headers }` final.
 */
export function registerTriggerWebhook<TBody>(
  app: FastifyInstance,
  dispatcher: WebhookDispatcher,
  buildRequest: (body: TBody) => {
    url: string;
    payload: unknown;
    headers?: Record<string, string>;
  },
): void {
  app.post<{ Body: TBody }>('/_control/trigger-webhook', async (req, reply) => {
    const built = buildRequest(req.body);
    const result = await dispatcher.send({
      url: built.url,
      payload: built.payload,
      headers: built.headers,
    });
    reply.status(result.status >= 200 && result.status < 300 ? 200 : 502);
    return { dispatched: true, backStatus: result.status, backBody: result.body };
  });
}

export function notFound(req: FastifyRequest): { error: string; path: string } {
  return { error: 'fake server: route not implemented', path: req.url };
}
