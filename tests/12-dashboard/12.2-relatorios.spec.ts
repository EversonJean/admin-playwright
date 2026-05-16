import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { assertOk, readJson } from '../../helpers/response';

/**
 * Fluxo: 12.2 — Relatórios
 * Diagrama: docs/fluxos/negocio-12.2-relatorios.mmd
 */

test.describe('Fluxo 12.2 — Relatórios', () => {
  test('@flow tela de relatórios financeiros carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/finance/reports');
  });

  test('@flow GET /api/reports/events com filtro de periodo responde 200', async ({ authApi }) => {
    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const res = await authApi.get(`/api/reports/events?from=${from}&to=${to}`);
    await assertOk(res, 'GET /api/reports/events');
    const data = await readJson<Record<string, unknown>>(res);
    expect(typeof data).toBe('object');
    expect(data).not.toBeNull();
  });
});
