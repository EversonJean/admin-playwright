import { authTest as test, expect } from '../../fixtures/auth.fixture';
import {
  apiCreateActivity,
  apiCreateClient,
  apiCreateCollaborator,
} from '../../helpers/api-entities';
import {
  apiAcceptPublicBudget,
  apiAssignCollaborator,
  apiCreateBudget,
  apiSendBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';

/**
 * Fluxo: 10.5 — Comissões da equipe
 * Diagrama: docs/fluxos/negocio-10.5-comissoes.mmd
 */

test.describe('Fluxo 10.5 — Comissões', () => {
  test('@flow GET /api/commissions responde sem 500', async ({ authApi }) => {
    const res = await authApi.get('/api/commissions');
    expect(res.status()).toBeLessThan(500);
  });

  test('@crud cria commission FixedAmount + mark-paid em evento', async ({ authApi }) => {
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

    const colab = await apiCreateCollaborator(authApi);
    await apiAssignCollaborator(authApi, eventId, colab.id);

    const createRes = await authApi.post(`/api/events/${eventId}/commissions`, {
      data: {
        collaboratorId: colab.id,
        kind: 'FixedAmount',
        value: 150,
        notes: 'Comissao E2E',
      },
    });
    if (!createRes.ok()) {
      throw new Error(`POST commission ${createRes.status()}: ${await createRes.text()}`);
    }
    const created = (await createRes.json()).data ?? (await createRes.json());
    expect(created.id).toBeTruthy();

    // Mark as paid
    const markRes = await authApi.post(
      `/api/events/${eventId}/commissions/${created.id}/mark-paid`,
    );
    expect(markRes.ok()).toBe(true);

    // Validar via summary
    const summaryRes = await authApi.get(`/api/events/${eventId}/commissions/summary`);
    expect(summaryRes.ok()).toBe(true);
    const sum = (await summaryRes.json()).data ?? (await summaryRes.json());
    const items: Array<{ id: string; isPaid?: boolean; paid?: boolean }> =
      sum.commissions ?? sum.items ?? [];
    const c = items.find((i) => i.id === created.id);
    expect(c, 'commission criada deve aparecer no summary').toBeTruthy();
    expect(c?.isPaid ?? c?.paid, 'apos mark-paid deve estar paga').toBe(true);
  });
});
