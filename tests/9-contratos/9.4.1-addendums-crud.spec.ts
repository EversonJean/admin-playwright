import { authTest as test, expect } from '../../fixtures/auth.fixture';
import {
  apiErrorBody,
  apiGetAddendum,
  apiListContractAddendums,
  apiTryCreateContractAddendum,
  apiTryProposeContractChange,
  freeTextClause,
} from '../../helpers/addendums';
import { apiGetEvent } from '../../helpers/api-event-flow';
import { setupFormalizedContract } from '../../helpers/setup-flows';
import { assertOk, readJson } from '../../helpers/response';
import { GUID_REGEX } from '../../helpers/types';

/**
 * Aprofundamento de 9.4 — Addendums CRUD completo (criar, consultar, cancelar).
 *
 * Etapa 287 (PLANO-ADITIVOS-COM-APROVACAO §5 item 2, A21): data e ajuste da
 * festa se propõem pela própria festa (`POST /api/events/{id}/contract-changes`);
 * o `POST /api/contracts/{id}/addendums` com data recusa com 400
 * `Addendums.ScopeViaEvent`. Etapa 285 (§3 item 6, I1): com um aditivo aberto,
 * criar outro dá 409 `Addendums.AnotherOpen` com o número do aberto.
 */

function shiftDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test.describe('9.4.1 — Addendums CRUD', () => {
  test('@crud cria addendum + GET retorna detalhe + cancel', async ({ authApi, tenant }) => {
    const { contractId, eventId } = await setupFormalizedContract(authApi, tenant.tenantId);
    const event = (await apiGetEvent(authApi, eventId)) as unknown as { eventDate: string };

    // O caminho antigo (data pelo contrato) agora é recusado, sem criar nada.
    const viaContract = await apiTryCreateContractAddendum(authApi, contractId, {
      reason: 'Mudanca de data pelo contrato',
      newEventDate: new Date(Date.now() + 60 * 86400000).toISOString(),
      priceDelta: 150,
    });
    expect(viaContract.status(), 'data pelo contrato').toBe(400);
    expect((await apiErrorBody(viaContract)).codes).toContain('Addendums.ScopeViaEvent');
    expect(await apiListContractAddendums(authApi, contractId)).toHaveLength(0);

    // Proposta pela festa: data + acréscimo.
    const createRes = await apiTryProposeContractChange(authApi, eventId, 'Mudanca de data + acrescimo', {
      eventDate: shiftDate(event.eventDate, 30),
      manualAdjustment: 150,
    });
    await assertOk(createRes, 'POST contract-changes');
    expect(createRes.status(), 'aditivo novo').toBe(201);
    const created = await readJson<{ addendumId: string; contractId: string; addendumNumber: number; status: string }>(
      createRes,
    );
    expect(created.addendumId).toMatch(GUID_REGEX);
    expect(created.contractId).toBe(contractId);
    expect(created.addendumNumber).toBe(1);
    expect(created.status).toBe('Draft');

    // GET addendum by id
    const detail = await apiGetAddendum(authApi, created.addendumId);
    expect(detail.id).toBe(created.addendumId);
    expect(detail.addendumNumber).toBe(1);
    expect(detail.status).toBe('Draft');

    // E9 — criar outro (só de cláusula, pelo contrato) com o #1 aberto: 409 AnotherOpen.
    const second = await apiTryCreateContractAddendum(authApi, contractId, {
      reason: 'Segundo aditivo com o primeiro aberto',
      clauses: [freeTextClause('segundo').op],
    });
    expect(second.status(), 'segundo aditivo com o primeiro aberto').toBe(409);
    const secondErr = await apiErrorBody(second);
    expect(secondErr.codes).toContain('Addendums.AnotherOpen');
    expect(secondErr.data?.openAddendumNumber).toBe(1);
    expect(secondErr.data?.openAddendumId).toBe(created.addendumId);
    expect(await apiListContractAddendums(authApi, contractId)).toHaveLength(1);

    // Cancel addendum (Draft pode cancelar)
    const cancelRes = await authApi.post(`/api/addendums/${created.addendumId}/cancel`, {
      data: { reason: 'Cancelado E2E' },
    });
    await assertOk(cancelRes, 'POST /api/addendums/{id}/cancel');
    expect((await apiGetAddendum(authApi, created.addendumId)).status).toBe('Canceled');

    // A festa continua com a data de antes.
    const after = (await apiGetEvent(authApi, eventId)) as unknown as { eventDate: string };
    expect(after.eventDate).toBe(event.eventDate);
  });
});
