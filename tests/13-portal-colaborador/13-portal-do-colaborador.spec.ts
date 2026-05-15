import { test, expect } from '@playwright/test';

/**
 * Fluxo: 13 — Portal do colaborador
 * Diagrama: docs/fluxos/negocio-13-portal-do-colaborador.mmd
 *
 * Portal `/portal/*` é acessado pelo colaborador com role CollaboratorPortal.
 * Cobertura completa exige criar Collaborator → User → enviar invite →
 * aceitar → logar. Aqui smoke da rota pública (redirect pra login).
 */

test.describe('Fluxo 13 — Portal do colaborador', () => {
  test('@flow rota /portal redireciona anônimo pra login', async ({ page }) => {
    await page.goto('/portal');
    await expect(page).toHaveURL(/\/auth\/login/);
  });
});
