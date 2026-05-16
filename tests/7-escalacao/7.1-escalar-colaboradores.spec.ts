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
  apiCreateBudget,
  apiGetEvent,
  apiSendBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';

/**
 * Fluxo: 7.1 — Escalar colaboradores
 * Diagrama: docs/fluxos/negocio-7.1-escalar-colaboradores.mmd
 *
 * Escalacao = POST /api/events/:id/collaborators. Cria EventCollaborator
 * em status Invited. Aparece em GET /api/events/:id como collaborators[].
 */

test.describe('Fluxo 7.1 — Escalar colaboradores', () => {
  test('@flow listagem de eventos carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/events/list');
  });

  test('@crud assign colaborador ao evento aparece em collaborators[]', async ({ authApi }) => {
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
    await apiAssignCollaborator(authApi, eventId, colab.id, { isLeader: true });

    const ev = (await apiGetEvent(authApi, eventId)) as unknown as {
      collaborators: Array<{ collaboratorId: string; isLeader?: boolean; status?: string }>;
    };
    const assigned = ev.collaborators.find((c) => c.collaboratorId === colab.id);
    expect(assigned, 'colaborador escalado deve aparecer em collaborators[]').toBeTruthy();
    expect(assigned?.isLeader).toBe(true);
  });
});
