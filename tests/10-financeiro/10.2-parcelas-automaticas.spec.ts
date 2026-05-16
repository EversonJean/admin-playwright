import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import {
  apiAcceptPublicBudget,
  apiCreateBudget,
  apiCreatePaymentPlan,
  apiGetPaymentPlan,
  apiSendBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';

/**
 * Fluxo: 10.2 — Parcelas automáticas
 * Diagrama: docs/fluxos/negocio-10.2-parcelas-automaticas.mmd
 *
 * PaymentTermsTemplate define modelos de parcelamento. Plano efetivo
 * vive em /api/events/:id/payment-plan (criado a partir do template ou
 * inline com installments[]).
 */

test.describe('Fluxo 10.2 — Parcelas automáticas', () => {
  test('@flow termos de pagamento carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/payment-terms');
  });

  test('@flow tela de recebíveis carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/finance/receivables');
  });

  test('@flow tela /settings/payment-terms/new carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/payment-terms/new');
  });

  test('@crud cria PaymentTermsTemplate 50/50 + ativa', async ({ authApi }) => {
    const name = `Template 50-50 ${Date.now()}`;
    const createRes = await authApi.post('/api/payment-terms-templates', {
      data: {
        name,
        isDefault: false,
        installments: [
          { order: 1, label: 'Sinal', percentage: 50, dueRule: 'OnAcceptance' },
          { order: 2, label: 'Saldo', percentage: 50, dueRule: 'DaysBeforeEvent', dueDays: 7 },
        ],
      },
    });
    if (!createRes.ok()) {
      throw new Error(`POST template ${createRes.status()}: ${await createRes.text()}`);
    }
    const template = (await createRes.json()).data ?? (await createRes.json());
    expect(template.id).toBeTruthy();

    const activate = await authApi.post(`/api/payment-terms-templates/${template.id}/activate`);
    expect(activate.ok()).toBe(true);
  });

  test('@crud cria payment-plan inline (2 parcelas) e GET retorna installments', async ({
    authApi,
  }) => {
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

    const due1 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const due2 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const plan = await apiCreatePaymentPlan(authApi, eventId, [
      { order: 1, label: 'Sinal', expectedAmount: 200, dueDate: due1 },
      { order: 2, label: 'Saldo', expectedAmount: 300, dueDate: due2 },
    ]);
    expect(plan.installments.length).toBe(2);

    const got = await apiGetPaymentPlan(authApi, eventId);
    expect(got).toBeTruthy();
    expect(got!.installments.length).toBe(2);
    expect(got!.installments[0]!.label).toBe('Sinal');
  });
});
