import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 11.3 — Notificações in-app
 * Diagrama: docs/fluxos/negocio-11.3-notificacoes-in-app.mmd
 *
 * Notifications in-app têm 5 triggers (parcela vencida, readiness crítico,
 * escalação recusada, evento próximo, low stock). Smoke do endpoint de
 * listagem.
 */

test.describe('Fluxo 11.3 — Notificações in-app', () => {
  test('@flow GET /api/notifications responde sem 500', async ({ authApi }) => {
    const res = await authApi.get('/api/notifications');
    expect(res.status()).toBeLessThan(500);
  });
});
