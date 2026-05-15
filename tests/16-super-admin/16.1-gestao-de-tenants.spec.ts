import { test, expect } from '@playwright/test';

/**
 * Fluxo: 16.1 — Gestão de tenants (SuperAdmin)
 * Diagrama: docs/fluxos/negocio-16.1-gestao-de-tenants.mmd
 *
 * Área SuperAdmin requer usuário com role `SuperAdmin` (não criado pelo
 * signup público). Cobertura completa exige fixture própria de SuperAdmin.
 * Aqui smoke da rota pública (redirect pra login).
 *
 * TODO E2E: criar fixture `superAdminTest` que loga com seed SuperAdmin
 * global (`superadmin@dev.local`, criado no startup do back em Dev).
 */

test.describe('Fluxo 16.1 — Gestão de tenants (SuperAdmin)', () => {
  test('@flow rota /super-admin redireciona anônimo pra login', async ({ page }) => {
    await page.goto('/super-admin');
    await expect(page).toHaveURL(/\/auth\/login/);
  });
});
