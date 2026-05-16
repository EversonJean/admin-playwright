import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { assertOk, readJson } from '../../helpers/response';

/**
 * Fluxo: 17.3 — Step-up auth
 * Diagrama: docs/fluxos/negocio-17.3-step-up-auth.mmd
 *
 * POST /api/auth/step-up { method, code|password } emite token TTL 5min.
 * Em tenant novo sem MFA ativo, fluxo padrao eh re-confirm password.
 */

test.describe('Fluxo 17.3 — Step-up auth', () => {
  test('@flow POST /api/auth/step-up sem body devolve 400/422', async ({ authApi }) => {
    const res = await authApi.post('/api/auth/step-up', { data: {} });
    expect([400, 422], `status: ${res.status()}`).toContain(res.status());
  });

  test('@crud step-up com senha correta devolve stepUpToken', async ({ authApi, tenant }) => {
    const res = await authApi.post('/api/auth/step-up', {
      data: { method: 'Password', password: tenant.password },
    });
    await assertOk(res, 'POST step-up senha correta');
    const data = await readJson<{ stepUpToken?: string; token?: string }>(res);
    const token = data.stepUpToken ?? data.token;
    expect(token, 'deveria devolver stepUpToken').toBeTruthy();
    expect(typeof token).toBe('string');
    expect((token ?? '').length).toBeGreaterThan(10);
  });

  test('@crud step-up com senha errada devolve 401', async ({ authApi }) => {
    const res = await authApi.post('/api/auth/step-up', {
      data: { method: 'Password', password: 'senha-errada-12345' },
    });
    expect(res.status(), 'senha errada deve ser 401 estrito').toBe(401);
  });
});
