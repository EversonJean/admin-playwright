import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import {
  apiCreateBudget,
  apiGetBudget,
  apiSendBudget,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';
import { fakeEmail } from '../../helpers/fake-providers';

/**
 * Fluxo: 5.2 — Envio do orçamento
 * Diagrama: docs/fluxos/negocio-5.2-envio-do-orcamento.mmd
 *
 * Envio gera publicUrl + dispara email pro cliente. Em E2E o fake email
 * (porta 1513) captura o POST /send com o link.
 */

test.describe('Fluxo 5.2 — Envio do orçamento', () => {
  test('@flow listagem de orçamentos carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/budgets/list');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test('@crud send transiciona Draft -> Sent + retorna publicUrl com token', async ({
    authApi,
  }) => {
    const cliente = await apiCreateClient(authApi);
    const atividade = await apiCreateActivity(authApi);
    const orcamento = await apiCreateBudget(authApi, {
      clientId: cliente.id,
      activityIds: [atividade.id],
    });

    const sent = await apiSendBudget(authApi, orcamento.id);
    expect(sent.publicUrl).toMatch(/\/budgets\//);
    const token = extractTokenFromPublicUrl(sent.publicUrl);
    expect(token.length).toBeGreaterThan(10);
    expect(sent.expiresAt).toBeTruthy();

    const after = (await apiGetBudget(authApi, orcamento.id)) as unknown as { status: string };
    expect(after.status).toBe('Sent');
  });

  test('@crud send dispara email pro cliente via fake email', async ({ authApi }) => {
    const cliente = await apiCreateClient(authApi);
    const atividade = await apiCreateActivity(authApi);
    const orcamento = await apiCreateBudget(authApi, {
      clientId: cliente.id,
      activityIds: [atividade.id],
    });

    const since = new Date().toISOString();
    await apiSendBudget(authApi, orcamento.id);

    // Fake email recebeu o POST /send com to=email do cliente
    const inbox = await fakeEmail.inbox({ since });
    const sendCalls = inbox.filter((e) => e.method === 'POST' && e.path === '/send');
    expect(
      sendCalls.length,
      'fake email deve ter recebido envio do orcamento',
    ).toBeGreaterThanOrEqual(1);

    const emails = await fakeEmail.emails({ to: (cliente as { email?: string }).email ?? '' });
    expect(emails.length).toBeGreaterThanOrEqual(1);
  });
});
