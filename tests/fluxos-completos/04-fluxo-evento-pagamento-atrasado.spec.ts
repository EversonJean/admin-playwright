import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import {
  apiAcceptPublicBudget,
  apiCreateBudget,
  apiCreatePaymentPlan,
  apiGetPaymentPlan,
  apiGetPaymentSummary,
  apiListPendingPayments,
  apiRecomputePaymentPlan,
  apiSendBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';

/**
 * Cenário: pagamento atrasado e pendência (fluxos 6.3 / 10.6).
 *
 * Plano com parcela vencida (dueDate < hoje) e nenhum pagamento registrado.
 * Após recompute, status da installment vira Overdue e o evento aparece em
 * /api/events/pending-payments (lista operacional do gestor).
 */

test.describe('Fluxo de evento — pagamento atrasado e pendencia', () => {
  test('@flow parcela vencida sem pagamento -> Overdue + aparece em pending-payments', async ({
    authApi,
  }) => {
    const cliente = await apiCreateClient(authApi);
    const atividade = await apiCreateActivity(authApi);

    const orcamento = await apiCreateBudget(authApi, {
      clientId: cliente.id,
      activityIds: [atividade.id],
      childrenCount: 15,
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

    const resumo = await apiGetPaymentSummary(authApi, eventId);
    const total = resumo.eventTotal;

    // Plano com 1 parcela vencida há 7 dias — folga grande pra eliminar
    // ambiguidade de fuso entre `Date.toISOString()` (UTC) e o `today` que o
    // back computa em America/Sao_Paulo via Event.Timezone.
    const ontem = new Date();
    ontem.setDate(ontem.getDate() - 7);
    const dueDate = ontem.toISOString().slice(0, 10);

    const plano = await apiCreatePaymentPlan(authApi, eventId, [
      { order: 1, label: 'Parcela vencida', expectedAmount: total, dueDate },
    ]);
    expect(plano.installments).toHaveLength(1);

    // Recompute força a reavaliação do status (cron simulado)
    await apiRecomputePaymentPlan(authApi, eventId);

    const planoApos = await apiGetPaymentPlan(authApi, eventId);
    expect(planoApos).toBeTruthy();
    expect(planoApos!.installments[0].status).toBe('Overdue');

    // Lista operacional de pendências deve incluir esse evento (saldo > 0)
    const pendencias = await apiListPendingPayments(authApi);
    const items = pendencias.items ?? [];
    const meuEvento = items.find((p) => p.eventId === eventId);
    expect(meuEvento, 'Evento com parcela vencida deve aparecer em pending-payments').toBeTruthy();
    expect(meuEvento!.balance).toBeCloseTo(total, 2);
  });
});
