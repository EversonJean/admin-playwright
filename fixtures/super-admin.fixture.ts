import { test as base, APIRequestContext, request as playwrightRequest } from '@playwright/test';
import { getSuperAdminTokens, SuperAdminTokens } from '../helpers/super-admin-session';

/**
 * Fixture `superAdminTest` — `superAdminApi` autenticado como
 * `superadmin@dev.local` / `Dev12345!`. Esse usuario eh seedado pelo
 * `SeedDevelopmentTenantAsync` em E2E quando o DB ainda esta vazio; em
 * runs posteriores ele persiste no banco.
 *
 * Caso o seed nao tenha rodado (DB com users antigos), os tests vao
 * falhar com 401 — solucao eh truncar o banco antes do CI (db:reset)
 * ou aceitar que SuperAdmin specs precisam de tenant zero.
 *
 * Etapa 235 (SEG-B): o seed tem TOTP e o login devolve o desafio MFA. A sessao
 * sai de `helpers/super-admin-session.ts`, que resolve o desafio com o codigo
 * calculado e loga UMA vez por execucao (o back recusa o mesmo codigo duas
 * vezes no periodo de 30 s, entao um login por teste esperaria um periodo
 * inteiro a cada teste).
 */

/** Credenciais do SuperAdmin semeado no E2E; specs fora do `superAdminTest` importam daqui. */
export {
  SUPER_ADMIN_EMAIL,
  SUPER_ADMIN_PASSWORD,
  SUPER_ADMIN_TOTP_SECRET,
} from '../helpers/super-admin-session';
const BACK_URL = process.env.BACK_URL ?? 'https://localhost:1501';

export interface SuperAdminFixtures {
  superAdminApi: APIRequestContext;
  /** `refreshToken` é o valor do cookie `recreativo_refresh` do login (Etapa 232). */
  superAdminTokens: SuperAdminTokens;
}

export const superAdminTest = base.extend<SuperAdminFixtures>({
  superAdminTokens: async ({}, use) => {
    await use(await getSuperAdminTokens());
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
