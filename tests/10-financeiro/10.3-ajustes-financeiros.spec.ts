import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import {
  apiAcceptPublicBudget,
  apiCreateBudget,
  apiCreatePaymentPlan,
  apiSendBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';

/**
 * Fluxo: 10.3 — Ajustes financeiros imutáveis
 * Diagrama: docs/fluxos/negocio-10.3-ajustes-financeiros.mmd
 *
 * POST /api/events/:id/financial-adjustments/discount aplica desconto
 * sobre uma parcela. Resposta inclui o ajuste persistido (imutavel).
 */

test.describe('Fluxo 10.3 — Ajustes financeiros', () => {
  test('@flow tela de recebíveis carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/finance/receivables');
  });

  test('@crud aplica discount em parcela e ajuste fica na listagem', async ({ authApi }) => {
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
      eventId = (await apiAcceptPublicBudget(publicApi, token)).eventId;
    } finally {
      await publicApi.dispose();
    }

    const dueDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const plan = await apiCreatePaymentPlan(authApi, eventId, [
      { order: 1, label: 'Parcela unica', expectedAmount: 500, dueDate },
    ]);
    const installmentId = plan.installments[0]!.id;

    const adjustRes = await authApi.post(
      `/api/events/${eventId}/financial-adjustments/discount`,
      {
        data: {
          installmentId,
          amount: 50,
          reason: 'Desconto E2E',
        },
      },
    );
    if (!adjustRes.ok()) {
      throw new Error(`POST discount ${adjustRes.status()}: ${await adjustRes.text()}`);
    }

    const listRes = await authApi.get(`/api/events/${eventId}/financial-adjustments`);
    expect(listRes.ok()).toBe(true);
    const body = await listRes.json();
    const items: Array<{ type?: string; amount?: number }> =
      body.data?.items ?? body.items ?? body.data ?? body;
    const arr = Array.isArray(items) ? items : [];
    expect(arr.length, 'apos discount deve ter 1 ajuste').toBeGreaterThanOrEqual(1);
    const discountItem = arr.find(
      (i) => (i.type ?? '').toLowerCase().includes('discount') && i.amount === 50,
    );
    expect(discountItem, 'ajuste discount=50 deve estar listado').toBeTruthy();
  });
});
