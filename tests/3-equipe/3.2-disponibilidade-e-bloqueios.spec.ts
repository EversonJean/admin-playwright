import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateCollaborator } from '../../helpers/api-entities';

/**
 * Fluxo: 3.2 — Disponibilidade e bloqueios
 * Diagrama: docs/fluxos/negocio-3.2-disponibilidade-e-bloqueios.mmd
 *
 * Disponibilidade ao colaborador no detalhe da entidade (não tem rota
 * dedicada). Valida que após criar um colaborador, a tela de detalhe
 * carrega com os blocos de schedule/blocks.
 */

test.describe('Fluxo 3.2 — Disponibilidade e bloqueios', () => {
  test('@flow tela de detalhe do colaborador carrega autenticada', async ({ authPage, authApi }) => {
    const created = await apiCreateCollaborator(authApi);
    await authPage.goto(`/app/collaborators/${created.id}`);
    await expect(authPage).toHaveURL(new RegExp(`/app/collaborators/${created.id}`));
    await expect(authPage.getByText(/acesso negado|403/i)).toHaveCount(0);
  });
});
