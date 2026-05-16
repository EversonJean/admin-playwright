import { test, expect } from '@playwright/test';
import { authTest } from '../../fixtures/auth.fixture';
import { apiCreateCollaborator } from '../../helpers/api-entities';

/**
 * Fluxo: 13 — Portal do colaborador
 * Diagrama: docs/fluxos/negocio-13-portal-do-colaborador.mmd
 *
 * Portal `/portal/*` eh acessado pelo colaborador com role
 * CollaboratorPortal. Cobertura completa exige criar User CollaboratorPortal
 * e logar — bloqueado por 500 no login (investigar: provavel dependencia
 * de tabela auxiliar nao plumbed em seed via SQL).
 *
 * Aqui validamos smoke da rota publica + criacao do Collaborator pelo
 * admin (origem do User portal).
 */

test.describe('Fluxo 13 — Portal do colaborador (anonimo)', () => {
  test('@flow rota /portal redireciona anônimo pra login', async ({ page }) => {
    await page.goto('/portal');
    await expect(page).toHaveURL(/\/auth\/login/);
  });
});

authTest.describe('Fluxo 13 — Setup do Collaborator (admin view)', () => {
  authTest('@crud admin cria Collaborator que vira candidato a portal', async ({
    authApi,
  }) => {
    const colab = await apiCreateCollaborator(authApi);
    expect(colab.id).toBeTruthy();

    // GET /api/collaborators/:id deve retornar o colab criado
    const fetchRes = await authApi.get(`/api/collaborators/${colab.id}`);
    expect(fetchRes.ok()).toBe(true);
  });
});
