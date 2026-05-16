import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { apiGetEvent } from '../../helpers/api-event-flow';
import { setupAcceptedEvent } from '../../helpers/setup-flows';
import type { EventDTO } from '../../helpers/types';

/**
 * Fluxo: 6.3 — Status do evento (3 eixos: operacional, financeiro, documental)
 * Diagrama: docs/fluxos/negocio-6.3-status-do-evento-tres-eixos.mmd
 *
 * O Event expoe 3 status no detail DTO (Etapa 56):
 *   - Status (operacional) — Scheduled/Confirmed/InProgress/Completed/Canceled
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
    const { eventId } = await setupAcceptedEvent(authApi);

    const ev = (await apiGetEvent(authApi, eventId)) as unknown as Pick<
      EventDTO,
      'status' | 'paymentPlanStatus' | 'contractStatus'
    >;
    expect(ev.status).toBe('Scheduled');
    expect(ev.paymentPlanStatus, 'sem plano de pagamento -> null').toBeNull();
    expect(ev.contractStatus, 'sem contrato -> null').toBeNull();
  });
});
