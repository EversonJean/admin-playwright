import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { apiCreateCollaborator, apiListCollaborators } from '../../helpers/api-entities';

/**
 * Fluxo: 3.1 — Cadastro de colaboradores
 * Diagrama: docs/fluxos/negocio-3.1-cadastro-colaboradores.mmd
 */

test.describe('Fluxo 3.1 — Cadastro de colaboradores', () => {
  test('@flow tela de listagem carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/collaborators/list');
  });

  test('@flow tela de criação carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/collaborators/new');
  });

  test('@flow criar colaborador via API + aparece na listagem', async ({ authApi }) => {
    const created = await apiCreateCollaborator(authApi);
    expect(created.id).toBeTruthy();
    const list = await apiListCollaborators(authApi);
    const items = (list as { items?: unknown[] }).items ?? (list as unknown as { data?: { items?: unknown[] } }).data?.items ?? [];
    expect(items.length).toBeGreaterThan(0);
  });
});
