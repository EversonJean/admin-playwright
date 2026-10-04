import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateClient, apiSetSettingParameter } from '../../helpers/api-entities';
import {
  apiGetEvent,
  apiIssueCredit,
  apiListClientCredits,
  apiTryIssueCredit,
} from '../../helpers/api-event-flow';
import { setupPaidEvent } from '../../helpers/setup-flows';

/**
 * Fluxo: 10.3.2 — Crédito do cliente: validade padrão e teto por cliente
 * Plano: docs/implementar/PLANO-AJUSTES-DA-CONVERSAO.md §7 item 1 (AJ-C,
 * Etapa 198) e D5. Registro e2e: E16 e E17.
 * Regra: docs/planejamento/13.2-financeiro.md, "Regras de expiração de
 * crédito" — validade padrão 365 dias, 0 = sem expiração.
 *
 * `CREDIT_DEFAULT_DUE_DAYS` dá a validade do crédito emitido SEM data (a data
 * informada pelo gestor continua valendo acima dele); `CREDIT_MAX_BALANCE_PER_CLIENT`
 * recusa o crédito que leva o saldo disponível do cliente acima do teto
 * (`CreditBalance.MaxBalanceExceeded`, com os valores na mensagem); 0 = sem teto.
 * Tenant que nunca gravou o parâmetro fica com os defaults de hoje: 365 dias
 * e sem teto.
 */

const CREDIT_DUE_DAYS = 'CREDIT_DEFAULT_DUE_DAYS';
const CREDIT_MAX_BALANCE = 'CREDIT_MAX_BALANCE_PER_CLIENT';

/** Data local (`yyyy-MM-dd`) do fuso do evento, a régua do back para a validade. */
function localDatePlus(timezone: string, days: number): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return shifted.toISOString().slice(0, 10);
}

async function eventTimezone(
  api: Parameters<typeof apiGetEvent>[0],
  eventId: string,
): Promise<string> {
  const ev = (await apiGetEvent(api, eventId)) as { timezone?: string };
  expect(ev.timezone, 'evento devolve o fuso').toBeTruthy();
  return ev.timezone!;
}

test.describe('Fluxo 10.3.2 — client credit: default validity (CREDIT_DEFAULT_DUE_DAYS)', () => {
  test('@flow tenant that never set the parameter keeps 365 days', async ({ authApi }) => {
    const paid = await setupPaidEvent(authApi);
    const tz = await eventTimezone(authApi, paid.eventId);

    await apiIssueCredit(authApi, paid.eventId, { installmentId: paid.installmentId, amount: 100 });

    const [credit] = await apiListClientCredits(authApi, paid.clienteId);
    expect(credit, 'crédito criado para o cliente da festa').toBeTruthy();
    expect(credit!.expiresAt).toBe(localDatePlus(tz, 365));
  });

  test('@flow parameter 30: credit issued today without a date expires in 30 days', async ({
    authApi,
  }) => {
    await apiSetSettingParameter(authApi, CREDIT_DUE_DAYS, 30);
    const paid = await setupPaidEvent(authApi);
    const tz = await eventTimezone(authApi, paid.eventId);

    await apiIssueCredit(authApi, paid.eventId, { installmentId: paid.installmentId, amount: 100 });

    const [credit] = await apiListClientCredits(authApi, paid.clienteId);
    expect(credit!.expiresAt).toBe(localDatePlus(tz, 30));
    expect(credit!.balance).toBe(100);

    // A data informada pelo gestor continua valendo acima do parâmetro.
    const informed = localDatePlus(tz, 90);
    await apiIssueCredit(authApi, paid.eventId, {
      installmentId: paid.installmentId,
      amount: 50,
      expiresAt: informed,
    });
    const credits = await apiListClientCredits(authApi, paid.clienteId);
    expect(credits.map((c) => c.expiresAt).sort()).toEqual([localDatePlus(tz, 30), informed].sort());
  });

  test('@flow parameter 0: credit has no validity', async ({ authApi }) => {
    await apiSetSettingParameter(authApi, CREDIT_DUE_DAYS, 0);
    const paid = await setupPaidEvent(authApi);

    await apiIssueCredit(authApi, paid.eventId, { installmentId: paid.installmentId, amount: 100 });

    const [credit] = await apiListClientCredits(authApi, paid.clienteId);
    expect(credit!.expiresAt).toBeNull();
    // Sem validade ainda é crédito utilizável hoje.
    const usable = await apiListClientCredits(authApi, paid.clienteId, true);
    expect(usable.map((c) => c.id)).toContain(credit!.id);
  });
});

test.describe('Fluxo 10.3.2 — client credit: max balance per client (CREDIT_MAX_BALANCE_PER_CLIENT)', () => {
  test('@flow limit 1000 with 900 available refuses a credit of 200 with the limit in the message; limit 0 accepts it', async ({
    authApi,
  }) => {
    const client = await apiCreateClient(authApi);
    // Duas festas do mesmo cliente, quitadas: o crédito sai do que já foi pago.
    const first = await setupPaidEvent(authApi, {
      clientId: client.id,
      budget: { childrenCount: 30 },
    });
    expect(first.total, 'festa paga cobre o crédito de 900').toBeGreaterThanOrEqual(900);
    const second = await setupPaidEvent(authApi, { clientId: client.id });
    expect(second.total).toBeGreaterThanOrEqual(200);

    await apiSetSettingParameter(authApi, CREDIT_MAX_BALANCE, 1000);
    await apiIssueCredit(authApi, first.eventId, { installmentId: first.installmentId, amount: 900 });

    const refused = await apiTryIssueCredit(authApi, second.eventId, {
      installmentId: second.installmentId,
      amount: 200,
    });
    expect(refused.status()).toBe(400);
    const body = await refused.text();
    expect(body).toContain('CreditBalance.MaxBalanceExceeded');
    // Mensagem em pt-BR com o limite, o saldo atual e o total que ficaria.
    expect(body).toContain('1000,00');
    expect(body).toContain('900,00');
    expect(body).toContain('1100,00');

    // Recusado antes de mexer no plano: só o crédito de 900 existe.
    const afterRefusal = await apiListClientCredits(authApi, client.id);
    expect(afterRefusal.map((c) => c.originalAmount)).toEqual([900]);

    // Teto 0 = sem teto: o mesmo crédito passa.
    await apiSetSettingParameter(authApi, CREDIT_MAX_BALANCE, 0);
    const accepted = await apiTryIssueCredit(authApi, second.eventId, {
      installmentId: second.installmentId,
      amount: 200,
    });
    expect(accepted.status(), await accepted.text()).toBeLessThan(300);

    const credits = await apiListClientCredits(authApi, client.id);
    expect(credits.map((c) => c.originalAmount).sort((a, b) => a - b)).toEqual([200, 900]);
    expect(credits.reduce((sum, c) => sum + c.balance, 0)).toBe(1100);
  });
});
