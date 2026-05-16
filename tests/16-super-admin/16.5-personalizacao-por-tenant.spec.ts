import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 16.5 — Personalização por tenant (tema/branding)
 * Diagrama: docs/fluxos/negocio-16.5-personalizacao-por-tenant.mmd
 */

test.describe('Fluxo 16.5 — Personalização por tenant', () => {
  test('@flow tela de tema carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/theme');
  });

  test('@crud PUT /api/settings/theme persiste cores e LoginTitle', async ({ authApi }) => {
    const upsert = await authApi.put('/api/settings/theme', {
      data: {
        primaryColor: '#FF5500',
        secondaryColor: '#0055FF',
        loginTitle: 'Bem-vindo E2E',
      },
    });
    if (!upsert.ok()) {
      throw new Error(`PUT theme ${upsert.status()}: ${await upsert.text()}`);
    }

    const get = await authApi.get('/api/settings/theme');
    expect(get.ok()).toBe(true);
    const theme = (await get.json()).data ?? (await get.json());
    expect(theme.primaryColor).toBe('#FF5500');
    expect(theme.secondaryColor).toBe('#0055FF');
    expect(theme.loginTitle).toBe('Bem-vindo E2E');
  });
});
