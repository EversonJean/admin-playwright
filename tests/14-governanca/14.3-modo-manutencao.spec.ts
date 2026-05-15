import { test, expect } from '@playwright/test';

/**
 * Fluxo: 14.3 — Modo manutenção
 * Diagrama: docs/fluxos/negocio-14.3-modo-manutencao.mmd
 *
 * Modo manutenção é controlado pelo SuperAdmin globalmente; quando ativo,
 * o front exibe `/maintenance`. Smoke da rota pública (sem auth).
 */

test.describe('Fluxo 14.3 — Modo manutenção', () => {
  test('@flow rota /maintenance carrega', async ({ page }) => {
    const res = await page.goto('/maintenance');
    expect(res?.status() ?? 0).toBeLessThan(500);
    await expect(page).toHaveURL(/\/maintenance/);
  });
});
