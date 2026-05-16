import { createFakeServer, registerTriggerWebhook } from '@fake-providers/shared';
import * as state from './state.js';

/**
 * Fake Asaas server — implementa o subset da API v3 que `AsaasBillingProvider`
 * chama no back (CRONOGRAMA §1571-1575):
 *
 *   GET  /customers?email=<email>   → lookup por email (anti-duplicidade)
 *   POST /customers                  → cria customer { id, ... }
 *   POST /payments                   → cria payment   { id, status, billingType, invoiceUrl, ... }
 *   GET  /payments/:id               → sync de status
 *
 * Webhook callback é disparado por `POST /_control/trigger-webhook` que
 * envia HTTP real assinado pro back em `/api/webhooks/asaas` (header
 * `asaas-access-token` quando o token está configurado).
 *
 * Auth: aceita qualquer `access_token`; em E2E o back manda dummy.
 */

const PORT = Number(process.env.FAKE_ASAAS_PORT ?? 1510);

await createFakeServer({
  name: 'asaas',
  port: PORT,
  registerRoutes: (app, dispatcher) => {
    app.delete('/_control/state', async () => {
      state.reset();
      return { reset: true };
    });

    app.get<{ Querystring: { email?: string } }>(
      '/customers',
      async (req) => {
        const email = req.query.email;
        if (email) {
          const found = state.findCustomerByEmail(email);
          return {
            data: found ? [found] : [],
            object: 'list',
            hasMore: false,
            limit: 10,
            offset: 0,
            totalCount: found ? 1 : 0,
          };
        }
        return { data: [], object: 'list', hasMore: false, limit: 10, offset: 0, totalCount: 0 };
      },
    );

    app.post<{
      Body: {
        name?: string;
        email?: string;
        cpfCnpj?: string;
        externalReference?: string;
      };
    }>('/customers', async (req, reply) => {
      const body = req.body;
      if (!body?.name || !body.email) {
        reply.status(400);
        return { errors: [{ code: 'invalid_body', description: 'name/email obrigatorios' }] };
      }
      const created = state.createCustomer({
        name: body.name,
        email: body.email,
        cpfCnpj: body.cpfCnpj,
        externalReference: body.externalReference,
      });
      reply.status(200);
      return created;
    });

    app.post<{
      Body: {
        customer?: string;
        value?: number;
        billingType?: string;
        dueDate?: string;
        description?: string;
        externalReference?: string;
      };
    }>('/payments', async (req, reply) => {
      const body = req.body;
      if (!body?.customer || typeof body.value !== 'number' || !body.dueDate) {
        reply.status(400);
        return { errors: [{ code: 'invalid_body', description: 'customer/value/dueDate obrigatorios' }] };
      }
      const created = state.createPayment({
        customer: body.customer,
        value: body.value,
        billingType: body.billingType ?? 'UNDEFINED',
        dueDate: body.dueDate,
        description: body.description,
        externalReference: body.externalReference,
      });
      reply.status(200);
      return created;
    });

    app.get<{ Params: { id: string } }>('/payments/:id', async (req, reply) => {
      const p = state.getPayment(req.params.id);
      if (!p) {
        reply.status(404);
        return { errors: [{ code: 'not_found', description: `payment ${req.params.id} not found` }] };
      }
      return p;
    });

    type TriggerBody = {
      /** PAYMENT_CONFIRMED, PAYMENT_RECEIVED, PAYMENT_OVERDUE, PAYMENT_FAILED, ... */
      event: string;
      /** Sobrescreve dados do payment in-memory (ou usa-os se omitidos) */
      paymentId?: string;
      /** Se paymentId nao existir, cria um payment ad-hoc com esses dados */
      payment?: {
        customer?: string;
        value?: number;
        billingType?: string;
        dueDate?: string;
        externalReference?: string;
        status?: string;
        description?: string;
      };
      /** URL do back pra disparar (default https://localhost:1501/api/webhooks/asaas) */
      backUrl?: string;
      /** asaas-access-token quando o back valida (config WebhookToken) */
      accessToken?: string;
    };

    registerTriggerWebhook<TriggerBody>(app, dispatcher, (body) => {
      let payment = body.paymentId ? state.getPayment(body.paymentId) : undefined;
      if (!payment && body.payment?.value !== undefined && body.payment.customer && body.payment.dueDate) {
        payment = state.createPayment({
          customer: body.payment.customer,
          value: body.payment.value,
          billingType: body.payment.billingType ?? 'PIX',
          dueDate: body.payment.dueDate,
          description: body.payment.description,
          externalReference: body.payment.externalReference,
          status: body.payment.status ?? 'PENDING',
        });
      }
      // Atualiza status conforme evento — mantem in-memory consistente
      const newStatus = mapEventToStatus(body.event);
      if (payment && newStatus) {
        state.updatePayment(payment.id, {
          status: newStatus,
          paymentDate: newStatus === 'CONFIRMED' || newStatus === 'RECEIVED'
            ? new Date().toISOString().slice(0, 10)
            : payment.paymentDate,
        });
      }

      const eventId = `fake_evt_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      const payload = {
        id: eventId,
        event: body.event,
        dateCreated: new Date().toISOString().slice(0, 10),
        payment: payment
          ? {
              id: payment.id,
              customer: payment.customer,
              value: payment.value,
              netValue: payment.netValue,
              billingType: payment.billingType,
              status: payment.status,
              dueDate: payment.dueDate,
              description: payment.description,
              externalReference: payment.externalReference,
              invoiceUrl: payment.invoiceUrl,
              bankSlipUrl: payment.bankSlipUrl,
              transactionReceiptUrl: payment.transactionReceiptUrl,
              paymentDate: payment.paymentDate,
              clientPaymentDate: payment.clientPaymentDate,
            }
          : null,
      };

      const headers: Record<string, string> = {};
      if (body.accessToken) headers['asaas-access-token'] = body.accessToken;

      return {
        url: body.backUrl ?? 'https://localhost:1501/api/webhooks/asaas',
        payload,
        headers,
      };
    });
  },
});

function mapEventToStatus(event: string): string | null {
  switch (event.toUpperCase()) {
    case 'PAYMENT_CONFIRMED': return 'CONFIRMED';
    case 'PAYMENT_RECEIVED': return 'RECEIVED';
    case 'PAYMENT_OVERDUE': return 'OVERDUE';
    case 'PAYMENT_REFUNDED': return 'REFUNDED';
    case 'PAYMENT_DELETED': return 'DELETED';
    default: return null;
  }
}
