import { authTest as test, expect } from '../../fixtures/auth.fixture';
import {
  apiAddendumPdf,
  apiCreateActiveClause,
  apiCreateContractAddendum,
  apiErrorBody,
  apiFormalizeAddendumManually,
  apiGetAddendum,
  apiListContractAddendums,
  apiListEffectiveClauses,
  apiTryCreateContractAddendum,
  freeTextClause,
  setupManuallyFormalizedContract,
} from '../../helpers/addendums';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import { apiCompleteOnboarding } from '../../helpers/api-entities';
import { pdfContains } from '../../helpers/pdf-text';
import { assertOk, readJson } from '../../helpers/response';

/**
 * Fluxo: 9.7 — Aditivo de cláusulas
 * Diagrama: docs/fluxos/negocio-9.7-aditivo-de-clausulas.mmd
 * Cenário: docs/cenarios-de-teste/9-contratos/9.7-aditivo-de-clausulas.md (CF-01 a CF-03, CE-01, CE-05)
 *
 * PLANO-ADITIVOS-COM-APROVACAO §4 (AD-B) itens 1 a 6, A17:
 * - substituir pela versão ativa da biblioteca do tenant, incluir em texto livre
 *   e remover a cláusula vigente;
 * - o PDF do aditivo traz "Cláusulas alteradas" com o texto integral e a remoção
 *   nomeada;
 * - formalizar congela a versão citada (`ClauseVersionFreezer`);
 * - `GET /api/contracts/{id}/effective-clauses` mostra "aditivo #N" como origem, e
 *   o contrato original não muda (A3);
 * - substituir a cláusula que um aditivo formalizado já tirou: 400
 *   `Addendums.ClauseNotInContract`;
 * - contrato de outra empresa: 404.
 */

interface ContractClausesView {
  clauses: Array<{ clauseId: string; clauseVersionId: string; title: string }>;
}

test.describe('Fluxo 9.7 — Aditivo de cláusulas', () => {
  test('@flow substituir pela biblioteca e formalizar: PDF com o texto, versao congelada, vigentes com a origem', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    const { contractId, eventId } = await setupManuallyFormalizedContract(authApi, tenant.tenantId);
    const contractBefore = await readJson<ContractClausesView>(await authApi.get(`/api/contracts/${contractId}`));

    const initial = await apiListEffectiveClauses(authApi, contractId);
    expect(initial, 'a cláusula do modelo').toHaveLength(1);
    expect(initial[0]!.origin).toBe('Contract');
    const modelClause = initial[0]!;

    const library = await apiCreateActiveClause(authApi);
    const addendum = await apiCreateContractAddendum(authApi, contractId, {
      reason: 'Troca da clausula pela redacao nova',
      clauses: [
        {
          operation: 'Replace',
          targetClauseId: modelClause.clauseId,
          clauseVersionId: library.versionId,
          freeTitle: null,
          freeBodyHtml: null,
        },
      ],
    });

    const pdf = await apiAddendumPdf(authApi, addendum.id);
    expect(pdfContains(pdf, 'Cláusulas alteradas'), 'seção do PDF').toBe(true);
    expect(pdfContains(pdf, `Substituição: ${modelClause.title}`), 'cláusula substituída nomeada').toBe(true);
    expect(pdfContains(pdf, library.bodyText), 'texto integral da cláusula nova').toBe(true);

    await apiFormalizeAddendumManually(authApi, addendum.id);
    const formalized = await apiGetAddendum(authApi, addendum.id);
    expect(formalized.status).toBe('Formalized');
    expect(formalized.effectsStatus, 'só de cláusula: nada a aplicar fora do contrato').toBe('NotApplicable');

    // A formalização congela a versão citada.
    const clauseRes = await authApi.get(`/api/clauses/${library.clauseId}`);
    await assertOk(clauseRes, 'GET /api/clauses/{id}');
    const clause = await readJson<{ versions: Array<{ id: string; status: string }> }>(clauseRes);
    expect(clause.versions.find((v) => v.id === library.versionId)?.status).toBe('Frozen');

    // Vigentes: a nova no lugar da antiga, com o aditivo como origem.
    const effective = await apiListEffectiveClauses(authApi, contractId);
    expect(effective).toHaveLength(1);
    expect(effective[0]!.title).toBe(library.title);
    expect(effective[0]!.clauseVersionId).toBe(library.versionId);
    expect(effective[0]!.origin).toBe('Addendum');
    expect(effective[0]!.originAddendumNumber).toBe(1);

    // O contrato original fica intacto.
    const contractAfter = await readJson<ContractClausesView>(await authApi.get(`/api/contracts/${contractId}`));
    expect(contractAfter.clauses.map((c) => c.clauseVersionId)).toEqual(
      contractBefore.clauses.map((c) => c.clauseVersionId),
    );
    expect(contractAfter.clauses.map((c) => c.title)).toEqual([modelClause.title]);

    // Na aba Contrato, "Cláusulas vigentes" mostra a origem.
    await apiCompleteOnboarding(authApi);
    await authPage.goto(`/app/events/${eventId}`);
    await authPage.getByRole('tab', { name: 'Contrato', exact: true }).click();
    await authPage.getByTestId('effective-clauses-panel').click();
    await expect(authPage.getByTestId('effective-clauses-count')).toContainText('(1)');
    await expect(authPage.getByTestId('effective-clause-0')).toContainText(library.title);
    await expect(authPage.getByTestId('effective-clause-origin-0')).toContainText('aditivo #1');
  });

  test('@flow incluir em texto livre, remover a do modelo e recusar substituir a que ja saiu', async ({
    authApi,
    tenant,
  }) => {
    const { contractId } = await setupManuallyFormalizedContract(authApi, tenant.tenantId);
    const [modelClause] = await apiListEffectiveClauses(authApi, contractId);

    // CF-02 — inclusão em texto livre.
    const free = freeTextClause('incluida');
    const add = await apiCreateContractAddendum(authApi, contractId, {
      reason: 'Inclusao de clausula',
      clauses: [free.op],
    });
    const addPdf = await apiAddendumPdf(authApi, add.id);
    expect(pdfContains(addPdf, 'Cláusulas alteradas')).toBe(true);
    expect(pdfContains(addPdf, `Inclusão: ${free.title}`), 'inclusão nomeada').toBe(true);
    expect(pdfContains(addPdf, free.bodyText), 'texto livre no PDF').toBe(true);
    await apiFormalizeAddendumManually(authApi, add.id);

    const afterAdd = await apiListEffectiveClauses(authApi, contractId);
    expect(afterAdd).toHaveLength(2);
    expect(afterAdd[1]!.title).toBe(free.title);
    expect(afterAdd[1]!.origin).toBe('Addendum');
    expect(afterAdd[1]!.originAddendumNumber).toBe(1);

    // CF-03 — remoção da cláusula do modelo.
    const remove = await apiCreateContractAddendum(authApi, contractId, {
      reason: 'Remocao de clausula',
      clauses: [
        { operation: 'Remove', targetClauseId: modelClause!.clauseId, clauseVersionId: null, freeTitle: null, freeBodyHtml: null },
      ],
    });
    const removePdf = await apiAddendumPdf(authApi, remove.id);
    expect(pdfContains(removePdf, `Remoção: ${modelClause!.title}`), 'remoção nomeada').toBe(true);
    expect(
      pdfContains(removePdf, `A cláusula "${modelClause!.title}" deixa de vigorar a partir deste aditivo.`),
    ).toBe(true);
    await apiFormalizeAddendumManually(authApi, remove.id);

    const afterRemove = await apiListEffectiveClauses(authApi, contractId);
    expect(afterRemove.map((c) => c.title), 'a do modelo some das vigentes').toEqual([free.title]);

    // CE-01 — substituir a cláusula que o aditivo #2 já tirou.
    const library = await apiCreateActiveClause(authApi);
    const refused = await apiTryCreateContractAddendum(authApi, contractId, {
      reason: 'Substituir a que ja saiu',
      clauses: [
        {
          operation: 'Replace',
          targetClauseId: modelClause!.clauseId,
          clauseVersionId: library.versionId,
          freeTitle: null,
          freeBodyHtml: null,
        },
      ],
    });
    expect(refused.status()).toBe(400);
    const err = await apiErrorBody(refused);
    expect(err.codes).toContain('Addendums.ClauseNotInContract');
    expect(err.descriptions.join(' ')).toContain('não está vigente neste contrato');
    expect(await apiListContractAddendums(authApi, contractId), 'nada é criado').toHaveLength(2);
  });

  test('@flow outra empresa nao ve as clausulas vigentes nem cria aditivo no contrato', async ({
    authApi,
    tenant,
  }) => {
    const { contractId } = await setupManuallyFormalizedContract(authApi, tenant.tenantId);

    const other = await signupNewTenant();
    const apiB = await createBearerApiContext(other.accessToken);
    try {
      const effective = await apiB.get(`/api/contracts/${contractId}/effective-clauses`);
      expect(effective.status(), 'vigentes de outra empresa').toBe(404);
      const create = await apiTryCreateContractAddendum(apiB, contractId, {
        reason: 'Invasao',
        clauses: [freeTextClause('invasao').op],
      });
      expect(create.status(), 'aditivo no contrato de outra empresa').toBe(404);
    } finally {
      await apiB.dispose();
    }
    expect(await apiListContractAddendums(authApi, contractId)).toHaveLength(0);
    expect(await apiListEffectiveClauses(authApi, contractId)).toHaveLength(1);
  });
});
