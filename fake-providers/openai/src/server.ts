import { createFakeServer, notFound } from '@fake-providers/shared';

const PORT = Number(process.env.FAKE_OPENAI_PORT ?? 1514);

await createFakeServer({
  name: 'openai',
  port: PORT,
  registerRoutes: (app) => {
    app.all('/*', async (req, reply) => {
      reply.status(501);
      return notFound(req);
    });
  },
});
