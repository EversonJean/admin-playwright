import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { superAdminTest } from '../../fixtures/super-admin.fixture';
import { assertOk } from '../../helpers/response';

/**
 * Fluxos extras — telas residuais:
 * - trilha de envios de e-mail (painel do Super Admin)
 * - /app/tenant-closures (lista de solicitacoes de encerramento)
 *
 * Etapa 236 (PLANO-SEGURANCA §SEG-F item 7, E102): a trilha de e-mails eh
 * cross-tenant e saiu de `/api/email-logs` para `/api/super-admin/email-logs`,
 * para cair na restricao de rede do SuperAdmin. O tenant nao alcanca mais a rota
 * antiga (404) nem a nova (403 `EmailLogs.SuperAdminOnly`); o Super Admin le.
 */

test.describe('Email logs (Super Admin)', () => {
  test('@flow tenant: rota antiga /api/email-logs da 404 e a nova da 403', async ({ authApi }) => {
    const old = await authApi.get('/api/email-logs');
    expect(old.status(), 'rota antiga /api/email-logs').toBe(404);
    const res = await authApi.get('/api/super-admin/email-logs');
    expect(res.status(), 'tenant em /api/super-admin/email-logs').toBe(403);
  });

  superAdminTest('@flow Super Admin le /api/super-admin/email-logs', async ({ superAdminApi }) => {
    const res = await superAdminApi.get('/api/super-admin/email-logs');
    await assertOk(res, 'GET /api/super-admin/email-logs');
  });
});

test.describe('Tenant closure', () => {
  test('@flow GET /api/privacy/exports responde 200', async ({ authApi }) => {
    const res = await authApi.get('/api/privacy/exports');
    await assertOk(res, 'GET /api/privacy/exports');
  });
});
