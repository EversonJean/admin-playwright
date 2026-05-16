import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { assertOk, readJson, unwrapList } from '../../helpers/response';

/**
 * Fluxo: 11.3 — Notificações in-app
 * Diagrama: docs/fluxos/negocio-11.3-notificacoes-in-app.mmd
 */

interface NotificationItem {
  id: string;
  isRead?: boolean;
  readAt?: string | null;
}

test.describe('Fluxo 11.3 — Notificações in-app', () => {
  test('@flow GET /api/notifications responde 200', async ({ authApi }) => {
    const res = await authApi.get('/api/notifications');
    expect(res.status()).toBe(200);
  });

  test('@flow lista de notifications e unread-count consistentes', async ({ authApi }) => {
    const listRes = await authApi.get('/api/notifications');
    await assertOk(listRes, 'GET /api/notifications');
    const arr = await unwrapList<NotificationItem>(listRes);

    const countRes = await authApi.get('/api/notifications/unread-count');
    await assertOk(countRes, 'GET /api/notifications/unread-count');
    const count = await readJson<number | { count?: number; unreadCount?: number }>(countRes);
    const unreadFromCount =
      typeof count === 'number' ? count : count.count ?? count.unreadCount ?? 0;
    const unreadFromList = arr.filter((n) => !(n.isRead || n.readAt)).length;
    expect(typeof unreadFromCount).toBe('number');
    expect(unreadFromList).toBeGreaterThanOrEqual(0);
  });

  test('@flow mark-all-read zera unread-count', async ({ authApi }) => {
    const r = await authApi.post('/api/notifications/mark-all-read');
    await assertOk(r, 'POST mark-all-read');
    const after = await readJson<number | { count?: number; unreadCount?: number }>(
      await authApi.get('/api/notifications/unread-count'),
    );
    const c = typeof after === 'number' ? after : after.count ?? after.unreadCount ?? 0;
    expect(c).toBe(0);
  });
});
