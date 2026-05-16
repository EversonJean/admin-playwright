import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { apiGetEvent } from '../../helpers/api-event-flow';
import { setupAcceptedEvent } from '../../helpers/setup-flows';
import { assertOk, readJson } from '../../helpers/response';
import { GUID_REGEX, type EventDTO } from '../../helpers/types';

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
    const { eventId, orcamentoId } = await setupAcceptedEvent(authApi);
    expect(eventId).toMatch(GUID_REGEX);

    const ev = (await apiGetEvent(authApi, eventId)) as unknown as Pick<
      EventDTO,
      'id' | 'kind' | 'budgetId' | 'status'
    >;
    expect(ev.id).toBe(eventId);
    expect(ev.kind).toBe('Commercial');
    expect(ev.budgetId).toBe(orcamentoId);
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
    await assertOk(res, 'POST operational');
    const created = await readJson<{ id: string; kind: string }>(res);
    expect(created.id).toMatch(GUID_REGEX);
    expect(created.kind).toBe('ScheduleBlock');
  });
});
