import { test as base, expect as baseExpect } from '@playwright/test';
import { superAdminTest, expect } from '../../fixtures/super-admin.fixture';

/**
 * Fluxo: 16.1 — Gestão de tenants (SuperAdmin)
 * Diagrama: docs/fluxos/negocio-16.1-gestao-de-tenants.mmd
 */

base.describe('Fluxo 16.1 — Gestão de tenants (SuperAdmin)', () => {
  base('@flow rota /super-admin redireciona anônimo pra login', async ({ page }) => {
    await page.goto('/super-admin');
    await baseExpect(page).toHaveURL(/\/auth\/login/);
  });
});

superAdminTest.describe('Fluxo 16.1 — Gestão de tenants (SuperAdmin)', () => {
  superAdminTest('@crud GET /api/super-admin/tenants lista tenants', async ({ superAdminApi }) => {
    const res = await superAdminApi.get('/api/super-admin/tenants');
    if (!res.ok()) {
      throw new Error(`GET tenants ${res.status()}: ${await res.text()}`);
    }
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const items: Array<{ id: string; companyName?: string }> =
      body.data?.items ?? body.items ?? body.data ?? body;
    const arr = Array.isArray(items) ? items : [];
    expect(arr.length, 'pelo menos 1 tenant deve aparecer').toBeGreaterThan(0);
  });

  superAdminTest('@crud GET tenant by id devolve detalhes', async ({ superAdminApi }) => {
    const listRes = await superAdminApi.get('/api/super-admin/tenants');
    const list = await listRes.json();
    const arr: Array<{ id: string }> = list.data?.items ?? list.items ?? list.data ?? list;
    const firstId = (Array.isArray(arr) ? arr : [])[0]?.id;
    expect(firstId).toBeTruthy();
    const res = await superAdminApi.get(`/api/super-admin/tenants/${firstId}`);
    expect(res.ok()).toBe(true);
    const detail = (await res.json()).data ?? (await res.json());
    expect(detail.id).toBe(firstId);
  });
});
