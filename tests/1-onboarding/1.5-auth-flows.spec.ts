import { test, expect } from '@playwright/test';
import { createApiContext } from '../../helpers/api-client';
import { fakeTenant } from '../../helpers/test-data';
import { confirmEmailDirect } from '../../helpers/db-helper';

/**
 * Fluxos adicionais de Auth (UI tem rotas /forgot-password, /reset-password,
 * /verify-email, /magic-link, /magic-link/consume).
 *
 * Em E2E o back expoe tokens nos payloads:
 *   - Signup.ExposeVerificationToken=true
 *   - PasswordReset.ExposeToken=true
 *
 * Aqui testamos os endpoints API end-to-end com extracao de token + reuso.
 */

test.describe('Auth flows extras (API)', () => {
  test('@crud signup -> verify-email com token devolve User Active', async () => {
    const api = await createApiContext();
    try {
      const fake = fakeTenant();
      const signupRes = await api.post('/api/auth/signup', {
        data: {
          companyName: fake.companyName,
          userName: fake.adminName,
          email: fake.adminEmail,
          password: fake.adminPassword,
        },
      });
      if (!signupRes.ok()) {
        throw new Error(`signup ${signupRes.status()}: ${await signupRes.text()}`);
      }
      const signupBody = await signupRes.json();
      const verToken = signupBody.data?.verificationToken ?? signupBody.verificationToken;
      expect(verToken, 'E2E deve expor verificationToken').toBeTruthy();

      const verRes = await api.post('/api/auth/verify-email', {
        data: { token: verToken },
      });
      expect(verRes.ok()).toBe(true);

      // Apos verify, login funciona
      const loginRes = await api.post('/api/auth/login', {
        data: { email: fake.adminEmail, password: fake.adminPassword },
      });
      expect(loginRes.ok()).toBe(true);
    } finally {
      await api.dispose();
    }
  });

  test('@crud forgot-password retorna token + reset-password troca senha', async () => {
    const api = await createApiContext();
    try {
      const fake = fakeTenant();
      // Pre-cond: usuario existir e ativo
      await api.post('/api/auth/signup', {
        data: {
          companyName: fake.companyName,
          userName: fake.adminName,
          email: fake.adminEmail,
          password: fake.adminPassword,
        },
      });
      confirmEmailDirect(fake.adminEmail);

      const forgotRes = await api.post('/api/auth/forgot-password', {
        data: { email: fake.adminEmail },
      });
      expect(forgotRes.ok()).toBe(true);
      const forgotBody = await forgotRes.json();
      const resetToken = forgotBody.data?.resetToken ?? forgotBody.resetToken;
      expect(resetToken, 'E2E deve expor resetToken').toBeTruthy();

      const newPassword = 'NovaSenha@2026';
      const resetRes = await api.post('/api/auth/reset-password', {
        data: { token: resetToken, newPassword },
      });
      expect(resetRes.ok()).toBe(true);

      // Login com senha NOVA funciona
      const loginNewRes = await api.post('/api/auth/login', {
        data: { email: fake.adminEmail, password: newPassword },
      });
      expect(loginNewRes.ok()).toBe(true);

      // Login com senha antiga falha
      const loginOldRes = await api.post('/api/auth/login', {
        data: { email: fake.adminEmail, password: fake.adminPassword },
      });
      expect(loginOldRes.ok()).toBe(false);
    } finally {
      await api.dispose();
    }
  });

  test('@flow magic-link request responde 200 e nao vaza se email existe', async () => {
    const api = await createApiContext();
    try {
      const r = await api.post('/api/auth/magic-link', {
        data: { email: 'inexistente-XYZ@e2e.test' },
      });
      // Resposta deve ser 200 (anti-enumeration)
      expect(r.ok()).toBe(true);
    } finally {
      await api.dispose();
    }
  });

  test('@flow reset-password com token invalido devolve 400/401', async () => {
    const api = await createApiContext();
    try {
      const r = await api.post('/api/auth/reset-password', {
        data: { token: 'token-fake-12345', newPassword: 'Qualquer@123' },
      });
      expect([400, 401, 422]).toContain(r.status());
    } finally {
      await api.dispose();
    }
  });

  test('@flow /forgot-password page carrega sem auth', async ({ page }) => {
    const res = await page.goto('/auth/forgot-password');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test('@flow /reset-password page carrega sem auth', async ({ page }) => {
    const res = await page.goto('/auth/reset-password?token=fake');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test('@flow /verify-email page carrega sem auth', async ({ page }) => {
    const res = await page.goto('/auth/verify-email?token=fake');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test('@flow /magic-link page carrega sem auth', async ({ page }) => {
    const res = await page.goto('/auth/magic-link');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });
});
