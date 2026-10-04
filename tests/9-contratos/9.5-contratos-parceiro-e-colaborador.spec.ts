import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { apiCompleteOnboarding, apiCreateCollaborator } from '../../helpers/api-entities';
import { assertOk, readJson } from '../../helpers/response';

/**
 * Fluxo: 9.5 — Outros tipos de contrato (parceiro, colaborador)
 * Diagrama: docs/fluxos/negocio-9.5-contratos-parceiro-e-colaborador.mmd
 */

test.describe('Fluxo 9.5 — Contratos parceiro e colaborador', () => {
  // Tenant recém-criado cai no assistente de configuração (onboardingGuard).
  test.beforeEach(async ({ authApi }) => {
    await apiCompleteOnboarding(authApi);
  });

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
    // O form busca entre os PARCEIROS ativos (`isPartner`, Etapa 183) pelo
    // autocomplete (Etapa 195, E3): o parceiro nasce com o flag.
    const partnerName = `Salão Parceiro ${Date.now()}`;
    const created = await authApi.post('/api/clients', {
      data: {
        type: 'PJ',
        name: partnerName,
        document: '11222333000181', // CNPJ válido
        phone: '41999990000',
        isPartner: true,
        partnerCategory: 'Buffet',
      },
    });
    await assertOk(created, 'criar parceiro');
    const partnerId = (await readJson<{ id: string }>(created)).id;

    await authPage.goto('/app/contracts/partner/new');
    const partnerInput = authPage.getByTestId('partner-contract-form-partnerId');
    await partnerInput.click();
    await partnerInput.fill(partnerName);
    const partnerOption = authPage.getByTestId(`partner-contract-form-partnerId-option-${partnerId}`);
    await expect(partnerOption).toBeVisible({ timeout: 10_000 });
    await partnerOption.click();
    await expect(partnerInput).toHaveValue(partnerName);

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
    const collaboratorName = `Recreador Contrato ${Date.now()}`;
    const collaborator = await apiCreateCollaborator(authApi, { name: collaboratorName });

    // Escolha pelo autocomplete (Etapa 195, E3).
    await authPage.goto('/app/contracts/collaborator/new');
    const collabInput = authPage.getByTestId('collaborator-contract-form-collaboratorId');
    await collabInput.click();
    await collabInput.fill(collaboratorName);
    const collabOption = authPage.getByTestId(
      `collaborator-contract-form-collaboratorId-option-${collaborator.id}`,
    );
    await expect(collabOption).toBeVisible({ timeout: 10_000 });
    await collabOption.click();
    await expect(collabInput).toHaveValue(collaboratorName);

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
