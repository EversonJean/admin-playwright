import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { setupFormalizedContract } from '../../helpers/setup-flows';
import { assertOk, readJson } from '../../helpers/response';
import { GUID_REGEX } from '../../helpers/types';

/**
 * Aprofundamento de 9.4 — Addendums CRUD completo.
 * Cobre os endpoints do AddendumsController nao testados em 9.4
 * (create real, GET by id, cancel).
 */

test.describe('9.4.1 — Addendums CRUD', () => {
  test('@crud cria addendum + GET retorna detalhe + cancel', async ({ authApi, tenant }) => {
    const { contractId } = await setupFormalizedContract(authApi, tenant.tenantId);

    const newDate = new Date(Date.now() + 60 * 86400000).toISOString();
    const createRes = await authApi.post(`/api/contracts/${contractId}/addendums`, {
      data: {
        reason: 'Mudanca de data + acrescimo',
        newEventDate: newDate,
        priceDelta: 150,
      },
    });
    await assertOk(createRes, 'POST addendum');
    const created = await readJson<{ id: string; status: string }>(createRes);
    expect(created.id).toMatch(GUID_REGEX);

    // GET addendum by id
    const getRes = await authApi.get(`/api/addendums/${created.id}`);
    await assertOk(getRes, 'GET /api/addendums/:id');
    const detail = await readJson<{ id: string; status: string }>(getRes);
    expect(detail.id).toBe(created.id);

    // Cancel addendum (state machine — Draft pode cancelar)
    const cancelRes = await authApi.post(`/api/addendums/${created.id}/cancel`, {
      data: { reason: 'Cancelado E2E' },
    });
    expect(cancelRes.status(), `cancel status: ${cancelRes.status()}`).toBeLessThan(500);
  });
});
