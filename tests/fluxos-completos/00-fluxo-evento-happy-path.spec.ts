import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateActivity, apiCreateClient, apiCreateCollaborator } from '../../helpers/api-entities';
import {
  apiAcceptPublicBudget,
  apiAssignCollaborator,
  apiCompleteEvent,
  apiConfirmCollaborator,
  apiCreateBudget,
  apiCreatePaymentPlan,
  apiGetBudget,
  apiGetEvent,
  apiGetPaymentSummary,
  apiGetPublicBudget,
  apiRegisterPayment,
  apiSendBudget,
  apiStartEvent,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';

/**
 * Fluxo de evento — caminho feliz (end-to-end).
 *
 * Encadeia 11 etapas: cadastros base → orçamento → envio → aceite público
 * → evento auto-criado → escalação → confirmação → plano de pagamento
 * → pagamento total → status financeiro Paid → start/complete operacional.
 *
 * Valida que cada transição persiste no back e que o EventId nascido do
 * Budget aceito é consultável e atinge status terminal em todos os 3 eixos.
 */

test.describe('Fluxo de evento — happy path completo', () => {
  test('@flow orcamento -> aceite publico -> evento -> escalacao -> pagamento -> conclusao', async ({
    authApi,
  }) => {
    // 1. Cadastros base
    const cliente = await apiCreateClient(authApi);
    const atividade = await apiCreateActivity(authApi);
    const colaborador = await apiCreateCollaborator(authApi);

    // 2. Cria orçamento (Draft)
    const orcamento = await apiCreateBudget(authApi, {
      clientId: cliente.id,
      activityIds: [atividade.id],
      childrenCount: 20,
    });
    expect(orcamento.id).toBeTruthy();
    expect(orcamento.status).toBe('Draft');

    // 3. Envia (Draft → Sent, gera token público)
    const enviado = await apiSendBudget(authApi, orcamento.id);
    expect(enviado.publicUrl).toContain('/budgets/');
    const token = extractTokenFromPublicUrl(enviado.publicUrl);

    // 4. Cliente abre link público (anônimo) e aceita
    const publicApi = await createPublicApiContext();
    let eventId: string;
    try {
      const publicView = await apiGetPublicBudget(publicApi, token);
      expect(publicView.status).toBe('Sent');
      expect(publicView.eventId).toBeFalsy();

      // 5. Cliente aceita → Event nasce automaticamente
      const aceito = await apiAcceptPublicBudget(publicApi, token);
      expect(aceito.status).toBe('Accepted');
      expect(aceito.eventId).toBeTruthy();
      eventId = aceito.eventId;
    } finally {
      await publicApi.dispose();
    }

    // 6. GET evento via API autenticada — confirma snapshot
    const evento = await apiGetEvent(authApi, eventId);
    expect(evento.id).toBe(eventId);
    expect((evento as { clientId?: string }).clientId).toBe(cliente.id);

    // 7. Orçamento agora reflete o Accepted e o EventId derivado
    const orcamentoAceito = await apiGetBudget(authApi, orcamento.id);
    expect(orcamentoAceito.status).toBe('Accepted');

    // 8. Escala colaborador como líder + confirma
    await apiAssignCollaborator(authApi, eventId, colaborador.id, { isLeader: true });
    await apiConfirmCollaborator(authApi, eventId, colaborador.id);

    // 9. EventTotal real é computado pelo back no aceite — pode diferir do
    //    BudgetTotal por causa do pricing do evento (Etapa 25.5). Usa o
    //    summary como fonte de verdade.
    const resumoAntes = await apiGetPaymentSummary(authApi, eventId);
    const eventTotal = resumoAntes.eventTotal;
    expect(eventTotal).toBeGreaterThan(0);

    // 10. Cria plano de pagamento — 1 parcela única no aceite
    const hoje = new Date().toISOString().slice(0, 10);
    const plano = await apiCreatePaymentPlan(authApi, eventId, [
      { order: 1, label: 'Total no aceite', expectedAmount: eventTotal, dueDate: hoje },
    ]);
    expect(plano.installments).toHaveLength(1);

    // 11. Registra pagamento total via Pix
    await apiRegisterPayment(authApi, eventId, {
      amount: eventTotal,
      method: 'Pix',
      installmentId: plano.installments[0].id,
      note: 'Pagamento E2E happy path',
    });

    // 12. Status financeiro deve ser Paid (totalPaid === eventTotal)
    const resumo = await apiGetPaymentSummary(authApi, eventId);
    expect(resumo.eventTotal).toBeCloseTo(eventTotal, 2);
    expect(resumo.totalPaid).toBeCloseTo(eventTotal, 2);
    expect(resumo.balance).toBeCloseTo(0, 2);
    expect(resumo.financialStatus).toBe('Paid');
    expect(resumo.entries).toHaveLength(1);

    // 13. Ciclo operacional — Start (exige equipe ≥ 1 + líder, já satisfeito)
    //     → Complete (transiciona pra Completed)
    await apiStartEvent(authApi, eventId);
    await apiCompleteEvent(authApi, eventId);

    const eventoFinal = await apiGetEvent(authApi, eventId);
    expect((eventoFinal as { status?: string }).status).toBe('Completed');
  });
});
