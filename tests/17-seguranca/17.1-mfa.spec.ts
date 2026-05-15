import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 17.1 — MFA (TOTP + Email OTP + Backup codes)
 * Diagrama: docs/fluxos/negocio-17.1-mfa.mmd
 *
 * Setup MFA completo exige TOTP secret + código válido. Aqui smoke das
 * telas de configuração e segurança.
 *
 * TODO E2E: cobrir fluxo TOTP completo usando lib `otplib` no teste pra
 * gerar códigos válidos a partir do secret retornado pelo back.
 */

test.describe('Fluxo 17.1 — MFA', () => {
  test('@flow tela de segurança carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/security');
  });

  test('@flow tela de setup MFA carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/mfa');
  });
});
