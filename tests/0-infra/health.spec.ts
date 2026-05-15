import { test, expect } from '@playwright/test';
import { isBackendHealthy } from '../../helpers/api-client';

/**
 * Smoke test de infraestrutura — valida que back e front estão respondendo.
 * Não depende de tenant ou banco populado.
 *
 * Se este teste falhar, NADA depois disso vai funcionar — investigue stack
 * antes de mexer em qualquer outro teste.
 */
test.describe('Infra — back e front respondendo', () => {
  test('@smoke backend /health retorna 200', async () => {
    const ok = await isBackendHealthy();
    expect(ok).toBe(true);
  });

  test('@smoke frontend serve a página raiz', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBeLessThan(400);
    await expect(page).toHaveTitle(/.+/);
  });

  test('@smoke frontend redireciona pra /auth/login quando anônimo', async ({ page }) => {
    await page.goto('/app');
    await expect(page).toHaveURL(/\/auth\/login/);
  });
});
