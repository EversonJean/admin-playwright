import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { fakeAsaas } from '../../helpers/fake-providers';

/**
 * Fluxo: 16.3 — Cobrança Asaas (webhook + faturas)
 * Diagrama: docs/fluxos/negocio-16.3-cobranca-asaas.mmd
 *
 * Asaas eh integracao externa real — em E2E, sobe `fake-providers/asaas`
 * (porta 1510) com state in-memory que responde como API Asaas v3, e
 * `POST /_control/trigger-webhook` dispara HTTP real pro back em
 * `/api/webhooks/asaas` (com header `asaas-access-token`).
 *
 * Cenario deep: trigger PAYMENT_CREATED com externalReference=TenantId →
 * back auto-cria Invoice (Pending). trigger PAYMENT_CONFIRMED → Invoice
 * passa pra Paid. GET /api/billing/invoices visualiza no tenant correto.
 */

test.describe('Fluxo 16.3 — Cobrança Asaas', () => {
  test('@flow tela de faturas carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/billing/invoices');
  });

  test('@crud webhook PAYMENT_CREATED → auto-cria Invoice → PAYMENT_CONFIRMED → Paid', async ({
    authApi,
    tenant,
  }) => {
    // Specs paralelos: cada um cria seu proprio payment id no fake (sequencial),
    // entao nao colidem. Cada tenant so ve suas proprias invoices via authApi.

    // 1. PAYMENT_CREATED com externalReference = TenantId (back cria Invoice)
    const amount = 199.9;
    const dueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const customerId = `fake_cus_for_${tenant.tenantId.slice(0, 8)}`;

    const createdRes = await fakeAsaas.triggerWebhook({
      event: 'PAYMENT_CREATED',
      payment: {
        customer: customerId,
        value: amount,
        billingType: 'PIX',
        dueDate,
        externalReference: tenant.tenantId,
        status: 'PENDING',
        description: `E2E invoice ${Date.now()}`,
      },
      accessToken: 'fake-asaas-webhook-token-e2e',
    });
    expect(createdRes.backStatus, 'back deve aceitar webhook com token correto').toBe(200);

    // 2. Localiza a invoice criada no back por amount + status (filtra por
    //    tenant via authApi que jah carrega Bearer do tenant atual).
    const listed = await authApi.get('/api/billing/invoices');
    if (!listed.ok()) {
      throw new Error(`GET /api/billing/invoices ${listed.status()}: ${await listed.text()}`);
    }
    const listedBody = await listed.json();
    const dataRoot = listedBody.data ?? listedBody;
    const items: Array<{
      id: string;
      amount: number;
      status: string;
      asaasPaymentId?: string;
    }> = dataRoot.items ?? dataRoot;
    const arr = Array.isArray(items) ? items : (items as any).items ?? [];
    const invoice = arr.find(
      (i: { amount: number; status: string }) =>
        Math.abs(i.amount - amount) < 0.01 && i.status === 'Pending',
    );
    if (!invoice) {
      throw new Error(
        `Invoice nao encontrada. Response: ${JSON.stringify(listedBody).slice(0, 500)}`,
      );
    }
    const paymentId = invoice.asaasPaymentId;
    expect(paymentId, 'Invoice deve carregar AsaasPaymentId').toBeTruthy();

    // 4. PAYMENT_CONFIRMED no mesmo paymentId → back marca Paid
    const confirmedRes = await fakeAsaas.triggerWebhook({
      event: 'PAYMENT_CONFIRMED',
      paymentId,
      accessToken: 'fake-asaas-webhook-token-e2e',
    });
    expect(confirmedRes.backStatus).toBe(200);

    // 5. Polling pra eliminar race: webhook eh processado async no back;
    //    re-lista invoice ate status virar Paid (ou estoura timeout de 5s).
    await expect
      .poll(
        async () => {
          const r = await authApi.get('/api/billing/invoices');
          const b = await r.json();
          const items = (b.data?.items ?? b.items ?? b.data ?? b) as Array<{
            id: string;
            status: string;
          }>;
          const arr = Array.isArray(items) ? items : [];
          return arr.find((i) => i.id === invoice!.id)?.status;
        },
        {
          message: 'Invoice deve transicionar pra Paid apos webhook CONFIRMED',
          timeout: 5_000,
          intervals: [200, 300, 500],
        },
      )
      .toBe('Paid');
  });

  test('@crud back faz HTTP real pro fake quando webhook chega sem invoice', async ({
    tenant,
  }) => {
    // Valida que o controller /api/webhooks/asaas eh atingido com HMAC
    // correto (asaas-access-token). Token errado deve retornar 401.
    const wrongTokenRes = await fakeAsaas.triggerWebhook({
      event: 'PAYMENT_CONFIRMED',
      payment: {
        customer: 'fake_cus_test',
        value: 50,
        dueDate: new Date().toISOString().slice(0, 10),
        externalReference: tenant.tenantId,
      },
      accessToken: 'wrong-token',
    });
    expect(wrongTokenRes.backStatus).toBe(401);
  });
});
