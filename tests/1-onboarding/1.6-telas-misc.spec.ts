import { expect } from '@playwright/test';
import { authTest } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { assertOk, readJson } from '../../helpers/response';

/**
 * Telas misc do tenant que existem em tenant-app.routes.ts:
 *   /app/onboarding            — wizard pos-signup
 *   /app/billing/blocked       — tela quando subscription suspensa
 *
 * + smoke da API /api/auth/me que alimenta o header do app.
 *
 * NOTA: /app/profile, /app/agenda, /app/email-logs, /app/availability
 * NAO existem como rotas no tenant.routes (sao do SuperAdmin ou portal
 * collaborator). Testes antigos com smokeRoute pra essas rotas eram
 * falsos positivos — Angular renderiza shell + redireciona e o teste
 * passa sem testar nada.
 */

authTest.describe('Telas misc (smoke + /api/auth/me)', () => {
  authTest('@flow /app/onboarding carrega autenticado', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/onboarding');
  });

  authTest('@flow /app/billing/blocked carrega autenticado', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/billing/blocked');
  });

  authTest('@flow GET /api/auth/me devolve dados do user logado', async ({ authApi, tenant }) => {
    const res = await authApi.get('/api/auth/me');
    await assertOk(res, 'GET /api/auth/me');
    const me = await readJson<{ email: string; tenantId: string }>(res);
    expect(me.email.toLowerCase()).toBe(tenant.email.toLowerCase());
    expect(me.tenantId).toBe(tenant.tenantId);
  });
});
