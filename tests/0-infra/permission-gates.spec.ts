import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Cobertura sistemica — permission gates retornam 403.
 *
 * Tenant Admin (Owner default do signup) NAO deve poder acessar
 * /api/super-admin/* — permissions de SuperAdmin sao exclusivas.
 *
 * Tambem cobre o caso de role limitada (Manager/Financial) nao ter
 * permissions de Owner — exercitado em specs especificos quando o
 * back tem permission granular.
 */

test.describe('Permission gates — tenant admin nao acessa SuperAdmin', () => {
  test('@crud admin de tenant NAO acessa /api/super-admin/tenants', async ({ authApi }) => {
    const res = await authApi.get('/api/super-admin/tenants');
    expect(res.status(), 'tenant admin -> 403 em super-admin').toBe(403);
  });

  test('@crud admin de tenant NAO acessa /api/super-admin/plans', async ({ authApi }) => {
    const res = await authApi.get('/api/super-admin/plans');
    expect(res.status()).toBe(403);
  });

  test('@crud admin de tenant NAO acessa /api/super-admin/bugs', async ({ authApi }) => {
    const res = await authApi.get('/api/super-admin/bugs');
    expect(res.status()).toBe(403);
  });

  test('@crud admin de tenant NAO acessa /api/super-admin/observability/metrics', async ({
    authApi,
  }) => {
    const res = await authApi.get('/api/super-admin/observability/metrics');
    expect(res.status()).toBe(403);
  });

  test('@crud admin de tenant NAO acessa /api/super-admin/maintenance', async ({ authApi }) => {
    const res = await authApi.get('/api/super-admin/maintenance');
    expect(res.status()).toBe(403);
  });

  test('@crud admin de tenant NAO acessa /api/super-admin/tenant-closures', async ({
    authApi,
  }) => {
    const res = await authApi.get('/api/super-admin/tenant-closures');
    expect(res.status()).toBe(403);
  });

  test('@crud admin de tenant NAO acessa /api/super-admin/whatsapp-templates', async ({
    authApi,
  }) => {
    const res = await authApi.get('/api/super-admin/whatsapp-templates');
    expect(res.status()).toBe(403);
  });
});
