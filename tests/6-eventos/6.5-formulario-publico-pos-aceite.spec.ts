import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import {
  apiAcceptPublicBudget,
  apiCreateBudget,
  apiSendBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';
import { getEventFormPublicTokenDirect } from '../../helpers/db-helper';

/**
 * Fluxo: 6.5 — Formulário público pós-aceite
 * Diagrama: docs/fluxos/negocio-6.5-formulario-publico-pos-aceite.mmd
 *
 * GET /api/public/events/:token/form devolve dados sem auth — token vem
 * do `FormPublicToken` do Event (lido via SQL, nao exposto pela API).
 */

test.describe('Fluxo 6.5 — Formulário público pós-aceite', () => {
  test('@flow rota /event-form/:token responde sem 500', async ({ page }) => {
    const res = await page.goto('/event-form/token-invalido-teste');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test('@crud GET /api/public/events/:token/form devolve dados do evento aceito', async ({
    authApi,
  }) => {
    const cliente = await apiCreateClient(authApi);
    const atividade = await apiCreateActivity(authApi);
    const orcamento = await apiCreateBudget(authApi, {
      clientId: cliente.id,
      activityIds: [atividade.id],
    });
    const sent = await apiSendBudget(authApi, orcamento.id);
    const token = extractTokenFromPublicUrl(sent.publicUrl);

    const publicApi = await createPublicApiContext();
    let eventId: string;
    try {
      const aceito = await apiAcceptPublicBudget(publicApi, token);
      eventId = aceito.eventId;
    } finally {
      await publicApi.dispose();
    }

    const formToken = getEventFormPublicTokenDirect(eventId);
    expect(formToken.length).toBeGreaterThan(10);

    const publicApi2 = await createPublicApiContext();
    try {
      const res = await publicApi2.get(`/api/public/events/${formToken}/form`);
      expect(res.ok()).toBe(true);
      const body = await res.json();
      const data = body.data ?? body;
      expect(data, 'GET publico do form deve devolver payload').toBeTruthy();
    } finally {
      await publicApi2.dispose();
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
