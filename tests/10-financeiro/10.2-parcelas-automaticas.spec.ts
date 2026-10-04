import { APIRequestContext, request as playwrightRequest } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { loginViaApi } from '../../helpers/api-client';
import {
  apiCompleteOnboarding,
  apiCreateActivity,
  apiCreateClient,
} from '../../helpers/api-entities';
import { seedUserWithRoleDirect } from '../../helpers/db-helper';
import { assertOk, readJson } from '../../helpers/response';
import {
  apiAcceptPublicBudget,
  apiCreateBudget,
  apiCreatePaymentPlan,
  apiGetPaymentPlan,
  apiSendBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';

/**
 * Fluxo: 10.2 — Parcelas automáticas
 * Diagrama: docs/fluxos/negocio-10.2-parcelas-automaticas.mmd
 *
 * PaymentTermsTemplate define modelos de parcelamento. Plano efetivo
 * vive em /api/events/:id/payment-plan (criado a partir do template ou
 * inline com installments[]).
 *
 * Etapa 198 (PLANO-AJUSTES-DA-CONVERSAO §7 item 3; registro e2e E21): a lista
 * de modelos ganha a ação Ativar/Inativar (`paymentterms.manage`). O modelo
 * padrão não inativa (`PaymentTerms.IsDefault`); quem só lê (Gerente) não vê
 * a ação e o back recusa a rota com 403.
 */

const BACK_URL = process.env.BACK_URL ?? 'https://localhost:1501';

interface TemplateDto {
  id: string;
  status: 'Active' | 'Inactive';
  isDefault: boolean;
}

async function apiCreateTemplate(
  api: APIRequestContext,
  input: { name: string; isDefault: boolean },
): Promise<TemplateDto> {
  const res = await api.post('/api/payment-terms-templates', {
    data: {
      name: input.name,
      isDefault: input.isDefault,
      installments: [{ order: 1, label: 'À vista', percentage: 100, dueRule: 'OnAcceptance' }],
    },
  });
  await assertOk(res, 'POST /api/payment-terms-templates');
  return readJson<TemplateDto>(res);
}

async function apiGetTemplate(api: APIRequestContext, id: string): Promise<TemplateDto> {
  const res = await api.get(`/api/payment-terms-templates/${id}`);
  await assertOk(res, 'GET /api/payment-terms-templates/{id}');
  return readJson<TemplateDto>(res);
}

test.describe('Fluxo 10.2 — Parcelas automáticas', () => {
  // Tenant recém-criado cai no assistente de configuração (onboardingGuard):
  // as telas só abrem depois do `apiCompleteOnboarding`.
  test('@flow termos de pagamento carrega autenticada', async ({ authPage, authApi }) => {
    await apiCompleteOnboarding(authApi);
    await smokeRoute(authPage, '/app/settings/payment-terms');
  });

  test('@flow tela de recebíveis carrega autenticada', async ({ authPage, authApi }) => {
    await apiCompleteOnboarding(authApi);
    await smokeRoute(authPage, '/app/finance/receivables');
  });

  test('@flow tela /settings/payment-terms/new carrega autenticada', async ({ authPage, authApi }) => {
    await apiCompleteOnboarding(authApi);
    await smokeRoute(authPage, '/app/settings/payment-terms/new');
  });

  test('@crud cria PaymentTermsTemplate 50/50 + ativa', async ({ authApi }) => {
    const name = `Template 50-50 ${Date.now()}`;
    const createRes = await authApi.post('/api/payment-terms-templates', {
      data: {
        name,
        isDefault: false,
        installments: [
          { order: 1, label: 'Sinal', percentage: 50, dueRule: 'OnAcceptance' },
          { order: 2, label: 'Saldo', percentage: 50, dueRule: 'DaysBeforeEvent', dueDays: 7 },
        ],
      },
    });
    if (!createRes.ok()) {
      throw new Error(`POST template ${createRes.status()}: ${await createRes.text()}`);
    }
    const template = (await createRes.json()).data ?? (await createRes.json());
    expect(template.id).toBeTruthy();

    const activate = await authApi.post(`/api/payment-terms-templates/${template.id}/activate`);
    expect(activate.ok()).toBe(true);
  });

  test('@crud cria payment-plan inline (2 parcelas) e GET retorna installments', async ({
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
      eventId = (await apiAcceptPublicBudget(publicApi, token)).eventId;
    } finally {
      await publicApi.dispose();
    }

    const due1 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const due2 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const plan = await apiCreatePaymentPlan(authApi, eventId, [
      { order: 1, label: 'Sinal', expectedAmount: 200, dueDate: due1 },
      { order: 2, label: 'Saldo', expectedAmount: 300, dueDate: due2 },
    ]);
    expect(plan.installments.length).toBe(2);

    const got = await apiGetPaymentPlan(authApi, eventId);
    expect(got).toBeTruthy();
    expect(got!.installments.length).toBe(2);
    expect(got!.installments[0]!.label).toBe('Sinal');
  });

  test('@crud list action deactivates and activates a template; the default one is not deactivated', async ({
    authApi,
    authPage,
  }) => {
    const stamp = Date.now();
    const regular = await apiCreateTemplate(authApi, { name: `Modelo E2E ${stamp}`, isDefault: false });
    const standard = await apiCreateTemplate(authApi, {
      name: `Padrão E2E ${stamp}`,
      isDefault: true,
    });
    expect(regular.status).toBe('Active');

    await apiCompleteOnboarding(authApi);
    await authPage.goto('/app/settings/payment-terms');
    await expect(authPage.getByTestId('payment-terms-table')).toBeVisible({ timeout: 15_000 });

    // Inativar
    await expect(authPage.getByTestId(`payment-terms-status-${regular.id}`)).toHaveText('Ativo');
    await authPage.getByTestId(`payment-terms-toggle-${regular.id}`).click();
    await expect(authPage.getByTestId(`payment-terms-status-${regular.id}`)).toHaveText('Inativo', {
      timeout: 15_000,
    });
    expect((await apiGetTemplate(authApi, regular.id)).status).toBe('Inactive');

    // Ativar de novo
    await authPage.getByTestId(`payment-terms-toggle-${regular.id}`).click();
    await expect(authPage.getByTestId(`payment-terms-status-${regular.id}`)).toHaveText('Ativo', {
      timeout: 15_000,
    });
    expect((await apiGetTemplate(authApi, regular.id)).status).toBe('Active');

    // O padrão não inativa: a tela explica e o status não muda.
    await authPage.getByTestId(`payment-terms-toggle-${standard.id}`).click();
    await expect(authPage.locator('.mat-mdc-snack-bar-label').last()).toContainText(
      'template padrão',
      { timeout: 15_000 },
    );
    await expect(authPage.getByTestId(`payment-terms-status-${standard.id}`)).toHaveText('Ativo');
    const stillDefault = await apiGetTemplate(authApi, standard.id);
    expect(stillDefault.status).toBe('Active');
    expect(stillDefault.isDefault).toBe(true);
  });

  test('@flow read-only user (Manager) does not see the action and gets 403 on activate/deactivate', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    const template = await apiCreateTemplate(authApi, {
      name: `Modelo E2E ${Date.now()}`,
      isDefault: false,
    });
    await apiCompleteOnboarding(authApi);

    // Gerente de verdade no mesmo tenant: `paymentterms.read` sem `.manage`.
    const manager = seedUserWithRoleDirect({
      tenantId: tenant.tenantId,
      role: 'Manager',
      emailPrefix: 'gerente',
    });
    const anon = await playwrightRequest.newContext({
      baseURL: BACK_URL,
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: { 'Content-Type': 'application/json' },
    });
    const tokens = await loginViaApi(anon, manager.email, manager.password);
    await anon.dispose();

    const managerApi = await playwrightRequest.newContext({
      baseURL: BACK_URL,
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokens.accessToken}`,
      },
    });
    try {
      expect((await managerApi.get(`/api/payment-terms-templates/${template.id}`)).status()).toBe(200);
      const deactivate = await managerApi.post(
        `/api/payment-terms-templates/${template.id}/deactivate`,
      );
      expect(deactivate.status()).toBe(403);
      const activate = await managerApi.post(`/api/payment-terms-templates/${template.id}/activate`);
      expect(activate.status()).toBe(403);
    } finally {
      await managerApi.dispose();
    }
    expect((await apiGetTemplate(authApi, template.id)).status).toBe('Active');

    await authPage.addInitScript(
      ({ access, refresh }) => {
        localStorage.setItem('access_token', access);
        localStorage.setItem('refresh_token', refresh);
      },
      { access: tokens.accessToken, refresh: tokens.refreshToken },
    );
    await authPage.goto('/app/settings/payment-terms');
    await expect(authPage.getByTestId(`payment-terms-status-${template.id}`)).toHaveText('Ativo', {
      timeout: 15_000,
    });
    await expect(authPage.getByTestId(`payment-terms-toggle-${template.id}`)).toHaveCount(0);
  });
});
