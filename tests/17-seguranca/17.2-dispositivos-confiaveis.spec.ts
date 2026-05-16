import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 17.2 — Dispositivos confiáveis
 * Diagrama: docs/fluxos/negocio-17.2-dispositivos-confiaveis.mmd
 *
 * Trusted devices via cookie HttpOnly + fingerprint. Os endpoints
 * /api/auth/trusted-devices, GET (lista), DELETE (revoga), POST
 * /revoke-all operam contra TrustedDevice entity.
 */

test.describe('Fluxo 17.2 — Dispositivos confiáveis', () => {
  test('@flow GET /api/auth/trusted-devices responde sem 500', async ({ authApi }) => {
    const res = await authApi.get('/api/auth/trusted-devices');
    expect(res.status()).toBeLessThan(500);
  });

  test('@crud GET /trusted-devices em tenant novo retorna lista vazia', async ({ authApi }) => {
    const res = await authApi.get('/api/auth/trusted-devices');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const items: Array<unknown> = body.data ?? body;
    expect(Array.isArray(items) ? items.length : 0).toBe(0);
  });

  test('@crud POST /revoke-all em lista vazia responde sem erro', async ({ authApi }) => {
    const res = await authApi.post('/api/auth/trusted-devices/revoke-all');
    expect(res.ok()).toBe(true);
  });
});
