import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { apiCreateClient } from '../../helpers/api-entities';

/**
 * Fluxo: 14.1 — Auditoria
 * Diagrama: docs/fluxos/negocio-14.1-auditoria.mmd
 */

test.describe('Fluxo 14.1 — Auditoria', () => {
  test('@flow tela de audit logs carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/audit');
  });

  test('@crud cria client e audit log registra a operacao', async ({ authApi }) => {
    const cliente = await apiCreateClient(authApi);

    const res = await authApi.get('/api/audit-logs');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const items: Array<{
      entityType?: string;
      entityId?: string;
      action?: string;
    }> = body.data?.items ?? body.items ?? body.data ?? body;
    const arr = Array.isArray(items) ? items : [];
    const clientLog = arr.find(
      (l) => (l.entityType ?? '').toLowerCase().includes('client') && l.entityId === cliente.id,
    );
    expect(clientLog, 'POST /api/clients deve gerar audit log da entidade').toBeTruthy();
  });
});
