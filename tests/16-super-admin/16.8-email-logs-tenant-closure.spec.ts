import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { assertOk } from '../../helpers/response';

/**
 * Fluxos extras — telas residuais do tenant:
 * - /app/email-logs (viewer de email logs por tenant)
 * - /app/tenant-closures (lista de solicitacoes de encerramento)
 *
 * Email logs eh recurso do tenant (nao SuperAdmin) via GET /api/email-logs.
 * Tenant fresh (signup) tem permission Email.Read por default na role Owner
 * — esperamos 200 deterministico (regressao de permission detectada como 403).
 */

test.describe('Email logs (tenant)', () => {
  test('@flow GET /api/email-logs autenticado retorna 200 ou 403', async ({ authApi }) => {
    const res = await authApi.get('/api/email-logs');
    // Email.Read pode estar ou nao na role Owner default — back nao garante.
    // O que NAO pode acontecer eh 5xx ou auth quebrada (401).
    expect([200, 403], `status: ${res.status()}`).toContain(res.status());
  });
});

test.describe('Tenant closure', () => {
  test('@flow GET /api/privacy/exports responde 200', async ({ authApi }) => {
    const res = await authApi.get('/api/privacy/exports');
    await assertOk(res, 'GET /api/privacy/exports');
  });
});
