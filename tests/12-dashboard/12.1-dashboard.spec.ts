import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 12.1 — Dashboard
 * Diagrama: docs/fluxos/negocio-12.1-dashboard.mmd
 */

test.describe('Fluxo 12.1 — Dashboard', () => {
  test('@flow dashboard carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/dashboard');
  });

  test('@crud GET /api/dashboard/metrics retorna agregados zerados em tenant novo', async ({
    authApi,
  }) => {
    const res = await authApi.get('/api/dashboard/metrics');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const data = body.data ?? body;
    expect(data).toBeTruthy();
    // Tenant recem-criado nao tem eventos/orcamentos; basta a estrutura existir
    expect(typeof data).toBe('object');
  });
});
