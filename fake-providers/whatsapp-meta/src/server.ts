import { createHmac } from 'node:crypto';
import { createFakeServer, registerTriggerWebhook } from '@fake-providers/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import * as state from './state.js';

/**
 * Fake WhatsApp Cloud API server (Meta Graph v18) — endpoints que
 * `MetaWhatsAppOutboundProvider`, `MetaWhatsAppApprovalProvider` e
 * `MetaWhatsAppOnboardingProvider` chamam:
 *
 *   POST /:phoneNumberId/messages       → envio de mensagem (template | text | document)
 *   POST /:phoneNumberId/media          → upload de mídia (multipart) → { id }
 *   GET  /:metaTemplateId               → consulta status do template (catálogo)
 *   GET  /:mediaId                      → mídia recebida cadastrada: { url, mime_type, file_size, id }
 *   GET  /_media/:mediaId               → bytes da mídia recebida (a `url` acima)
 *   GET  /:wabaId/phone_numbers         → numeros da WABA (Etapa 239)
 *   GET  /:wabaId/message_templates     → templates da WABA por `name` (Etapa 242)
 *   POST /:wabaId/message_templates     → submete template à WABA (Etapa 242)
 *   POST /:appId/uploads                → abre sessão de upload resumable → { id: "upload:..." }
 *   POST /upload:...                    → sobe o exemplo do cabeçalho → { h }
 *   GET  /oauth/access_token            → troca do `code` do Embedded Signup
 *   POST /:wabaId/subscribed_apps       → assina o app nos webhooks da WABA
 *
 * Controle: `PUT /_control/wabas/:wabaId/phone-numbers` `{ ids }` cadastra os
 * numeros que a WABA lista; sem cadastro a lista vem vazia (connect -> 400
 * `Conversations.PhoneNumberNotInWaba`). `POST /_control/wabas/:wabaId/templates`
 * pré-cadastra um template na WABA com status específico (Rejected/Paused).
 * `POST /_control/media` `{ id, mimeType, contentBase64 }` cadastra a mídia que
 * um webhook inbound vai citar pelo `id` (o `GET /:mediaId` e o download exigem o
 * token do canal do tenant, como a Meta).
 *
 * Webhook callback (status update / inbound mensagem):
 *   POST /_control/trigger-webhook → POSTa em /api/webhooks/whatsapp
 *   com header `X-Hub-Signature-256: sha256=<hex>` (HMAC do raw body com
 *   `WEBHOOK_APP_SECRET`). `kind: 'raw'` manda o `payload` do spec como está,
 *   so assinado (varios `entry` num POST, `message_template_status_update`).
 *
 * Credencial (Etapa 242, SEG-C2): o envio, a mídia e tudo que é da WABA do
 * tenant saem com o token DO CANAL DO TENANT. O fake recusa com 401 (o
 * `OAuthException` 190 da Meta) a chamada sem Bearer ou com o token da
 * PLATAFORMA (`WhatsApp:ApiKey` do `appsettings.E2E.json`): é a regressão que a
 * etapa fecha — a família recebia do número da plataforma. O token de cada canal
 * semeado é `fake_token_<phoneNumberId>` (`helpers/db-helper.ts`), e o spec o
 * confere no inbox. A consulta do CATÁLOGO (`GET /:metaTemplateId`) continua com
 * o token da plataforma, de propósito.
 */

const PORT = Number(process.env.FAKE_WHATSAPP_PORT ?? 1512);
const APP_SECRET =
  process.env.FAKE_WHATSAPP_APP_SECRET ?? 'fake-whatsapp-app-secret-e2e';
/** `WhatsApp:ApiKey` do `appsettings.E2E.json`: nunca serve para a WABA do tenant. */
const PLATFORM_TOKEN = process.env.FAKE_WHATSAPP_PLATFORM_TOKEN ?? 'fake-whatsapp-key-e2e';
/**
 * Credenciais do app para a troca do `code` e para o upload do exemplo:
 * `WhatsApp:AppId`/`WhatsApp:AppSecret` do `appsettings.E2E.json` do back, com
 * os mesmos literais. A variável de ambiente só troca o valor esperado; o fake
 * sempre confere o par, como a Meta faz.
 */
const EXPECTED_APP_ID = process.env.FAKE_WHATSAPP_APP_ID ?? 'fake-whatsapp-app-id-e2e';
const EXPECTED_APP_SECRET =
  process.env.FAKE_WHATSAPP_APP_CLIENT_SECRET ?? 'fake-whatsapp-app-client-secret-e2e';

function uniqueWamid(): string {
  return 'wamid.fake_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function uniqueId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function oauthError(reply: FastifyReply, message: string) {
  reply.status(401);
  return { error: { message, type: 'OAuthException', code: 190 } };
}

/** Token do header `Authorization: <scheme> <token>`, ou null. */
function tokenOf(req: FastifyRequest, scheme: 'Bearer' | 'OAuth'): string | null {
  const raw = req.headers['authorization'];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) return null;
  const [got, ...rest] = header.split(' ');
  if (got?.toLowerCase() !== scheme.toLowerCase()) return null;
  const token = rest.join(' ').trim();
  return token.length > 0 ? token : null;
}

/** null = token de tenant aceito; senão, o motivo da recusa. */
function tenantTokenProblem(req: FastifyRequest, scheme: 'Bearer' | 'OAuth' = 'Bearer'): string | null {
  const token = tokenOf(req, scheme);
  if (!token) return 'Missing access token';
  if (token === PLATFORM_TOKEN) {
    return 'The platform token has no permission over this WhatsApp Business Account';
  }
  return null;
}

await createFakeServer({
  name: 'whatsapp-meta',
  port: PORT,
  registerRoutes: (app, dispatcher) => {
    // `/media` chega em multipart e o upload resumable em binário sem
    // Content-Type: o fake não lê o conteúdo, só guarda o tamanho no inbox.
    app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, { bytes: (body as { length: number }).length });
    });

    app.delete('/_control/state', async () => {
      state.reset();
      return { reset: true };
    });

    // POST /:phoneNumberId/messages
    app.post<{
      Params: { phoneNumberId: string };
      Body: {
        messaging_product?: string;
        to?: string;
        type?: string;
        template?: {
          name?: string;
          language?: { code?: string };
          components?: Array<{ type?: string; parameters?: Array<{ text?: string }> }>;
        };
      };
    }>('/:phoneNumberId/messages', async (req, reply) => {
      const denied = tenantTokenProblem(req);
      if (denied) return oauthError(reply, denied);
      const body = req.body;
      if (!body?.to || !body.type) {
        reply.status(400);
        return { error: { message: 'invalid request', code: 100 } };
      }
      // Resposta com formato da Meta v18
      const wamid = uniqueWamid();
      reply.status(200);
      return {
        messaging_product: 'whatsapp',
        contacts: [{ input: body.to, wa_id: body.to.replace(/\D/g, '') }],
        messages: [{ id: wamid, message_status: 'accepted' }],
      };
    });

    // POST /:phoneNumberId/media — upload do PDF do orçamento por WhatsApp.
    app.post<{ Params: { phoneNumberId: string } }>(
      '/:phoneNumberId/media',
      async (req, reply) => {
        const denied = tenantTokenProblem(req);
        if (denied) return oauthError(reply, denied);
        reply.status(200);
        return { id: uniqueId('media_fake') };
      },
    );

    // GET /:metaTemplateId (consulta status). Se nao foi pre-cadastrado via
    // _control/state, devolve Approved por default (cenario otimista).
    app.get<{ Params: { metaTemplateId: string }; Querystring: { fields?: string } }>(
      '/:metaTemplateId',
      async (req, reply) => {
        const id = req.params.metaTemplateId;

        // Mídia recebida (`MetaWhatsAppMediaFetcher`): o mesmo `GET /:id` da
        // Graph, com a url assinada do binário. Só o id cadastrado pelo spec.
        const media = state.getInboundMedia(id);
        if (media) {
          const denied = tenantTokenProblem(req);
          if (denied) return oauthError(reply, denied);
          reply.status(200);
          return {
            messaging_product: 'whatsapp',
            id: media.id,
            url: `http://localhost:${PORT}/_media/${encodeURIComponent(media.id)}`,
            mime_type: media.mimeType,
            file_size: media.bytes.length,
          };
        }

        let tpl = state.getTemplate(id);
        if (!tpl) {
          // Cria-on-demand como Approved — facilita specs que so testam
          // o caminho feliz. Pra cenarios Rejected, spec usa POST
          // /_control/state pra pre-cadastrar com status especifico.
          tpl = state.upsertTemplate({ id, name: 'autoseed', status: 'APPROVED' });
        }
        reply.status(200);
        return {
          id: tpl.id,
          name: tpl.name,
          status: tpl.status,
          rejected_reason: tpl.rejectedReason,
        };
      },
    );

    // GET /_media/:mediaId — o binário da url assinada acima (token do canal).
    app.get<{ Params: { mediaId: string } }>('/_media/:mediaId', async (req, reply) => {
      const denied = tenantTokenProblem(req);
      if (denied) return oauthError(reply, denied);
      const media = state.getInboundMedia(req.params.mediaId);
      if (!media) {
        reply.status(404);
        return { error: { message: 'media not found', code: 100 } };
      }
      reply.status(200).header('content-type', media.mimeType);
      return reply.send(media.bytes);
    });

    // POST /_control/media — cadastra a mídia que o webhook inbound vai citar.
    app.post<{ Body: { id?: string; mimeType?: string; contentBase64?: string } }>(
      '/_control/media',
      async (req, reply) => {
        const { id, mimeType, contentBase64 } = req.body ?? {};
        if (!id || !mimeType || typeof contentBase64 !== 'string') {
          reply.status(400);
          return { error: 'id, mimeType e contentBase64 sao obrigatorios' };
        }
        const media = state.putInboundMedia({ id, mimeType, bytes: Buffer.from(contentBase64, 'base64') });
        return { id: media.id, size: media.bytes.length };
      },
    );

    // GET /:wabaId/phone_numbers?fields=id&limit=100 — so o `id` de cada
    // numero, que e o que o back le; uma pagina so (sem `paging`).
    app.get<{ Params: { wabaId: string } }>('/:wabaId/phone_numbers', async (req, reply) => {
      reply.status(200);
      return { data: state.getWabaPhoneNumbers(req.params.wabaId).map((id) => ({ id })) };
    });

    // GET /:wabaId/message_templates?name=…&fields=id,name,language,status,rejected_reason
    // (Etapa 242) — o back procura o template antes de submeter (reconexão).
    app.get<{ Params: { wabaId: string }; Querystring: { name?: string } }>(
      '/:wabaId/message_templates',
      async (req, reply) => {
        const denied = tenantTokenProblem(req);
        if (denied) return oauthError(reply, denied);
        reply.status(200);
        return {
          data: state.findWabaTemplates(req.params.wabaId, req.query.name).map((t) => ({
            id: t.id,
            name: t.name,
            language: t.language,
            status: t.status,
            ...(t.rejectedReason ? { rejected_reason: t.rejectedReason } : {}),
          })),
        };
      },
    );

    // POST /:wabaId/message_templates { name, language, category, components }
    // (Etapa 242). Aprova na hora, deterministico como o provider de log do
    // back; o cenario de recusa se pre-cadastra por `_control`.
    app.post<{
      Params: { wabaId: string };
      Body: {
        name?: string;
        language?: string;
        category?: string;
        components?: Array<{
          type?: string;
          format?: string;
          text?: string;
          example?: { header_handle?: string[] };
        }>;
      };
    }>('/:wabaId/message_templates', async (req, reply) => {
      const denied = tenantTokenProblem(req);
      if (denied) return oauthError(reply, denied);
      const body = req.body;
      const components = body?.components ?? [];
      if (!body?.name || !body.language || !body.category || !components.some((c) => c.type === 'BODY')) {
        reply.status(400);
        return { error: { message: 'Invalid parameter', type: 'OAuthException', code: 100 } };
      }
      const header = components.find((c) => c.type === 'HEADER');
      const headerHandle = header?.example?.header_handle?.[0];
      if (header && header.format === 'DOCUMENT' && !headerHandle) {
        reply.status(400);
        return {
          error: { message: 'Header document requires an example handle', type: 'OAuthException', code: 100 },
        };
      }
      const tpl = state.addWabaTemplate(req.params.wabaId, {
        name: body.name,
        language: body.language,
        category: body.category,
        headerHandle,
      });
      reply.status(200);
      return { id: tpl.id, status: tpl.status, category: tpl.category };
    });

    // POST /_control/wabas/:wabaId/templates — pre-cadastra na WABA um template
    // com status especifico; o GET do back o acha e nao submete de novo.
    app.post<{
      Params: { wabaId: string };
      Body: {
        id?: string;
        name: string;
        language?: string;
        category?: string;
        status?: state.FakeWabaTemplate['status'];
        rejectedReason?: string;
      };
    }>('/_control/wabas/:wabaId/templates', async (req) => {
      const tpl = state.addWabaTemplate(req.params.wabaId, {
        id: req.body.id,
        name: req.body.name,
        language: req.body.language ?? 'pt_BR',
        category: req.body.category ?? 'UTILITY',
        status: req.body.status,
        rejectedReason: req.body.rejectedReason,
      });
      return { template: tpl };
    });

    // POST /:appId/uploads?file_name=&file_length=&file_type= — sessão do
    // upload resumable do exemplo do cabeçalho de documento (Etapa 242). O id
    // volta com `?sig=`, como na Meta, e o back o usa tal como veio na URL.
    app.post<{
      Params: { appId: string };
      Querystring: { file_name?: string; file_length?: string; file_type?: string };
    }>('/:appId/uploads', async (req, reply) => {
      const denied = tenantTokenProblem(req);
      if (denied) return oauthError(reply, denied);
      if (req.params.appId !== EXPECTED_APP_ID) {
        reply.status(400);
        return { error: { message: 'Unsupported post request: unknown app id', type: 'GraphMethodException', code: 100 } };
      }
      const { file_name, file_length, file_type } = req.query;
      const length = Number(file_length);
      if (!file_name || !file_type || !Number.isFinite(length) || length <= 0) {
        reply.status(400);
        return { error: { message: 'Invalid upload session parameters', type: 'OAuthException', code: 100 } };
      }
      const id = state.openUploadSession(file_name, length, file_type);
      reply.status(200);
      return { id: `${id}?sig=fake_sig` };
    });

    // POST /upload:<sessão>?sig=… — corpo binário, `Authorization: OAuth <token>`
    // e `file_offset: 0` (Resumable Upload API) → handle `h`.
    app.post<{ Params: { uploadSession: string } }>('/:uploadSession', async (req, reply) => {
      const session = req.params.uploadSession;
      if (!session.startsWith('upload:') || !state.hasUploadSession(session)) {
        reply.status(404);
        return { error: { message: 'Unknown upload session', type: 'OAuthException', code: 100 } };
      }
      const denied = tenantTokenProblem(req, 'OAuth');
      if (denied) return oauthError(reply, denied);
      if (req.headers['file_offset'] !== '0') {
        reply.status(400);
        return { error: { message: 'file_offset header required', type: 'OAuthException', code: 100 } };
      }
      reply.status(200);
      return { h: `4::${uniqueId('fake_handle')}` };
    });

    // GET /oauth/access_token?client_id=&client_secret=&code= — troca do code
    // do Embedded Signup pelo token do canal do tenant.
    app.get<{ Querystring: { client_id?: string; client_secret?: string; code?: string } }>(
      '/oauth/access_token',
      async (req, reply) => {
        const { client_id, client_secret, code } = req.query;
        const wrongApp = client_id !== EXPECTED_APP_ID || client_secret !== EXPECTED_APP_SECRET;
        if (!client_id || !client_secret || !code || wrongApp) {
          reply.status(400);
          return {
            error: { message: 'Error validating client secret or code', type: 'OAuthException', code: 1 },
          };
        }
        reply.status(200);
        return {
          access_token: `fake_token_code_${code}`,
          token_type: 'bearer',
          expires_in: 5183944,
        };
      },
    );

    // POST /:wabaId/subscribed_apps — assina o app nos webhooks da WABA.
    app.post<{ Params: { wabaId: string } }>('/:wabaId/subscribed_apps', async (req, reply) => {
      const denied = tenantTokenProblem(req);
      if (denied) return oauthError(reply, denied);
      reply.status(200);
      return { success: true };
    });

    // PUT /_control/wabas/:wabaId/phone-numbers — o spec cadastra o numero que
    // vai conectar antes do POST /api/conversations/whatsapp/connect.
    app.put<{ Params: { wabaId: string }; Body: { ids?: string[] } }>(
      '/_control/wabas/:wabaId/phone-numbers',
      async (req) => {
        const ids = state.setWabaPhoneNumbers(req.params.wabaId, req.body?.ids ?? []);
        return { wabaId: req.params.wabaId, ids };
      },
    );

    // POST /_control/template — pre-cadastra um template com status
    // especifico pra cenarios de Rejected/Paused.
    app.post<{
      Body: {
        id?: string;
        name: string;
        status?: 'APPROVED' | 'PENDING' | 'REJECTED' | 'PAUSED';
        rejectedReason?: string;
      };
    }>('/_control/template', async (req) => {
      const tpl = state.upsertTemplate(req.body);
      return { template: tpl };
    });

    type TriggerBody = {
      /**
       * `messages.status` (delivered/read/failed), `messages.inbound`, ou `raw`:
       * o `payload` do spec vai como está, só assinado (lote com varios
       * `entry` de numeros diferentes, `message_template_status_update`).
       */
      kind: 'status' | 'inbound' | 'raw';
      /** So no `raw`: o corpo inteiro no formato da Meta. */
      payload?: Record<string, unknown>;
      /** Phone do recipiente / remetente */
      phone: string;
      /** Pra status: wamid da mensagem enviada que esta sendo atualizada */
      messageId?: string;
      /** Pra status: novo status (sent/delivered/read/failed) */
      status?: 'sent' | 'delivered' | 'read' | 'failed';
      /** Pra inbound: texto recebido */
      text?: string;
      /**
       * Pra status: `timestamp` da Meta em segundos (default agora). Fixo, o
       * mesmo payload pode ser reenviado byte a byte (replay de verdade).
       */
      timestamp?: number;
      /** Pra status `failed`: `errors[]` no formato da Meta (code, title, error_data.details). */
      errors?: Array<{
        code: number;
        title: string;
        message?: string;
        error_data?: { details?: string };
      }>;
      /**
       * `metadata.phone_number_id` do payload (default `fake_phone`). E por ele
       * que o back acha o tenant: o spec passa o id do canal que semeou
       * (`seedWhatsappChannelDirect` devolve um por tenant), senao dois specs
       * em workers paralelos roubam o canal um do outro.
       */
      phoneNumberId?: string;
      /** Override URL (default https://localhost:1501/api/webhooks/whatsapp) */
      backUrl?: string;
    };

    registerTriggerWebhook<TriggerBody>(app, dispatcher, (body) => {
      // `raw` (PLANO-SEGURANCA E131, E143, E144): o lote que a Meta pode mandar
      // e o fake nao monta sozinho. Assinado como os outros: o back e fail-closed.
      if (body.kind === 'raw' && body.payload) {
        const rawBody = JSON.stringify(body.payload);
        const sig = createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');
        return {
          url: body.backUrl ?? 'https://localhost:1501/api/webhooks/whatsapp',
          payload: body.payload,
          headers: { 'X-Hub-Signature-256': `sha256=${sig}` },
        };
      }

      // Estrutura Meta v18 Webhooks:
      // { object: 'whatsapp_business_account', entry: [{ id, changes:
      //   [{ value: { messaging_product, metadata, messages, statuses } }] }] }
      const payload: Record<string, unknown> = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'fake_waba_id',
            changes: [
              {
                value: {
                  messaging_product: 'whatsapp',
                  metadata: { display_phone_number: '5541999000000', phone_number_id: body.phoneNumberId ?? 'fake_phone' },
                  ...(body.kind === 'status'
                    ? {
                        statuses: [
                          {
                            id: body.messageId,
                            status: body.status ?? 'delivered',
                            recipient_id: body.phone.replace(/\D/g, ''),
                            timestamp: (body.timestamp ?? Math.floor(Date.now() / 1000)).toString(),
                            ...(body.errors ? { errors: body.errors } : {}),
                          },
                        ],
                      }
                    : {
                        messages: [
                          {
                            from: body.phone.replace(/\D/g, ''),
                            id: uniqueWamid(),
                            timestamp: Math.floor(Date.now() / 1000).toString(),
                            type: 'text',
                            text: { body: body.text ?? '' },
                          },
                        ],
                      }),
                },
                field: 'messages',
              },
            ],
          },
        ],
      };

      const rawBody = JSON.stringify(payload);
      const sig = createHmac('sha256', APP_SECRET).update(rawBody).digest('hex');

      return {
        url: body.backUrl ?? 'https://localhost:1501/api/webhooks/whatsapp',
        payload,
        headers: { 'X-Hub-Signature-256': `sha256=${sig}` },
      };
    });
  },
});
