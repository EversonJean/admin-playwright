import { createFakeServer, notFound } from '@fake-providers/shared';

const PORT = Number(process.env.FAKE_CLICKSIGN_PORT ?? 1511);

await createFakeServer({
  name: 'clicksign',
  port: PORT,
  registerRoutes: (app) => {
    app.all('/*', async (req, reply) => {
      reply.status(501);
      return notFound(req);
    });
  },
});
