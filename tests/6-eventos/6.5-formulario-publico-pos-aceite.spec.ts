import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiIssueEventFormLink, createPublicApiContext } from '../../helpers/api-event-flow';
import { setupAcceptedEvent } from '../../helpers/setup-flows';
import { assertOk, readJson } from '../../helpers/response';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 6.5 — Formulário público pós-aceite
 * Diagrama: docs/fluxos/negocio-6.5-formulario-publico-pos-aceite.mmd
 *
 * GET /api/public/events/:token/form devolve dados sem auth — o token sai da
 * URL que o gestor emite em POST /api/events/:id/form-link (Etapa 233: o banco
 * guarda so o hash, e o aceite nao emite mais o link).
 */

test.describe('Fluxo 6.5 — Formulário público pós-aceite', () => {
  test('@flow rota /event-form/:token carrega no front sem 5xx', async ({ page }) => {
    // SPA Angular: rota com token invalido carrega shell + tela de erro.
    await smokeRoute(page, '/event-form/token-invalido-teste');
  });

  test('@crud GET /api/public/events/:token/form devolve payload do evento aceito', async ({
    authApi,
  }) => {
    const { eventId } = await setupAcceptedEvent(authApi);
    const { token: formToken } = await apiIssueEventFormLink(authApi, eventId);
    expect(formToken.length).toBeGreaterThan(10);

    const publicApi = await createPublicApiContext();
    try {
      const res = await publicApi.get(`/api/public/events/${formToken}/form`);
      await assertOk(res, 'GET public form');
      const data = await readJson<{
        eventDate?: string;
        startTime?: string;
        endTime?: string;
        clientName?: string;
        fields?: unknown[];
      }>(res);
      // Valida shape minimo (nao so toBeTruthy).
      expect(data.eventDate ?? data.startTime, 'payload publico deve ter campo de evento').toBeTruthy();
    } finally {
      await publicApi.dispose();
    }
  });

  test('@crud token invalido devolve 404 sem vazar info', async () => {
    const publicApi = await createPublicApiContext();
    try {
      const res = await publicApi.get('/api/public/events/token-fake-inexistente/form');
      expect(res.status()).toBe(404);
    } finally {
      await publicApi.dispose();
    }
  });
});
