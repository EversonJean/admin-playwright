import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import {
  apiAcceptPublicBudget,
  apiCreateBudget,
  apiGetEvent,
  apiSendBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';

/**
 * Fluxo: 6.2 — Detalhe do evento
 * Diagrama: docs/fluxos/negocio-6.2-detalhe-do-evento.mmd
 */

test.describe('Fluxo 6.2 — Detalhe do evento', () => {
  test('@flow listagem de eventos carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/events/list');
  });

  test('@crud GET /api/events/:id devolve detalhes completos pos-aceite', async ({ authApi }) => {
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

    const ev = (await apiGetEvent(authApi, eventId)) as unknown as {
      id: string;
      clientId?: string;
      clientName?: string;
      teamSize: number;
      pricingItems?: Array<{ activityId?: string; quantity: number }>;
      total: number;
      status: string;
    };
    expect(ev.id).toBe(eventId);
    expect(ev.clientId).toBe(cliente.id);
    expect(ev.clientName).toBeTruthy();
    expect(ev.teamSize).toBeGreaterThanOrEqual(0);
    expect(ev.pricingItems?.length).toBeGreaterThanOrEqual(1);
    expect(ev.total).toBeGreaterThan(0);
  });

  test('@crud GET evento inexistente devolve 404', async ({ authApi }) => {
    const r = await authApi.get('/api/events/00000000-0000-0000-0000-000000000000');
    expect([400, 404]).toContain(r.status());
  });
});
