import { APIRequestContext } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { setInvoiceDueDateDirect, setSubscriptionActiveDirect } from '../../helpers/db-helper';
import { fakeAsaas } from '../../helpers/fake-providers';
import { assertOk, readJson, unwrapList } from '../../helpers/response';

/**
 * Fluxo: 16.3.1 — reconciliação das faturas com o Asaas (webhook perdido)
 * Plano: docs/implementar/PLANO-AJUSTES-DA-CONVERSAO.md §10 item 1 (AJ-D,
 * Etapa 201), D10 e "Testes" da §10. Registro e2e: E29.
 *
 *   1. Fatura do tenant paga no Asaas sem o webhook chegar: depois do
 *      vencimento, UM ciclo do worker de assinatura marca a fatura Paga e
 *      reativa a assinatura inadimplente.
 *   2. Fatura ainda pendente no Asaas continua pendente.
 *   3. Um segundo ciclo não muda nada.
 *
 * O ciclo é o do `SubscriptionLifecycleWorker` de verdade: o
 * `appsettings.E2E.json` o liga a cada 60 s (o piso dele). Não há endpoint de
 * disparo; um ciclo se reconhece pelo GET /payments/{id} que a reconciliação
 * faz no fake para cada fatura vencida em aberto.
 *
 * Pré-condição pelo caminho real: as duas faturas nascem pelo webhook
 * PAYMENT_CREATED (`externalReference` = tenant), e a inadimplência pelo
 * PAYMENT_OVERDUE. Gravados direto: a assinatura paga (`Active`; contratar
 * passa pelo Super Admin e pelo Asaas, fora do que o fluxo prova) e o
 * vencimento no passado (a fatura do webhook não nasce vencida).
 *
 * Sem diagrama `.mmd`: verificação de plano de ajustes.
 */

const WEBHOOK_TOKEN = 'fake-asaas-webhook-token-e2e';
/** Um ciclo a cada 60 s; a espera cobre um ciclo inteiro e a folga do commit. */
const CYCLE_TIMEOUT = 100_000;

interface InvoiceItem {
  id: string;
  asaasPaymentId: string | null;
  status: string;
  paidAt: string | null;
  amount: number;
  description: string | null;
}

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function invoices(api: APIRequestContext): Promise<InvoiceItem[]> {
  const res = await api.get('/api/billing/invoices?page=1&pageSize=50');
  await assertOk(res, 'GET /api/billing/invoices');
  return unwrapList<InvoiceItem>(res);
}

async function invoiceByPayment(api: APIRequestContext, paymentId: string): Promise<InvoiceItem> {
  const item = (await invoices(api)).find((i) => i.asaasPaymentId === paymentId);
  expect(item, `fatura do payment ${paymentId}`).toBeTruthy();
  return item!;
}

async function subscriptionStatus(api: APIRequestContext): Promise<string> {
  const res = await api.get('/api/billing/my-plan');
  await assertOk(res, 'GET /api/billing/my-plan');
  const plan = await readJson<{ subscription: { status: string } | null }>(res);
  return plan.subscription?.status ?? 'none';
}

/** Fatura vencida criada pelo webhook PAYMENT_CREATED; devolve o id do payment no fake. */
async function createPastDueInvoice(
  api: APIRequestContext,
  tenantId: string,
  amount: number,
): Promise<string> {
  const description = `E2E reconciliação ${amount} ${Date.now()}`;
  const created = await fakeAsaas.triggerWebhook({
    event: 'PAYMENT_CREATED',
    payment: {
      customer: `fake_cus_${tenantId.slice(0, 8)}`,
      value: amount,
      billingType: 'PIX',
      // A fatura do webhook é emitida agora e não aceita vencimento anterior
      // à emissão: nasce vencendo amanhã e o calendário "anda" pelo banco.
      dueDate: inDays(1),
      externalReference: tenantId,
      status: 'PENDING',
      description,
    },
    accessToken: WEBHOOK_TOKEN,
  });
  expect(created.backStatus, `PAYMENT_CREATED: ${created.backBody}`).toBe(200);

  const paymentOf = async (): Promise<string | null> =>
    (await invoices(api)).find((i) => i.description === description)?.asaasPaymentId ?? null;
  await expect.poll(paymentOf, { message: `fatura de ${amount} criada pelo webhook` }).not.toBeNull();
  const paymentId = (await paymentOf())!;
  setInvoiceDueDateDirect(paymentId, inDays(-3));
  return paymentId;
}

/** Quantas vezes a reconciliação consultou o payment no fake desde `since`. */
async function syncCalls(paymentId: string, since: string): Promise<number> {
  const inbox = await fakeAsaas.inbox({ since });
  return inbox.filter((e) => e.method === 'GET' && e.path.split('?')[0] === `/payments/${paymentId}`)
    .length;
}

test.describe('Fluxo 16.3.1 — Asaas reconciliation by the subscription worker', () => {
  test('@flow invoice paid at Asaas without webhook is reconciled by one worker cycle; pending stays pending; a second cycle changes nothing', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(330_000);

    // Assinatura paga, que fica inadimplente pelo webhook de vencimento.
    setSubscriptionActiveDirect(tenant.tenantId);
    expect(await subscriptionStatus(authApi)).toBe('Active');

    const paidAtAsaas = await createPastDueInvoice(authApi, tenant.tenantId, 149.9);
    const stillPending = await createPastDueInvoice(authApi, tenant.tenantId, 89.9);

    const overdue = await fakeAsaas.triggerWebhook({
      event: 'PAYMENT_OVERDUE',
      paymentId: paidAtAsaas,
      accessToken: WEBHOOK_TOKEN,
    });
    expect(overdue.backStatus, `PAYMENT_OVERDUE: ${overdue.backBody}`).toBe(200);
    await expect.poll(() => subscriptionStatus(authApi), { message: 'assinatura inadimplente' }).toBe(
      'PastDue',
    );
    expect((await invoiceByPayment(authApi, paidAtAsaas)).status).toBe('Overdue');
    expect((await invoiceByPayment(authApi, stillPending)).status).toBe('Pending');

    // O cliente paga no Asaas e o webhook se perde.
    const since = new Date().toISOString();
    await fakeAsaas.setPaymentStatus(paidAtAsaas, 'RECEIVED');

    // 1. Um ciclo do worker: consulta o Asaas e aplica o que está lá.
    await expect
      .poll(async () => (await invoiceByPayment(authApi, paidAtAsaas)).status, {
        message: 'fatura paga no Asaas reconciliada como Paid pelo ciclo do worker',
        timeout: CYCLE_TIMEOUT,
        intervals: [2_000],
      })
      .toBe('Paid');
    expect(await syncCalls(paidAtAsaas, since), 'a reconciliação consultou o payment no fake').toBeGreaterThan(0);

    const paid = await invoiceByPayment(authApi, paidAtAsaas);
    expect(paid.paidAt, 'fatura reconciliada tem data de pagamento').toBeTruthy();
    expect(await subscriptionStatus(authApi), 'assinatura reativada').toBe('Active');

    // 2. A pendente é consultada no mesmo ciclo (a ordem entre as duas é pelo
    //    id, então pode vir depois da paga) e continua pendente.
    await expect
      .poll(() => syncCalls(stillPending, since), {
        message: 'o ciclo também consulta a fatura ainda pendente no Asaas',
        timeout: CYCLE_TIMEOUT,
        intervals: [1_000],
      })
      .toBeGreaterThan(0);
    expect((await invoiceByPayment(authApi, stillPending)).status).toBe('Pending');

    // 3. Segundo ciclo: reconhecido por uma nova consulta da pendente.
    const secondSince = new Date().toISOString();
    await expect
      .poll(() => syncCalls(stillPending, secondSince), {
        message: 'segundo ciclo do worker consulta a fatura ainda pendente',
        timeout: CYCLE_TIMEOUT,
        intervals: [2_000],
      })
      .toBeGreaterThan(0);

    const paidAfter = await invoiceByPayment(authApi, paidAtAsaas);
    expect(paidAfter.status).toBe('Paid');
    expect(paidAfter.paidAt).toBe(paid.paidAt);
    expect(await syncCalls(paidAtAsaas, secondSince), 'fatura já paga não é consultada de novo').toBe(0);
    expect((await invoiceByPayment(authApi, stillPending)).status).toBe('Pending');
    expect(await subscriptionStatus(authApi)).toBe('Active');
  });

  // O item 2 sozinho, sem depender da fatura paga do teste acima.
  test('@flow invoice still pending at Asaas stays pending through two worker cycles', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(330_000);
    setSubscriptionActiveDirect(tenant.tenantId);
    const pending = await createPastDueInvoice(authApi, tenant.tenantId, 79.9);

    for (const cycle of ['primeiro', 'segundo']) {
      const since = new Date().toISOString();
      await expect
        .poll(() => syncCalls(pending, since), {
          message: `${cycle} ciclo do worker consulta a fatura pendente no Asaas`,
          timeout: CYCLE_TIMEOUT,
          intervals: [2_000],
        })
        .toBeGreaterThan(0);
      expect((await invoiceByPayment(authApi, pending)).status, `depois do ${cycle} ciclo`).toBe('Pending');
    }
  });
});
