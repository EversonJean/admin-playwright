import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import {
  apiAcceptPublicBudget,
  apiCreateBudget,
  apiCreatePaymentPlan,
  apiGetPaymentPlan,
  apiGetPaymentSummary,
  apiRegisterPayment,
  apiSendBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';

/**
 * Cenário: pagamento parcelado (fluxo 10.2).
 *
 * Após aceite, gestor cria plano 30/70: 1ª parcela hoje, 2ª no dia do evento.
 * Registra a 1ª como paga → status financeiro = PartiallyPaid. Registra a 2ª
 * → status = Paid. Cada installment é referenciada via installmentId no
 * RegisterPaymentRequest pra que o back saiba qual parcela liquidar.
 */

test.describe('Fluxo de evento — pagamento parcelado 30/70', () => {
  test('@flow plano 30/70: pagar primeira parcela vira partial; segunda vira paid', async ({
    authApi,
  }) => {
    const cliente = await apiCreateClient(authApi);
    const atividade = await apiCreateActivity(authApi);

    const orcamento = await apiCreateBudget(authApi, {
      clientId: cliente.id,
      activityIds: [atividade.id],
      childrenCount: 20,
    });
    const enviado = await apiSendBudget(authApi, orcamento.id);
    const token = extractTokenFromPublicUrl(enviado.publicUrl);

    const publicApi = await createPublicApiContext();
    let eventId: string;
    try {
      const aceito = await apiAcceptPublicBudget(publicApi, token);
      eventId = aceito.eventId;
    } finally {
      await publicApi.dispose();
    }

    const resumoAntes = await apiGetPaymentSummary(authApi, eventId);
    const total = resumoAntes.eventTotal;
    expect(total).toBeGreaterThan(0);

    // Plano 30/70 — round nos centavos pra evitar drift cumulativo
    const parcela1 = Math.round(total * 0.3 * 100) / 100;
    const parcela2 = Math.round((total - parcela1) * 100) / 100;
    const hoje = new Date().toISOString().slice(0, 10);
    const futuro = new Date();
    futuro.setDate(futuro.getDate() + 30);

    const plano = await apiCreatePaymentPlan(authApi, eventId, [
      { order: 1, label: '30% no aceite', expectedAmount: parcela1, dueDate: hoje },
      {
        order: 2,
        label: '70% no dia do evento',
        expectedAmount: parcela2,
        dueDate: futuro.toISOString().slice(0, 10),
      },
    ]);
    expect(plano.installments).toHaveLength(2);

    // 1ª parcela paga via Pix
    await apiRegisterPayment(authApi, eventId, {
      amount: parcela1,
      method: 'Pix',
      installmentId: plano.installments[0].id,
    });

    const resumoParcial = await apiGetPaymentSummary(authApi, eventId);
    expect(resumoParcial.totalPaid).toBeCloseTo(parcela1, 2);
    expect(resumoParcial.balance).toBeCloseTo(parcela2, 2);
    expect(resumoParcial.financialStatus).toBe('PartiallyPaid');

    // Confirma que a parcela 1 foi marcada como Paid no plano
    const planoMeio = await apiGetPaymentPlan(authApi, eventId);
    expect(planoMeio).toBeTruthy();
    const inst1Meio = planoMeio!.installments.find((i) => i.order === 1)!;
    expect(inst1Meio.paidAmount).toBeCloseTo(parcela1, 2);
    expect(inst1Meio.status).toBe('Paid');

    // 2ª parcela quita o saldo via Transfer
    await apiRegisterPayment(authApi, eventId, {
      amount: parcela2,
      method: 'Transfer',
      installmentId: plano.installments[1].id,
    });

    const resumoFinal = await apiGetPaymentSummary(authApi, eventId);
    expect(resumoFinal.totalPaid).toBeCloseTo(total, 2);
    expect(resumoFinal.balance).toBeCloseTo(0, 2);
    expect(resumoFinal.financialStatus).toBe('Paid');
    expect(resumoFinal.entries).toHaveLength(2);
  });
});
