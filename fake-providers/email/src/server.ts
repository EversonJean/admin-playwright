import { createFakeServer, notFound } from '@fake-providers/shared';

const PORT = Number(process.env.FAKE_EMAIL_PORT ?? 1513);

await createFakeServer({
  name: 'email',
  port: PORT,
  registerRoutes: (app) => {
    app.all('/*', async (req, reply) => {
      reply.status(501);
      return notFound(req);
    });
  },
});
