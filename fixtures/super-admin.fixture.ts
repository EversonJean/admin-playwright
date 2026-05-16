import { test as base, APIRequestContext, request as playwrightRequest } from '@playwright/test';
import { loginViaApi } from '../helpers/api-client';

/**
 * Fixture `superAdminTest` — `superAdminApi` autenticado como
 * `superadmin@dev.local` / `Dev12345!`. Esse usuario eh seedado pelo
 * `SeedDevelopmentTenantAsync` em E2E quando o DB ainda esta vazio; em
 * runs posteriores ele persiste no banco.
 *
 * Caso o seed nao tenha rodado (DB com users antigos), os tests vao
 * falhar com 401 — solucao eh truncar o banco antes do CI (db:reset)
 * ou aceitar que SuperAdmin specs precisam de tenant zero.
 */

const SUPER_ADMIN_EMAIL = 'superadmin@dev.local';
const SUPER_ADMIN_PASSWORD = 'Dev12345!';
const BACK_URL = process.env.BACK_URL ?? 'https://localhost:1501';

export interface SuperAdminFixtures {
  superAdminApi: APIRequestContext;
  superAdminTokens: { accessToken: string; refreshToken: string };
}

export const superAdminTest = base.extend<SuperAdminFixtures>({
  superAdminTokens: async ({}, use) => {
    const api = await playwrightRequest.newContext({
      baseURL: BACK_URL,
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: { 'Content-Type': 'application/json' },
    });
    try {
      const tokens = await loginViaApi(api, SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD);
      await use(tokens);
    } finally {
      await api.dispose();
    }
  },

  superAdminApi: async ({ superAdminTokens }, use) => {
    const ctx = await playwrightRequest.newContext({
      baseURL: BACK_URL,
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${superAdminTokens.accessToken}`,
      },
    });
    await use(ctx);
    await ctx.dispose();
  },
});

export { expect } from '@playwright/test';
