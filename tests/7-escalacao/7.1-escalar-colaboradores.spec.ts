import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import {
  apiCompleteOnboarding,
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
import { setupAcceptedEvent } from '../../helpers/setup-flows';
import { assertOk, readJson } from '../../helpers/response';

/**
 * Fluxo: 7.1 — Escalar colaboradores
 * Diagrama: docs/fluxos/negocio-7.1-escalar-colaboradores.mmd
 *
 * Escalacao = POST /api/events/:id/collaborators. Cria EventCollaborator
 * em status Invited. Aparece em GET /api/events/:id como collaborators[].
 *
 * Etapa 191 — lideranca e por festa: PATCH .../collaborators/:cid/leader
 * define ou remove o lider DEPOIS de escalar, e "Definir como lider" e
 * exclusivo por padrao (o anterior volta a Equipe). A resposta e a equipe
 * inteira, porque a troca muda duas linhas.
 */

interface TeamRow {
  collaboratorId: string;
  name: string;
  isLeader: boolean;
  confirmationStatus?: string;
}

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

  test('@flow PATCH leader swaps the leader exclusively and refuses a declined assignment', async ({
    authApi,
  }) => {
    const { eventId } = await setupAcceptedEvent(authApi);
    const firstLeader = await apiCreateCollaborator(authApi);
    const secondLeader = await apiCreateCollaborator(authApi);
    const declinedMember = await apiCreateCollaborator(authApi);
    // Escala os tres sem lider — como nasce o evento de orcamento aceito com
    // reservas (Etapa 189), que e o caso que a 191 destrava.
    await apiAssignCollaborator(authApi, eventId, firstLeader.id);
    await apiAssignCollaborator(authApi, eventId, secondLeader.id);
    await apiAssignCollaborator(authApi, eventId, declinedMember.id);

    const leaderUrl = (collaboratorId: string) =>
      `/api/events/${eventId}/collaborators/${collaboratorId}/leader`;

    // 1) O primeiro vira lider (a funcao do cadastro e "Recreador" e nao ha nivel:
    //    o back nao olha Role nem CanLead).
    const first = await authApi.patch(leaderUrl(firstLeader.id), { data: { isLeader: true } });
    await assertOk(first, 'PATCH leader (first)');
    const teamAfterFirst = await readJson<TeamRow[]>(first);
    expect(teamAfterFirst, 'a resposta e a equipe inteira').toHaveLength(3);
    expect(teamAfterFirst.find((r) => r.collaboratorId === firstLeader.id)?.isLeader).toBe(true);

    // 2) O segundo assume: troca exclusiva, o primeiro volta a Equipe.
    const second = await authApi.patch(leaderUrl(secondLeader.id), { data: { isLeader: true } });
    await assertOk(second, 'PATCH leader (second)');
    const teamAfterSecond = await readJson<TeamRow[]>(second);
    expect(teamAfterSecond.find((r) => r.collaboratorId === secondLeader.id)?.isLeader).toBe(true);
    expect(teamAfterSecond.find((r) => r.collaboratorId === firstLeader.id)?.isLeader).toBe(false);
    expect(teamAfterSecond.filter((r) => r.isLeader)).toHaveLength(1);

    // O detalhe do evento enxerga o mesmo estado (nao e so a resposta do PATCH).
    const ev = (await apiGetEvent(authApi, eventId)) as unknown as { collaborators: TeamRow[] };
    expect(ev.collaborators.filter((c) => c.isLeader).map((c) => c.collaboratorId)).toEqual([
      secondLeader.id,
    ]);

    // 3) Quem recusou nao pode virar lider.
    const declined = await authApi.post(
      `/api/events/${eventId}/collaborators/${declinedMember.id}/decline`,
      { data: { reason: 'Conflito de agenda E2E' } },
    );
    await assertOk(declined, 'POST decline');
    const refused = await authApi.patch(leaderUrl(declinedMember.id), { data: { isLeader: true } });
    expect(refused.status(), 'promover linha recusada e 409').toBe(409);
    expect(JSON.stringify(await refused.json())).toContain('Event.LeaderMustBeActiveAssignment');
  });

  test('@crud "Definir como líder" on the Team tab asks for confirmation and moves the chip', async ({
    authApi,
    authPage,
  }) => {
    const { eventId } = await setupAcceptedEvent(authApi);
    const firstLeader = await apiCreateCollaborator(authApi);
    const secondLeader = await apiCreateCollaborator(authApi);
    await apiAssignCollaborator(authApi, eventId, firstLeader.id, { isLeader: true });
    await apiAssignCollaborator(authApi, eventId, secondLeader.id);
    await apiCompleteOnboarding(authApi);

    await authPage.goto(`/app/events/${eventId}`);
    // `data-testid` no <mat-tab> nao chega ao cabecalho renderizado: a aba e
    // encontrada pelo papel ARIA, que o Material garante (exact: existe
    // tambem a aba 'Roteiro da equipe').
    await authPage.getByRole('tab', { name: 'Equipe', exact: true }).click();

    await expect(authPage.getByTestId(`event-detail-team-leader-chip-${firstLeader.id}`)).toBeVisible();
    await authPage.getByTestId(`event-detail-team-set-leader-${secondLeader.id}`).click();

    // Ja ha lider: a troca exclusiva pede confirmacao citando quem sai.
    await expect(authPage.getByTestId('confirm-title')).toHaveText(/Trocar o líder/);
    await expect(authPage.getByTestId('confirm-message')).toContainText(String(firstLeader.name));
    await authPage.getByTestId('confirm-ok').click();

    await expect(authPage.getByTestId(`event-detail-team-leader-chip-${secondLeader.id}`)).toBeVisible();
    await expect(authPage.getByTestId(`event-detail-team-leader-chip-${firstLeader.id}`)).toHaveCount(0);
    // O primeiro ganhou de volta o botao "Definir como lider" (esta ativo e nao e lider).
    await expect(authPage.getByTestId(`event-detail-team-set-leader-${firstLeader.id}`)).toBeVisible();

    // O back confirma sem recarregar a pagina.
    const ev = (await apiGetEvent(authApi, eventId)) as unknown as { collaborators: TeamRow[] };
    expect(ev.collaborators.find((c) => c.collaboratorId === secondLeader.id)?.isLeader).toBe(true);
    expect(ev.collaborators.find((c) => c.collaboratorId === firstLeader.id)?.isLeader).toBe(false);
  });
});
