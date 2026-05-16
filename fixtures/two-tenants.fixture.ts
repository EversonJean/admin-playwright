import { test as base, APIRequestContext, request as playwrightRequest } from '@playwright/test';
import { createApiContext, signupAndConfirm, SignupResult } from '../helpers/api-client';
import { fakeTenant } from '../helpers/test-data';

/**
 * Fixture `twoTenantsTest` — cria DOIS tenants independentes (A e B) com
 * APIs autenticadas pra cada um. Usado pra exercitar isolamento multi-
 * tenant (recursos do tenant A nao podem ser lidos/escritos pelo tenant B).
 *
 * Categoria mais critica em SaaS — vazamento entre clientes seria SEV-1.
 */

const BACK_URL = process.env.BACK_URL ?? 'https://localhost:1501';

export interface TwoTenantsFixtures {
  tenantA: SignupResult;
  tenantB: SignupResult;
  apiA: APIRequestContext;
  apiB: APIRequestContext;
}

async function bootTenant(): Promise<SignupResult> {
  const fake = fakeTenant();
  const api = await createApiContext();
  try {
    return await signupAndConfirm(api, {
      companyName: fake.companyName,
      adminName: fake.adminName,
      adminEmail: fake.adminEmail,
      adminPassword: fake.adminPassword,
    });
  } finally {
    await api.dispose();
  }
}

async function authedContext(token: string): Promise<APIRequestContext> {
  return await playwrightRequest.newContext({
    baseURL: BACK_URL,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });
}

export const twoTenantsTest = base.extend<TwoTenantsFixtures>({
  tenantA: async ({}, use) => {
    const t = await bootTenant();
    await use(t);
  },
  tenantB: async ({}, use) => {
    const t = await bootTenant();
    await use(t);
  },
  apiA: async ({ tenantA }, use) => {
    const ctx = await authedContext(tenantA.accessToken);
    await use(ctx);
    await ctx.dispose();
  },
  apiB: async ({ tenantB }, use) => {
    const ctx = await authedContext(tenantB.accessToken);
    await use(ctx);
    await ctx.dispose();
  },
});

export { expect } from '@playwright/test';
