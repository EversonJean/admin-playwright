import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createApiContext } from '../../helpers/api-client';
import { assertOk, unwrapList } from '../../helpers/response';

/**
 * Fluxo: 17.4 — Detecção de acesso suspeito
 * Diagrama: docs/fluxos/negocio-17.4-deteccao-acesso-suspeito.mmd
 *
 * Tentativas de login falhas geram SecurityEvent. GET /api/auth/
 * security-events lista os eventos do tenant.
 */

interface SecurityEventItem {
  type?: string;
  eventType?: string;
}

test.describe('Fluxo 17.4 — Detecção de acesso suspeito', () => {
  test('@flow GET /api/auth/security-events autenticado retorna 200', async ({ authApi }) => {
    const res = await authApi.get('/api/auth/security-events');
    expect(res.status()).toBe(200);
  });

  test('@crud falha de login + GET security-events lista evento LoginFailed', async ({
    authApi,
    tenant,
  }) => {
    // Falha login propositalmente — gera SecurityEvent.LoginFailed
    const publicApi = await createApiContext();
    try {
      await publicApi.post('/api/auth/login', {
        data: { email: tenant.email, password: 'senha-errada-XYZ123' },
      });
    } finally {
      await publicApi.dispose();
    }

    const res = await authApi.get('/api/auth/security-events');
    await assertOk(res, 'GET security-events');
    const items = await unwrapList<SecurityEventItem>(res);
    const hasFailedLogin = items.some((e) =>
      (e.type ?? e.eventType ?? '').toLowerCase().includes('loginfailed'),
    );
    expect(
      hasFailedLogin,
      'apos login falho deve haver SecurityEvent com type LoginFailed (e nao qualquer evento)',
    ).toBe(true);
  });
});
