import { test as base, expect } from '@playwright/test';
import { authTest } from '../../fixtures/auth.fixture';
import { superAdminTest } from '../../fixtures/super-admin.fixture';
import { assertOk } from '../../helpers/response';
import { createApiContext } from '../../helpers/api-client';
import { fakeTenant } from '../../helpers/test-data';
import { fakeEmail } from '../../helpers/fake-providers';

/**
 * Fluxo: 11.1 — Email
 * Diagrama: docs/fluxos/negocio-11.1-email.mmd
 *
 * Em E2E o back usa `Email:Provider=Http` apontando pra fake-providers/
 * email (porta 1513). Toda chamada de IEmailService.SendAsync vira POST
 * HTTP real /send no fake — o fake guarda em memoria e specs consultam
 * via /_control/emails (helper fakeEmail.emails).
 *
 * Isso exercita o caminho Bearer auth + serializacao JSON + HttpClient
 * factory (em vez do logging interno do back).
 */

base.describe('Fluxo 11.1 — Email', () => {
  // Etapa 236 (PLANO-SEGURANCA §SEG-F item 7, E102): a trilha de envios saiu de
  // `/api/email-logs` para `/api/super-admin/email-logs`. O tenant nao alcanca
  // mais a rota antiga (404) nem a nova (403); o Super Admin le a nova.
  authTest(
    '@flow trilha de e-mails: tenant toma 404 na rota antiga e 403 na nova',
    async ({ authApi }) => {
      const old = await authApi.get('/api/email-logs');
      expect(old.status(), 'rota antiga /api/email-logs').toBe(404);
      const res = await authApi.get('/api/super-admin/email-logs');
      expect(res.status(), 'tenant em /api/super-admin/email-logs').toBe(403);
    },
  );

  superAdminTest(
    '@flow trilha de e-mails: Super Admin le /api/super-admin/email-logs',
    async ({ superAdminApi }) => {
      const res = await superAdminApi.get('/api/super-admin/email-logs');
      await assertOk(res, 'GET /api/super-admin/email-logs');
    },
  );

  base('@flow signup faz HTTP real pro fake email com Bearer e subject de verificacao', async () => {
    const since = new Date().toISOString();
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

    // Fake recebeu o POST /send com Bearer do back
    const inbox = await fakeEmail.inbox({ since });
    const sendCalls = inbox.filter((e) => e.path === '/send' && e.method === 'POST');
    expect(sendCalls.length, 'fake deve receber POST /send do back').toBeGreaterThanOrEqual(1);
    const authHeader = sendCalls[0]!.headers['authorization'];
    const authStr = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    expect(authStr, 'back deve mandar Bearer da ApiKey').toMatch(/^Bearer\s+/);

    // Email parseado do fake — destinatario e subject batem
    const emails = await fakeEmail.emails({ to: fake.adminEmail });
    const verification = emails.find((e) => e.to.toLowerCase() === fake.adminEmail.toLowerCase());
    expect(verification, 'fake email deve ter capturado verificacao').toBeTruthy();
    expect(verification!.subject.toLowerCase()).toMatch(/verifica|confirm|bem.vindo/);
  });

  authTest('@flow forgot-password faz HTTP real pro fake email', async ({ api, tenant }) => {
    const since = new Date().toISOString();
    const res = await api.post('/api/auth/forgot-password', {
      data: { email: tenant.email },
    });
    expect(res.ok()).toBe(true);

    // Tenant ja recebeu email de verificacao no signup; aqui o forgot-password
    // dispara outro. Filtra pelo subject pra pegar o reset especificamente
    // (signup tem "verifica/confirm", reset tem "senha/reset/recuper").
    const emails = await fakeEmail.emails({ to: tenant.email });
    const reset = emails
      .filter((e) => e.to.toLowerCase() === tenant.email.toLowerCase())
      .find((e) => /senha|reset|recuper/i.test(e.subject));
    expect(reset, 'fake email deve ter capturado reset de senha').toBeTruthy();
    // Sanity: inbox HTTP do fake tambem registra
    const inbox = await fakeEmail.inbox({ since });
    expect(inbox.some((e) => e.path === '/send')).toBe(true);
  });
});
