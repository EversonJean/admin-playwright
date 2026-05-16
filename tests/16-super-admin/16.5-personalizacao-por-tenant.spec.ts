import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { assertOk, readJson } from '../../helpers/response';

/**
 * Fluxo: 16.5 — Personalização por tenant (tema/branding)
 * Diagrama: docs/fluxos/negocio-16.5-personalizacao-por-tenant.mmd
 *
 * Cada test usa tenant fresh do fixture `authTest`, entao mudancas de
 * tema nao vazam pra outros specs. Mesmo assim usamos finally pra
 * restaurar como boa pratica e suportar futuras mudancas de escopo da
 * fixture.
 */

const ORIGINAL_THEME = {
  primaryColor: null,
  secondaryColor: null,
  loginTitle: null,
};

test.describe('Fluxo 16.5 — Personalização por tenant', () => {
  test('@flow tela de tema carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/theme');
  });

  test('@crud PUT /api/settings/theme persiste cores e LoginTitle', async ({ authApi }) => {
    try {
      const upsert = await authApi.put('/api/settings/theme', {
        data: {
          primaryColor: '#FF5500',
          secondaryColor: '#0055FF',
          loginTitle: 'Bem-vindo E2E',
        },
      });
      await assertOk(upsert, 'PUT theme');

      const get = await authApi.get('/api/settings/theme');
      await assertOk(get, 'GET theme');
      const theme = await readJson<{
        primaryColor: string;
        secondaryColor: string;
        loginTitle: string;
      }>(get);
      expect(theme.primaryColor).toBe('#FF5500');
      expect(theme.secondaryColor).toBe('#0055FF');
      expect(theme.loginTitle).toBe('Bem-vindo E2E');
    } finally {
      // Restaura defaults — defesa em profundidade caso fixture mude.
      await authApi.put('/api/settings/theme', { data: ORIGINAL_THEME });
    }
  });
});
