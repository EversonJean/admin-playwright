import { createHmac } from 'node:crypto';
import { createFakeServer, registerTriggerWebhook } from '@fake-providers/shared';
import * as state from './state.js';

/**
 * Fake Clicksign server (PLANEJAMENTO §13292-13301) — subset usado por
 * `ClicksignDigitalSignatureProvider`:
 *
 *   POST /documents          → cria document { document: { key } }
 *   POST /signers            → cria signer   { signer:   { key, url } }
 *   POST /lists              → vincula signer-doc
 *   POST /notifications      → dispara entrega (email)
 *   POST /notify_by_whatsapp → idem WhatsApp
 *   POST /notify_by_sms      → idem SMS
 *   PATCH /documents/:key/cancel → cancela envelope
 *   GET   /documents/:key    → status + download_url
 *
 * Webhook callback: `/_control/trigger-webhook` POSTa em
 * /api/webhooks/clicksign com header `X-Clicksign-Signature: sha256=<hex>`
 * calculado com `WEBHOOK_SECRET` (default 'fake-clicksign-webhook-secret-e2e').
 *
 * Auth: aceita qualquer Bearer; em E2E o back manda dummy.
 */

const PORT = Number(process.env.FAKE_CLICKSIGN_PORT ?? 1511);
const WEBHOOK_SECRET =
  process.env.FAKE_CLICKSIGN_WEBHOOK_SECRET ?? 'fake-clicksign-webhook-secret-e2e';

await createFakeServer({
  name: 'clicksign',
  port: PORT,
  registerRoutes: (app, dispatcher) => {
    app.delete('/_control/state', async () => {
      state.reset();
      return { reset: true };
    });

    app.post<{
      Body: {
        document?: {
          path?: string;
          content_base64?: string;
          deadline_at?: string;
        };
      };
    }>('/documents', async (req, reply) => {
      const d = req.body?.document;
      if (!d?.path || !d.content_base64) {
        reply.status(422);
        return { errors: [{ code: 'invalid', description: 'document.path/content_base64 obrigatorios' }] };
      }
      const filename = (d.path.split('/').pop() ?? 'contract.pdf').trim();
      const doc = state.createDocument({
        path: d.path,
        filename,
        deadlineAt: d.deadline_at ?? new Date(Date.now() + 15 * 86400000).toISOString(),
        port: PORT,
      });
      reply.status(201);
      return {
        document: {
          key: doc.key,
          filename: doc.filename,
          status: doc.status,
          deadline_at: doc.deadlineAt,
        },
      };
    });

    app.post<{
      Body: {
        signer?: {
          email?: string;
          phone_number?: string;
          name?: string;
          auths?: string[];
        };
      };
    }>('/signers', async (req, reply) => {
      const s = req.body?.signer;
      if (!s || (!s.email && !s.phone_number)) {
        reply.status(422);
        return { errors: [{ code: 'invalid', description: 'signer.email ou phone_number obrigatorio' }] };
      }
      const signer = state.createSigner({
        email: s.email,
        phoneNumber: s.phone_number,
        name: s.name,
      });
      reply.status(201);
      return {
        signer: {
          key: signer.key,
          url: signer.url,
          email: signer.email,
          phone_number: signer.phoneNumber,
        },
      };
    });

    app.post<{
      Body: {
        list?: {
          document_key?: string;
          signer_key?: string;
          sign_as?: string;
          message?: string;
          group?: number;
        };
      };
    }>('/lists', async (req, reply) => {
      const l = req.body?.list;
      if (!l?.document_key || !l.signer_key) {
        reply.status(422);
        return { errors: [{ code: 'invalid', description: 'document_key e signer_key obrigatorios' }] };
      }
      state.attachSignerToDocument(l.document_key, l.signer_key);
      reply.status(201);
      return { list: { document_key: l.document_key, signer_key: l.signer_key, sign_as: l.sign_as } };
    });

    const notifyHandler = async () => ({ notification: { delivered: true } });
    app.post('/notifications', notifyHandler);
    app.post('/notify_by_whatsapp', notifyHandler);
    app.post('/notify_by_sms', notifyHandler);

    app.patch<{ Params: { key: string } }>('/documents/:key/cancel', async (req, reply) => {
      const doc = state.setDocumentStatus(req.params.key, 'canceled');
      if (!doc) {
        reply.status(404);
        return { errors: [{ code: 'not_found', description: 'document not found' }] };
      }
      return { document: { key: doc.key, status: doc.status } };
    });

    app.get<{ Params: { key: string } }>('/documents/:key', async (req, reply) => {
      const doc = state.getDocument(req.params.key);
      if (!doc) {
        reply.status(404);
        return { errors: [{ code: 'not_found', description: 'document not found' }] };
      }
      return {
        document: {
          key: doc.key,
          filename: doc.filename,
          status: doc.status,
          download_url: doc.downloadUrl,
        },
      };
    });

    // Bytes dummy de PDF assinado — back faz GET aqui apos receber
    // download_url do GET /documents/:key. PDF minimo valido (cabecalho).
    app.get<{ Params: { keyName: string } }>('/_files/:keyName', async (req, reply) => {
      // Header PDF de 1 pagina vazia — suficiente pra passar pelo Document
      // Importer do back que valida MIME type.
      const minimalPdf = Buffer.from(
        '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
          '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
          '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]>>endobj\n' +
          'xref\n0 4\n0000000000 65535 f\n0000000009 00000 n\n0000000058 00000 n\n' +
          '0000000115 00000 n\ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n189\n%%EOF',
        'utf-8',
      );
      reply.header('Content-Type', 'application/pdf');
      reply.status(200);
      return minimalPdf;
    });

    type TriggerBody = {
      /** Event name segundo o parser do back: `sign`, `auto_close`, `cancel`, `refuse`, ... */
      event: string;
      providerDocumentKey: string;
      providerSignerKey?: string;
      occurredAt?: string;
      reason?: string;
      /** Override URL (default https://localhost:1501/api/webhooks/clicksign) */
      backUrl?: string;
    };

    registerTriggerWebhook<TriggerBody>(app, dispatcher, (body) => {
      // Atualiza state in-memory pra refletir o efeito (consistencia com o real)
      if (body.event === 'sign' || body.event === 'auto_close') {
        state.setDocumentStatus(body.providerDocumentKey, 'closed');
      } else if (body.event === 'cancel') {
        state.setDocumentStatus(body.providerDocumentKey, 'canceled');
      }

      const payload: Record<string, unknown> = {
        event: {
          name: body.event,
          occurred_at: body.occurredAt ?? new Date().toISOString(),
          data: body.reason ? { reason: body.reason } : {},
        },
        document: { key: body.providerDocumentKey },
      };
      if (body.providerSignerKey) {
        payload.signer = { key: body.providerSignerKey };
      }

      // HMAC SHA-256 do raw body com WebhookSecret (ClicksignDigital
      // SignatureProvider.ValidateWebhookSignature recomputa e compara).
      const rawBody = JSON.stringify(payload);
      const sig = createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');

      return {
        url: body.backUrl ?? 'https://localhost:1501/api/webhooks/clicksign',
        payload,
        headers: { 'X-Clicksign-Signature': `sha256=${sig}` },
      };
    });
  },
});
