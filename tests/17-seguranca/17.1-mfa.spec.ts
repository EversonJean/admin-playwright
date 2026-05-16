import { generateSync } from 'otplib';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 17.1 — MFA (TOTP + Email OTP + Backup codes)
 * Diagrama: docs/fluxos/negocio-17.1-mfa.mmd
 *
 * TOTP completo: enroll devolve secret -> otplib gera codigo valido a
 * partir do mesmo secret -> verify aceita -> status passa pra enrolled.
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
    await authApi.post('/api/auth/mfa/enroll');
    const r = await authApi.post('/api/auth/mfa/enroll/verify', {
      data: { code: '000000' },
    });
    expect([400, 401, 422]).toContain(r.status());
  });

  test('@crud TOTP enroll -> verify com codigo valido (otplib) -> status enrolled', async ({
    authApi,
  }) => {
    const enrollRes = await authApi.post('/api/auth/mfa/enroll');
    if (!enrollRes.ok()) {
      throw new Error(`enroll ${enrollRes.status()}: ${await enrollRes.text()}`);
    }
    const enroll = (await enrollRes.json()).data ?? (await enrollRes.json());
    const secret: string = enroll.secret;
    expect(secret).toBeTruthy();

    // Gera codigo TOTP a partir do MESMO secret usando otplib
    // (compativel com Authenticator do Google/Authy — RFC 6238, 30s step).
    const code = generateSync({ secret, strategy: 'totp' });
    expect(code).toMatch(/^\d{6}$/);

    const verifyRes = await authApi.post('/api/auth/mfa/enroll/verify', {
      data: { code },
    });
    if (!verifyRes.ok()) {
      throw new Error(`verify ${verifyRes.status()}: ${await verifyRes.text()}`);
    }
    const verify = (await verifyRes.json()).data ?? (await verifyRes.json());
    // BackupCodesResponseDto: { codes: string[] }
    expect(verify.codes, 'verify deve devolver backup codes').toBeTruthy();
    expect(Array.isArray(verify.codes)).toBe(true);
    expect(verify.codes.length).toBeGreaterThan(0);

    const status = (await (await authApi.get('/api/auth/mfa/status')).json()).data;
    expect(status.enrolled, 'apos verify, status.enrolled=true').toBe(true);
    expect(status.hasBackupCodes).toBe(true);
    expect(status.remainingBackupCodes).toBeGreaterThan(0);
  });
});
