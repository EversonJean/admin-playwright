import { test as base, APIRequestContext } from '@playwright/test';
import { createApiContext, signupAndConfirm, SignupResult } from '../helpers/api-client';
import { fakeTenant } from '../helpers/test-data';

/**
 * Fixture que cria um tenant + admin novos antes de cada teste e dispõe
 * tokens já prontos. Isolamento total por teste — banco fica sujo (sem
 * rollback), mas cada teste só "vê" o próprio tenant graças ao filtro
 * multi-tenant do back.
 */

export interface TenantFixtures {
  api: APIRequestContext;
  tenant: SignupResult & { companyName: string; subdomain: string };
}

export const tenantTest = base.extend<TenantFixtures>({
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
});

export { expect } from '@playwright/test';
