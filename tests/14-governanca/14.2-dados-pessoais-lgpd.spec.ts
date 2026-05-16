import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 14.2 — Dados pessoais (LGPD)
 * Diagrama: docs/fluxos/negocio-14.2-dados-pessoais-lgpd.mmd
 */

test.describe('Fluxo 14.2 — Dados pessoais (LGPD)', () => {
  test('@flow tela de privacidade carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/privacy');
  });

  test('@crud POST /api/privacy/export-user-data registra solicitacao', async ({ authApi }) => {
    const res = await authApi.post('/api/privacy/export-user-data', { data: {} });
    if (!res.ok()) {
      throw new Error(`POST export-user-data ${res.status()}: ${await res.text()}`);
    }
    const created = (await res.json()).data ?? (await res.json());
    expect(created.id ?? created.exportId, 'export deve devolver id').toBeTruthy();

    const listRes = await authApi.get('/api/privacy/exports');
    expect(listRes.ok()).toBe(true);
    const body = await listRes.json();
    const items: Array<{ id?: string }> =
      body.data?.items ?? body.items ?? body.data ?? body;
    const arr = Array.isArray(items) ? items : [];
    expect(arr.length, 'solicitacao deve aparecer na lista').toBeGreaterThanOrEqual(1);
  });
});
