import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import {
  apiAcceptPublicBudget,
  apiCreateBudget,
  apiSendBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';
import { fakeClicksign } from '../../helpers/fake-providers';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';

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
        applicableTo: 'ClientIndividual',
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
});
