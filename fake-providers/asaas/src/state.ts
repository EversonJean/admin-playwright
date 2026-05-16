/**
 * Estado in-memory do fake Asaas — IDs determinísticos baseados em counters
 * pra os specs poderem prever (fake_cus_1, fake_pay_1). Limpado via
 * `DELETE /_control/state` (alias adicional ao reset do inbox).
 */
export interface FakeCustomer {
  id: string;
  name: string;
  email: string;
  cpfCnpj?: string;
  externalReference?: string;
}

export interface FakePayment {
  id: string;
  customer: string;
  value: number;
  netValue: number;
  billingType: string;
  status: string;
  dueDate: string;
  description?: string;
  externalReference?: string;
  invoiceUrl: string;
  bankSlipUrl?: string;
  transactionReceiptUrl?: string;
  paymentDate?: string;
  clientPaymentDate?: string;
  dateCreated: string;
}

// IDs unicos POR INSTANCIA + POR CRIACAO — timestamp ms + random sufix.
// Se usasse contador local (1,2,3...), colidia com Invoices de runs anteriores
// no banco (DB persiste entre runs do back; o back deduplica por AsaasPaymentId
// e acabava nao criando Invoice nova pro tenant do run atual).
function uniqueSuffix(): string {
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

const customers = new Map<string, FakeCustomer>();
const payments = new Map<string, FakePayment>();

export function reset(): void {
  customers.clear();
  payments.clear();
}

export function findCustomerByEmail(email: string): FakeCustomer | undefined {
  for (const c of customers.values()) {
    if (c.email === email) return c;
  }
  return undefined;
}

export function createCustomer(input: Omit<FakeCustomer, 'id'>): FakeCustomer {
  const id = `fake_cus_${uniqueSuffix()}`;
  const customer: FakeCustomer = { id, ...input };
  customers.set(id, customer);
  return customer;
}

export function getCustomer(id: string): FakeCustomer | undefined {
  return customers.get(id);
}

export function createPayment(input: {
  customer: string;
  value: number;
  billingType: string;
  dueDate: string;
  description?: string;
  externalReference?: string;
  status?: string;
}): FakePayment {
  const id = `fake_pay_${uniqueSuffix()}`;
  const payment: FakePayment = {
    id,
    customer: input.customer,
    value: input.value,
    netValue: input.value,
    billingType: input.billingType,
    status: input.status ?? 'PENDING',
    dueDate: input.dueDate,
    description: input.description,
    externalReference: input.externalReference,
    invoiceUrl: `https://fake-asaas.local/i/${id}`,
    bankSlipUrl: input.billingType === 'BOLETO'
      ? `https://fake-asaas.local/b/${id}`
      : undefined,
    dateCreated: new Date().toISOString().slice(0, 10),
  };
  payments.set(id, payment);
  return payment;
}

export function getPayment(id: string): FakePayment | undefined {
  return payments.get(id);
}

export function updatePayment(id: string, patch: Partial<FakePayment>): FakePayment | undefined {
  const p = payments.get(id);
  if (!p) return undefined;
  Object.assign(p, patch);
  return p;
}

export function listPayments(): FakePayment[] {
  return Array.from(payments.values());
}
