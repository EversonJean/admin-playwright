import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 12.2 — Relatórios
 * Diagrama: docs/fluxos/negocio-12.2-relatorios.mmd
 */

test.describe('Fluxo 12.2 — Relatórios', () => {
  test('@flow tela de relatórios financeiros carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/finance/reports');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test('@crud GET /api/reports/events com filtro de periodo responde', async ({ authApi }) => {
    const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const res = await authApi.get(`/api/reports/events?from=${from}&to=${to}`);
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.data ?? body).toBeTruthy();
  });
});
