import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 17.2 — Dispositivos confiáveis
 * Diagrama: docs/fluxos/negocio-17.2-dispositivos-confiaveis.mmd
 *
 * Trusted devices via cookie HttpOnly + fingerprint. Cobertura completa exige
 * multi-sessão + manipulação de cookies. Smoke do endpoint de listagem.
 */

test.describe('Fluxo 17.2 — Dispositivos confiáveis', () => {
  test('@flow GET /api/auth/trusted-devices responde sem 500', async ({ authApi }) => {
    const res = await authApi.get('/api/auth/trusted-devices');
    expect(res.status()).toBeLessThan(500);
  });
});
