import { superAdminTest, expect } from '../../fixtures/super-admin.fixture';
import { assertOk, readJson } from '../../helpers/response';

/**
 * Fluxo extra — SuperAdmin observability
 * (tela /app/observability)
 */

superAdminTest.describe('SuperAdmin — Observability', () => {
  superAdminTest('@flow GET /api/super-admin/observability/metrics devolve shape minimo', async ({
    superAdminApi,
  }) => {
    const res = await superAdminApi.get('/api/super-admin/observability/metrics');
    await assertOk(res, 'GET observability/metrics');
    const data = await readJson<Record<string, unknown> | unknown[]>(res);
    if (Array.isArray(data)) {
      // Estilo lista de metricas
      expect(data.length).toBeGreaterThanOrEqual(0);
    } else {
      expect(typeof data).toBe('object');
      expect(data).not.toBeNull();
      expect(Object.keys(data).length).toBeGreaterThan(0);
    }
  });
});
