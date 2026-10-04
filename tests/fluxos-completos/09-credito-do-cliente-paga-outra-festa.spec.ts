import { APIRequestContext } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { twoTenantsTest } from '../../fixtures/two-tenants.fixture';
import { apiCompleteOnboarding, apiCreateClient } from '../../helpers/api-entities';
import {
  apiGetPaymentSummary,
  apiIssueCredit,
  apiListClientCredits,
  CreditBalanceItem,
  registerPaymentBody,
} from '../../helpers/api-event-flow';
import { setCreditExpiresAtDirect } from '../../helpers/db-helper';
import { assertOk } from '../../helpers/response';
import { setupAcceptedEvent, setupPaidEvent, setupPortalUser } from '../../helpers/setup-flows';

/**
 * Fluxo completo 09 — o crédito do cliente paga outra festa dele
 * Plano: docs/implementar/PLANO-AJUSTES-DA-CONVERSAO.md §7 item 1 (AJ-C,
 * Etapa 198) e D5; "Testes" da §7. Registro e2e: E18 e E19.
 * Regra: docs/planejamento/13.2-financeiro.md, entidade `CreditBalance` —
 * "Quando crédito é aplicado a novo evento, gera `PaymentEntry` com
 * `method = Credit` e referência ao `CreditBalance`".
 *
 *   1. A festa é cancelada e o que o cliente já pagou vira crédito dele
 *      (ajuste `Credit` na parcela paga).
 *   2. Na outra festa do mesmo cliente, "Registrar pagamento" oferece a forma
 *      "Crédito do cliente" com os créditos UTILIZÁVEIS dele: crédito vencido e
 *      crédito de outro cliente não aparecem.
 *   3. Pagar com o crédito baixa o saldo do crédito e o saldo devedor da festa
 *      no mesmo valor.
 *   4. Usuário do portal não paga com crédito (403); crédito de outro tenant
 *      não paga festa do tenant A.
 *
 * Sem diagrama `.mmd`: verificação de plano de ajustes.
 */

/** Data `yyyy-MM-dd` de N dias atrás, longe o bastante para estar no passado em qualquer fuso. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** Valor como o `CurrencyPipe` pt-BR mostra, sem o "R$" (o espaço dele é não separável). */
function brl(value: number): string {
  return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    value,
  );
}

async function creditByAdjustment(
  api: APIRequestContext,
  clientId: string,
  adjustmentId: string,
): Promise<CreditBalanceItem> {
  const credit = (await apiListClientCredits(api, clientId)).find(
    (c) => c.originAdjustmentId === adjustmentId,
  );
  expect(credit, `crédito do ajuste ${adjustmentId}`).toBeTruthy();
  return credit!;
}

test.describe('Fluxo 09 — client credit pays another party', () => {
  test('@flow cancelled party becomes credit and the credit pays the next party through "Crédito do cliente"', async ({
    authApi,
    authPage,
  }) => {
    const client = await apiCreateClient(authApi);

    // 1. Festa paga e cancelada: o pago vira crédito do cliente.
    const canceled = await setupPaidEvent(authApi, { clientId: client.id });
    expect(canceled.total).toBeGreaterThanOrEqual(400);
    await assertOk(
      await authApi.post(`/api/events/${canceled.eventId}/cancel`, {
        data: { reason: 'Cliente desistiu da data' },
      }),
      'POST /api/events/{id}/cancel',
    );
    const adjustment = await apiIssueCredit(authApi, canceled.eventId, {
      installmentId: canceled.installmentId,
      amount: 300,
      reason: 'Festa cancelada vira crédito',
    });
    const credit = await creditByAdjustment(authApi, client.id, adjustment.id);
    expect(credit.balance).toBe(300);

    // Crédito do mesmo cliente, mas vencido: não pode aparecer.
    const expiredAdjustment = await apiIssueCredit(authApi, canceled.eventId, {
      installmentId: canceled.installmentId,
      amount: 50,
      reason: 'Crédito antigo',
    });
    const expired = await creditByAdjustment(authApi, client.id, expiredAdjustment.id);
    setCreditExpiresAtDirect(expired.id, daysAgo(5));

    // Crédito de OUTRO cliente do mesmo tenant: também não.
    const other = await setupPaidEvent(authApi);
    const otherAdjustment = await apiIssueCredit(authApi, other.eventId, {
      installmentId: other.installmentId,
      amount: 80,
    });
    const otherCredit = await creditByAdjustment(authApi, other.clienteId, otherAdjustment.id);

    // A lista da forma "Crédito" (usableOnly) só tem o crédito bom.
    const usable = await apiListClientCredits(authApi, client.id, true);
    expect(usable.map((c) => c.id)).toEqual([credit.id]);

    // 2. A próxima festa do mesmo cliente, ainda sem nenhum pagamento.
    const next = await setupAcceptedEvent(authApi, { clientId: client.id });
    const before = await apiGetPaymentSummary(authApi, next.eventId);
    expect(before.balance).toBeGreaterThan(120);

    await apiCompleteOnboarding(authApi);
    await authPage.goto(`/app/events/${next.eventId}`);
    await authPage.getByRole('tab', { name: 'Financeiro', exact: true }).click();
    await authPage.getByTestId('event-detail-payments-register').click();
    await expect(authPage.getByTestId('register-payment-title')).toBeVisible();

    await authPage.getByTestId('register-payment-method').click();
    await authPage.getByTestId('register-payment-method-Credit').click();

    await authPage.getByTestId('register-payment-credit').click();
    await expect(authPage.getByTestId(`register-payment-credit-${credit.id}`)).toBeVisible();
    await expect(authPage.getByTestId(`register-payment-credit-${expired.id}`)).toHaveCount(0);
    await expect(authPage.getByTestId(`register-payment-credit-${otherCredit.id}`)).toHaveCount(0);
    await authPage.getByTestId(`register-payment-credit-${credit.id}`).click();

    await authPage.getByTestId('register-payment-amount').fill('120');
    await authPage.getByTestId('register-payment-submit').click();
    await expect(authPage.getByTestId('register-payment-title')).toHaveCount(0, { timeout: 15_000 });

    // 3. Os dois saldos caem juntos, no mesmo valor.
    await expect(authPage.getByTestId('event-detail-payments-balance')).toContainText(
      brl(before.balance - 120),
      { timeout: 15_000 },
    );
    const after = await apiGetPaymentSummary(authApi, next.eventId);
    expect(after.balance).toBeCloseTo(before.balance - 120, 2);
    expect(after.totalPaid).toBeCloseTo(before.totalPaid + 120, 2);
    expect(after.entries.map((e) => e.method)).toEqual(['Credit']);

    const used = await creditByAdjustment(authApi, client.id, adjustment.id);
    expect(used.balance).toBe(180);
    expect(used.usedAmount).toBe(120);
    expect(used.status).toBe('PartiallyUsed');

    // Os créditos que não apareceram continuam intactos.
    expect((await creditByAdjustment(authApi, client.id, expiredAdjustment.id)).balance).toBe(50);
    expect((await creditByAdjustment(authApi, other.clienteId, otherAdjustment.id)).balance).toBe(80);
  });

  test('@flow collaborator portal user gets 403 when paying with credit', async ({
    authApi,
    tenant,
  }) => {
    const paid = await setupPaidEvent(authApi);
    const adjustment = await apiIssueCredit(authApi, paid.eventId, {
      installmentId: paid.installmentId,
      amount: 100,
    });
    const credit = await creditByAdjustment(authApi, paid.clienteId, adjustment.id);
    const next = await setupAcceptedEvent(authApi, { clientId: paid.clienteId });
    const before = await apiGetPaymentSummary(authApi, next.eventId);

    const portal = await setupPortalUser(authApi, tenant.tenantId);
    try {
      const res = await portal.portalApi.post(`/api/events/${next.eventId}/payments`, {
        data: registerPaymentBody({ amount: 50, method: 'Credit', creditBalanceId: credit.id }),
      });
      expect(res.status()).toBe(403);
    } finally {
      await portal.portalApi.dispose();
      await portal.publicApiDispose();
    }

    const after = await apiGetPaymentSummary(authApi, next.eventId);
    expect(after.balance).toBe(before.balance);
    expect(after.entries).toHaveLength(0);
    expect((await creditByAdjustment(authApi, paid.clienteId, adjustment.id)).balance).toBe(100);
  });
});

twoTenantsTest.describe('Fluxo 09 — client credit: tenant isolation', () => {
  twoTenantsTest('@flow a credit of tenant B does not pay a party of tenant A', async ({
    apiA,
    apiB,
    tenantA,
    tenantB,
  }) => {
    expect(tenantB.tenantId, 'dois tenants distintos').not.toBe(tenantA.tenantId);

    const paidB = await setupPaidEvent(apiB);
    const adjustmentB = await apiIssueCredit(apiB, paidB.eventId, {
      installmentId: paidB.installmentId,
      amount: 100,
    });
    const creditB = await creditByAdjustment(apiB, paidB.clienteId, adjustmentB.id);

    const partyA = await setupAcceptedEvent(apiA);
    const before = await apiGetPaymentSummary(apiA, partyA.eventId);

    // O gestor de A tenta usar o id do crédito de B na festa de A.
    const res = await apiA.post(`/api/events/${partyA.eventId}/payments`, {
      data: registerPaymentBody({ amount: 50, method: 'Credit', creditBalanceId: creditB.id }),
    });
    expect(res.status(), await res.text()).toBe(400);
    expect(await res.text()).toContain('CreditBalance.NotAvailableForClient');

    const after = await apiGetPaymentSummary(apiA, partyA.eventId);
    expect(after.balance).toBe(before.balance);
    expect(after.entries).toHaveLength(0);
    expect((await creditByAdjustment(apiB, paidB.clienteId, adjustmentB.id)).balance).toBe(100);
  });

  twoTenantsTest('@flow tenant B paying a party of tenant A with its credit gets 404', async ({
    apiA,
    apiB,
  }) => {
    twoTenantsTest.fail(
      true,
      'SEG-G item 0 (PLANO-SEGURANCA): filtro de tenant desligado em request autenticado; tirar esta marca quando a SEG-G sair',
    );

    const paidB = await setupPaidEvent(apiB);
    const adjustmentB = await apiIssueCredit(apiB, paidB.eventId, {
      installmentId: paidB.installmentId,
      amount: 100,
    });
    const creditB = await creditByAdjustment(apiB, paidB.clienteId, adjustmentB.id);
    const partyA = await setupAcceptedEvent(apiA);

    // A festa de A não existe para B (§7, "Testes": cross-tenant 404).
    const res = await apiB.post(`/api/events/${partyA.eventId}/payments`, {
      data: registerPaymentBody({ amount: 50, method: 'Credit', creditBalanceId: creditB.id }),
    });
    expect(res.status(), (await res.text()).slice(0, 300)).toBe(404);
  });
});
