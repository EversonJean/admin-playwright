import { test as base, Page, APIRequestContext, request as playwrightRequest } from '@playwright/test';
import { createApiContext, signupAndConfirm, SignupResult } from '../helpers/api-client';
import { fakeTenant } from '../helpers/test-data';

/**
 * Fixture `authTest` — entrega `authPage` já autenticada (tokens injetados no
 * localStorage via addInitScript) e `authApi` autenticado com Bearer.
 *
 * Cada teste cria seu próprio tenant + admin via API (signup → confirm via
 * SQL → login) e usa esses tokens. Reuso entre testes em paralelo é seguro
 * porque cada teste tem seu próprio tenant isolado.
 */

export interface AuthFixtures {
  api: APIRequestContext;
  tenant: SignupResult & { companyName: string; subdomain: string };
  /** API autenticado — chama endpoints `/api/*` com Authorization: Bearer já setado. */
  authApi: APIRequestContext;
  /** Page já com tokens em localStorage. Navegação direta pra `/app/*` funciona. */
  authPage: Page;
}

export const authTest = base.extend<AuthFixtures>({
  api: async ({}, use) => {
    const api = await createApiContext();
    await use(api);
    await api.dispose();
  },

  tenant: async ({ api }, use) => {
    const fake = fakeTenant();
    const result = await signupAndConfirm(api, {
      companyName: fake.companyName,
      adminName: fake.adminName,
      adminEmail: fake.adminEmail,
      adminPassword: fake.adminPassword,
    });
    await use({ ...result, companyName: fake.companyName, subdomain: fake.subdomain });
  },

  authApi: async ({ tenant }, use) => {
    const ctx = await playwrightRequest.newContext({
      baseURL: process.env.BACK_URL ?? 'https://localhost:1501',
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tenant.accessToken}`,
      },
    });
    await use(ctx);
    await ctx.dispose();
  },

  authPage: async ({ page, tenant }, use) => {
    // Injeta tokens ANTES de qualquer script da página rodar — o auth-boot do
    // front lê localStorage no startup e considera o usuário logado.
    await page.addInitScript(
      ({ access, refresh }) => {
        localStorage.setItem('access_token', access);
        if (refresh) localStorage.setItem('refresh_token', refresh);
      },
      { access: tenant.accessToken, refresh: tenant.refreshToken ?? null },
    );

    await use(page);
  },
});

/** Backwards-compat: helper original de login UI (pra fluxos que validam o login em si). */
export async function loginViaUi(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/auth/login');
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  await page.getByTestId('login-submit').click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

export { expect } from '@playwright/test';
