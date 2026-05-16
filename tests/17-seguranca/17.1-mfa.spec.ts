import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 17.1 — MFA (TOTP + Email OTP + Backup codes)
 * Diagrama: docs/fluxos/negocio-17.1-mfa.mmd
 */

test.describe('Fluxo 17.1 — MFA', () => {
  test('@flow tela de segurança carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/security');
  });

  test('@flow tela de setup MFA carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/mfa');
  });

  test('@flow tela de setup MFA wizard carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/mfa/setup');
  });

  test('@crud GET /api/auth/mfa/status em tenant novo retorna enrolled=false', async ({
    authApi,
  }) => {
    const res = await authApi.get('/api/auth/mfa/status');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const status = body.data ?? body;
    expect(status.enrolled).toBe(false);
    expect(Array.isArray(status.methodsAvailable)).toBe(true);
  });

  test('@crud POST /api/auth/mfa/enroll devolve secret + otpAuthUri', async ({ authApi }) => {
    const res = await authApi.post('/api/auth/mfa/enroll');
    if (!res.ok()) {
      throw new Error(`enroll ${res.status()}: ${await res.text()}`);
    }
    const body = await res.json();
    const data = body.data ?? body;
    expect(data.secret, 'secret TOTP deve voltar').toBeTruthy();
    expect(data.otpAuthUri ?? data.uri, 'otpauth URI deve voltar').toBeTruthy();
    expect(data.otpAuthUri ?? data.uri).toMatch(/^otpauth:\/\//);
  });

  test('@crud verify com codigo invalido devolve 400/401', async ({ authApi }) => {
    // Enroll primeiro pra estar em "enrolling"
    await authApi.post('/api/auth/mfa/enroll');
    const r = await authApi.post('/api/auth/mfa/enroll/verify', {
      data: { code: '000000' },
    });
    expect([400, 401, 422]).toContain(r.status());
  });
});
