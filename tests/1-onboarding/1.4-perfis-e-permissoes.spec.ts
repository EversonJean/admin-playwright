import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 1.4 — Perfis e permissões + identidade do usuário
 * Diagrama: docs/fluxos/negocio-1.4-perfis-e-permissoes.mmd
 * Especificação: docs/FUNCIONALIDADES-NEGOCIO.md §1.4
 */

test.describe('Fluxo 1.4 — Perfis e permissões', () => {
  test('@flow GET /me/permissions devolve permissões do admin do tenant', async ({ authApi }) => {
    const res = await authApi.get('/api/me/permissions');
    if (!res.ok()) {
      throw new Error(`Status ${res.status()}: ${await res.text()}`);
    }
    const body = await res.json();
    const perms = body.data?.permissions ?? body.permissions ?? [];
    expect(Array.isArray(perms)).toBe(true);
    expect(perms.length).toBeGreaterThan(0);
  });

  test('@flow admin recém-criado consegue acessar dashboard', async ({ authPage }) => {
    await authPage.goto('/app/dashboard');
    await expect(authPage).toHaveURL(/\/app\/dashboard/);
    await expect(authPage.getByText(/acesso negado|403/i)).toHaveCount(0);
  });

  test('@flow GET /api/auth/me devolve email e tenantId do user autenticado', async ({ authApi, tenant }) => {
    const res = await authApi.get('/api/auth/me');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const data = body.data ?? body;
    expect(String(data.email ?? '').toLowerCase()).toBe(tenant.email.toLowerCase());
    expect(data.tenantId ?? data.user?.tenantId).toBe(tenant.tenantId);
  });

  test('@flow GET /api/auth/sessions lista a sessão atual', async ({ authApi }) => {
    const res = await authApi.get('/api/auth/sessions');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const data = body.data ?? body;
    const items = Array.isArray(data) ? data : data.items ?? data.sessions ?? [];
    // O fluxo de signup → login criou pelo menos 1 refresh token (sessão)
    expect(items.length).toBeGreaterThan(0);
  });
});
