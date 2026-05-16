import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxos extras — telas residuais do tenant:
 * - /app/email-logs (viewer de email logs por tenant)
 * - /app/tenant-closures (lista de solicitacoes de encerramento)
 *
 * Email logs eh recurso do tenant (nao SuperAdmin) via GET /api/email-logs.
 * TenantClosure eh acionado por GET /api/privacy/tenant-closures (lista).
 */

test.describe('Email logs (tenant)', () => {
  test('@crud GET /api/email-logs responde 200 ou 403 (entitlement)', async ({ authApi }) => {
    const res = await authApi.get('/api/email-logs');
    // Pode ser 200 (admin tem permission) ou 403 (sem permission especifica)
    expect([200, 403], `status: ${res.status()}`).toContain(res.status());
  });
});

test.describe('Tenant closure', () => {
  test('@crud GET /api/privacy/exports responde', async ({ authApi }) => {
    // tenant-closures aparece em /privacy/exports filtrado; aqui smoke do
    // endpoint base que serve a tela /app/tenant-closures
    const res = await authApi.get('/api/privacy/exports');
    expect(res.ok()).toBe(true);
  });
});
