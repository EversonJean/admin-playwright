import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 1.4 — Perfis e permissões
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
});
