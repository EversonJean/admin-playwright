import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import {
  apiAcceptPublicBudget,
  apiCreateBudget,
  apiGetPaymentSummary,
  apiRegisterPayment,
  apiSendBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';

/**
 * Fluxo: 10.1 — Pagamentos manuais
 * Diagrama: docs/fluxos/negocio-10.1-pagamentos-manuais.mmd
 *
 * POST /api/events/:id/payments registra PaymentEntry imutavel.
 * GET /api/events/:id/payments devolve summary com totalPaid/balance.
 */

test.describe('Fluxo 10.1 — Pagamentos manuais', () => {
  test('@flow tela de recebíveis carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/finance/receivables');
  });

  test('@crud registra pagamento Pix em evento e atualiza summary', async ({ authApi }) => {
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

    const summaryBefore = await apiGetPaymentSummary(authApi, eventId);
    expect(summaryBefore.totalPaid).toBe(0);
    const expectedBalance = summaryBefore.balance;

    await apiRegisterPayment(authApi, eventId, { amount: 100, method: 'Pix' });

    const summaryAfter = await apiGetPaymentSummary(authApi, eventId);
    expect(summaryAfter.totalPaid).toBe(100);
    expect(summaryAfter.balance).toBe(expectedBalance - 100);
    expect(summaryAfter.entries.length).toBe(1);
    expect(summaryAfter.entries[0]!.method).toBe('Pix');
  });
});
