import { authTest as test, expect } from '../../fixtures/auth.fixture';
import {
  apiAddendumPdf,
  apiCreateContractAddendum,
  apiErrorBody,
  apiGetAddendum,
  apiListContractAddendums,
  apiProposeContractChange,
  apiSendAddendum,
  apiTryCreateContractAddendum,
  freeTextClause,
  setupManuallyFormalizedContract,
} from '../../helpers/addendums';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import { apiCompleteOnboarding } from '../../helpers/api-entities';
import { pdfContains } from '../../helpers/pdf-text';
import { assertOk } from '../../helpers/response';
import { loginAsRole } from '../../helpers/setup-flows';

/**
 * Fluxo: 9.4 — Aditivos de contrato (variante 9.4.2: correção do rascunho)
 * Diagrama: docs/fluxos/negocio-9.4-aditivos.mmd
 * Cenário: docs/cenarios-de-teste/9-contratos/9.4-aditivos.md (CF-04, CE-04, CE-05, CE-07, CE-08, CE-12)
 *
 * PLANO-ADITIVOS-COM-APROVACAO §3 (AD-A) itens 4 a 6 e 8, A14:
 * - corrigir o rascunho (`PUT /api/addendums/{id}`, `contracts.manage`) mantém o
 *   número, sobe a revisão e o PDF diz "Aditivo #N, revisão R";
 * - fora de rascunho, 409 `Addendums.NotEditable` ("Recolha-o para rascunho antes");
 *   recolhido, corrige de novo;
 * - criar com outro aberto: 409 `Addendums.AnotherOpen` com o número no `metadata`;
 * - aditivo de outra empresa: 404.
 * Desde a Etapa 287 (A21) o `PUT` só corrige cláusula e ajuste manual; a mudança
 * da festa se corrige propondo de novo pela festa, que funde no rascunho aberto.
 */

test.describe('Fluxo 9.4.2 — Correção do aditivo', () => {
  test('@flow corrigir o rascunho mantém o número, sobe a revisão e o PDF diz a revisão', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    const { contractId, eventId } = await setupManuallyFormalizedContract(authApi, tenant.tenantId);
    const wrong = freeTextClause('errada');
    const created = await apiCreateContractAddendum(authApi, contractId, {
      reason: 'Inclusao de clausula (digitada errada)',
      clauses: [wrong.op],
    });
    expect(created.addendumNumber).toBe(1);

    // CE-08 — com o #1 aberto, outro aditivo é recusado com o número dele.
    const another = await apiTryCreateContractAddendum(authApi, contractId, {
      reason: 'Outro aditivo',
      clauses: [freeTextClause('outro').op],
    });
    expect(another.status()).toBe(409);
    const anotherErr = await apiErrorBody(another);
    expect(anotherErr.codes).toContain('Addendums.AnotherOpen');
    expect(anotherErr.data?.openAddendumNumber).toBe(1);
    expect(anotherErr.descriptions.join(' ')).toContain('#1 ainda está aberto neste contrato');

    // CF-04 — corrigir no lugar (estado completo).
    const right = freeTextClause('certa');
    const put = await authApi.put(`/api/addendums/${created.id}`, {
      data: { reason: 'Inclusao de clausula (corrigida)', clauses: [right.op], expectedRevision: 1 },
    });
    await assertOk(put, 'PUT /api/addendums/{id}');
    const corrected = await apiGetAddendum(authApi, created.id);
    expect(corrected.addendumNumber, 'mesmo número').toBe(1);
    expect(corrected.revision, 'revisão sobe').toBe(2);
    expect(corrected.status).toBe('Draft');
    expect(await apiListContractAddendums(authApi, contractId), 'sem segundo aditivo').toHaveLength(1);

    const pdf = await apiAddendumPdf(authApi, created.id);
    expect(pdfContains(pdf, 'Aditivo #1, revisão 2'), 'cabeçalho com a revisão').toBe(true);
    expect(pdfContains(pdf, right.bodyText), 'texto da correção no PDF').toBe(true);
    expect(pdfContains(pdf, wrong.bodyText), 'a redação errada sai do PDF').toBe(false);

    // A mudança na festa com o rascunho aberto entra nele (mesmo número, revisão + 1).
    const merged = await apiProposeContractChange(authApi, eventId, 'Local corrigido', {
      location: `Salao corrigido ${Date.now()}`,
    });
    expect(merged.merged, 'fundiu no rascunho aberto').toBe(true);
    expect(merged.addendumId).toBe(created.id);
    expect(merged.addendumNumber).toBe(1);
    expect(merged.revision).toBe(3);

    // Na tela, a linha continua "#1" e mostra a revisão.
    await apiCompleteOnboarding(authApi);
    await authPage.goto(`/app/events/${eventId}`);
    await authPage.getByRole('tab', { name: 'Contrato', exact: true }).click();
    await expect(authPage.getByTestId(`addendum-number-${created.id}`)).toContainText('#1');
    await expect(authPage.getByTestId(`addendum-revision-${created.id}`)).toContainText('revisão 3');
  });

  test('@flow enviado: corrigir recusa com NotEditable; recolhido, corrige e sobe a revisão', async ({
    authApi,
    tenant,
  }) => {
    const { contractId } = await setupManuallyFormalizedContract(authApi, tenant.tenantId);
    const created = await apiCreateContractAddendum(authApi, contractId, {
      reason: 'Inclusao de clausula',
      clauses: [freeTextClause('enviada').op],
    });
    await apiSendAddendum(authApi, created.id);
    expect((await apiGetAddendum(authApi, created.id)).status).toBe('Sent');

    // CE-07 — corrigir o enviado.
    const fix = freeTextClause('corrigida');
    const refused = await authApi.put(`/api/addendums/${created.id}`, {
      data: { reason: 'Correcao', clauses: [fix.op] },
    });
    expect(refused.status()).toBe(409);
    const refusedErr = await apiErrorBody(refused);
    expect(refusedErr.codes).toContain('Addendums.NotEditable');
    expect(refusedErr.descriptions.join(' ')).toContain('Recolha-o para rascunho antes.');
    const stillSent = await apiGetAddendum(authApi, created.id);
    expect(stillSent.status).toBe('Sent');
    expect(stillSent.revision).toBe(1);

    // CE-04 — recolher e corrigir.
    await assertOk(await authApi.post(`/api/addendums/${created.id}/recall`), 'POST recall');
    expect((await apiGetAddendum(authApi, created.id)).status).toBe('Draft');
    await assertOk(
      await authApi.put(`/api/addendums/${created.id}`, { data: { reason: 'Correcao', clauses: [fix.op] } }),
      'PUT depois de recolher',
    );
    const corrected = await apiGetAddendum(authApi, created.id);
    expect(corrected.addendumNumber).toBe(1);
    expect(corrected.revision).toBe(2);
    expect(corrected.status).toBe('Draft');
    expect(pdfContains(await apiAddendumPdf(authApi, created.id), 'Aditivo #1, revisão 2')).toBe(true);
  });

  test('@flow sem contracts.manage nao corrige o aditivo (403) e nada muda', async ({ authApi, tenant }) => {
    const { contractId } = await setupManuallyFormalizedContract(authApi, tenant.tenantId);
    const created = await apiCreateContractAddendum(authApi, contractId, {
      reason: 'Inclusao de clausula',
      clauses: [freeTextClause('permissao').op],
    });

    // O Financeiro não tem `contracts.manage` (nem `contracts.read`).
    const financial = await loginAsRole(tenant.tenantId, 'Financial');
    try {
      const put = await financial.api.put(`/api/addendums/${created.id}`, {
        data: { reason: 'Tentativa sem permissao', clauses: [freeTextClause('negada').op] },
      });
      expect(put.status(), 'PUT sem contracts.manage').toBe(403);
    } finally {
      await financial.api.dispose();
    }
    const unchanged = await apiGetAddendum(authApi, created.id);
    expect(unchanged.revision).toBe(1);
    expect(unchanged.reason).toBe('Inclusao de clausula');
  });

  test('@flow aditivo de outra empresa da 404 e nao e corrigido nem cancelado', async ({ authApi, tenant }) => {
    const { contractId } = await setupManuallyFormalizedContract(authApi, tenant.tenantId);
    const created = await apiCreateContractAddendum(authApi, contractId, {
      reason: 'Inclusao de clausula',
      clauses: [freeTextClause('isolamento').op],
    });

    const other = await signupNewTenant();
    const apiB = await createBearerApiContext(other.accessToken);
    try {
      expect((await apiB.get(`/api/addendums/${created.id}`)).status(), 'GET de outra empresa').toBe(404);
      const put = await apiB.put(`/api/addendums/${created.id}`, {
        data: { reason: 'Invasao', clauses: [freeTextClause('invasao').op] },
      });
      expect(put.status(), 'PUT de outra empresa').toBe(404);
      const cancel = await apiB.post(`/api/addendums/${created.id}/cancel`, { data: { reason: 'Invasao' } });
      expect(cancel.status(), 'cancel de outra empresa').toBe(404);
    } finally {
      await apiB.dispose();
    }
    const unchanged = await apiGetAddendum(authApi, created.id);
    expect(unchanged.status).toBe('Draft');
    expect(unchanged.revision).toBe(1);
  });
});
