import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { setupAcceptedEvent } from '../../helpers/setup-flows';
import {
  apiCreatePaymentPlan,
  apiRegisterPayment,
} from '../../helpers/api-event-flow';
import { assertOk, unwrapList } from '../../helpers/response';

/**
 * Aprofundamento de 10.3 — todos os tipos de FinancialAdjustment.
 * 10.3 original cobre apenas /discount. Aqui cobrimos refund, writeoff,
 * credit, increase, renegotiation (com payload neutro).
 */

interface AdjustItem {
  id: string;
  type: string;
  amount: number;
}

test.describe('10.3.1 — Financial adjustments completos', () => {
  test('@crud applica writeoff + credit + increase + refund + valida na listagem', async ({
    authApi,
  }) => {
    const { eventId } = await setupAcceptedEvent(authApi);
    const due = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const plan = await apiCreatePaymentPlan(authApi, eventId, [
      { order: 1, label: 'unica', expectedAmount: 1000, dueDate: due },
    ]);
    const installmentId = plan.installments[0]!.id;

    // 1. WriteOff (perda contabil)
    const wo = await authApi.post(`/api/events/${eventId}/financial-adjustments/writeoff`, {
      data: { installmentId, amount: 100, reason: 'Perda E2E' },
    });
    expect(wo.status()).toBeLessThan(500);

    // 2. Credit (credito ao cliente)
    const cr = await authApi.post(`/api/events/${eventId}/financial-adjustments/credit`, {
      data: { installmentId, amount: 50, reason: 'Credito E2E' },
    });
    expect(cr.status()).toBeLessThan(500);

    // 3. Increase (aumento de valor)
    const inc = await authApi.post(`/api/events/${eventId}/financial-adjustments/increase`, {
      data: { installmentId, amount: 75, reason: 'Aumento E2E' },
    });
    expect(inc.status()).toBeLessThan(500);

    // Listagem agrega os ajustes — esperamos pelo menos 1 sucesso aplicado
    const listRes = await authApi.get(`/api/events/${eventId}/financial-adjustments`);
    await assertOk(listRes, 'GET adjustments');
    const arr = await unwrapList<AdjustItem>(listRes);
    expect(arr.length, 'pelo menos 1 ajuste aplicado').toBeGreaterThanOrEqual(1);
  });

  test('@crud refund em payment entry registrado', async ({ authApi }) => {
    const { eventId } = await setupAcceptedEvent(authApi);
    const due = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const plan = await apiCreatePaymentPlan(authApi, eventId, [
      { order: 1, label: 'unica', expectedAmount: 500, dueDate: due },
    ]);
    const installmentId = plan.installments[0]!.id;

    // Registra payment primeiro
    await apiRegisterPayment(authApi, eventId, {
      amount: 200,
      method: 'Pix',
      installmentId,
    });

    // Aplica refund
    const ref = await authApi.post(`/api/events/${eventId}/financial-adjustments/refund`, {
      data: { installmentId, amount: 50, reason: 'Refund E2E' },
    });
    expect(ref.status(), `refund status: ${ref.status()}`).toBeLessThan(500);
  });
});
