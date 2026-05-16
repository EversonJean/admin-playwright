import { superAdminTest, expect } from '../../fixtures/super-admin.fixture';

/**
 * Fluxo extra — SuperAdmin observability
 * (tela /app/observability)
 */

superAdminTest.describe('SuperAdmin — Observability', () => {
  superAdminTest('@crud GET /api/super-admin/observability/metrics responde', async ({
    superAdminApi,
  }) => {
    const res = await superAdminApi.get('/api/super-admin/observability/metrics');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const data = body.data ?? body;
    expect(data, 'metrics retorna objeto/array').toBeTruthy();
  });
});
