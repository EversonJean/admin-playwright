import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiErrorBody } from '../../helpers/addendums';
import { apiGetEvent } from '../../helpers/api-event-flow';
import { setupFormalizedContract } from '../../helpers/setup-flows';
import { assertOk, readJson, unwrapList } from '../../helpers/response';

/**
 * Fluxo: 9.4 — Aditivos de contrato
 * Diagrama: docs/fluxos/negocio-9.4-aditivos.mmd
 *
 * Aditivo so pode ser criado em Contract Formalized/Active. Reusa
 * `setupFormalizedContract` que faz a cadeia completa (template+clausula
 * +contract+send+webhook sign HMAC real).
 *
 * Etapa 287 (PLANO-ADITIVOS-COM-APROVACAO §5 item 2, A21): a mudança da festa
 * (data, crianças, ajuste) se calcula pela própria festa
 * (`POST /api/events/{id}/contract-changes/preview`); o `preview-impact` do
 * contrato com seção de evento recusa com 400 `Addendums.ScopeViaEvent`.
 */

function shiftDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test.describe('Fluxo 9.4 — Aditivos', () => {
  test('@flow listagem de eventos carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/events/list');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test('@crud preview pela festa em contrato Formalized devolve o conjunto de mudancas sem gravar', async ({
    authApi,
    tenant,
  }) => {
    const { contractId, eventId } = await setupFormalizedContract(authApi, tenant.tenantId);
    const before = (await apiGetEvent(authApi, eventId)) as unknown as {
      eventDate: string;
      childrenCount: number;
      total: number;
    };
    const newDate = shiftDate(before.eventDate, 30);
    const newChildren = before.childrenCount + 5;

    const previewRes = await authApi.post(`/api/events/${eventId}/contract-changes/preview`, {
      data: { eventDate: newDate, childrenCount: newChildren, manualAdjustment: 200 },
    });
    await assertOk(previewRes, 'POST contract-changes/preview');
    const preview = await readJson<{
      contractId: string;
      hasChanges: boolean;
      totalBefore: number;
      manualAdjustment: number;
      financialImpact: number;
      changeSet: {
        schedule: { before: { date: string }; after: { date: string } } | null;
        childrenCount: { before: number; after: number } | null;
        manualAdjustment: { amount: number } | null;
      };
    }>(previewRes);
    expect(preview.contractId).toBe(contractId);
    expect(preview.hasChanges, 'a prévia tem o que propor').toBe(true);
    expect(preview.changeSet.schedule?.before.date).toBe(before.eventDate);
    expect(preview.changeSet.schedule?.after.date).toBe(newDate);
    expect(preview.changeSet.childrenCount?.after).toBe(newChildren);
    expect(preview.changeSet.manualAdjustment?.amount).toBe(200);
    expect(preview.manualAdjustment).toBe(200);
    expect(preview.totalBefore).toBeCloseTo(before.total, 2);

    // A prévia não grava: a festa continua igual e nenhum aditivo nasce.
    const after = (await apiGetEvent(authApi, eventId)) as unknown as {
      eventDate: string;
      childrenCount: number;
      total: number;
    };
    expect(after.eventDate).toBe(before.eventDate);
    expect(after.childrenCount).toBe(before.childrenCount);
    expect(after.total).toBeCloseTo(before.total, 2);
    const listRes = await authApi.get(`/api/contracts/${contractId}/addendums`);
    await assertOk(listRes, 'GET addendums');
    expect((await unwrapList<unknown>(listRes)).length, 'a prévia não cria aditivo').toBe(0);
  });

  test('@crud preview-impact do contrato com data e criancas recusa com Addendums.ScopeViaEvent', async ({
    authApi,
    tenant,
  }) => {
    const { contractId } = await setupFormalizedContract(authApi, tenant.tenantId);

    const newDate = new Date(Date.now() + 45 * 86400000).toISOString();
    const previewRes = await authApi.post(`/api/contracts/${contractId}/addendums/preview-impact`, {
      data: { newEventDate: newDate, newGuestCount: 25, priceDelta: 200 },
    });
    expect(previewRes.status(), 'escopo de festa pelo contrato').toBe(400);
    const err = await apiErrorBody(previewRes);
    expect(err.codes).toContain('Addendums.ScopeViaEvent');
    expect(err.descriptions.join(' ')).toContain('Mudanças na festa se propõem pela própria festa.');
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
