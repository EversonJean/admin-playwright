import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 17.4 — Detecção de acesso suspeito
 * Diagrama: docs/fluxos/negocio-17.4-deteccao-acesso-suspeito.mmd
 *
 * SecurityEvent + GeoIp + impossible-travel detector. Cobertura via UI
 * exige logins de IPs diferentes. Smoke do endpoint de security events.
 */

test.describe('Fluxo 17.4 — Detecção de acesso suspeito', () => {
  test('@flow GET /api/security-events responde sem 500', async ({ authApi }) => {
    const res = await authApi.get('/api/security-events');
    expect(res.status()).toBeLessThan(500);
  });
});
