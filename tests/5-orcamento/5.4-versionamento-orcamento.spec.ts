import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import {
  apiCreateBudget,
  apiListBudgetVersions,
  apiRestartBudgetAsDraft,
  apiSendBudget,
} from '../../helpers/api-event-flow';
import { setBudgetStatusDirect } from '../../helpers/db-helper';

/**
 * Fluxo: 5.4 — Versionamento do orçamento
 * Diagrama: docs/fluxos/negocio-5.4-versionamento-orcamento.mmd
 *
 * Cada nova versão eh criada quando o orcamento eh restart-as-draft a
 * partir de Refused/Expired. Etapa 38: nova versao herda dados, fica
 * Draft, e historico aparece em /versions.
 */

test.describe('Fluxo 5.4 — Versionamento', () => {
  test('@flow listagem de orçamentos carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/budgets/list');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test('@crud restart-as-draft de Refused gera nova versao listavel', async ({ authApi }) => {
    const cliente = await apiCreateClient(authApi);
    const atividade = await apiCreateActivity(authApi);
    const orcamento = await apiCreateBudget(authApi, {
      clientId: cliente.id,
      activityIds: [atividade.id],
    });
    await apiSendBudget(authApi, orcamento.id);
    // Backend so aceita restart de Refused/Expired — forca via SQL
    setBudgetStatusDirect(orcamento.id, 'Refused');

    await apiRestartBudgetAsDraft(authApi, orcamento.id);

    const versions = await apiListBudgetVersions(authApi, orcamento.id);
    expect(versions.length, 'versionamento deve registrar ao menos 1 entrada').toBeGreaterThanOrEqual(1);
  });
});
