import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { apiGetEvent } from '../../helpers/api-event-flow';
import { setupAcceptedEvent } from '../../helpers/setup-flows';
import type { EventDTO } from '../../helpers/types';

/**
 * Fluxo: 6.2 — Detalhe do evento
 * Diagrama: docs/fluxos/negocio-6.2-detalhe-do-evento.mmd
 */

test.describe('Fluxo 6.2 — Detalhe do evento', () => {
  test('@flow listagem de eventos carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/events/list');
  });

  test('@crud GET /api/events/:id devolve detalhes completos pos-aceite', async ({ authApi }) => {
    const { eventId, clienteId } = await setupAcceptedEvent(authApi);

    const ev = (await apiGetEvent(authApi, eventId)) as unknown as Pick<
      EventDTO,
      'id' | 'clientId' | 'clientName' | 'teamSize' | 'pricingItems' | 'total' | 'status'
    >;
    expect(ev.id).toBe(eventId);
    expect(ev.clientId).toBe(clienteId);
    expect(ev.clientName).toBeTruthy();
    expect(ev.teamSize).toBeGreaterThanOrEqual(0);
    expect(ev.pricingItems?.length).toBeGreaterThanOrEqual(1);
    expect(ev.total).toBeGreaterThan(0);
  });

  test('@crud GET evento inexistente devolve 400 ou 404 (sem 5xx)', async ({ authApi }) => {
    // Back atual devolve 400 (validacao do route param) pra guid que nao
    // corresponde a evento do tenant. Aceita 400 ou 404 — fica documentado
    // que ambos sao OK desde que nao vaze 5xx nem 200.
    const randomGuid = '11111111-2222-3333-4444-555555555555';
    const r = await authApi.get(`/api/events/${randomGuid}`);
    expect([400, 404], `status: ${r.status()}`).toContain(r.status());
  });
});
