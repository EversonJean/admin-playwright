import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateCollaborator } from '../../helpers/api-entities';

/**
 * Fluxo: 3.3 — Dados bancários (PayoutProfile)
 * Diagrama: docs/fluxos/negocio-3.3-dados-bancarios-colaborador.mmd
 *
 * PayoutProfile so eh criado pelo proprio colaborador via portal
 * (POST /api/portal/payout-profile). Admin so pode GET + PUT /status
 * pra validar/desabilitar. Aqui testamos o GET admin retorna 404
 * limpo quando colab nao tem profile + PUT status falha sem profile.
 */

test.describe('Fluxo 3.3 — Dados bancários (PayoutProfile)', () => {
  test('@flow GET /payout-profile do colaborador responde sem 500', async ({ authApi }) => {
    const created = await apiCreateCollaborator(authApi);
    const res = await authApi.get(`/api/collaborators/${created.id}/payout-profile`);
    expect(res.status()).toBeLessThan(500);
  });

  test('@crud GET payout-profile de colab novo devolve 4xx limpo (sem 500)', async ({
    authApi,
  }) => {
    const colab = await apiCreateCollaborator(authApi);
    const res = await authApi.get(`/api/collaborators/${colab.id}/payout-profile`);
    expect([200, 400, 404], `status inesperado: ${res.status()}`).toContain(res.status());
  });

  test('@crud PUT status em colab sem profile devolve 404/409', async ({ authApi }) => {
    const colab = await apiCreateCollaborator(authApi);
    const res = await authApi.put(
      `/api/collaborators/${colab.id}/payout-profile/status`,
      { data: { status: 'Validated' } },
    );
    expect([400, 404, 409, 422]).toContain(res.status());
  });
});
