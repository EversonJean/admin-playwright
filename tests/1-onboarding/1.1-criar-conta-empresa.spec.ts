import { test, expect } from '@playwright/test';
import { tenantTest } from '../../fixtures/tenant.fixture';
import { authTest } from '../../fixtures/auth.fixture';
import { fakeTenant } from '../../helpers/test-data';
import { confirmEmailDirect } from '../../helpers/db-helper';
import { createApiContext } from '../../helpers/api-client';

/**
 * Fluxo: 1.1 — Criar conta da empresa (ciclo de vida do usuário completo)
 * Diagrama: docs/fluxos/negocio-1.1-criar-conta-empresa.mmd
 * Especificação: docs/FUNCIONALIDADES-NEGOCIO.md §1.1
 *
 * Cobertura:
 *  - smoke: página de signup carrega
 *  - signup completo pela UI → signup-sent (sem confirmar email ainda)
 *  - verify-email via token devolvido em dev (signupPolicy.ExposeVerificationToken)
 *  - login com senha errada
 *  - login pós-signup leva ao /app
 *  - logout pela UI redireciona pra /auth/login
 *  - forgot-password + reset-password com token devolvido em dev
 *
 * Não coberto: login com Google (precisa OAuth real), magic link (precisa email real).
 */

test.describe('Fluxo 1.1 — Signup pela UI', () => {
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
    const fake = fakeTenant();

    await page.goto('/auth/signup');
    await page.getByTestId('signup-company').fill(fake.companyName);
    await page.getByTestId('signup-user').fill(fake.adminName);
    await page.getByTestId('signup-email').fill(fake.adminEmail);
    await page.getByTestId('signup-password').fill(fake.adminPassword);
    await page.getByTestId('signup-confirm-password').fill('Outra@Senha123');
    await page.getByTestId('signup-terms').locator('input[type="checkbox"]').check({ force: true });
    await page.getByTestId('signup-submit').click();

    await page.waitForTimeout(1500);
    expect(page.url()).toMatch(/\/auth\/signup$/);
  });

  test('@flow verify-email com token devolvido em dev marca user como Active e libera login', async () => {
    // Fluxo REAL (sem SQL hack): signup → token na response → POST verify-email → login OK
    const fake = fakeTenant();
    const api = await createApiContext();
    try {
      const signupRes = await api.post('/api/auth/signup', {
        data: {
          companyName: fake.companyName,
          userName: fake.adminName,
          email: fake.adminEmail,
          password: fake.adminPassword,
        },
      });
      expect(signupRes.ok()).toBe(true);
      const signupBody = await signupRes.json();
      const token = signupBody.data?.verificationToken ?? signupBody.verificationToken;
      expect(token).toBeTruthy();

      const verifyRes = await api.post('/api/auth/verify-email', { data: { token } });
      expect(verifyRes.ok()).toBe(true);

      const loginRes = await api.post('/api/auth/login', {
        data: { email: fake.adminEmail, password: fake.adminPassword },
      });
      expect(loginRes.ok()).toBe(true);
    } finally {
      await api.dispose();
    }
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

authTest.describe('Fluxo 1.1 — Logout', () => {
  authTest('@flow logout pela UI redireciona pra /auth/login', async ({ authPage }) => {
    await authPage.goto('/app');
    // user-chip é o botão que abre o menu (matMenuTriggerFor=userMenu); não tem testid próprio
    await authPage.locator('.user-chip').click();
    await authPage.getByTestId('user-menu-logout').click();
    await authPage.waitForURL(/\/auth\/login/, { timeout: 10_000 });
  });

  authTest('@flow logout via API invalida o refresh token', async ({ authApi, tenant }) => {
    const logoutRes = await authApi.post('/api/auth/logout', {
      data: { refreshToken: tenant.refreshToken },
    });
    expect(logoutRes.ok()).toBe(true);

    // Refresh com o mesmo token agora falha (token foi revogado)
    const refreshRes = await authApi.post('/api/auth/refresh', {
      data: { refreshToken: tenant.refreshToken },
    });
    expect(refreshRes.status()).toBeGreaterThanOrEqual(400);
  });
});

authTest.describe('Fluxo 1.1 — Recuperação de senha', () => {
  authTest('@flow forgot-password + reset com token devolvido em dev troca a senha', async ({ authPage, api, tenant }) => {
    // 1. Submete forgot pela UI (validação visual + back call)
    await authPage.goto('/auth/forgot-password');
    await authPage.getByTestId('forgot-email').fill(tenant.email);
    await authPage.getByTestId('forgot-submit').click();
    await authPage.waitForTimeout(1000);

    // 2. Pega o resetToken via API direto (em dev, response devolve)
    const forgotRes = await api.post('/api/auth/forgot-password', { data: { email: tenant.email } });
    expect(forgotRes.ok()).toBe(true);
    const forgotBody = await forgotRes.json();
    const resetToken = forgotBody.data?.resetToken ?? forgotBody.resetToken;
    expect(resetToken).toBeTruthy();

    // 3. Abre reset-password com o token e define nova senha pela UI
    const novaSenha = 'NovaSenha@2026';
    await authPage.goto(`/auth/reset-password?token=${resetToken}`);
    await authPage.getByTestId('reset-new-password').fill(novaSenha);
    await authPage.getByTestId('reset-confirm-password').fill(novaSenha);
    await authPage.getByTestId('reset-submit').click();

    // 4. Login com a senha NOVA via API confirma que o reset funcionou
    await authPage.waitForTimeout(2000);
    const loginRes = await api.post('/api/auth/login', {
      data: { email: tenant.email, password: novaSenha },
    });
    expect(loginRes.ok()).toBe(true);

    // 5. Login com a senha VELHA agora falha
    const oldLoginRes = await api.post('/api/auth/login', {
      data: { email: tenant.email, password: tenant.password },
    });
    expect(oldLoginRes.ok()).toBe(false);
  });
});
