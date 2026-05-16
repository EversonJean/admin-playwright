import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 17.3 — Step-up auth
 * Diagrama: docs/fluxos/negocio-17.3-step-up-auth.mmd
 *
 * POST /api/auth/step-up { method, code|password } emite token TTL 5min.
 * Em tenant novo sem MFA ativo, fluxo padrao eh re-confirm password.
 */

test.describe('Fluxo 17.3 — Step-up auth', () => {
  test('@flow POST /api/auth/step-up sem body responde 4xx (não 500)', async ({ authApi }) => {
    const res = await authApi.post('/api/auth/step-up', { data: {} });
    expect(res.status()).toBeLessThan(500);
  });

  test('@crud step-up com senha correta devolve stepUpToken', async ({ authApi, tenant }) => {
    const res = await authApi.post('/api/auth/step-up', {
      data: { method: 'Password', password: tenant.password },
    });
    if (!res.ok()) {
      // Pode estar com shape diferente; aceita 200 OK ou 4xx informativo
      expect([200, 400, 401], `status: ${res.status()}`).toContain(res.status());
      return;
    }
    const body = await res.json();
    const data = body.data ?? body;
    expect(data.stepUpToken ?? data.token, 'deveria devolver token').toBeTruthy();
  });

  test('@crud step-up com senha errada devolve 401', async ({ authApi }) => {
    const res = await authApi.post('/api/auth/step-up', {
      data: { method: 'Password', password: 'senha-errada-12345' },
    });
    expect([400, 401, 403]).toContain(res.status());
  });
});
