import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 11.1 — Email
 * Diagrama: docs/fluxos/negocio-11.1-email.mmd
 *
 * Email service (SES) tem 7 fluxos integrados (signup, invite, password-reset,
 * etc.). Verificação E2E completa exigiria mock SMTP. Smoke do endpoint de
 * logs de email (visíveis ao admin).
 */

test.describe('Fluxo 11.1 — Email', () => {
  test('@flow GET /api/email-logs responde sem 500', async ({ authApi }) => {
    const res = await authApi.get('/api/email-logs');
    expect(res.status()).toBeLessThan(500);
  });
});
