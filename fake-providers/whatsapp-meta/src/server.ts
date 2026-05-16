import { createHmac } from 'node:crypto';
import { createFakeServer, registerTriggerWebhook } from '@fake-providers/shared';
import * as state from './state.js';

/**
 * Fake WhatsApp Cloud API server (Meta Graph v18) — endpoints que
 * `MetaWhatsAppOutboundProvider` e `MetaWhatsAppApprovalProvider` chamam:
 *
 *   POST /:phoneNumberId/messages       → envio de mensagem (template)
 *   GET  /:metaTemplateId               → consulta status do template
 *
 * Webhook callback (status update / inbound mensagem):
 *   POST /_control/trigger-webhook → POSTa em /api/webhooks/whatsapp
 *   com header `X-Hub-Signature-256: sha256=<hex>` (HMAC do raw body com
 *   `WEBHOOK_APP_SECRET`).
 *
 * Auth Bearer aceita qualquer token; em E2E o back manda dummy.
 */

const PORT = Number(process.env.FAKE_WHATSAPP_PORT ?? 1512);
const APP_SECRET =
  process.env.FAKE_WHATSAPP_APP_SECRET ?? 'fake-whatsapp-app-secret-e2e';

function uniqueWamid(): string {
  return 'wamid.fake_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

await createFakeServer({
  name: 'whatsapp-meta',
  port: PORT,
  registerRoutes: (app, dispatcher) => {
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

    // GET /:metaTemplateId (consulta status). Se nao foi pre-cadastrado via
    // _control/state, devolve Approved por default (cenario otimista).
    app.get<{ Params: { metaTemplateId: string }; Querystring: { fields?: string } }>(
      '/:metaTemplateId',
      async (req, reply) => {
        const id = req.params.metaTemplateId;
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
      /** `messages.status` (delivered/read/failed) ou `messages.inbound` */
      kind: 'status' | 'inbound';
      /** Phone do recipiente / remetente */
      phone: string;
      /** Pra status: wamid da mensagem enviada que esta sendo atualizada */
      messageId?: string;
      /** Pra status: novo status (sent/delivered/read/failed) */
      status?: 'sent' | 'delivered' | 'read' | 'failed';
      /** Pra inbound: texto recebido */
      text?: string;
      /** Override URL (default https://localhost:1501/api/webhooks/whatsapp) */
      backUrl?: string;
    };

    registerTriggerWebhook<TriggerBody>(app, dispatcher, (body) => {
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
                  metadata: { display_phone_number: '5541999000000', phone_number_id: 'fake_phone' },
                  ...(body.kind === 'status'
                    ? {
                        statuses: [
                          {
                            id: body.messageId,
                            status: body.status ?? 'delivered',
                            recipient_id: body.phone.replace(/\D/g, ''),
                            timestamp: Math.floor(Date.now() / 1000).toString(),
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
