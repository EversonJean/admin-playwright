import { expect } from '@playwright/test';
import { authTest } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Settings residuais — link-google + endpoint negativo.
 *
 * NOTA: /app/availability era falso positivo (rota nao existe no
 * tenant-app.routes; pertence ao portal do colaborador). Removida.
 */

authTest.describe('Settings residuais (smoke)', () => {
  authTest('@flow /app/settings/link-google carrega autenticado', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/link-google');
  });

  authTest('@flow POST /api/auth/link-google sem token devolve 4xx', async ({ authApi }) => {
    const res = await authApi.post('/api/auth/link-google', {
      data: { idToken: '' },
    });
    expect([400, 401, 422]).toContain(res.status());
  });
});
