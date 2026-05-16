import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { setupAcceptedEvent } from '../../helpers/setup-flows';
import {
  apiCancelBudget,
  apiCompleteEvent,
  apiCreateBudget,
  apiSendBudget,
  apiStartEvent,
} from '../../helpers/api-event-flow';
import { apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';

/**
 * Cobertura sistemica — transicoes de state machine invalidas devem
 * retornar 409 Conflict (ou 4xx), nao 200 nem 500.
 *
 * Cenarios:
 *   - Cancelar evento Completed -> 409 (ja terminou)
 *   - Start evento ja Started/Completed/Canceled -> 409
 *   - Complete evento sem Start -> 409
 *   - Send budget Canceled -> 409
 *   - Restart-as-draft em budget Sent (sem ser Refused/Expired) -> 409
 */

test.describe('State machine — transicoes invalidas rejeitadas', () => {
  test('@crud cancel evento ja Canceled retorna 4xx', async ({ authApi }) => {
    const { eventId } = await setupAcceptedEvent(authApi);
    // Cancela primeira vez
    const c1 = await authApi.post(`/api/events/${eventId}/cancel`, {
      data: { reason: 'Teste primeira vez' },
    });
    expect(c1.ok()).toBe(true);
    // Cancela segunda vez no mesmo evento ja Canceled
    const c2 = await authApi.post(`/api/events/${eventId}/cancel`, {
      data: { reason: 'Teste segunda vez' },
    });
    expect([400, 409, 422], `status: ${c2.status()}`).toContain(c2.status());
  });

  test('@crud start evento Canceled retorna 4xx', async ({ authApi }) => {
    const { eventId } = await setupAcceptedEvent(authApi);
    await authApi.post(`/api/events/${eventId}/cancel`, { data: { reason: 'cancel' } });
    let threw = false;
    try {
      await apiStartEvent(authApi, eventId);
    } catch {
      threw = true;
    }
    expect(threw, 'start evento Canceled deve falhar').toBe(true);
  });

  test('@crud complete evento sem Start retorna 4xx', async ({ authApi }) => {
    const { eventId } = await setupAcceptedEvent(authApi);
    let threw = false;
    try {
      await apiCompleteEvent(authApi, eventId);
    } catch {
      threw = true;
    }
    expect(threw, 'complete sem start deve falhar').toBe(true);
  });

  test('@crud cancel budget ja Canceled eh idempotente ou rejeitado (sem 5xx)', async ({
    authApi,
  }) => {
    const cliente = await apiCreateClient(authApi);
    const ativ = await apiCreateActivity(authApi);
    const orc = await apiCreateBudget(authApi, { clientId: cliente.id, activityIds: [ativ.id] });
    await apiSendBudget(authApi, orc.id);
    await apiCancelBudget(authApi, orc.id);
    // Segundo cancel: ok (idempotente) ou 409 (state machine)
    const r = await authApi.post(`/api/budgets/${orc.id}/cancel`);
    expect([200, 204, 400, 409, 422], `status: ${r.status()}`).toContain(r.status());
  });

  test('@crud restart-as-draft budget Sent (nao Refused) retorna 4xx', async ({ authApi }) => {
    const cliente = await apiCreateClient(authApi);
    const ativ = await apiCreateActivity(authApi);
    const orc = await apiCreateBudget(authApi, { clientId: cliente.id, activityIds: [ativ.id] });
    await apiSendBudget(authApi, orc.id);
    // Restart direto em Sent (nao em Refused/Expired) — back deve recusar
    const r = await authApi.post(`/api/budgets/${orc.id}/restart-as-draft`);
    expect(
      [400, 409, 422],
      `status: ${r.status()} — restart so de Refused/Expired`,
    ).toContain(r.status());
  });

  test('@crud send budget Canceled retorna 4xx', async ({ authApi }) => {
    const cliente = await apiCreateClient(authApi);
    const ativ = await apiCreateActivity(authApi);
    const orc = await apiCreateBudget(authApi, { clientId: cliente.id, activityIds: [ativ.id] });
    await apiSendBudget(authApi, orc.id);
    await apiCancelBudget(authApi, orc.id);
    // Re-send budget Canceled
    const r = await authApi.post(`/api/budgets/${orc.id}/send`);
    expect([400, 409, 422], `status: ${r.status()}`).toContain(r.status());
  });
});
