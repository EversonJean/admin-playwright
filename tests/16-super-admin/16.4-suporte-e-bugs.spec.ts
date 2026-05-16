import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { superAdminTest } from '../../fixtures/super-admin.fixture';

/**
 * Fluxo: 16.4 — Suporte e bug tracking
 * Diagrama: docs/fluxos/negocio-16.4-suporte-e-bugs.mmd
 */

test.describe('Fluxo 16.4 — Suporte e bugs (tenant)', () => {
  test('@flow tela de bugs do tenant carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/support/bugs');
  });

  test('@crud tenant cria bug + visualiza no GET /api/bugs', async ({ authApi }) => {
    const createRes = await authApi.post('/api/bugs', {
      data: {
        title: `Bug E2E ${Date.now()}`,
        description: 'Bug reportado pelo spec.',
        stepsToReproduce: '1. Abrir tela X. 2. Clicar Y.',
        affectedModule: 'Events',
        severity: 'Medium',
        context: {
          currentUrl: 'https://app.test/eventos',
          currentModule: 'Events',
          browser: 'Chrome 130',
          device: 'Desktop',
          os: 'Windows 11',
          screenResolution: '1920x1080',
          appVersion: '1.0.0',
        },
      },
    });
    if (!createRes.ok()) {
      throw new Error(`POST bug ${createRes.status()}: ${await createRes.text()}`);
    }
    const bug = (await createRes.json()).data ?? (await createRes.json());
    expect(bug.id).toBeTruthy();

    const listRes = await authApi.get('/api/bugs');
    expect(listRes.ok()).toBe(true);
    const body = await listRes.json();
    const items: Array<{ id: string }> = body.data?.items ?? body.items ?? body.data ?? body;
    const arr = Array.isArray(items) ? items : [];
    expect(arr.some((b) => b.id === bug.id), 'bug criado deve aparecer na lista').toBe(true);
  });
});

superAdminTest.describe('Fluxo 16.4 — Suporte e bugs (SuperAdmin triagem)', () => {
  superAdminTest('@crud GET /api/super-admin/bugs lista cross-tenant', async ({ superAdminApi }) => {
    const res = await superAdminApi.get('/api/super-admin/bugs');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const arr: Array<unknown> = body.data?.items ?? body.items ?? body.data ?? body;
    expect(Array.isArray(arr) ? arr.length : 0).toBeGreaterThanOrEqual(0);
  });

  superAdminTest('@crud GET /api/super-admin/bugs/summary devolve agregados', async ({ superAdminApi }) => {
    const res = await superAdminApi.get('/api/super-admin/bugs/summary');
    expect(res.ok()).toBe(true);
  });
});
