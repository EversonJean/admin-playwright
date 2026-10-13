import { APIRequestContext } from '@playwright/test';

import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createApiContext, createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import { apiCompleteOnboarding } from '../../helpers/api-entities';
import { apiErrorCodes, assertOk, unwrapList } from '../../helpers/response';
import { RoleSession, loginAsRole, openSessionPage } from '../../helpers/setup-flows';

/**
 * Fluxo: 1.8 — Bloqueio e desbloqueio de usuário pela lista de usuários
 * Diagrama: — (cenário E96 do registro e2e de `docs/implementados/PLANO-SEGURANCA.md`)
 *
 * Fonte do comportamento: PLANO-SEGURANCA §8 (SEG-F): item 2 (`PUT
 * /api/users/{id}/status` com `users.update`; `Users.CannotBlockSelf`,
 * `Users.CannotBlockOwner`; o bloqueio revoga as sessões e troca o
 * `SecurityStamp`; desbloquear exige `security.unlock`) e item 10 (ação na tela
 * de usuários, com confirmação), mais a decisão A9 da revisão. O spec afirma o
 * plano; divergência é falha de código, não de asserção.
 */

interface UserRow {
  id: string;
  email: string;
  role: string;
  status: string;
}

async function listUsers(api: APIRequestContext): Promise<UserRow[]> {
  const res = await api.get('/api/users?pageSize=100');
  await assertOk(res, 'GET /api/users');
  return unwrapList<UserRow>(res);
}

async function userByEmail(api: APIRequestContext, email: string): Promise<UserRow> {
  const row = (await listUsers(api)).find((u) => u.email.toLowerCase() === email.toLowerCase());
  expect(row, `usuário ${email} na lista`).toBeTruthy();
  return row!;
}

/** Login pela API num contexto descartado; devolve o status e os códigos de erro. */
async function loginAttempt(email: string, password: string): Promise<{ status: number; codes: string[] }> {
  const anon = await createApiContext();
  try {
    const res = await anon.post('/api/auth/login', { data: { email, password } });
    const status = res.status();
    return { status, codes: status === 200 ? [] : await apiErrorCodes(res) };
  } finally {
    await anon.dispose();
  }
}

test.describe('Fluxo 1.8 — Bloqueio de usuário', () => {
  test('E96 @crud Admin bloqueia o Manager com confirmação: a sessão dele cai e o login é recusado; desbloquear devolve o login', async ({
    authApi,
    tenant,
    browser,
  }) => {
    test.setTimeout(180_000);
    await apiCompleteOnboarding(authApi);
    const admin = await loginAsRole(tenant.tenantId, 'Admin');
    const manager: RoleSession = await loginAsRole(tenant.tenantId, 'Manager');
    try {
      // O Manager tem sessão aberta e funcionando antes do bloqueio.
      expect((await manager.api.get('/api/clients?pageSize=1')).status(), 'sessão do Manager antes').toBe(200);

      const managerRow = await userByEmail(authApi, manager.email);
      const adminRow = await userByEmail(authApi, admin.email);
      const ownerRow = await userByEmail(authApi, tenant.email);

      const { page, context } = await openSessionPage(browser, admin.tokens);
      try {
        await page.goto('/app/users/list');
        await expect(page.getByTestId('users-table')).toBeVisible();

        // Sem ação no Owner nem em si mesmo.
        await expect(page.getByTestId(`users-block-${ownerRow.id}`), 'sem bloquear o Owner').toHaveCount(0);
        await expect(page.getByTestId(`users-block-${adminRow.id}`), 'sem bloquear a si').toHaveCount(0);

        // Bloquear pede confirmação; cancelar não muda nada.
        await page.getByTestId(`users-block-${managerRow.id}`).click();
        await expect(page.getByTestId('confirm-title')).toBeVisible();
        await page.getByTestId('confirm-cancel').click();
        expect((await userByEmail(authApi, manager.email)).status, 'cancelar não bloqueia').toBe('Active');

        const blocked = page.waitForResponse(
          (r) => r.request().method() === 'PUT' && r.url().includes(`/api/users/${managerRow.id}/status`),
        );
        await page.getByTestId(`users-block-${managerRow.id}`).click();
        await page.getByTestId('confirm-ok').click();
        expect((await blocked).status(), 'PUT status Blocked').toBeLessThan(300);
        await expect(page.getByTestId(`users-unblock-${managerRow.id}`)).toBeVisible();

        // A sessão aberta do Manager cai no request seguinte e o login é recusado.
        expect((await manager.api.get('/api/clients?pageSize=1')).status(), 'sessão do Manager depois').toBe(401);
        const refused = await loginAttempt(manager.email, 'Dev12345!');
        expect(refused.status, 'login do Manager bloqueado').toBe(403);
        expect(refused.codes, 'motivo da recusa').toContain('Auth.UserBlocked');

        // Desbloquear (Admin tem security.unlock) devolve o login.
        const unblocked = page.waitForResponse(
          (r) => r.request().method() === 'PUT' && r.url().includes(`/api/users/${managerRow.id}/status`),
        );
        await page.getByTestId(`users-unblock-${managerRow.id}`).click();
        await page.getByTestId('confirm-ok').click();
        expect((await unblocked).status(), 'PUT status Active').toBeLessThan(300);
        await expect(page.getByTestId(`users-block-${managerRow.id}`)).toBeVisible();
        expect((await loginAttempt(manager.email, 'Dev12345!')).status, 'login do Manager de volta').toBe(200);
      } finally {
        await context.close();
      }
    } finally {
      await admin.api.dispose();
      await manager.api.dispose();
    }
  });

  test('E96 @flow pela API: bloquear usuário de outro tenant dá 404 e bloquear o Owner dá 400', async ({
    authApi,
    tenant,
  }) => {
    const admin = await loginAsRole(tenant.tenantId, 'Admin');
    const other = await signupNewTenant();
    const otherApi = await createBearerApiContext(other.accessToken);
    try {
      const otherManager = await loginAsRole(other.tenantId, 'Manager');
      await otherManager.api.dispose();
      const foreign = await userByEmail(otherApi, otherManager.email);

      const cross = await admin.api.put(`/api/users/${foreign.id}/status`, { data: { status: 'Blocked' } });
      expect(cross.status(), 'usuário de outro tenant').toBe(404);
      expect((await userByEmail(otherApi, otherManager.email)).status, 'o de fora segue ativo').toBe('Active');

      const owner = await userByEmail(authApi, tenant.email);
      const blockOwner = await admin.api.put(`/api/users/${owner.id}/status`, { data: { status: 'Blocked' } });
      expect(blockOwner.status(), 'bloquear o Owner').toBe(400);
      expect(await apiErrorCodes(blockOwner)).toContain('Users.CannotBlockOwner');

      const adminRow = await userByEmail(authApi, admin.email);
      const blockSelf = await admin.api.put(`/api/users/${adminRow.id}/status`, { data: { status: 'Blocked' } });
      expect(blockSelf.status(), 'bloquear a si mesmo').toBe(400);
      expect(await apiErrorCodes(blockSelf)).toContain('Users.CannotBlockSelf');
    } finally {
      await admin.api.dispose();
      await otherApi.dispose();
    }
  });
});
