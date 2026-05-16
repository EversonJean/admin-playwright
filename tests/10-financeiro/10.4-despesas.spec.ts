import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import {
  apiAcceptPublicBudget,
  apiCreateBudget,
  apiSendBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';

/**
 * Fluxo: 10.4 — Despesas
 * Diagrama: docs/fluxos/negocio-10.4-despesas.mmd
 *
 * Despesas vivem aninhadas no evento (/api/events/{id}/expenses) — CRUD na
 * aba financeira do detalhe. Aqui validamos a integração de criar via API
 * autenticada e ler via GET no mesmo evento (front popula através do detalhe).
 */

test.describe('Fluxo 10.4 — Despesas', () => {
  test('@flow GET /api/expenses responde sem 500', async ({ authApi }) => {
    const res = await authApi.get('/api/expenses');
    expect(res.status()).toBeLessThan(500);
  });

  test('@flow tela de relatórios financeiros carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/finance/reports');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test('@crud cria despesa em evento existente e valida via GET', async ({ authApi }) => {
    // Pre-cond: precisa de um evento aceito (despesa exige eventId)
    const client = await apiCreateClient(authApi);
    const activity = await apiCreateActivity(authApi);
    const budget = await apiCreateBudget(authApi, {
      clientId: client.id,
      activityIds: [activity.id],
    });
    const sent = await apiSendBudget(authApi, budget.id);
    const token = extractTokenFromPublicUrl(sent.publicUrl);

    const publicApi = await createPublicApiContext();
    let eventId: string;
    try {
      const accepted = await apiAcceptPublicBudget(publicApi, token);
      eventId = accepted.eventId;
    } finally {
      await publicApi.dispose();
    }

    const hoje = new Date().toISOString().slice(0, 10);
    const createRes = await authApi.post(`/api/events/${eventId}/expenses`, {
      data: {
        amount: 75.5,
        category: 'Transporte',
        date: hoje,
        description: 'Uber ida/volta E2E',
      },
    });
    expect(createRes.ok()).toBe(true);

    const summaryRes = await authApi.get(`/api/events/${eventId}/expenses`);
    expect(summaryRes.ok()).toBe(true);
    const body = await summaryRes.json();
    const summary = body.data ?? body;
    expect(summary.totalExpenses).toBeCloseTo(75.5, 2);
    expect(summary.expenses.length).toBeGreaterThan(0);
    expect(summary.expenses[0].category).toBe('Transporte');
  });
});
