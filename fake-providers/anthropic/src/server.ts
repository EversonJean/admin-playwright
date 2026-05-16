import { createFakeServer, notFound } from '@fake-providers/shared';

const PORT = Number(process.env.FAKE_ANTHROPIC_PORT ?? 1515);

await createFakeServer({
  name: 'anthropic',
  port: PORT,
  registerRoutes: (app) => {
    app.all('/*', async (req, reply) => {
      reply.status(501);
      return notFound(req);
    });
  },
});
