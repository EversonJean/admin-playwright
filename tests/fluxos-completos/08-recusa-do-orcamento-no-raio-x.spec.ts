import { APIRequestContext } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import {
  apiCompleteOnboarding,
  apiCreateActivity,
  apiCreateClient,
  apiCreateCollaborator,
} from '../../helpers/api-entities';
import { apiCreateBudget, apiGetBudget, apiSendBudget } from '../../helpers/api-event-flow';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';
import { fakeOpenAi } from '../../helpers/fake-providers';
import { assertOk, readJson } from '../../helpers/response';

/**
 * Fluxo completo 08 — recusa do orçamento no Raio-X
 * Plano: docs/implementar/PLANO-AJUSTES-DA-CONVERSAO.md §6 item 1 (AJ-B,
 * Etapa 197), decisão D1. Registro e2e: E12.
 *
 * `Budget.Refuse()` existia sem produtor: orçamento nunca ficava recusado e o
 * Raio-X das recusas só via oportunidade perdida (lead). Agora o gestor marca
 * um orçamento ENVIADO como recusado, com motivo obrigatório:
 *   1. o detalhe mostra "Recusado" e o motivo;
 *   2. os holds da equipe reservada para o orçamento são liberados;
 *   3. a recusa vira item do Raio-X (`RefusalSourceType.Budget`, pelo evento
 *      `BudgetRefusedIntegrationEvent` no Outbox) e é classificada pelo worker
 *      com a feature de IA ligada — em E2E, pelo fake do OpenAI.
 *
 * O worker do Raio-X varre a cada 1 min: o teste espera até ~3 min.
 * Sem diagrama `.mmd`: verificação de plano de ajustes.
 */

interface RefusalItem {
  id: string;
  sourceType: string;
  sourceId: string;
  status: string;
  category: string | null;
  lostValue: number | null;
}

async function listHolds(api: APIRequestContext, budgetId: string): Promise<unknown[]> {
  const res = await api.get(`/api/budgets/${budgetId}/holds`);
  await assertOk(res, 'GET /api/budgets/{id}/holds');
  return readJson<unknown[]>(res);
}

async function findBudgetRefusal(
  api: APIRequestContext,
  budgetId: string,
): Promise<RefusalItem | undefined> {
  const res = await api.get('/api/ai/refusal-analysis?pageSize=50');
  await assertOk(res, 'GET /api/ai/refusal-analysis');
  const page = await readJson<{ items: RefusalItem[] }>(res);
  return page.items.find((i) => i.sourceType === 'Budget' && i.sourceId === budgetId);
}

test.describe('Fluxo completo 08 — budget refusal reaches the refusal X-ray', () => {
  test('@flow manager refuses a sent budget: detail shows it, holds are released, X-ray classifies it', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(240_000);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_ai');
    await apiCompleteOnboarding(authApi);

    // O Raio-X é uma feature da Central de IA: o worker só varre tenant com o
    // toggle ligado.
    await assertOk(
      await authApi.put('/api/ai/features/ai_refusal_analysis', {
        data: { enabled: true, configJson: null },
      }),
      'PUT /api/ai/features/ai_refusal_analysis',
    );

    const client = await apiCreateClient(authApi);
    const activity = await apiCreateActivity(authApi);
    const collaborator = await apiCreateCollaborator(authApi);
    const budget = await apiCreateBudget(authApi, {
      clientId: client.id,
      activityIds: [activity.id],
    });
    await apiSendBudget(authApi, budget.id);

    await assertOk(
      await authApi.post(`/api/budgets/${budget.id}/holds`, {
        data: { collaboratorIds: [collaborator.id] },
      }),
      'POST /api/budgets/{id}/holds',
    );
    expect(await listHolds(authApi, budget.id)).toHaveLength(1);

    // UI: "Marcar como recusado" com motivo.
    const reason = `Achou o valor alto ${Date.now()}`;
    await authPage.goto(`/app/budgets/${budget.id}`);
    const refuse = authPage.getByTestId('budget-form-refuse');
    await expect(refuse).toBeVisible({ timeout: 15_000 });
    await refuse.click();
    await authPage.getByTestId('refuse-budget-reason').fill(reason);
    await authPage.getByTestId('refuse-budget-confirm').click();

    const refusal = authPage.getByTestId('budget-form-refusal');
    await expect(refusal).toBeVisible({ timeout: 15_000 });
    await expect(refusal).toContainText('Recusado');
    await expect(authPage.getByTestId('budget-form-refusal-reason')).toHaveText(reason);
    // Só `Sent` recusa: a ação some depois.
    await expect(refuse).toHaveCount(0);

    const after = (await apiGetBudget(authApi, budget.id)) as {
      status?: string;
      refusalReason?: string | null;
      refusedAt?: string | null;
    };
    expect(after.status).toBe('Refused');
    expect(after.refusalReason).toBe(reason);
    expect(after.refusedAt).toBeTruthy();

    // Holds liberados: a reserva da equipe não segura mais o colaborador.
    expect(await listHolds(authApi, budget.id)).toHaveLength(0);

    // Raio-X: o item nasce pelo Outbox e o worker o classifica pelo fake.
    const since = new Date(Date.now() - 60_000).toISOString();
    await expect
      .poll(async () => (await findBudgetRefusal(authApi, budget.id))?.status ?? 'absent', {
        timeout: 200_000,
        intervals: [2_000, 5_000, 10_000],
      })
      .toBe('Completed');
    const item = (await findBudgetRefusal(authApi, budget.id))!;
    expect(item.category).toBe('Price');

    const calls = (await fakeOpenAi.inbox({ since })).filter((e) => {
      const messages = (e.body as { messages?: Array<{ content?: string }> }).messages ?? [];
      return messages.some((m) => (m.content ?? '').includes(reason));
    });
    expect(calls.length, 'o fake do OpenAI recebeu o motivo da recusa').toBeGreaterThanOrEqual(1);

    // E a tela do Raio-X lista a recusa apontando para o orçamento.
    await authPage.goto('/app/ai/refusal-insights');
    const source = authPage
      .getByTestId('refusal-analyses-table')
      .locator(`a[href="/app/budgets/${budget.id}"]`);
    await expect(source).toBeVisible({ timeout: 15_000 });
    await expect(source).toHaveText('Orçamento recusado');
  });
});
