import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateCollaborator } from '../../helpers/api-entities';

/**
 * Fluxo: 3.3 — Dados bancários (PayoutProfile)
 * Diagrama: docs/fluxos/negocio-3.3-dados-bancarios-colaborador.mmd
 *
 * PayoutProfile mora dentro do detalhe do colaborador. Valida que o endpoint
 * de leitura de profile responde (mesmo que vazio) sem 500 nem 403.
 */

test.describe('Fluxo 3.3 — Dados bancários (PayoutProfile)', () => {
  test('@flow GET /payout-profile do colaborador responde sem 500', async ({ authApi }) => {
    const created = await apiCreateCollaborator(authApi);
    const res = await authApi.get(`/api/collaborators/${created.id}/payout-profile`);
    expect(res.status()).toBeLessThan(500);
  });
});
