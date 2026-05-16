import { createFakeServer, notFound } from '@fake-providers/shared';

const PORT = Number(process.env.FAKE_WHATSAPP_PORT ?? 1512);

await createFakeServer({
  name: 'whatsapp-meta',
  port: PORT,
  registerRoutes: (app) => {
    app.all('/*', async (req, reply) => {
      reply.status(501);
      return notFound(req);
    });
  },
});
