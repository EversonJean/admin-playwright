import { createFakeServer, notFound } from '@fake-providers/shared';

const PORT = Number(process.env.FAKE_GOOGLE_MAPS_PORT ?? 1516);

await createFakeServer({
  name: 'google-maps',
  port: PORT,
  registerRoutes: (app) => {
    app.all('/*', async (req, reply) => {
      reply.status(501);
      return notFound(req);
    });
  },
});
