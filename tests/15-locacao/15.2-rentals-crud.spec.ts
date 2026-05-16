import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';
import { assertOk, readJson } from '../../helpers/response';

/**
 * Cobertura adicional 15.x — rentals dashboard + listagem.
 * Aprofundamento focado no caminho de leitura (mais simples) pra fechar
 * o gap de 0 endpoints cobertos no RentalsController.
 */

test.describe('15.2 — Rentals (leitura)', () => {
  test('@flow GET /api/rentals/dashboard retorna shape', async ({ authApi, tenant }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_equipment_rental');
    const res = await authApi.get('/api/rentals/dashboard');
    await assertOk(res, 'GET rentals/dashboard');
    const data = await readJson<Record<string, unknown>>(res);
    expect(typeof data).toBe('object');
    expect(data).not.toBeNull();
  });

  test('@flow GET /api/rentals lista rentals (vazio em tenant novo)', async ({
    authApi,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_equipment_rental');
    const res = await authApi.get('/api/rentals');
    await assertOk(res, 'GET rentals');
  });
});
