import { APIRequestContext, Page } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import {
  apiAcceptPublicBudget,
  apiCreateBudget,
  apiSendBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';
import { apiCompleteOnboarding } from '../../helpers/api-entities';
import { fakeClicksign } from '../../helpers/fake-providers';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';
import { assertOk, readJson } from '../../helpers/response';
import { setupDraftContract } from '../../helpers/setup-flows';

/** Signatários que o back criou no fake desde `since` (POST /signers). */
async function signersSince(since: string) {
  const inbox = await fakeClicksign.inbox({ since });
  return inbox
    .filter((e) => e.method === 'POST' && e.path === '/signers')
    .map((e) => (e.body as { signer?: { name?: string; email?: string; phone_number?: string } }).signer ?? {});
}

const digits = (value: string | null | undefined) => (value ?? '').replace(/\D/g, '');

/**
 * Contrato em rascunho de um evento aceito, com o PDF gerado (o envio pede:
 * "Gere o PDF primeiro"), e o diálogo de assinatura aberto pela aba Contrato,
 * já conferido com o e-mail e o telefone do cliente do evento.
 */
async function openSendDialogWithClientContact(
  api: APIRequestContext,
  page: Page,
  tenantId: string,
): Promise<{ contractId: string; client: { name: string; email: string; phone: string } }> {
  const { contractId, eventId, clienteId } = await setupDraftContract(api, tenantId);
  const clientRes = await api.get(`/api/clients/${clienteId}`);
  await assertOk(clientRes, 'GET /api/clients/{id}');
  const client = await readJson<{ name: string; email: string; phone: string }>(clientRes);
  await assertOk(await api.get(`/api/contracts/${contractId}/pdf`), 'GET /api/contracts/{id}/pdf');

  await apiCompleteOnboarding(api);
  await page.goto(`/app/events/${eventId}`);
  await page.getByRole('tab', { name: 'Contrato', exact: true }).click();
  await page.getByTestId('contract-tab-send-digital').click();

  await expect(page.getByTestId('send-digital-signer-email')).toHaveValue(client.email);
  const phoneField = page.getByTestId('send-digital-signer-phone');
  await expect(phoneField).not.toHaveValue('');
  expect(digits(await phoneField.inputValue())).toBe(digits(client.phone));
  return { contractId, client };
}

/** Clica em "Enviar para assinatura" e devolve o status HTTP e o corpo do envio. */
async function submitSend(page: Page, contractId: string): Promise<{ status: number; body: string }> {
  const response = page.waitForResponse(
    (r) =>
      r.url().includes(`/api/contracts/${contractId}/digital-signature/send`) &&
      r.request().method() === 'POST',
  );
  await page.getByTestId('send-digital-submit').click();
  const res = await response;
  return { status: res.status(), body: (await res.text()).slice(0, 300) };
}

/**
 * Fluxo: 9.3 — Geração e formalização de contrato
 * Diagrama: docs/fluxos/negocio-9.3-geracao-e-formalizacao.mmd
 *
 * Fluxo completo end-to-end:
 *   evento aceito → criar contract template → gerar contract → enviar pra
 *   assinatura digital (back faz POST real pro fake Clicksign em
 *   http://localhost:1511, recebe providerDocumentKey/signerKey) → fake
 *   dispara webhook `sign` HTTP real com HMAC valido pro back → contract
 *   vira Formalized (passa pelo ClicksignWebhookController real).
 */

test.describe('Fluxo 9.3 — Geração e formalização', () => {
  test('@flow listagem de eventos (origem do contrato) carrega', async ({ authPage }) => {
    const res = await authPage.goto('/app/events/list');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test('@crud gera contrato + simula clicksign signed -> Formalized', async ({
    authApi,
    tenant,
  }) => {
    // 1. Pré-cond: feature_digital_signature ligado pra ContractAppService
    //    aceitar o envio pra assinatura digital
    enableFeatureFlagDirect(tenant.tenantId, 'feature_digital_signature');

    // 2. Setup: cliente + atividade + orçamento aceito (gera EventId)
    const cliente = await apiCreateClient(authApi);
    const atividade = await apiCreateActivity(authApi);
    const orcamento = await apiCreateBudget(authApi, {
      clientId: cliente.id,
      activityIds: [atividade.id],
    });
    const enviado = await apiSendBudget(authApi, orcamento.id);
    const token = extractTokenFromPublicUrl(enviado.publicUrl);

    const publicApi = await createPublicApiContext();
    let eventId: string;
    try {
      const aceito = await apiAcceptPublicBudget(publicApi, token);
      eventId = aceito.eventId;
    } finally {
      await publicApi.dispose();
    }

    // 3. Template de contrato (cria mínimo via API — pega primeiro layout)
    const layoutsRes = await authApi.get('/api/contract-layouts');
    expect(layoutsRes.ok()).toBe(true);
    const layouts = (await layoutsRes.json()).data ?? (await layoutsRes.json());
    const layoutKey = (Array.isArray(layouts) ? layouts : layouts.items ?? [])[0]?.key;
    expect(layoutKey, 'Catálogo de layouts deve ter ao menos 1 item').toBeTruthy();

    const templateRes = await authApi.post('/api/contract-templates', {
      data: {
        name: `Template E2E ${Date.now()}`,
        description: 'Template de teste E2E',
        type: 'ClientIndividual',
        layoutKey,
        header: 'Cabeçalho E2E',
        footer: 'Rodapé E2E',
        showLogo: true,
      },
    });
    if (!templateRes.ok()) {
      throw new Error(`POST template ${templateRes.status()}: ${await templateRes.text()}`);
    }
    const template = (await templateRes.json()).data ?? (await templateRes.json());

    // Template precisa de cláusulas pra ser ativado. Cria 1 cláusula mínima
    // e anexa via PUT /clauses (replace).
    const clauseRes = await authApi.post('/api/clauses', {
      data: {
        title: `Clausula E2E ${Date.now()}`,
        category: 'Geral',
        // `ClauseApplicability` é flags e o DTO recebe o número (1 = pessoa física).
        applicableTo: 1,
        isRequired: false,
        suggestedOrder: 1,
        bodyHtml: '<p>Cláusula de teste.</p>',
        bodyPlain: 'Cláusula de teste.',
      },
    });
    if (!clauseRes.ok()) {
      throw new Error(`POST clause ${clauseRes.status()}: ${await clauseRes.text()}`);
    }
    const clause = (await clauseRes.json()).data ?? (await clauseRes.json());

    // Cláusula nasce em Draft — precisa emitir versão e ativá-la pra ser
    // referenciada por um template ativo.
    const issueRes = await authApi.post(`/api/clauses/${clause.id}/versions`, {
      data: { bodyHtml: '<p>Cláusula de teste.</p>', bodyPlain: 'Cláusula de teste.' },
    });
    if (!issueRes.ok()) {
      throw new Error(`issue version ${issueRes.status()}: ${await issueRes.text()}`);
    }
    const issued = (await issueRes.json()).data ?? (await issueRes.json());
    const versionId = issued.id ?? issued.versionId;
    const activateClauseRes = await authApi.post(
      `/api/clauses/${clause.id}/versions/${versionId}/activate`,
    );
    if (!activateClauseRes.ok()) {
      throw new Error(`activate version ${activateClauseRes.status()}: ${await activateClauseRes.text()}`);
    }

    const replaceClausesRes = await authApi.put(`/api/contract-templates/${template.id}/clauses`, {
      data: { clauses: [{ clauseId: clause.id, order: 1 }] },
    });
    if (!replaceClausesRes.ok()) {
      throw new Error(`PUT clauses ${replaceClausesRes.status()}: ${await replaceClausesRes.text()}`);
    }

    // Agora pode ativar
    const activateRes = await authApi.post(`/api/contract-templates/${template.id}/activate`);
    if (!activateRes.ok()) {
      throw new Error(`activate template ${activateRes.status()}: ${await activateRes.text()}`);
    }

    const contractRes = await authApi.post('/api/contracts', {
      data: { eventId, templateId: template.id },
    });
    if (!contractRes.ok()) {
      throw new Error(`POST contract ${contractRes.status()}: ${await contractRes.text()}`);
    }
    const contract = (await contractRes.json()).data ?? (await contractRes.json());

    // 4. Envia pra assinatura digital — LoggingDigitalSignatureProvider devolve
    //    providerDocumentKey determinístico baseado no contractId
    const sendRes = await authApi.post(
      `/api/contracts/${contract.id}/digital-signature/send`,
      {
        data: {
          signerName: cliente.name ?? 'Cliente E2E',
          signerEmail: 'cliente@e2e.test',
          deliveryChannel: 'Email',
          message: 'Por favor, assine.',
        },
      },
    );
    if (!sendRes.ok()) {
      throw new Error(`send signature ${sendRes.status()}: ${await sendRes.text()}`);
    }

    // 5. Pega o envelope criado pra extrair providerDocumentKey (gerado
    //    pelo fake ClickSign quando o back fez POST /documents)
    const envRes = await authApi.get(`/api/contracts/${contract.id}/digital-signature`);
    expect(envRes.ok()).toBe(true);
    const envelope = (await envRes.json()).data ?? (await envRes.json());
    expect(envelope.providerDocumentKey, 'envelope deve ter key vinda do fake ClickSign').toBeTruthy();
    expect(envelope.providerDocumentKey).toMatch(/^fake_doc_/);

    // 6. Fake ClickSign dispara webhook 'sign' HTTP real com HMAC valido
    //    pra /api/webhooks/clicksign — passa pelo controller real, valida
    //    assinatura e processor formaliza o contrato.
    const trigger = await fakeClicksign.triggerWebhook({
      event: 'sign',
      providerDocumentKey: envelope.providerDocumentKey,
      providerSignerKey: envelope.providerSignerKey,
    });
    expect(trigger.backStatus, 'back deve aceitar webhook com HMAC correto').toBe(200);

    // 7. Contrato agora deve estar Formalized
    const finalRes = await authApi.get(`/api/contracts/${contract.id}`);
    expect(finalRes.ok()).toBe(true);
    const finalContract = (await finalRes.json()).data ?? (await finalRes.json());
    expect(finalContract.status).toBe('Formalized');
  });

  /**
   * E38 (PLANO-AJUSTES-DA-CONVERSAO §12 item 3, Etapa 203): o signatário vai
   * ao Clicksign com nome, e-mail e telefone; o diálogo de envio já vem com o
   * e-mail e o telefone do cliente do evento.
   */
  test('@crud send for digital signature with the event client e-mail and phone prefilled: the fake receives name, e-mail and phone', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    const { contractId, client } = await openSendDialogWithClientContact(authApi, authPage, tenant.tenantId);

    // WhatsApp: o canal que precisa do telefone pré-preenchido.
    await authPage.getByTestId('send-digital-channel').click();
    await authPage.getByTestId('send-digital-channel-whatsapp').click();

    const since = new Date().toISOString();
    const sent = await submitSend(authPage, contractId);
    expect(sent.status, sent.body).toBe(200);
    await expect(authPage.getByTestId('send-digital-submit')).toHaveCount(0, { timeout: 20_000 });

    const signer = (await signersSince(since)).find((s) => s.email === client.email);
    expect(signer, 'o fake recebeu o signatário com o e-mail do cliente').toBeTruthy();
    expect(signer!.name).toBe(client.name);
    expect(digits(signer!.phone_number)).toContain(digits(client.phone));

    await assertOk(
      await authApi.get(`/api/contracts/${contractId}/digital-signature`),
      'GET digital-signature envelope',
    );
  });

  test('@crud send for digital signature with the default channel ("Padrão da empresa") and the prefilled contact goes through', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    const { contractId, client } = await openSendDialogWithClientContact(authApi, authPage, tenant.tenantId);

    // Sem tocar no canal ("Padrão da empresa"): o front resolve WhatsApp quando há telefone, senão e-mail
    // (SIGNATURE_DEFAULT_METHOD = whatsapp em planejamento/19-autenticacao.md; o back exige o canal).
    const since = new Date().toISOString();
    const sent = await submitSend(authPage, contractId);
    expect(sent.status, `envio com o canal padrão da empresa: ${sent.body}`).toBe(200);

    const signer = (await signersSince(since)).find((s) => s.email === client.email);
    expect(signer, 'o fake recebeu o signatário com o e-mail do cliente').toBeTruthy();
    expect(digits(signer!.phone_number)).toContain(digits(client.phone));
  });

  test('@crud WhatsApp delivery without a phone is refused before reaching the fake', async ({
    authApi,
    tenant,
  }) => {
    const { contractId } = await setupDraftContract(authApi, tenant.tenantId);
    const signerEmail = `sem-telefone-${Date.now()}@e2e.test`;

    const since = new Date().toISOString();
    const res = await authApi.post(`/api/contracts/${contractId}/digital-signature/send`, {
      data: {
        signerName: 'Cliente sem telefone',
        signerEmail,
        signerPhone: null,
        deliveryChannel: 'whatsapp',
        message: null,
      },
    });
    const body = await res.text();
    expect(res.status(), body.slice(0, 300)).toBe(400);
    expect(body).toContain('Contracts.SignatureContactRequired');

    expect((await signersSince(since)).filter((s) => s.email === signerEmail)).toHaveLength(0);
    const contractRes = await authApi.get(`/api/contracts/${contractId}`);
    await assertOk(contractRes, 'GET /api/contracts/{id}');
    expect((await readJson<{ status: string }>(contractRes)).status).toBe('Draft');
  });
});
