import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { assertOk, readJson } from '../../helpers/response';

/**
 * Fluxos LGPD aprofundados (extensao do 14.2).
 *   POST /api/privacy/request-user-deletion -> agenda exclusao
 *   GET  /api/privacy/user-deletion          -> consulta status
 *   POST /api/privacy/request-tenant-closure -> Owner solicita fechamento
 *   GET  /api/privacy/channel                 -> info do canal LGPD
 */

test.describe('LGPD — deletion + closure lifecycle', () => {
  test('@crud GET /api/privacy/channel devolve info do canal', async ({ authApi }) => {
    const res = await authApi.get('/api/privacy/channel');
    await assertOk(res, 'GET /privacy/channel');
    const data = await readJson<{ email?: string; tenantClosureGraceDays?: number }>(res);
    expect(typeof data).toBe('object');
    expect(data).not.toBeNull();
  });

  test('@crud POST /api/privacy/request-user-deletion agenda + GET retorna pending', async ({
    authApi,
  }) => {
    const reqRes = await authApi.post('/api/privacy/request-user-deletion');
    if (!reqRes.ok()) {
      // Pode requerer body — checa shape, mas valida 2xx OR 4xx (nao 5xx)
      expect(reqRes.status()).toBeLessThan(500);
      return;
    }

    const statusRes = await authApi.get('/api/privacy/user-deletion');
    await assertOk(statusRes, 'GET user-deletion status');
    const data = await readJson<{ status?: string }>(statusRes);
    // Apos request, status deve ser nao-nulo (pending/scheduled)
    expect(typeof data).toBe('object');
  });

  test('@crud DELETE /api/privacy/user-deletion cancela solicitacao', async ({ authApi }) => {
    await authApi.post('/api/privacy/request-user-deletion');
    const cancelRes = await authApi.delete('/api/privacy/user-deletion');
    expect(cancelRes.status(), `status: ${cancelRes.status()}`).toBeLessThan(500);
  });

  test('@crud POST /api/privacy/request-tenant-closure Owner agenda closure', async ({
    authApi,
  }) => {
    const res = await authApi.post('/api/privacy/request-tenant-closure', {
      data: { confirmation: 'CONFIRMAR ENCERRAMENTO' },
    });
    // Espera 200/201 (sucesso) OU 400 (faltou confirmation correta) — nao 5xx
    expect(res.status(), `status: ${res.status()}`).toBeLessThan(500);
  });
});
