import { Page } from '@playwright/test';

/**
 * Faz login pela UI (não via API) — útil quando o teste precisa validar
 * o fluxo de login em si, ou quando o cookie/storage do navegador é
 * relevante pro fluxo.
 *
 * Para reusar autenticação em vários testes sem fazer login toda vez,
 * a evolução natural é gerar `storageState` no global setup.
 */
export async function loginViaUi(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.goto('/auth/login');
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(password);
  await page.getByRole('button', { name: /entrar|login/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}
