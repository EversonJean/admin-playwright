import { createFakeServer, notFound } from '@fake-providers/shared';

/**
 * Fake Asaas server — stub inicial. Implementação completa virá na Fatia 2:
 * /v3/customers, /v3/payments, /v3/subscriptions + trigger-webhook
 * PAYMENT_CONFIRMED/PAYMENT_RECEIVED/PAYMENT_OVERDUE.
 */
const PORT = Number(process.env.FAKE_ASAAS_PORT ?? 1510);

await createFakeServer({
  name: 'asaas',
  port: PORT,
  registerRoutes: (app) => {
    app.all('/*', async (req, reply) => {
      reply.status(501);
      return notFound(req);
    });
  },
});
