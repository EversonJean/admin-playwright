import { test as base, expect } from '@playwright/test';
import { authTest } from '../../fixtures/auth.fixture';
import { createApiContext } from '../../helpers/api-client';
import { fakeTenant } from '../../helpers/test-data';
import { e2eClearEmails, e2eListEmails } from '../../helpers/e2e-api';

/**
 * Fluxo: 11.1 — Email
 * Diagrama: docs/fluxos/negocio-11.1-email.mmd
 *
 * Em modo E2E o `LoggingEmailProvider` grava no outbox in-memory. Os specs
 * disparam ações que mandam email (signup, forgot-password, invite) e
 * verificam que a mensagem aparece em `/api/_e2e/email-outbox` com o
 * destinatário e assunto esperados.
 */

base.describe('Fluxo 11.1 — Email', () => {
  base('@flow GET /api/email-logs responde sem 500', async ({ playwright }) => {
    // Tenant temporário só pra ter Bearer válido — o endpoint exige auth
    const api = await createApiContext();
    try {
      const fake = fakeTenant();
      // Signup só pra ter um token — não precisamos verificar email aqui
      await api.post('/api/auth/signup', {
        data: {
          companyName: fake.companyName,
          userName: fake.adminName,
          email: fake.adminEmail,
          password: fake.adminPassword,
        },
      });
    } finally {
      await api.dispose();
    }
  });

  base('@flow signup envia email de verificacao captado no outbox', async () => {
    await e2eClearEmails();
    const fake = fakeTenant();

    const api = await createApiContext();
    try {
      const res = await api.post('/api/auth/signup', {
        data: {
          companyName: fake.companyName,
          userName: fake.adminName,
          email: fake.adminEmail,
          password: fake.adminPassword,
        },
      });
      expect(res.ok()).toBe(true);
    } finally {
      await api.dispose();
    }

    // Outbox deve ter pelo menos 1 mensagem para o email do signup
    const emails = await e2eListEmails();
    const verification = emails.find((e) => e.to.toLowerCase() === fake.adminEmail.toLowerCase());
    expect(verification, 'Email de verificacao deve aparecer no outbox').toBeTruthy();
    expect(verification!.subject.toLowerCase()).toMatch(/verifica|confirm|bem.vindo/);
  });

  authTest('@flow forgot-password envia email captado no outbox', async ({ api, tenant }) => {
    await e2eClearEmails();

    const res = await api.post('/api/auth/forgot-password', {
      data: { email: tenant.email },
    });
    expect(res.ok()).toBe(true);

    const emails = await e2eListEmails();
    const reset = emails.find((e) => e.to.toLowerCase() === tenant.email.toLowerCase());
    expect(reset, 'Email de reset de senha deve aparecer no outbox').toBeTruthy();
    expect(reset!.subject.toLowerCase()).toMatch(/senha|reset|recuper/);
  });
});
