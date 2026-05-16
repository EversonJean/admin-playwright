import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import {
  apiCancelBudget,
  apiCreateBudget,
  apiGetBudget,
  apiSendBudget,
  apiTryAcceptPublicBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';

/**
 * Cenário: cliente recusa (fluxo 5.5).
 *
 * O cliente comunica recusa fora do sistema; o gestor marca o orçamento como
 * cancelado via /cancel (state machine BudgetStatus.Canceled — endpoint público
 * de "refuse" não existe). Após cancelamento, o link público continua existindo
 * mas o aceite responde 409. Nenhum Event é criado.
 */

test.describe('Fluxo de evento — recusa do orcamento', () => {
  test('@flow gestor cancela orcamento Sent e cliente nao consegue mais aceitar', async ({
    authApi,
  }) => {
    // Setup
    const cliente = await apiCreateClient(authApi);
    const atividade = await apiCreateActivity(authApi);

    // Cria + envia
    const orcamento = await apiCreateBudget(authApi, {
      clientId: cliente.id,
      activityIds: [atividade.id],
    });
    const enviado = await apiSendBudget(authApi, orcamento.id);
    const token = extractTokenFromPublicUrl(enviado.publicUrl);

    // Gestor cancela (cliente comunicou recusa fora do sistema)
    await apiCancelBudget(authApi, orcamento.id);

    const orcamentoCancelado = await apiGetBudget(authApi, orcamento.id);
    expect(orcamentoCancelado.status).toBe('Canceled');

    // Cliente abre o link e tenta aceitar mesmo assim — back devolve 409
    const publicApi = await createPublicApiContext();
    try {
      const tentativa = await apiTryAcceptPublicBudget(publicApi, token);
      expect(tentativa.ok).toBe(false);
      expect(tentativa.status).toBe(409);
    } finally {
      await publicApi.dispose();
    }

    // Garante que nenhum evento foi criado a partir desse orçamento
    const final = await apiGetBudget(authApi, orcamento.id);
    expect((final as { eventId?: string | null }).eventId ?? null).toBeFalsy();
  });
});
