import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { superAdminTest, expect } from '../../fixtures/super-admin.fixture';
import { assertOk, readJson, unwrapList } from '../../helpers/response';

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

  test('@flow GET /api/billing/plans devolve catalogo publico', async ({ authApi }) => {
    const res = await authApi.get('/api/billing/plans');
    await assertOk(res, 'GET /api/billing/plans');
    const arr = await readJson<Array<{ code: string }>>(res);
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBeGreaterThanOrEqual(1);
    expect(arr[0]!.code).toBeTruthy();
  });
});

superAdminTest.describe('Fluxo 16.2 — Planos (SuperAdmin CRUD)', () => {
  superAdminTest('@flow GET /api/super-admin/plans lista catalogo', async ({ superAdminApi }) => {
    const res = await superAdminApi.get('/api/super-admin/plans');
    await assertOk(res, 'GET /api/super-admin/plans');
    const arr = await unwrapList<{ code: string }>(res);
    expect(arr.length, 'seed do back deve ter ao menos 1 plano').toBeGreaterThanOrEqual(1);
  });
});
