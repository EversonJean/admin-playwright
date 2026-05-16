import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { fakeAsaas, fakeClicksign } from '../../helpers/fake-providers';
import { setupFormalizedContract } from '../../helpers/setup-flows';
import { assertOk, readJson, unwrapList } from '../../helpers/response';

/**
 * Cobertura sistemica — webhooks devem ser idempotentes (re-entrega do
 * mesmo eventId nao duplica efeito).
 */

interface InvoiceItem {
  id: string;
  amount: number;
  status: string;
  asaasPaymentId?: string;
}

test.describe('Idempotencia de webhook Asaas', () => {
  test('@crud 2x mesmo eventId+paymentId -> invoice criada apenas 1x', async ({
    authApi,
    tenant,
  }) => {
    const dueDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const eventId = `fake_evt_idemp_${Date.now()}`;
    const uniqueAmount = 999.91;

    // Primeira entrega: cria payment no fake + auto-cria invoice no back
    const r1 = await fakeAsaas.triggerWebhook({
      event: 'PAYMENT_CREATED',
      eventId,
      payment: {
        customer: 'fake_cus_idemp',
        value: uniqueAmount,
        billingType: 'PIX',
        dueDate,
        externalReference: tenant.tenantId,
        status: 'PENDING',
      },
      accessToken: 'fake-asaas-webhook-token-e2e',
    });
    expect(r1.backStatus).toBe(200);

    // Pega o paymentId que o fake criou
    const listRes1 = await authApi.get('/api/billing/invoices');
    await assertOk(listRes1, 'GET invoices apos primeira entrega');
    const arr1 = await unwrapList<InvoiceItem>(listRes1);
    const created = arr1.find((i) => Math.abs(i.amount - uniqueAmount) < 0.01);
    expect(created, 'primeira entrega criou invoice').toBeTruthy();
    const paymentId = created!.asaasPaymentId!;

    // Segunda entrega: MESMO eventId + MESMO paymentId
    const r2 = await fakeAsaas.triggerWebhook({
      event: 'PAYMENT_CREATED',
      eventId,
      paymentId,
      accessToken: 'fake-asaas-webhook-token-e2e',
    });
    expect(r2.backStatus, 'webhook duplicado aceita 200 (idempotente)').toBe(200);

    // Confirma que NAO duplicou invoice
    const listRes2 = await authApi.get('/api/billing/invoices');
    await assertOk(listRes2, 'GET invoices apos segunda entrega');
    const arr2 = await unwrapList<InvoiceItem>(listRes2);
    const matchingInvoices = arr2.filter((i) => Math.abs(i.amount - uniqueAmount) < 0.01);
    expect(
      matchingInvoices.length,
      'webhook idempotente NAO deve duplicar invoice',
    ).toBe(1);
  });
});

test.describe('Idempotencia de webhook Clicksign', () => {
  test('@crud 2x webhook sign no mesmo doc -> contract continua Formalized', async ({
    authApi,
    tenant,
  }) => {
    const { contractId, envelope } = await setupFormalizedContract(authApi, tenant.tenantId);

    // Re-disparar webhook sign — back ja formalizou no setup
    const r = await fakeClicksign.triggerWebhook({
      event: 'sign',
      providerDocumentKey: envelope.providerDocumentKey,
      providerSignerKey: envelope.providerSignerKey,
    });
    expect(r.backStatus, 'webhook duplicado aceita 200').toBe(200);

    // Contract continua Formalized
    const ctRes = await authApi.get(`/api/contracts/${contractId}`);
    await assertOk(ctRes, 'GET contract');
    const ct = await readJson<{ status: string }>(ctRes);
    expect(ct.status, 'contract permanece Formalized apos webhook duplicado').toBe('Formalized');
  });
});
