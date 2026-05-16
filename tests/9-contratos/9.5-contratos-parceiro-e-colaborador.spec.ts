import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { apiCreateClient, apiCreateCollaborator } from '../../helpers/api-entities';

/**
 * Fluxo: 9.5 — Outros tipos de contrato (parceiro, colaborador)
 * Diagrama: docs/fluxos/negocio-9.5-contratos-parceiro-e-colaborador.mmd
 */

test.describe('Fluxo 9.5 — Contratos parceiro e colaborador', () => {
  test('@flow listagem de contratos de parceiro carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/contracts/partner/list');
  });

  test('@flow criação de contrato de parceiro carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/contracts/partner/new');
  });

  test('@flow listagem de contratos de colaborador carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/contracts/collaborator/list');
  });

  test('@flow criação de contrato de colaborador carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/contracts/collaborator/new');
  });

  test('@crud cria contrato com parceiro (PJ) via UI e valida no back', async ({
    authPage,
    authApi,
  }) => {
    // Form filtra clientes por type=PJ — precisa criar PJ antes
    await apiCreateClient(authApi, {
      type: 'PJ',
      document: '11222333000181', // CNPJ válido
    });

    // Aguarda GET de clientes resolver ANTES de abrir o select pra evitar
    // pegar mat-option de painel anterior aberto / lista vazia.
    const clientsLoadedPromise = authPage.waitForResponse(
      (r) => r.url().includes('/api/clients') && r.request().method() === 'GET',
      { timeout: 10_000 },
    );
    await authPage.goto('/app/contracts/partner/new');
    await clientsLoadedPromise;
    // mat-label flutua sobre o trigger e intercepta cliques — usa keyboard.
    const partnerSelect = authPage.getByTestId('partner-contract-form-partnerId');
    await expect(partnerSelect).toBeVisible();
    await partnerSelect.focus();
    await authPage.keyboard.press('Enter');
    await authPage.locator('mat-option:not([aria-disabled="true"])').first().click();

    // Vigência — data início obrigatória
    const hoje = new Date().toISOString().slice(0, 10);
    await authPage.getByTestId('partner-contract-form-startDate').fill(hoje);

    // Type default = FixedMonthly → exige `fixedValue`
    await authPage.getByTestId('partner-contract-form-fixedValue').fill('1500');

    const respPromise = authPage.waitForResponse(
      (r) => r.url().includes('/api/partner-contracts') && r.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await authPage.getByTestId('partner-contract-form-submit').click();
    const resp = await respPromise;
    expect(resp.ok()).toBe(true);

    const list = await authApi.get('/api/partner-contracts');
    expect(list.ok()).toBe(true);
  });

  test('@crud cria contrato com colaborador via UI e valida no back', async ({
    authPage,
    authApi,
  }) => {
    await apiCreateCollaborator(authApi);

    const collabsLoadedPromise = authPage.waitForResponse(
      (r) => r.url().includes('/api/collaborators') && r.request().method() === 'GET',
      { timeout: 10_000 },
    );
    await authPage.goto('/app/contracts/collaborator/new');
    await collabsLoadedPromise;
    const collabSelect = authPage.getByTestId('collaborator-contract-form-collaboratorId');
    await expect(collabSelect).toBeVisible();
    await collabSelect.focus();
    await authPage.keyboard.press('Enter');
    await authPage.locator('mat-option:not([aria-disabled="true"])').first().click();

    const hoje = new Date().toISOString().slice(0, 10);
    await authPage.getByTestId('collaborator-contract-form-startDate').fill(hoje);

    // Remuneração base — pelo menos um dos dois é obrigatório
    await authPage.getByTestId('collaborator-contract-form-baseValuePerEvent').fill('150');

    const respPromise = authPage.waitForResponse(
      (r) => r.url().includes('/api/collaborator-contracts') && r.request().method() === 'POST',
      { timeout: 10_000 },
    );
    await authPage.getByTestId('collaborator-contract-form-submit').click();
    const resp = await respPromise;
    expect(resp.ok()).toBe(true);

    const list = await authApi.get('/api/collaborator-contracts');
    expect(list.ok()).toBe(true);
  });
});
