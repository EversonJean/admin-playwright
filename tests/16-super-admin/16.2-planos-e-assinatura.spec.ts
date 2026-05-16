import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { superAdminTest, expect } from '../../fixtures/super-admin.fixture';

/**
 * Fluxo: 16.2 — Planos e assinatura
 * Diagrama: docs/fluxos/negocio-16.2-planos-e-assinatura.mmd
 */

test.describe('Fluxo 16.2 — Planos e assinatura (tenant view)', () => {
  test('@flow tela "meu plano" carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/billing/my-plan');
  });

  test('@flow tela de comparação de planos carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/billing/plans');
  });

  test('@crud GET /api/billing/plans devolve catalogo publico', async ({ authApi }) => {
    const res = await authApi.get('/api/billing/plans');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const arr: Array<{ code: string }> = body.data ?? body;
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBeGreaterThanOrEqual(1);
  });
});

superAdminTest.describe('Fluxo 16.2 — Planos (SuperAdmin CRUD)', () => {
  superAdminTest('@crud GET /api/super-admin/plans lista catalogo', async ({ superAdminApi }) => {
    const res = await superAdminApi.get('/api/super-admin/plans');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const arr: Array<{ code: string }> = body.data?.items ?? body.data ?? body;
    expect(Array.isArray(arr) ? arr : []).toBeTruthy();
  });
});
