import { expect } from '@playwright/test';
import { authTest } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { assertOk, readJson } from '../../helpers/response';

/**
 * Telas misc do tenant sem cobertura dedicada:
 *   /app/profile               — perfil do usuario
 *   /app/onboarding            — wizard pos-signup
 *   /app/billing/blocked       — tela quando subscription suspensa
 *   /app/agenda                — vista pessoal
 *   /app/email-logs            — viewer email logs
 *
 * Smoke + validacao API /api/auth/me que alimenta /profile.
 */

authTest.describe('Telas misc (smoke + /api/auth/me)', () => {
  authTest('@flow /app/profile carrega autenticado', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/profile');
  });

  authTest('@flow /app/onboarding carrega autenticado', async ({ authPage }) => {
    const res = await authPage.goto('/app/onboarding');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  authTest('@flow /app/billing/blocked carrega autenticado', async ({ authPage }) => {
    const res = await authPage.goto('/app/billing/blocked');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  authTest('@flow /app/agenda carrega autenticado', async ({ authPage }) => {
    const res = await authPage.goto('/app/agenda');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  authTest('@flow /app/email-logs carrega autenticado', async ({ authPage }) => {
    const res = await authPage.goto('/app/email-logs');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  authTest('@flow GET /api/auth/me devolve dados do user logado', async ({ authApi, tenant }) => {
    const res = await authApi.get('/api/auth/me');
    await assertOk(res, 'GET /api/auth/me');
    const me = await readJson<{ email: string; tenantId: string }>(res);
    expect(me.email.toLowerCase()).toBe(tenant.email.toLowerCase());
    expect(me.tenantId).toBe(tenant.tenantId);
  });
});
