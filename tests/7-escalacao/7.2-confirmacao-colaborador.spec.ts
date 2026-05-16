import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import {
  apiCreateActivity,
  apiCreateClient,
  apiCreateCollaborator,
} from '../../helpers/api-entities';
import {
  apiAcceptPublicBudget,
  apiAssignCollaborator,
  apiConfirmCollaborator,
  apiCreateBudget,
  apiGetEvent,
  apiSendBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';

/**
 * Fluxo: 7.2 — Confirmação do colaborador
 * Diagrama: docs/fluxos/negocio-7.2-confirmacao-colaborador.mmd
 *
 * Endpoint POST /api/events/:id/collaborators/:cid/confirm muda
 * EventCollaborator.Status de Invited -> Confirmed.
 */

test.describe('Fluxo 7.2 — Confirmação do colaborador', () => {
  test('@flow tela de calendário time-timeline carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/schedule/calendar');
  });

  test('@crud confirm transiciona EventCollaborator de Invited -> Confirmed', async ({
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

    const colab = await apiCreateCollaborator(authApi);
    await apiAssignCollaborator(authApi, eventId, colab.id);
    await apiConfirmCollaborator(authApi, eventId, colab.id);

    const ev = (await apiGetEvent(authApi, eventId)) as unknown as {
      collaborators: Array<{ collaboratorId: string; confirmationStatus: string }>;
    };
    const confirmed = ev.collaborators.find((c) => c.collaboratorId === colab.id);
    expect(
      confirmed?.confirmationStatus,
      'apos confirm confirmationStatus deve ser Confirmed',
    ).toBe('Confirmed');
  });
});
