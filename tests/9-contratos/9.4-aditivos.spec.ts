import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { setupFormalizedContract } from '../../helpers/setup-flows';
import { assertOk, readJson, unwrapList } from '../../helpers/response';

/**
 * Fluxo: 9.4 — Aditivos de contrato
 * Diagrama: docs/fluxos/negocio-9.4-aditivos.mmd
 *
 * Aditivo so pode ser criado em Contract Formalized/Active. Reusa
 * `setupFormalizedContract` que faz a cadeia completa (template+clausula
 * +contract+send+webhook sign HMAC real) — elimina ~80 linhas duplicadas.
 */

test.describe('Fluxo 9.4 — Aditivos', () => {
  test('@flow listagem de eventos carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/events/list');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test('@crud preview-impact em contrato Formalized devolve changesSummary', async ({
    authApi,
    tenant,
  }) => {
    const { contractId } = await setupFormalizedContract(authApi, tenant.tenantId);

    const newDate = new Date(Date.now() + 45 * 86400000).toISOString();
    const previewRes = await authApi.post(
      `/api/contracts/${contractId}/addendums/preview-impact`,
      {
        data: {
          newEventDate: newDate,
          newGuestCount: 25,
          priceDelta: 200,
        },
      },
    );
    await assertOk(previewRes, 'POST preview-impact');
    const preview = await readJson<{
      changesSummary: Array<{ field: string; before?: unknown; after?: unknown }>;
    }>(previewRes);
    expect(preview.changesSummary.length).toBeGreaterThan(0);
  });

  test('@crud GET addendums de contrato Formalized devolve lista vazia inicialmente', async ({
    authApi,
    tenant,
  }) => {
    const { contractId } = await setupFormalizedContract(authApi, tenant.tenantId);

    const listRes = await authApi.get(`/api/contracts/${contractId}/addendums`);
    await assertOk(listRes, 'GET addendums');
    const arr = await unwrapList<unknown>(listRes);
    expect(arr.length, 'contrato recem-criado sem aditivos').toBe(0);
  });
});
