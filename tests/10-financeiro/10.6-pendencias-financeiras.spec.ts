import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import {
  apiAcceptPublicBudget,
  apiCreateBudget,
  apiCreatePaymentPlan,
  apiListPendingPayments,
  apiSendBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';

/**
 * Fluxo: 10.6 — Pendências financeiras
 * Diagrama: docs/fluxos/negocio-10.6-pendencias-financeiras.mmd
 *
 * GET /api/events/pending-payments lista parcelas/saldos pendentes
 * (PagedList + totalPendingBalance agregado).
 */

test.describe('Fluxo 10.6 — Pendências financeiras', () => {
  test('@flow tela de recebíveis carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/finance/receivables');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test('@flow tela de relatórios financeiros carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/finance/reports');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test('@crud evento aceito com payment-plan aparece em pending-payments', async ({
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
      eventId = (await apiAcceptPublicBudget(publicApi, token)).eventId;
    } finally {
      await publicApi.dispose();
    }

    const due = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    await apiCreatePaymentPlan(authApi, eventId, [
      { order: 1, label: 'Parcela unica', expectedAmount: 250, dueDate: due },
    ]);

    const pending = await apiListPendingPayments(authApi);
    expect(pending.totalPendingBalance).toBeGreaterThanOrEqual(250);
    const myEvent = pending.items.find((p) => p.eventId === eventId);
    expect(myEvent, 'evento com plano deve aparecer em pendencias').toBeTruthy();
  });
});
