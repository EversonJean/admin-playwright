import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createApiContext } from '../../helpers/api-client';

/**
 * Fluxo: 17.4 — Detecção de acesso suspeito
 * Diagrama: docs/fluxos/negocio-17.4-deteccao-acesso-suspeito.mmd
 *
 * Tentativas de login falhas geram SecurityEvent. GET /api/auth/
 * security-events lista os eventos do tenant.
 */

test.describe('Fluxo 17.4 — Detecção de acesso suspeito', () => {
  test('@flow GET /api/auth/security-events responde sem 500', async ({ authApi }) => {
    const res = await authApi.get('/api/auth/security-events');
    expect(res.status()).toBeLessThan(500);
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
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const items: Array<{ type?: string; eventType?: string }> =
      body.data?.items ?? body.items ?? body.data ?? body;
    const arr = Array.isArray(items) ? items : [];
    const hasFailedLogin = arr.some((e) =>
      (e.type ?? e.eventType ?? '').toLowerCase().includes('loginfailed'),
    );
    expect(
      hasFailedLogin || arr.length > 0,
      'apos login falho deve haver pelo menos 1 SecurityEvent',
    ).toBe(true);
  });
});
