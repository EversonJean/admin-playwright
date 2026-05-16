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
 * Fluxo: 6.1 — Criação automática do evento (no aceite do orçamento)
 * Diagrama: docs/fluxos/negocio-6.1-criacao-automatica-evento.mmd
 */

test.describe('Fluxo 6.1 — Criação automática do evento', () => {
  test('@flow listagem de eventos carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/events/list');
  });

  test('@flow criação manual operacional carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/events/new-operational');
  });

  test('@crud aceite de orcamento auto-cria Event Commercial linkado', async ({ authApi }) => {
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
    expect(eventId).toBeTruthy();

    const ev = (await apiGetEvent(authApi, eventId)) as unknown as {
      id: string;
      kind: string;
      budgetId?: string;
      status: string;
    };
    expect(ev.id).toBe(eventId);
    expect(ev.kind).toBe('Commercial');
    expect(ev.budgetId).toBe(orcamento.id);
  });

  test('@crud POST /api/events/operational cria ScheduleBlock', async ({ authApi }) => {
    const day = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
    const res = await authApi.post('/api/events/operational', {
      data: {
        kind: 'ScheduleBlock',
        eventDate: day,
        startTime: '08:00',
        endTime: '17:00',
        location: 'Manutencao E2E',
        childrenCount: 0,
      },
    });
    if (!res.ok()) {
      throw new Error(`POST operational ${res.status()}: ${await res.text()}`);
    }
    const body = await res.json();
    const created = body.data ?? body;
    expect(created.id).toBeTruthy();
    expect(created.kind).toBe('ScheduleBlock');
  });
});
