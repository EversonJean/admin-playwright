import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import {
  apiAcceptPublicBudget,
  apiCreateBudget,
  apiGetEvent,
  apiSendBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';

/**
 * Fluxo: 6.3 — Status do evento (3 eixos: operacional, financeiro, documental)
 * Diagrama: docs/fluxos/negocio-6.3-status-do-evento-tres-eixos.mmd
 *
 * O Event expoe 3 status no detail DTO (Etapa 56):
 *   - Status (operacional) — Confirmed/InProgress/Completed/Canceled
 *   - PaymentPlanStatus (financeiro) — null quando sem plano
 *   - ContractStatus (documental) — null quando sem contrato
 */

test.describe('Fluxo 6.3 — Três eixos de status', () => {
  test('@flow listagem de eventos exibe coluna de status', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/events/list');
  });

  test('@crud evento recem-aceito tem Status=Scheduled + PaymentPlanStatus/ContractStatus=null', async ({
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
      const aceito = await apiAcceptPublicBudget(publicApi, token);
      eventId = aceito.eventId;
    } finally {
      await publicApi.dispose();
    }

    const ev = (await apiGetEvent(authApi, eventId)) as unknown as {
      status: string;
      paymentPlanStatus: string | null;
      contractStatus: string | null;
    };
    expect(ev.status).toBe('Scheduled');
    expect(ev.paymentPlanStatus, 'sem plano de pagamento -> null').toBeNull();
    expect(ev.contractStatus, 'sem contrato -> null').toBeNull();
  });
});
