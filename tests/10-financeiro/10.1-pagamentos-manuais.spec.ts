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
    expect(summaryAfter.entries[0]!.kind).toBe('Regular');
  });

  /**
   * Etapa 160 — o cliente paga a mais e manda ficar com o troco.
   *
   * O que este cenário protege ponta a ponta: o excedente vira um lançamento
   * PRÓPRIO, e o "total pago" continua falando só da dívida. Sem isso, a
   * gorjeta quitaria um evento que ainda deve.
   */
  test('@crud pagamento acima do saldo quebra em regular + gorjeta', async ({ authApi }) => {
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

    const { balance: saldo } = await apiGetPaymentSummary(authApi, eventId);
    const gorjeta = 50;

    const result = await apiRegisterPayment(authApi, eventId, {
      amount: saldo + gorjeta,
      method: 'Pix',
      note: 'Cliente mandou ficar com o troco',
      excessKind: 'Tip',
    });

    expect(result.regularAmount).toBe(saldo);
    expect(result.extraAmount).toBe(gorjeta);
    expect(result.entries.length).toBe(2);
    expect(result.entries.map((e) => e.kind)).toEqual(['Regular', 'Tip']);

    const summary = await apiGetPaymentSummary(authApi, eventId);
    expect(summary.totalPaid).toBe(saldo);
    expect(summary.balance).toBe(0);
    expect(summary.financialStatus).toBe('Paid');
    // A gorjeta aparece no extrato, mas FORA do total pago.
    expect(summary.totalExtras).toBe(gorjeta);
    expect(summary.entries.length).toBe(2);
  });

  test('@crud valor acima do saldo sem classificar continua sendo recusado', async ({ authApi }) => {
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

    const { balance: saldo } = await apiGetPaymentSummary(authApi, eventId);

    const res = await authApi.post(`/api/events/${eventId}/payments`, {
      data: {
        paidAt: new Date().toISOString().slice(0, 10),
        amount: saldo + 50,
        method: 'Pix',
        note: null,
        installmentId: null,
      },
    });

    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.errors[0].code).toBe('EventPayment.ExceedsEventTotal');
  });
});
