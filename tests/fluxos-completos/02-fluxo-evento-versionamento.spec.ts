import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import { setBudgetStatusDirect } from '../../helpers/db-helper';
import {
  apiAcceptPublicBudget,
  apiCreateBudget,
  apiGetBudget,
  apiListBudgetVersions,
  apiRestartBudgetAsDraft,
  apiSendBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';

/**
 * Cenário: versionamento do orçamento (fluxo 5.4).
 *
 * Cliente recusa a 1ª versão; gestor reabre como Draft (POST /restart-as-draft
 * — Etapa 38), o que invalida o token anterior e gera uma nova versão no
 * histórico. Nova revisão é enviada e aceita normalmente.
 *
 * `restart-as-draft` só transita a partir de Refused/Expired (validação do
 * domínio). Como não existe endpoint público de "refuse", o teste força o
 * status via SQL — simula o cliente recusando por fora e o gestor marcando.
 */

test.describe('Fluxo de evento — versionamento do orcamento', () => {
  test('@flow reabrir como draft cria nova versao e invalida o token anterior', async ({
    authApi,
  }) => {
    const cliente = await apiCreateClient(authApi);
    const atividade = await apiCreateActivity(authApi);

    // V1 — cria + envia
    const orcamento = await apiCreateBudget(authApi, {
      clientId: cliente.id,
      activityIds: [atividade.id],
      childrenCount: 10,
    });
    const enviadoV1 = await apiSendBudget(authApi, orcamento.id);
    const tokenV1 = extractTokenFromPublicUrl(enviadoV1.publicUrl);

    // Cliente comunica recusa por fora — força Refused via SQL pra desbloquear
    // a transição Refused → Draft (restart-as-draft rejeita Sent → Draft).
    setBudgetStatusDirect(orcamento.id, 'Refused');

    // Gestor reabre como Draft pra gerar nova versão
    await apiRestartBudgetAsDraft(authApi, orcamento.id);
    const orcamentoDraft = await apiGetBudget(authApi, orcamento.id);
    expect(orcamentoDraft.status).toBe('Draft');

    // Histórico tem pelo menos 1 versão (a anterior, antes do restart)
    const versoes = await apiListBudgetVersions(authApi, orcamento.id);
    expect(versoes.length).toBeGreaterThanOrEqual(1);

    // Token V1 deixou de servir — back devolve 404 (uniforme)
    const publicApi = await createPublicApiContext();
    try {
      const respV1 = await publicApi.get(`/api/public/budgets/${tokenV1}`);
      expect(respV1.status()).toBe(404);
    } finally {
      await publicApi.dispose();
    }

    // V2 — gestor envia de novo (gera novo token); cliente aceita
    const enviadoV2 = await apiSendBudget(authApi, orcamento.id);
    expect(enviadoV2.publicUrl).not.toBe(enviadoV1.publicUrl);
    const tokenV2 = extractTokenFromPublicUrl(enviadoV2.publicUrl);

    const publicApi2 = await createPublicApiContext();
    try {
      const aceito = await apiAcceptPublicBudget(publicApi2, tokenV2);
      expect(aceito.status).toBe('Accepted');
      expect(aceito.eventId).toBeTruthy();
    } finally {
      await publicApi2.dispose();
    }
  });
});
