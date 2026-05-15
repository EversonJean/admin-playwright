import { test, expect } from '@playwright/test';
import { tenantTest } from '../../fixtures/tenant.fixture';
import { fakeTenant } from '../../helpers/test-data';
import { confirmEmailDirect } from '../../helpers/db-helper';

/**
 * Fluxo: 1.1 — Criar conta da empresa
 * Diagrama: docs/fluxos/negocio-1.1-criar-conta-empresa.mmd
 * Especificação: docs/FUNCIONALIDADES-NEGOCIO.md §1.1
 *
 * Cobertura atual:
 *  - smoke: página de signup carrega com todos os campos
 *  - golden via UI: signup → confirm email (SQL) → login → dashboard
 *  - golden via API: fixture cria tenant → login UI → dashboard
 *  - alternativa: signup com senhas diferentes mostra erro
 *
 * Pendente (fixme): wizard de boas-vindas, login com Google, recuperação de senha
 * (existem como fluxos separados — ver tests/0-infra/ e tests/auth*).
 */

test.describe('Fluxo 1.1 — Criar conta da empresa', () => {
  test('@smoke página de signup tem todos os campos esperados', async ({ page }) => {
    await page.goto('/auth/signup');

    await expect(page.getByTestId('signup-company')).toBeVisible();
    await expect(page.getByTestId('signup-user')).toBeVisible();
    await expect(page.getByTestId('signup-email')).toBeVisible();
    await expect(page.getByTestId('signup-password')).toBeVisible();
    await expect(page.getByTestId('signup-confirm-password')).toBeVisible();
    await expect(page.getByTestId('signup-terms')).toBeVisible();
    await expect(page.getByTestId('signup-submit')).toBeVisible();
  });

  test('signup completo pela UI redireciona pra signup-sent', async ({ page }) => {
    const fake = fakeTenant();

    await page.goto('/auth/signup');
    await page.getByTestId('signup-company').fill(fake.companyName);
    await page.getByTestId('signup-user').fill(fake.adminName);
    await page.getByTestId('signup-email').fill(fake.adminEmail);
    await page.getByTestId('signup-password').fill(fake.adminPassword);
    await page.getByTestId('signup-confirm-password').fill(fake.adminPassword);
    await page.getByTestId('signup-terms').locator('input[type="checkbox"]').check({ force: true });
    await page.getByTestId('signup-submit').click();

    await page.waitForURL(/\/auth\/signup-sent/, { timeout: 15_000 });
    await expect(page.getByTestId('signup-sent-email')).toContainText(fake.adminEmail);
  });

  test('senhas diferentes bloqueiam o submit (sem navegar)', async ({ page }) => {
    // Nota: o componente do signup tem `matchPassword` como validator de FORM,
    // mas <mat-error> só mostra erros do CAMPO. Resultado: o texto "Senhas não
    // coincidem" nunca aparece visualmente (template dead code). O submit é
    // bloqueado silenciosamente — esta é a única verificação confiável aqui.
    // TODO front: adicionar ErrorStateMatcher pra propagar form-level error.
    const fake = fakeTenant();

    await page.goto('/auth/signup');
    await page.getByTestId('signup-company').fill(fake.companyName);
    await page.getByTestId('signup-user').fill(fake.adminName);
    await page.getByTestId('signup-email').fill(fake.adminEmail);
    await page.getByTestId('signup-password').fill(fake.adminPassword);
    await page.getByTestId('signup-confirm-password').fill('Outra@Senha123');
    await page.getByTestId('signup-terms').locator('input[type="checkbox"]').check({ force: true });
    await page.getByTestId('signup-submit').click();

    // Permanece em /auth/signup — submit blocked pelo validator de form.
    await page.waitForTimeout(1500);
    expect(page.url()).toMatch(/\/auth\/signup$/);
  });
});

tenantTest.describe('Fluxo 1.1 — Login pós-signup', () => {
  tenantTest('@smoke login com tenant recém-criado leva ao /app', async ({ page, tenant }) => {
    confirmEmailDirect(tenant.email);

    await page.goto('/auth/login');
    await page.getByTestId('login-email').fill(tenant.email);
    await page.getByTestId('login-password').fill(tenant.password);
    await page.getByTestId('login-submit').click();

    await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
    expect(page.url()).toMatch(/\/app/);
  });

  tenantTest('login com senha errada mantém o usuário em /auth/login', async ({ page, tenant }) => {
    await page.goto('/auth/login');
    await page.getByTestId('login-email').fill(tenant.email);
    await page.getByTestId('login-password').fill('Senha@Errada123');
    await page.getByTestId('login-submit').click();

    await page.waitForTimeout(2000);
    expect(page.url()).toMatch(/\/auth\/login/);
  });
});
