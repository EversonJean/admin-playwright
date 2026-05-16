import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import {
  apiAcceptPublicBudget,
  apiCreateBudget,
  apiGetBudget,
  apiGetPublicBudget,
  apiSendBudget,
  apiTryAcceptPublicBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';

/**
 * Fluxo: 5.3 — Aceite pelo cliente
 * Diagrama: docs/fluxos/negocio-5.3-aceite-pelo-cliente.mmd
 *
 * Aceite acontece via página pública anônima `/budgets/:token`. Cobre:
 * - GET publico devolve dados sem auth
 * - POST publico /accept transiciona Sent -> Accepted + gera EventId
 * - Token invalido -> 404
 */

test.describe('Fluxo 5.3 — Aceite pelo cliente', () => {
  test('@flow rota pública /budgets/:token responde (sem auth)', async ({ page }) => {
    const res = await page.goto('/budgets/token-invalido-teste');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test('@crud cliente aceita orcamento publico -> Accepted + EventId criado', async ({
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
    try {
      // GET publico sem auth devolve dados do orcamento
      const fetched = await apiGetPublicBudget(publicApi, token);
      expect(fetched.status).toBe('Sent');

      const aceito = await apiAcceptPublicBudget(publicApi, token);
      expect(aceito.eventId).toBeTruthy();
      expect(aceito.status).toBe('Accepted');
    } finally {
      await publicApi.dispose();
    }

    // Confirmacao via API autenticada
    const after = (await apiGetBudget(authApi, orcamento.id)) as unknown as { status: string };
    expect(after.status).toBe('Accepted');
  });

  test('@flow token invalido devolve 404 sem vazar info', async () => {
    const publicApi = await createPublicApiContext();
    try {
      const r = await apiTryAcceptPublicBudget(publicApi, 'token-fake-inexistente');
      expect(r.ok).toBe(false);
      expect([400, 401, 404]).toContain(r.status);
    } finally {
      await publicApi.dispose();
    }
  });
});
