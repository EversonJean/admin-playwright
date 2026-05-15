import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 1.3 — Convidar equipe interna
 * Diagrama: docs/fluxos/negocio-1.3-convidar-equipe-interna.mmd
 * Especificação: docs/FUNCIONALIDADES-NEGOCIO.md §1.3
 */

test.describe('Fluxo 1.3 — Convidar equipe interna', () => {
  test('@flow tela de invites carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/users/invites');
  });

  test('@flow chamar endpoint de invites autenticado não retorna 500', async ({ authApi }) => {
    const res = await authApi.get('/api/invitations');
    expect(res.status()).toBeLessThan(500);
  });
});
