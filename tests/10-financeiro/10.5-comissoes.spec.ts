import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 10.5 — Comissões da equipe
 * Diagrama: docs/fluxos/negocio-10.5-comissoes.mmd
 *
 * Comissões são calculadas a partir das EventCollaborators e fechadas em
 * períodos. Smoke do endpoint /api/commissions.
 */

test.describe('Fluxo 10.5 — Comissões', () => {
  test('@flow GET /api/commissions responde sem 500', async ({ authApi }) => {
    const res = await authApi.get('/api/commissions');
    expect(res.status()).toBeLessThan(500);
  });
});
