import { request as playwrightRequest } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { twoTenantsTest } from '../../fixtures/two-tenants.fixture';
import { loginViaApi } from '../../helpers/api-client';
import {
  apiCompleteOnboarding,
  apiCreateActivity,
  apiCreateClient,
} from '../../helpers/api-entities';
import { apiCreateBudget, apiGetBudget, apiSendBudget } from '../../helpers/api-event-flow';
import { seedUserWithRoleDirect } from '../../helpers/db-helper';

/**
 * Fluxo: 5.6 — Marcar orçamento como recusado: permissão e isolamento
 * Plano: docs/implementar/PLANO-AJUSTES-DA-CONVERSAO.md §6 (AJ-B, Etapa 197),
 * "Testes": 403 sem `Budgets.Update`, 404 cross-tenant. Registro e2e: E13.
 *
 * `POST /api/budgets/{id}/refuse` exige `budgets.update`. O papel Financeiro
 * só LÊ orçamentos: não vê a ação no detalhe e o back o recusa com 403 mesmo
 * se ele chamar a rota direto. Orçamento de outra empresa é 404 (não existe
 * para quem pergunta), e nada muda nele.
 *
 * O caminho feliz (detalhe, holds e Raio-X) está em
 * `fluxos-completos/08-recusa-do-orcamento-no-raio-x.spec.ts`.
 */

const BACK_URL = process.env.BACK_URL ?? 'https://localhost:1501';

test.describe('Fluxo 5.6 — refuse budget: permission', () => {
  test('@flow Financial role does not see "Mark as refused" and gets 403 on POST /refuse', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    await apiCompleteOnboarding(authApi);
    const client = await apiCreateClient(authApi);
    const activity = await apiCreateActivity(authApi);
    const budget = await apiCreateBudget(authApi, {
      clientId: client.id,
      activityIds: [activity.id],
    });
    await apiSendBudget(authApi, budget.id);

    // Usuário Financeiro de verdade no mesmo tenant (não stub de permissão).
    const financial = seedUserWithRoleDirect({
      tenantId: tenant.tenantId,
      role: 'Financial',
      emailPrefix: 'financeiro',
    });
    const anon = await playwrightRequest.newContext({
      baseURL: BACK_URL,
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: { 'Content-Type': 'application/json' },
    });
    const tokens = await loginViaApi(anon, financial.email, financial.password);
    await anon.dispose();

    const financialApi = await playwrightRequest.newContext({
      baseURL: BACK_URL,
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.accessToken}`,
      },
    });
    try {
      // Ele lê o orçamento (budgets.read)...
      const read = await financialApi.get(`/api/budgets/${budget.id}`);
      expect(read.status()).toBe(200);

      // ...mas não recusa.
      const res = await financialApi.post(`/api/budgets/${budget.id}/refuse`, {
        data: { reason: 'Tentativa do financeiro' },
      });
      expect(res.status()).toBe(403);
    } finally {
      await financialApi.dispose();
    }

    const unchanged = (await apiGetBudget(authApi, budget.id)) as { status?: string };
    expect(unchanged.status).toBe('Sent');

    // UI do Financeiro: o detalhe abre, sem a ação.
    await authPage.addInitScript(
      ({ access, refresh }) => {
        localStorage.setItem('access_token', access);
        localStorage.setItem('refresh_token', refresh);
      },
      { access: tokens.accessToken, refresh: tokens.refreshToken },
    );
    await authPage.goto(`/app/budgets/${budget.id}`);
    await expect(authPage.getByTestId('budget-form-title')).toHaveText(/Editar orçamento/, {
      timeout: 15_000,
    });
    await expect(authPage.getByTestId('budget-form-loading')).toHaveCount(0, { timeout: 15_000 });
    await expect(authPage.getByTestId('budget-form-refuse')).toHaveCount(0);
  });
});

twoTenantsTest.describe('Fluxo 5.6 — refuse budget: tenant isolation', () => {
  twoTenantsTest('@flow refusing a budget of another tenant returns 404 and changes nothing', async ({
    apiA,
    apiB,
    tenantA,
    tenantB,
  }) => {
    const client = await apiCreateClient(apiA);
    const activity = await apiCreateActivity(apiA);
    const budget = await apiCreateBudget(apiA, {
      clientId: client.id,
      activityIds: [activity.id],
    });
    await apiSendBudget(apiA, budget.id);

    expect(tenantB.tenantId, 'dois tenants distintos').not.toBe(tenantA.tenantId);

    const res = await apiB.post(`/api/budgets/${budget.id}/refuse`, {
      data: { reason: 'Recusa de outra empresa' },
    });
    // Soft: se vazar, o teste ainda confere abaixo se o orçamento de A mudou.
    expect
      .soft(res.status(), `POST /refuse pelo tenant B: ${(await res.text()).slice(0, 300)}`)
      .toBe(404);

    const unchanged = (await apiGetBudget(apiA, budget.id)) as {
      status?: string;
      refusalReason?: string | null;
    };
    expect(unchanged.status).toBe('Sent');
    expect(unchanged.refusalReason ?? null).toBeNull();
  });
});
