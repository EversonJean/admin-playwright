import { createFakeServer } from '@fake-providers/shared';
import * as state from './state.js';

/**
 * Fake REST email server — endpoint que `HttpEmailProvider` chama:
 *
 *   POST /send
 *   Body: { to, subject, bodyHtml, bodyText, from, fromName }
 *   Auth: Authorization: Bearer <ApiKey>
 *   Resposta: { id: "fake_email_<unique>" }
 *
 * Em E2E o back tem `Email:Provider=Http` + BaseUrl=http://localhost:1513/,
 * entao todo email "enviado" cai aqui. Specs leem via `/_control/emails`
 * (helper especifico) ou `/_control/inbox` (request raw).
 */

const PORT = Number(process.env.FAKE_EMAIL_PORT ?? 1513);

await createFakeServer({
  name: 'email',
  port: PORT,
  registerRoutes: (app) => {
    app.delete('/_control/state', async () => {
      state.reset();
      return { reset: true };
    });

    app.get<{ Querystring: { to?: string; subject?: string } }>(
      '/_control/emails',
      async (req) => {
        const items = state.list(req.query);
        return { items, total: items.length };
      },
    );

    app.post<{
      Body: {
        to?: string;
        subject?: string;
        bodyHtml?: string;
        bodyText?: string;
        from?: string;
        fromName?: string;
      };
    }>('/send', async (req, reply) => {
      const body = req.body;
      if (!body?.to || !body.subject || !body.bodyHtml) {
        reply.status(422);
        return { error: 'to/subject/bodyHtml obrigatorios' };
      }
      const email = state.append({
        to: body.to,
        subject: body.subject,
        bodyHtml: body.bodyHtml,
        bodyText: body.bodyText,
        from: body.from,
        fromName: body.fromName,
      });
      reply.status(200);
      return { id: email.id };
    });
  },
});
