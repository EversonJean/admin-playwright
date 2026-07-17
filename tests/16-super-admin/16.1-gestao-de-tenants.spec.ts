import { test as base, expect as baseExpect } from '@playwright/test';
import { superAdminTest, expect } from '../../fixtures/super-admin.fixture';

/**
 * Fluxo: 16.1 — Gestão de tenants (SuperAdmin)
 * Diagrama: docs/fluxos/negocio-16.1-gestao-de-tenants.mmd
 */

// O painel Super Admin é um app/origem próprios desde SEPARACAO-SUPER-ADMIN.md
// (dev: porta 4201). Navegações do painel usam URL absoluta — o baseURL do
// Playwright aponta pro app tenant.
const SUPER_ADMIN_URL = process.env.SUPER_ADMIN_URL ?? 'http://localhost:4201';

base.describe('Fluxo 16.1 — Gestão de tenants (SuperAdmin)', () => {
  base('@flow painel: rota /super-admin redireciona anônimo pra login', async ({ page }) => {
    await page.goto(`${SUPER_ADMIN_URL}/super-admin`);
    await baseExpect(page).toHaveURL(/\/auth\/login/);
  });

  base('@flow app tenant não hospeda mais o painel (/super-admin → 404)', async ({ page }) => {
    await page.goto('/super-admin');
    // Rota removida do app tenant — cai no wildcard NotFound, sem redirect
    // pra login (não é rota protegida; simplesmente não existe).
    await baseExpect(page).not.toHaveURL(/\/auth\/login/);
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
