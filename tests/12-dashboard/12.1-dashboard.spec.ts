import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { assertOk, readJson } from '../../helpers/response';

/**
 * Fluxo: 12.1 — Dashboard
 * Diagrama: docs/fluxos/negocio-12.1-dashboard.mmd
 */

test.describe('Fluxo 12.1 — Dashboard', () => {
  test('@flow dashboard carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/dashboard');
  });

  test('@flow GET /api/dashboard/metrics retorna estrutura em tenant novo', async ({
    authApi,
  }) => {
    const res = await authApi.get('/api/dashboard/metrics');
    await assertOk(res, 'GET /api/dashboard/metrics');
    const data = await readJson<Record<string, unknown>>(res);
    expect(typeof data).toBe('object');
    expect(data).not.toBeNull();
    // Pelo menos uma chave conhecida deve existir (smoke do shape)
    expect(Object.keys(data).length).toBeGreaterThan(0);
  });
});
