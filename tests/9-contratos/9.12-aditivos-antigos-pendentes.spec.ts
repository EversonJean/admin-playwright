import type { APIRequestContext } from '@playwright/test';

import { authTest as test, expect } from '../../fixtures/auth.fixture';
import {
  apiErrorBody,
  apiGetAddendum,
  apiListContractAddendums,
  apiProposeContractChange,
  apiTryCreateContractAddendum,
  apiTryProposeContractChange,
  freeTextClause,
  setupManuallyFormalizedContract,
} from '../../helpers/addendums';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import { apiCompleteOnboarding } from '../../helpers/api-entities';
import { execSql } from '../../helpers/db-helper';
import { assertOk, readJson, unwrapList } from '../../helpers/response';

/**
 * Fluxo: 9.12 — Aditivos antigos pendentes
 * Diagrama: docs/fluxos/negocio-9.12-aditivos-antigos-pendentes.mmd
 * Cenário: docs/cenarios-de-teste/9-contratos/9.12-aditivos-antigos-pendentes.md (CF-01, CE-01, CE-02, CE-04)
 *
 * PLANO-ADITIVOS-COM-APROVACAO §3 item 10, A12, A13, A14:
 * - o aditivo da propagação ainda aberto e marcado `AppliedBeforeFormalization`
 *   (o evento já mudou) aparece em `GET /api/addendums/legacy-pending` e na tela
 *   "Aditivos antigos pendentes" (`/app/contracts/addendums/legacy`), com o selo
 *   "Evento já alterado" e os campos que já mudaram;
 * - cancelar sem `acknowledgeEventAlreadyChanged` dá 409
 *   `Addendums.LegacyEventAlreadyChanged` com os campos; com ele, cancela e não
 *   toca o evento;
 * - proposta nova no mesmo contrato: 409 `Addendums.LegacyOpen`;
 * - outra empresa não vê a lista nem cancela.
 *
 * Massa: desde a Etapa 289 a propagação não cria mais aditivo, então o legado se
 * monta como a seed `seeds/flows/09-contracts.ts` (fluxo 9.12): contrato
 * formalizado, aditivo de local em rascunho pela festa e a marca do legado por SQL
 * (`EffectsStatus = AppliedBeforeFormalization`, `ChangeSet` nulo), o estado que a
 * migration `Etapa285_AddendumChangeSet` deu aos antigos.
 *
 * O aviso no sino (`AddendumLegacyPending`) sai de um backfill de boot (A13) e
 * só é publicado quando o back sobe com o legado já gravado; o spec monta o legado
 * com o back no ar, então o sino fica fora daqui.
 */

interface LegacyItem {
  addendumId: string;
  contractId: string;
  eventId: string;
  number: number;
  status: string;
  reason: string;
  changedFields: string[];
}

async function setupLegacyPending(api: APIRequestContext, tenantId: string) {
  const { contractId, eventId } = await setupManuallyFormalizedContract(api, tenantId);
  const location = `Salao da propagacao ${Date.now()}`;
  const proposal = await apiProposeContractChange(api, eventId, `Propagação da série: festa mudou para ${location}`, {
    location,
  });
  execSql(
    `UPDATE "ContractAddendums" SET "EffectsStatus" = 'AppliedBeforeFormalization', "ChangeSet" = NULL WHERE "Id" = '${proposal.addendumId}'`,
  );
  return { contractId, eventId, addendumId: proposal.addendumId, number: proposal.addendumNumber };
}

async function listLegacy(api: APIRequestContext): Promise<LegacyItem[]> {
  const res = await api.get('/api/addendums/legacy-pending');
  await assertOk(res, 'GET /api/addendums/legacy-pending');
  return unwrapList<LegacyItem>(res);
}

async function eventLocation(api: APIRequestContext, eventId: string): Promise<string | null> {
  const res = await api.get(`/api/events/${eventId}`);
  await assertOk(res, 'GET /api/events/{id}');
  return (await readJson<{ location: string | null }>(res)).location;
}

test.describe('Fluxo 9.12 — Aditivos antigos pendentes', () => {
  test('@flow o legado aberto aparece na lista e na tela com o selo e os campos ja alterados', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    const legacy = await setupLegacyPending(authApi, tenant.tenantId);

    const items = await listLegacy(authApi);
    const item = items.find((i) => i.addendumId === legacy.addendumId);
    expect(item, 'o legado está na lista').toBeTruthy();
    expect(item!.contractId).toBe(legacy.contractId);
    expect(item!.eventId).toBe(legacy.eventId);
    expect(item!.number).toBe(legacy.number);
    expect(item!.status).toBe('Draft');
    expect(item!.changedFields).toContain('Local do evento');

    const detail = await apiGetAddendum(authApi, legacy.addendumId);
    expect(detail.isLegacyEventAlreadyChanged).toBe(true);
    expect(detail.effectsStatus).toBe('AppliedBeforeFormalization');

    await apiCompleteOnboarding(authApi);
    await authPage.goto('/app/contracts/addendums/legacy');
    await expect(authPage.getByTestId('legacy-addendums-title')).toHaveText('Aditivos antigos pendentes');
    const row = authPage.getByTestId(`legacy-addendum-${legacy.addendumId}`);
    await expect(row).toContainText(`Aditivo #${legacy.number}`);
    await expect(authPage.getByTestId(`legacy-addendum-badge-${legacy.addendumId}`)).toContainText('Evento já alterado');
    await expect(authPage.getByTestId(`legacy-addendum-fields-${legacy.addendumId}`)).toContainText('Local do evento');
    await expect(authPage.getByTestId(`legacy-addendum-cancel-${legacy.addendumId}`)).toBeVisible();

    // "Abrir a festa" leva à aba Contrato, com o selo na linha do aditivo.
    await authPage.getByTestId(`legacy-addendum-open-${legacy.addendumId}`).click();
    await expect(authPage).toHaveURL(new RegExp(`/app/events/${legacy.eventId}`));
    await expect(authPage.getByTestId(`addendum-legacy-${legacy.addendumId}`)).toBeVisible();
    await expect(authPage.getByTestId(`addendum-correct-${legacy.addendumId}`)).toHaveCount(0);
  });

  test('@flow proposta nova no contrato com o legado aberto e recusada com Addendums.LegacyOpen', async ({
    authApi,
    tenant,
  }) => {
    const legacy = await setupLegacyPending(authApi, tenant.tenantId);

    const byContract = await apiTryCreateContractAddendum(authApi, legacy.contractId, {
      reason: 'Clausula nova',
      clauses: [freeTextClause('legado').op],
    });
    expect(byContract.status(), 'aditivo pelo contrato').toBe(409);
    const contractErr = await apiErrorBody(byContract);
    expect(contractErr.codes).toContain('Addendums.LegacyOpen');
    expect(contractErr.descriptions.join(' ')).toContain(`(#${legacy.number})`);
    expect(contractErr.data?.legacyAddendumNumber).toBe(legacy.number);

    const byEvent = await apiTryProposeContractChange(authApi, legacy.eventId, 'Outro local', {
      location: `Outro salao ${Date.now()}`,
    });
    expect(byEvent.status(), 'proposta pela festa').toBe(409);
    expect((await apiErrorBody(byEvent)).codes).toContain('Addendums.LegacyOpen');

    const addendums = await apiListContractAddendums(authApi, legacy.contractId);
    expect(addendums.map((a) => a.id), 'nada é criado nem fundido').toEqual([legacy.addendumId]);
    expect((await apiGetAddendum(authApi, legacy.addendumId)).revision).toBe(1);
  });

  test('@flow cancelar o legado sem a ciencia e recusado com os campos; com ela cancela e nao toca o evento', async ({
    authApi,
    tenant,
  }) => {
    const legacy = await setupLegacyPending(authApi, tenant.tenantId);
    const locationBefore = await eventLocation(authApi, legacy.eventId);

    const refused = await authApi.post(`/api/addendums/${legacy.addendumId}/cancel`, {
      data: { reason: 'Cliente nao concordou' },
    });
    expect(refused.status()).toBe(409);
    const err = await apiErrorBody(refused);
    expect(err.codes).toContain('Addendums.LegacyEventAlreadyChanged');
    expect(err.descriptions.join(' ')).toContain(
      'O evento já foi alterado por esta propagação; cancelar o aditivo não desfaz a mudança.',
    );
    expect(err.data?.changedFields).toContain('Local do evento');
    expect((await apiGetAddendum(authApi, legacy.addendumId)).status).toBe('Draft');

    await assertOk(
      await authApi.post(`/api/addendums/${legacy.addendumId}/cancel`, {
        data: { reason: 'Cliente nao concordou', acknowledgeEventAlreadyChanged: true },
      }),
      'POST cancel com a ciência',
    );
    expect((await apiGetAddendum(authApi, legacy.addendumId)).status).toBe('Canceled');
    expect(await eventLocation(authApi, legacy.eventId), 'cancelar não desfaz nada no evento').toBe(locationBefore);
    expect((await listLegacy(authApi)).some((i) => i.addendumId === legacy.addendumId), 'sai da lista').toBe(false);
  });

  test('@flow outra empresa nao ve o legado na lista nem o cancela', async ({ authApi, tenant }) => {
    const legacy = await setupLegacyPending(authApi, tenant.tenantId);

    const other = await signupNewTenant();
    const apiB = await createBearerApiContext(other.accessToken);
    try {
      const items = await listLegacy(apiB);
      expect(items.some((i) => i.addendumId === legacy.addendumId), 'lista da outra empresa').toBe(false);
      const cancel = await apiB.post(`/api/addendums/${legacy.addendumId}/cancel`, {
        data: { reason: 'Invasao', acknowledgeEventAlreadyChanged: true },
      });
      expect(cancel.status(), 'cancelar o legado de outra empresa').toBe(404);
    } finally {
      await apiB.dispose();
    }
    expect((await apiGetAddendum(authApi, legacy.addendumId)).status).toBe('Draft');
    expect((await listLegacy(authApi)).some((i) => i.addendumId === legacy.addendumId)).toBe(true);
  });
});
