import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import {
  apiCancelBudget,
  apiCreateBudget,
  apiGetBudget,
  apiSendBudget,
} from '../../helpers/api-event-flow';
import { setBudgetStatusDirect } from '../../helpers/db-helper';

/**
 * Fluxo: 5.5 — Estados possíveis do orçamento
 * Diagrama: docs/fluxos/negocio-5.5-estados-orcamento.mmd
 *
 * Estados: Draft -> Sent -> Accepted | Refused | Expired | Canceled.
 * Aqui validamos transicoes-chave que tem endpoint publico (cancel) e
 * status forcado direto via DB pros estados que so chegam por timer/cliente.
 */

test.describe('Fluxo 5.5 — Estados do orçamento', () => {
  test('@flow listagem de orçamentos carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/budgets/list');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test('@crud Draft -> Sent -> Canceled via /cancel', async ({ authApi }) => {
    const cliente = await apiCreateClient(authApi);
    const atividade = await apiCreateActivity(authApi);
    const orcamento = await apiCreateBudget(authApi, {
      clientId: cliente.id,
      activityIds: [atividade.id],
    });
    await apiSendBudget(authApi, orcamento.id);

    await apiCancelBudget(authApi, orcamento.id);
    const after = (await apiGetBudget(authApi, orcamento.id)) as unknown as { status: string };
    expect(after.status).toBe('Canceled');
  });

  test('@crud filtragem por status devolve apenas matches', async ({ authApi }) => {
    const cliente = await apiCreateClient(authApi);
    const atividade = await apiCreateActivity(authApi);
    const draft = await apiCreateBudget(authApi, {
      clientId: cliente.id,
      activityIds: [atividade.id],
    });
    const refused = await apiCreateBudget(authApi, {
      clientId: cliente.id,
      activityIds: [atividade.id],
    });
    setBudgetStatusDirect(refused.id, 'Refused');

    const draftRes = await authApi.get('/api/budgets?status=Draft');
    expect(draftRes.ok()).toBe(true);
    const draftBody = await draftRes.json();
    const draftItems = draftBody.data?.items ?? draftBody.items ?? draftBody.data ?? draftBody;
    const draftArr: Array<{ id: string; status: string }> = Array.isArray(draftItems)
      ? draftItems
      : [];
    expect(
      draftArr.find((b) => b.id === draft.id),
      'Draft aparece no filtro Draft',
    ).toBeTruthy();
    expect(
      draftArr.find((b) => b.id === refused.id),
      'Refused NAO aparece no filtro Draft',
    ).toBeFalsy();
  });
});
