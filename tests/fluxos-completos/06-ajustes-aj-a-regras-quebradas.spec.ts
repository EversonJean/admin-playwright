import { APIRequestContext } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import {
  apiCompleteOnboarding,
  apiCreateCollaborator,
  apiCreateContactIdentity,
} from '../../helpers/api-entities';
import {
  apiAssignCollaborator,
  apiConfirmCollaborator,
  apiCreatePaymentPlan,
  apiCreatePublicEvent,
  apiGetEvent,
  apiGetPaymentSummary,
  apiRefundInstallment,
  apiRegisterPayment,
  apiReversePaymentEntry,
} from '../../helpers/api-event-flow';
import { enableFeatureFlagDirect, seedWhatsappChannelDirect } from '../../helpers/db-helper';
import { fakeWhatsApp } from '../../helpers/fake-providers';
import { setupAcceptedEvent } from '../../helpers/setup-flows';

/**
 * AJ-A / Etapa 194 — regras que o usuário vê quebradas.
 * Plano: docs/implementar/PLANO-AJUSTES-DA-CONVERSAO.md, §4 (Fatia AJ-A) e
 * "Verificação end-to-end", itens 1 a 3. Inclui a revisão pós-entrega do back
 * de 2026-09-29.
 *
 * 1. Evento público `Scheduled`: o detalhe mostra "Iniciar" e não "Concluir"
 *    (item 7 do front: o predicado é `usesFullStateMachine`, não
 *    `kind === 'Commercial'`); iniciar leva a `InProgress`, e só então
 *    "Concluir" aparece e funciona.
 * 2. Painel financeiro: "Recebido no mês" desconta `Refund` e `Reversal`
 *    (item 1 do back, decisão D13: todo o dinheiro que entrou no mês menos as
 *    devoluções do mês).
 * 3. Merge de contatos: a prévia conta as conversas de verdade (item 2 do
 *    back, via `IConversationLookupRead`) e, depois do merge, o evento
 *    `ContactIdentitiesMerged` (Outbox, assíncrono) reaponta as conversas do
 *    absorvido para o sobrevivente. Nenhuma tela lista as conversas de um
 *    contato (Entrega da Etapa 194), então o "depois" é conferido na API.
 *
 * Sem diagrama `.mmd`: é verificação de plano de ajustes, não fluxo novo.
 */

function unwrapData<T>(body: unknown): T {
  const b = body as { data?: T };
  return (b.data ?? body) as T;
}

/** "R$ 1.234,56" com o espaço que o pipe de moeda devolver (NBSP ou comum). */
function brl(value: number): RegExp {
  const formatted = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format(value)
    .replace(/\./g, '\\.');
  return new RegExp(`R\\$\\s*${formatted}`);
}

interface ConversationListItem {
  id: string;
  contactPhone: string;
  contactIdentityId: string | null;
}

async function listConversations(api: APIRequestContext): Promise<ConversationListItem[]> {
  const res = await api.get('/api/conversations?pageSize=50');
  if (!res.ok()) {
    throw new Error(`GET /api/conversations falhou (${res.status()}): ${await res.text()}`);
  }
  const data = unwrapData<{ items: ConversationListItem[] } | ConversationListItem[]>(await res.json());
  return Array.isArray(data) ? data : data.items;
}

test.describe('AJ-A / Etapa 194 — rules the user saw broken', () => {
  test('@flow public event in Scheduled shows Start, not Complete; Start then Complete work', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_ticketing');
    await apiCompleteOnboarding(authApi);

    // Pré-condição por API: evento público com equipe e líder (o Start do
    // domínio exige os dois, para comercial e público).
    const event = await apiCreatePublicEvent(authApi);
    expect(event.kind).toBe('PublicEvent');
    expect(event.status).toBe('Scheduled');
    const collaborator = await apiCreateCollaborator(authApi);
    await apiAssignCollaborator(authApi, event.id, collaborator.id, { isLeader: true });
    await apiConfirmCollaborator(authApi, event.id, collaborator.id);

    await authPage.goto(`/app/events/${event.id}`);
    await expect(authPage.getByTestId('event-detail-kind-badge')).toBeVisible();
    await expect(authPage.getByTestId('event-detail-status')).toHaveText(/Agendado/);

    // O defeito corrigido: antes, "Iniciar" sumia e "Concluir" aparecia.
    await expect(authPage.getByTestId('event-detail-start')).toBeVisible();
    await expect(authPage.getByTestId('event-detail-complete')).toHaveCount(0);

    await authPage.getByTestId('event-detail-start').click();
    await authPage.getByTestId('confirm-ok').click();

    await expect(authPage.getByTestId('event-detail-status')).toHaveText(/Em andamento/);
    await expect(authPage.getByTestId('event-detail-start')).toHaveCount(0);
    await expect(authPage.getByTestId('event-detail-complete')).toBeVisible();
    expect((await apiGetEvent(authApi, event.id)).status).toBe('InProgress');

    await authPage.getByTestId('event-detail-complete').click();
    await authPage.getByTestId('confirm-ok').click();

    await expect(authPage.getByTestId('event-detail-status')).toHaveText(/Concluído/);
    await expect(authPage.getByTestId('event-detail-complete')).toHaveCount(0);
    expect((await apiGetEvent(authApi, event.id)).status).toBe('Completed');
  });

  test('@flow financial dashboard "Received this month" subtracts refund and reversal', async ({
    authApi,
    authPage,
  }) => {
    await apiCompleteOnboarding(authApi);

    const { eventId } = await setupAcceptedEvent(authApi);
    const total = (await apiGetPaymentSummary(authApi, eventId)).eventTotal;
    expect(total, 'o evento precisa de total para receber pagamentos').toBeGreaterThan(0);

    // Valores inteiros proporcionais ao total, para caber no saldo do evento.
    const firstPayment = Math.floor(total * 0.5);
    const secondPayment = Math.floor(total * 0.2);
    const refund = Math.floor(total * 0.1);
    expect(refund).toBeGreaterThan(0);

    const due = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
    const plan = await apiCreatePaymentPlan(authApi, eventId, [
      { order: 1, label: 'Parcela única', expectedAmount: total, dueDate: due },
    ]);
    const installmentId = plan.installments[0]!.id;

    await apiRegisterPayment(authApi, eventId, { amount: firstPayment, method: 'Pix', installmentId });
    const second = await apiRegisterPayment(authApi, eventId, {
      amount: secondPayment,
      method: 'Transfer',
      installmentId,
    });

    // Reversal anula o segundo lançamento inteiro; Refund devolve parte do primeiro.
    await apiReversePaymentEntry(authApi, eventId, second.entries[0]!.id);
    await apiRefundInstallment(authApi, eventId, installmentId, refund);

    // D13: todo o dinheiro que entrou no mês menos as devoluções do mês.
    const entered = firstPayment + secondPayment;
    const returned = secondPayment + refund;
    const expected = entered - returned;

    // Back primeiro: separa defeito do Read de defeito da tela.
    const apiRes = await authApi.get('/api/dashboard/financial');
    expect(apiRes.ok()).toBe(true);
    const dashboard = unwrapData<{ receivedThisMonth: number }>(await apiRes.json());
    expect(dashboard.receivedThisMonth, 'GET /api/dashboard/financial receivedThisMonth').toBeCloseTo(
      expected,
      2,
    );

    await authPage.goto('/app/dashboard/financial');
    await expect(authPage.getByTestId('kpi-received-month')).toHaveText(brl(expected));
  });

  test('@flow contact merge preview counts real conversations; after merge they belong to the survivor', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_whatsapp');
    const phoneNumberId = seedWhatsappChannelDirect(tenant.tenantId);
    await apiCompleteOnboarding(authApi);

    // Telefones únicos por execução (celular de Curitiba, 9 dígitos).
    const seed = String(Date.now()).slice(-7);
    const survivorPhone = `+55419${seed}1`;
    const absorbedPhoneA = `+55419${seed}2`;
    const absorbedPhoneB = `+55419${seed}3`;

    const survivor = await apiCreateContactIdentity(authApi, {
      displayName: `Sobrevivente E2E ${seed}`,
      whatsappPhones: [survivorPhone],
    });
    const absorbed = await apiCreateContactIdentity(authApi, {
      displayName: `Absorvido E2E ${seed}`,
      whatsappPhones: [absorbedPhoneA, absorbedPhoneB],
    });

    // Uma conversa por telefone, pelo webhook real (HMAC do fake). O resolver
    // casa o telefone com o ponto de contato e liga a conversa à identidade.
    for (const phone of [survivorPhone, absorbedPhoneA, absorbedPhoneB]) {
      const hook = await fakeWhatsApp.triggerWebhook({
        kind: 'inbound',
        phoneNumberId,
        phone,
        text: 'Oi, quero orçamento',
      });
      expect(hook.backStatus, `webhook inbound ${phone}: ${hook.backBody}`).toBe(200);
    }

    // Recorte pelos telefones deste teste: o que se prova aqui é o merge, não o
    // isolamento entre tenants (esse é do 0-infra).
    const ownPhones = new Set([survivorPhone, absorbedPhoneA, absorbedPhoneB]);
    const ownConversations = async () =>
      (await listConversations(authApi)).filter((c) => ownPhones.has(c.contactPhone));

    const before = await ownConversations();
    expect(before, 'três conversas criadas pelo webhook').toHaveLength(3);
    expect(before.filter((c) => c.contactIdentityId === absorbed.id)).toHaveLength(2);
    expect(before.filter((c) => c.contactIdentityId === survivor.id)).toHaveLength(1);

    // Prévia e merge pela tela, a partir do detalhe do sobrevivente.
    await authPage.goto(`/app/contacts/${survivor.id}`);
    await authPage.getByTestId('contact-merge').click();
    await authPage.getByTestId('merge-absorbed-id').fill(absorbed.id);
    await authPage.getByTestId('merge-load-preview').click();

    await expect(authPage.getByTestId('merge-preview')).toBeVisible();
    await expect(authPage.getByTestId('merge-absorbed-name')).toHaveText(absorbed.displayName);
    // O defeito corrigido: antes a prévia mostrava sempre 0 conversas.
    await expect(authPage.getByTestId('merge-conversations-count')).toHaveText('2');

    await authPage.getByTestId('merge-reason').fill('Mesma família, dois números (E2E AJ-A)');
    await authPage.getByTestId('merge-confirm').click();
    await expect(authPage.getByTestId('merge-preview')).toHaveCount(0);

    // Reapontamento é assíncrono (evento no Outbox): espera por poll.
    await expect
      .poll(
        async () => (await ownConversations()).filter((c) => c.contactIdentityId === survivor.id).length,
        { message: 'conversas no contato sobrevivente depois do merge', timeout: 30_000 },
      )
      .toBe(3);

    const after = await ownConversations();
    expect(after.filter((c) => c.contactIdentityId === absorbed.id)).toHaveLength(0);
  });
});
