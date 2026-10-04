import { APIRequestContext, Page } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import {
  apiCompleteOnboarding,
  apiCreateActivity,
  apiCreateClient,
} from '../../helpers/api-entities';
import {
  apiAcceptPublicBudget,
  apiCreateBudget,
  apiCreatePaymentPlan,
  apiGetPaymentPlan,
  apiRegisterPayment,
  apiReversePaymentEntry,
  apiSendBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';
import { assertOk } from '../../helpers/response';
import { setupAcceptedEvent } from '../../helpers/setup-flows';

/**
 * Fluxo: 10.3 — Ajustes financeiros imutáveis
 * Diagrama: docs/fluxos/negocio-10.3-ajustes-financeiros.mmd
 *
 * POST /api/events/:id/financial-adjustments/discount aplica desconto
 * sobre uma parcela. Resposta inclui o ajuste persistido (imutavel).
 *
 * E32 (PLANO-AJUSTES-DA-CONVERSAO §11 item 5, Etapa 202): o cabeçalho do plano
 * de pagamento na aba Financeiro mostra Pago e Saldo LÍQUIDOS, vindos do
 * servidor; Pago + Saldo fecha com o Total, e parcela baixada ou renegociada
 * não entra em nenhum dos dois.
 */

/** Valor como o `CurrencyPipe` pt-BR mostra, sem o "R$" (o espaço dele é não separável). */
function brl(value: number): string {
  return new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    value,
  );
}

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** Cabeçalho do plano na aba Financeiro do evento, recarregado do servidor. */
async function expectPlanHeader(
  page: Page,
  eventId: string,
  expected: { total: number; paid: number; balance: number },
): Promise<void> {
  await page.goto(`/app/events/${eventId}`);
  await page.getByRole('tab', { name: 'Financeiro', exact: true }).click();
  await expect(page.getByTestId('installments-view-total')).toHaveText(money(expected.total));
  await expect(page.getByTestId('installments-view-paid')).toHaveText(money(expected.paid));
  await expect(page.getByTestId('installments-view-balance')).toHaveText(money(expected.balance));
}

/** O valor inteiro da célula ("R$ 0,00" não pode casar com "R$ 120,00"). */
function money(value: number): RegExp {
  return new RegExp(`^\\s*R\\$\\s*${brl(value).replace(/\./g, '\\.')}\\s*$`);
}

/** Os três números do plano como o servidor os devolve. */
async function planNumbers(api: APIRequestContext, eventId: string) {
  const plan = (await apiGetPaymentPlan(api, eventId)) as unknown as {
    totalAmount: number;
    paidAmount: number;
    balance: number;
    installments: Array<{ id: string; status: string }>;
  };
  expect(plan, 'plano de pagamento do evento').toBeTruthy();
  return plan;
}

test.describe('Fluxo 10.3 — Ajustes financeiros', () => {
  test('@flow tela de recebíveis carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/finance/receivables');
  });

  test('@crud aplica discount em parcela e ajuste fica na listagem', async ({ authApi }) => {
    const cliente = await apiCreateClient(authApi);
    const atividade = await apiCreateActivity(authApi);
    const orcamento = await apiCreateBudget(authApi, {
      clientId: cliente.id,
      activityIds: [atividade.id],
    });
    const sent = await apiSendBudget(authApi, orcamento.id);
    const token = extractTokenFromPublicUrl(sent.publicUrl);
    const publicApi = await createPublicApiContext();
    let eventId: string;
    try {
      eventId = (await apiAcceptPublicBudget(publicApi, token)).eventId;
    } finally {
      await publicApi.dispose();
    }

    const dueDate = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const plan = await apiCreatePaymentPlan(authApi, eventId, [
      { order: 1, label: 'Parcela unica', expectedAmount: 500, dueDate },
    ]);
    const installmentId = plan.installments[0]!.id;

    const adjustRes = await authApi.post(
      `/api/events/${eventId}/financial-adjustments/discount`,
      {
        data: {
          installmentId,
          amount: 50,
          reason: 'Desconto E2E',
        },
      },
    );
    if (!adjustRes.ok()) {
      throw new Error(`POST discount ${adjustRes.status()}: ${await adjustRes.text()}`);
    }

    const listRes = await authApi.get(`/api/events/${eventId}/financial-adjustments`);
    expect(listRes.ok()).toBe(true);
    const body = await listRes.json();
    const items: Array<{ type?: string; amount?: number }> =
      body.data?.items ?? body.items ?? body.data ?? body;
    const arr = Array.isArray(items) ? items : [];
    expect(arr.length, 'apos discount deve ter 1 ajuste').toBeGreaterThanOrEqual(1);
    const discountItem = arr.find(
      (i) => (i.type ?? '').toLowerCase().includes('discount') && i.amount === 50,
    );
    expect(discountItem, 'ajuste discount=50 deve estar listado').toBeTruthy();
  });

  test('@flow plan header shows net Paid and Balance from the server; written-off and renegotiated installments count in neither', async ({
    authApi,
    authPage,
  }) => {
    const { eventId } = await setupAcceptedEvent(authApi);
    const plan = await apiCreatePaymentPlan(authApi, eventId, [
      { order: 1, label: 'Sinal', expectedAmount: 300, dueDate: inDays(10) },
      { order: 2, label: 'Segunda', expectedAmount: 200, dueDate: inDays(20) },
      { order: 3, label: 'Terceira', expectedAmount: 100, dueDate: inDays(30) },
    ]);
    const [first, second, third] = plan.installments.sort((a, b) => a.order - b.order);
    await apiCompleteOnboarding(authApi);

    // 1. Pagamento parcial na primeira parcela.
    const payment = await apiRegisterPayment(authApi, eventId, {
      amount: 120,
      method: 'Pix',
      installmentId: first!.id,
    });
    let server = await planNumbers(authApi, eventId);
    expect(server.paidAmount).toBe(120);
    expect(server.balance).toBe(480);
    expect(server.paidAmount + server.balance).toBe(server.totalAmount);
    await expectPlanHeader(authPage, eventId, { total: 600, paid: 120, balance: 480 });

    // 2. O estorno dele: o Pago volta a zero, líquido.
    await apiReversePaymentEntry(authApi, eventId, payment.entries[0]!.id);
    server = await planNumbers(authApi, eventId);
    expect(server.paidAmount).toBe(0);
    expect(server.balance).toBe(600);
    await expectPlanHeader(authPage, eventId, { total: 600, paid: 0, balance: 600 });

    // 3. A segunda recebe 30 e é baixada; a terceira é renegociada em duas de 50.
    await apiRegisterPayment(authApi, eventId, { amount: 30, method: 'Pix', installmentId: second!.id });
    await assertOk(
      await authApi.post(`/api/events/${eventId}/financial-adjustments/writeoff`, {
        data: { installmentId: second!.id, reason: 'Baixa E2E', notes: null },
      }),
      'POST writeoff',
    );
    await assertOk(
      await authApi.post(`/api/events/${eventId}/financial-adjustments/renegotiation`, {
        data: {
          installmentId: third!.id,
          reason: 'Renegociação E2E',
          notes: null,
          newInstallments: [
            { order: 4, label: 'Terceira A', expectedAmount: 50, dueDate: inDays(40) },
            { order: 5, label: 'Terceira B', expectedAmount: 50, dueDate: inDays(50) },
          ],
        },
      }),
      'POST renegotiation',
    );
    // E a primeira volta a receber, 60.
    await apiRegisterPayment(authApi, eventId, { amount: 60, method: 'Pix', installmentId: first!.id });

    server = await planNumbers(authApi, eventId);
    const statusOf = (id: string) => server.installments.find((i) => i.id === id)?.status;
    expect(statusOf(second!.id)).toBe('WrittenOff');
    expect(statusOf(third!.id)).toBe('Renegotiated');
    // Vivas: 300 (60 pagos) + 50 + 50. Os 30 da baixada não entram no Pago.
    expect(server.totalAmount).toBe(400);
    expect(server.paidAmount).toBe(60);
    expect(server.balance).toBe(340);
    expect(server.paidAmount + server.balance).toBe(server.totalAmount);
    await expectPlanHeader(authPage, eventId, { total: 400, paid: 60, balance: 340 });
  });
});
