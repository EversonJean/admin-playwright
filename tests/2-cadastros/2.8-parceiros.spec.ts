import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { assertOk } from '../../helpers/response';

/**
 * Fluxo: 2.8 — Parceiros (venda via parceiro)
 * Plano: docs/implementar/PLANO-PARCEIROS.md (fatias P-A e P-B; Etapas 183/184)
 *
 * [NOTA] O plano pedia `2.7-parceiros`; o número já estava ocupado por
 * `2.7-event-form-fields.spec.ts` desde a Etapa 55. Renumerado para 2.8 — o
 * diagrama correspondente segue o mesmo número.
 *
 * O caminho que este spec prova é o do salão, ponta a ponta:
 * cadastrar parceiro → abrir orçamento pelo deep link da ficha → venda via
 * parceiro com cliente final → "Salvar e criar evento agora" → o evento nasce
 * `Commercial` com o flag e a família, e aparece na agenda.
 */

const CNPJ = '11222333000181';

test.describe('Fluxo 2.8 — Parceiros e venda via parceiro', () => {
  test('@flow lista e ficha do parceiro carregam autenticadas', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/partners/list');
    await smokeRoute(authPage, '/app/partners/new');
  });

  test('@crud cadastra parceiro pela UI e ele aparece na lista de Parceiros', async ({
    authPage,
    authApi,
  }) => {
    const nome = `Salão Festa Feliz ${Date.now()}`;

    await authPage.goto('/app/partners/new');
    await authPage.getByTestId('client-form-name').fill(nome);
    await authPage.getByTestId('client-form-document').fill(CNPJ);
    await authPage.getByTestId('client-form-save').click();
    await authPage.waitForURL(/\/app\/partners\/list(\?|$)/, { timeout: 10_000 });

    // O papel é do CADASTRO desde a Etapa 183 — não se deduz de contrato.
    const res = await authApi.get('/api/clients?isPartner=true');
    await assertOk(res, 'listar parceiros');
    const body = await res.json();
    const items = body.data?.items ?? body.items ?? [];
    expect(items.some((c: { name?: string }) => c.name === nome)).toBe(true);
  });

  test('@flow venda via parceiro: deep link, cliente final e "criar evento agora"', async ({
    authPage,
    authApi,
  }) => {
    const partnerName = `Buffet Parceiro ${Date.now()}`;
    const created = await authApi.post('/api/clients', {
      data: {
        type: 'PJ',
        name: partnerName,
        document: CNPJ,
        isPartner: true,
        partnerCategory: 'Buffet',
      },
    });
    await assertOk(created, 'criar parceiro');
    const partnerId = (await created.json()).data.id as string;

    // Deep link da ficha do parceiro: pré-seleciona o cliente, LIGA o toggle e
    // pré-preenche o local com o nome do salão.
    await authPage.goto(`/app/budgets/quick?partnerId=${partnerId}`);
    await expect(authPage.getByTestId('budget-form-partner-sale')).toBeVisible();
    await expect(authPage.getByTestId('budget-form-endCustomerName')).toBeVisible();

    const eventDate = isoDaysFromToday(30);
    await authPage.getByTestId('budget-form-eventDate').fill(eventDate);
    await authPage.getByTestId('budget-form-eventStartTime').fill('14:00');
    await authPage.getByTestId('budget-form-eventEndTime').fill('17:00');
    await authPage.getByTestId('budget-form-childrenCount').fill('20');
    await authPage.getByTestId('budget-form-endCustomerName').fill('Família Souza');
    await authPage.getByTestId('budget-form-celebrantName').fill('João');
    await authPage.getByTestId('budget-form-celebrantAge').fill('5');

    // "Salvar e criar evento agora" = POST /budgets + POST /budgets/{id}/accept
    // encadeados (decisão 4 do plano: sem endpoint novo).
    await authPage.getByTestId('budget-form-save-and-create-event').click();
    await authPage.getByTestId('confirm-ok').click();
    await authPage.waitForURL(/\/app\/events\/[0-9a-f-]+(\?|$)/i, { timeout: 15_000 });

    // O bloco "Venda via parceiro" no detalhe do evento.
    await expect(authPage.getByTestId('event-detail-partner-sale')).toBeVisible();
    await expect(authPage.getByTestId('event-detail-endCustomer'))
      .toContainText('Família Souza');
    await expect(authPage.getByTestId('event-detail-celebrant')).toContainText('João (5)');

    // E o back concorda: evento comercial do PARCEIRO, com o flag.
    const events = await authApi.get(`/api/events?isPartnerSale=true&clientId=${partnerId}`);
    await assertOk(events, 'listar eventos via parceiro');
    const list = (await events.json()).data?.items ?? [];
    expect(list.length).toBe(1);
    expect(list[0].kind).toBe('Commercial');
    expect(list[0].isPartnerSale).toBe(true);
    expect(list[0].endCustomerName).toBe('Família Souza');
  });

  test('@flow o toggle não fica disponível para cliente comum', async ({
    authPage,
    authApi,
  }) => {
    // 🚨 A regra que o back protege com `Budget.ClientIsNotPartner`: sem ela,
    // qualquer orçamento poderia se declarar venda via parceiro e sair do NPS,
    // do aniversário e do backfill do formulário.
    const common = await authApi.post('/api/clients', {
      data: { type: 'PF', name: `Cliente Comum ${Date.now()}`, document: '11144477735' },
    });
    await assertOk(common, 'criar cliente comum');
    const clientId = (await common.json()).data.id as string;

    await authPage.goto(`/app/budgets/quick?partnerId=${clientId}`);
    await expect(authPage.getByTestId('budget-form-partner-sale-hint')).toBeVisible();
    await expect(authPage.getByTestId('budget-form-endCustomerName')).toHaveCount(0);
  });
});

/** `yyyy-MM-dd` local a N dias de hoje. */
function isoDaysFromToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear().toString().padStart(4, '0');
  const m = (d.getMonth() + 1).toString().padStart(2, '0');
  const day = d.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
}
