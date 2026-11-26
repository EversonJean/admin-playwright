import type { APIRequestContext } from '@playwright/test';

import { authTest as test, expect } from '../../fixtures/auth.fixture';
import {
  apiErrorBody,
  apiFormalizeContractManually,
  apiListContractAddendums,
  apiTryProposeContractChange,
} from '../../helpers/addendums';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import { apiCreateActivity, apiCreatePackage, apiSetSettingParameter } from '../../helpers/api-entities';
import {
  apiCreatePaymentPlan,
  apiGetPaymentPlan,
  apiGetPaymentSummary,
  apiListClientCredits,
  apiRegisterPayment,
  EventInstallment,
} from '../../helpers/api-event-flow';
import { assertOk, readJson, unwrapList } from '../../helpers/response';
import { loginAsRole, setupDraftContract } from '../../helpers/setup-flows';

/**
 * Fluxo: 9.8 — Aditivo de escopo, preço e pagamento
 * Diagrama: docs/fluxos/negocio-9.8-aditivo-de-escopo-e-pagamento.mmd
 * Cenário: docs/cenarios-de-teste/9-contratos/9.8-aditivo-de-escopo-e-pagamento.md (CF-01 a CF-04, CE-04, CE-07 a CE-09)
 *
 * PLANO-ADITIVOS-COM-APROVACAO §5 (AD-C) itens 1 a 4, decisões 1 e 10, A20 a A22, A27:
 * - quem tem `events.update` propõe pela festa (`POST /api/events/{id}/contract-changes`);
 *   o Events precifica (linha do pacote novo pelo catálogo, extras preservados) e o
 *   EventPayments mostra as parcelas; a proposta não muda a festa, os itens, o
 *   total nem as parcelas (A20);
 * - propor de novo com o rascunho aberto funde nele (mesmo número, revisão + 1);
 * - redução maior que o saldo em aberto: o excedente vira crédito do cliente na
 *   prévia; acima do "Saldo máximo de crédito por cliente", a prévia avisa e a
 *   proposta é recusada com `CreditBalance.MaxBalanceExceeded`;
 * - sem `events.update`: 403; festa de outra empresa: 404; nada é criado.
 */

const CREDIT_MAX_BALANCE = 'CREDIT_MAX_BALANCE_PER_CLIENT';

function dayPlus(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** Plano em 3 parcelas (vencem em 3, 7 e 10 dias) com o sinal pago, como a massa do 9.8 (festa 1). */
async function planWithDepositPaid(api: APIRequestContext, eventId: string): Promise<EventInstallment[]> {
  const total = (await apiGetPaymentSummary(api, eventId)).eventTotal;
  const part = Math.floor((total / 3) * 100) / 100;
  const last = Math.round((total - part * 2) * 100) / 100;
  const plan = await apiCreatePaymentPlan(api, eventId, [
    { order: 1, label: 'Sinal', expectedAmount: part, dueDate: dayPlus(3) },
    { order: 2, label: 'Segunda parcela', expectedAmount: part, dueDate: dayPlus(7) },
    { order: 3, label: 'Quitação', expectedAmount: last, dueDate: dayPlus(10) },
  ]);
  const deposit = plan.installments.find((i) => i.order === 1)!;
  await apiRegisterPayment(api, eventId, { amount: deposit.expectedAmount, method: 'Pix', installmentId: deposit.id });
  return (await apiGetPaymentPlan(api, eventId))!.installments;
}

/** Festa com contrato formalizado por aceite manual e o plano com o sinal pago. */
async function setupFormalizedWithPlan(api: APIRequestContext, tenantId: string) {
  const draft = await setupDraftContract(api, tenantId);
  const installments = await planWithDepositPaid(api, draft.eventId);
  await apiFormalizeContractManually(api, draft.contractId);
  return { ...draft, installments };
}

interface PricingLine {
  sourceType: string;
  sourceId: string | null;
  totalPrice: number;
}

interface EventState {
  total: number;
  packageId: string | null;
  location: string | null;
  items: Array<{ sourceType: string; sourceId: string | null; totalPrice: number }>;
  installments: Array<{ id: string; expectedAmount: number; paidAmount: number; status: string }>;
}

/** O que a proposta não pode mudar: total, pacote, local, itens de preço e parcelas. */
async function eventState(api: APIRequestContext, eventId: string): Promise<EventState> {
  const eventRes = await api.get(`/api/events/${eventId}`);
  await assertOk(eventRes, 'GET /api/events/{id}');
  const event = await readJson<{ total: number; packageId: string | null; location: string | null }>(eventRes);
  const itemsRes = await api.get(`/api/events/${eventId}/pricing-items`);
  await assertOk(itemsRes, 'GET /api/events/{id}/pricing-items');
  const items = (await unwrapList<PricingLine>(itemsRes))
    .map((i) => ({ sourceType: i.sourceType, sourceId: i.sourceId, totalPrice: i.totalPrice }))
    .sort((a, b) => `${a.sourceType}${a.sourceId}`.localeCompare(`${b.sourceType}${b.sourceId}`));
  const plan = await apiGetPaymentPlan(api, eventId);
  const installments = (plan?.installments ?? [])
    .map((i) => ({ id: i.id, expectedAmount: i.expectedAmount, paidAmount: i.paidAmount, status: i.status }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { total: event.total, packageId: event.packageId, location: event.location, items, installments };
}

interface PreviewResult {
  totalBefore: number;
  totalAfter: number;
  financialImpact: number;
  packageIdAfter: string | null;
  itemsBefore: PricingLine[];
  itemsAfter: PricingLine[];
  hasChanges: boolean;
  payment: {
    mode: string;
    creditAmount: number;
    creditExceedsLimit: boolean;
    installments: Array<{ installmentId: string | null; order: number; amountAfter: number; change: string }>;
  } | null;
  warnings: Array<{ kind: string; code: string; message: string }>;
}

async function preview(api: APIRequestContext, eventId: string, change: Record<string, unknown>): Promise<PreviewResult> {
  const res = await api.post(`/api/events/${eventId}/contract-changes/preview`, { data: change });
  await assertOk(res, 'POST /api/events/{id}/contract-changes/preview');
  return readJson<PreviewResult>(res);
}

test.describe('Fluxo 9.8 — Aditivo de escopo, preço e pagamento', () => {
  test('@flow gestor propoe pela festa a troca de pacote com parcela extra; a festa nao muda e a segunda proposta funde', async ({
    authApi,
    tenant,
  }) => {
    const { eventId, contractId } = await setupFormalizedWithPlan(authApi, tenant.tenantId);
    const before = await eventState(authApi, eventId);
    const extraActivityIds = before.items.filter((i) => i.sourceType === 'Activity').map((i) => i.sourceId);
    expect(extraActivityIds.length, 'a festa tem a atividade do orçamento').toBeGreaterThan(0);
    const packageActivity = await apiCreateActivity(authApi);
    const pkg = await apiCreatePackage(authApi, { activityIds: [packageActivity.id] });

    // Decisão 1: o Gestor (events.update) propõe, sem passar pelo caminho do contrato.
    const manager = await loginAsRole(tenant.tenantId, 'Manager');
    try {
      const change = { packageId: pkg.id, payment: { mode: 'ExtraInstallments', installmentCount: 1 } };
      const p = await preview(manager.api, eventId, change);
      expect(p.hasChanges).toBe(true);
      expect(p.packageIdAfter).toBe(pkg.id);
      expect(p.itemsAfter[0]?.sourceType, 'o pacote novo primeiro').toBe('Package');
      expect(p.itemsAfter[0]?.sourceId).toBe(pkg.id);
      for (const activityId of extraActivityIds) {
        expect(
          p.itemsAfter.some((i) => i.sourceType === 'Activity' && i.sourceId === activityId),
          'a atividade que a festa já tinha continua',
        ).toBe(true);
      }
      expect(p.totalBefore).toBeCloseTo(before.total, 2);
      expect(p.totalAfter).toBeGreaterThan(p.totalBefore);
      expect(p.financialImpact).toBeCloseTo(p.totalAfter - p.totalBefore, 2);
      expect(p.payment?.mode).toBe('ExtraInstallments');
      const added = p.payment?.installments.filter((i) => i.installmentId === null) ?? [];
      expect(added, 'uma parcela extra nova').toHaveLength(1);
      expect(added[0]!.change).toBe('Added');
      expect(added[0]!.amountAfter).toBeCloseTo(p.financialImpact, 2);

      const proposeRes = await apiTryProposeContractChange(manager.api, eventId, 'Cliente trocou o pacote', change);
      await assertOk(proposeRes, 'POST contract-changes (Gestor)');
      expect(proposeRes.status()).toBe(201);
      const proposal = await readJson<{ addendumId: string; addendumNumber: number; status: string; revision: number; merged: boolean; financialImpact: number }>(proposeRes);
      expect(proposal.status).toBe('Draft');
      expect(proposal.addendumNumber).toBe(1);
      expect(proposal.merged).toBe(false);
      expect(proposal.financialImpact).toBeCloseTo(p.financialImpact, 2);

      // A20 — a festa, os itens, o total e as parcelas continuam iguais.
      expect(await eventState(authApi, eventId)).toEqual(before);

      // A parcela extra está no conjunto de mudanças do aditivo aberto.
      const pendingRes = await authApi.get(`/api/events/${eventId}/pending-contract-changes`);
      await assertOk(pendingRes, 'GET pending-contract-changes');
      const pending = await readJson<{
        addendumId: string;
        changeSet: {
          pricing: { packageIdAfter: string | null } | null;
          payment: { mode: string; installments: Array<{ installmentId: string | null; change: string }> } | null;
        };
      }>(pendingRes);
      expect(pending.addendumId).toBe(proposal.addendumId);
      expect(pending.changeSet.pricing?.packageIdAfter).toBe(pkg.id);
      expect(pending.changeSet.payment?.mode).toBe('ExtraInstallments');
      expect(pending.changeSet.payment?.installments.some((i) => i.installmentId === null && i.change === 'Added')).toBe(
        true,
      );

      // Propor de novo com o rascunho aberto funde nele.
      const againRes = await apiTryProposeContractChange(manager.api, eventId, 'Cliente trocou o pacote e o local', {
        ...change,
        location: `Salao novo ${Date.now()}`,
      });
      await assertOk(againRes, 'POST contract-changes (de novo)');
      expect(againRes.status()).toBe(200);
      const again = await readJson<{ addendumId: string; addendumNumber: number; revision: number; merged: boolean }>(againRes);
      expect(again.merged).toBe(true);
      expect(again.addendumId).toBe(proposal.addendumId);
      expect(again.addendumNumber).toBe(1);
      expect(again.revision).toBe(proposal.revision + 1);
    } finally {
      await manager.api.dispose();
    }
    expect(await apiListContractAddendums(authApi, contractId), 'um aditivo só').toHaveLength(1);
    expect(await eventState(authApi, eventId)).toEqual(before);
  });

  test('@flow reducao maior que o saldo em aberto vira credito na previa; acima do teto a proposta e recusada', async ({
    authApi,
    tenant,
  }) => {
    const { eventId, contractId, clienteId, installments } = await setupFormalizedWithPlan(authApi, tenant.tenantId);
    const deposit = installments.find((i) => i.order === 1)!;
    const before = await eventState(authApi, eventId);
    const change = { manualAdjustment: -before.total, payment: { mode: 'DistributeOverOpen' } };

    // A prévia desconta as parcelas em aberto até zerar e mostra o excedente como crédito.
    const p = await preview(authApi, eventId, change);
    expect(p.payment?.mode).toBe('DistributeOverOpen');
    expect(p.payment?.creditAmount, 'o excedente = o sinal já pago').toBeCloseTo(deposit.paidAmount, 2);
    expect(p.payment?.creditExceedsLimit).toBe(false);
    const byOrder = new Map((p.payment?.installments ?? []).map((i) => [i.order, i]));
    expect(byOrder.get(1)?.change, 'o sinal pago fica como está').toBe('Unchanged');
    for (const order of [2, 3]) {
      expect(byOrder.get(order)?.change).toBe('Decreased');
      expect(byOrder.get(order)?.amountAfter).toBeCloseTo(0, 2);
    }

    // Com o teto abaixo do crédito, a prévia avisa e a proposta é recusada.
    await apiSetSettingParameter(authApi, CREDIT_MAX_BALANCE, 1);
    const limited = await preview(authApi, eventId, change);
    expect(limited.payment?.creditExceedsLimit).toBe(true);
    expect(
      limited.warnings.some((w) => w.kind === 'Credit' && w.code === 'CreditBalance.MaxBalanceExceeded'),
      'aviso de crédito acima do teto',
    ).toBe(true);

    const refused = await apiTryProposeContractChange(authApi, eventId, 'Desconto acima do saldo', change);
    expect(refused.status()).toBeGreaterThanOrEqual(400);
    expect(refused.status()).toBeLessThan(500);
    expect((await apiErrorBody(refused)).codes).toContain('CreditBalance.MaxBalanceExceeded');

    // Sem aditivo, sem crédito e com o plano intacto.
    expect(await apiListContractAddendums(authApi, contractId)).toHaveLength(0);
    expect(await apiListClientCredits(authApi, clienteId)).toHaveLength(0);
    expect(await eventState(authApi, eventId)).toEqual(before);
  });

  test('@flow sem events.update a previa e a proposta dao 403; festa de outra empresa da 404; nada e criado', async ({
    authApi,
    tenant,
  }) => {
    const { eventId, contractId } = await setupFormalizedWithPlan(authApi, tenant.tenantId);
    const before = await eventState(authApi, eventId);
    const change = { location: `Outro salao ${Date.now()}` };

    // O Financeiro não tem `events.update`.
    const financial = await loginAsRole(tenant.tenantId, 'Financial');
    try {
      const previewRes = await financial.api.post(`/api/events/${eventId}/contract-changes/preview`, { data: change });
      expect(previewRes.status(), 'prévia sem events.update').toBe(403);
      const proposeRes = await apiTryProposeContractChange(financial.api, eventId, 'Sem permissao', change);
      expect(proposeRes.status(), 'proposta sem events.update').toBe(403);
    } finally {
      await financial.api.dispose();
    }

    const other = await signupNewTenant();
    const apiB = await createBearerApiContext(other.accessToken);
    try {
      const previewRes = await apiB.post(`/api/events/${eventId}/contract-changes/preview`, { data: change });
      expect(previewRes.status(), 'prévia na festa de outra empresa').toBe(404);
      const proposeRes = await apiTryProposeContractChange(apiB, eventId, 'Invasao', change);
      expect(proposeRes.status(), 'proposta na festa de outra empresa').toBe(404);
    } finally {
      await apiB.dispose();
    }

    expect(await apiListContractAddendums(authApi, contractId), 'nenhum aditivo no tenant dono').toHaveLength(0);
    expect(await eventState(authApi, eventId)).toEqual(before);
  });
});
