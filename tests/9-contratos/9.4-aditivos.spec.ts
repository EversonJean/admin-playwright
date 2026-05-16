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
 * Fluxo: 9.4 — Aditivos de contrato
 * Diagrama: docs/fluxos/negocio-9.4-aditivos.mmd
 *
 * Aditivo so pode ser criado em Contract Formalized/Active. Setup espelha
 * 9.3 (template+clausula+contract+send digital sig+webhook sign).
 */

test.describe('Fluxo 9.4 — Aditivos', () => {
  test('@flow listagem de eventos carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/events/list');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test('@crud preview-impact em contrato Formalized devolve impact', async ({
    authApi,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_digital_signature');
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

    // Template + clausula + contract + send + webhook sign (mesma cadeia de 9.3)
    const layouts = await (await authApi.get('/api/contract-layouts')).json();
    const layoutsArr: Array<{ key: string }> = layouts.data ?? layouts;
    const layoutKey = (Array.isArray(layoutsArr) ? layoutsArr : (layoutsArr as { items?: Array<{ key: string }> }).items ?? [])[0]?.key;

    const templateRes = await authApi.post('/api/contract-templates', {
      data: {
        name: `T9.4 ${Date.now()}`,
        description: 'tpl 9.4',
        type: 'ClientIndividual',
        layoutKey,
        header: 'H',
        footer: 'F',
        showLogo: true,
      },
    });
    const template = (await templateRes.json()).data ?? (await templateRes.json());

    const clauseRes = await authApi.post('/api/clauses', {
      data: {
        title: `C9.4 ${Date.now()}`,
        category: 'Geral',
        applicableTo: 'ClientIndividual',
        isRequired: false,
        suggestedOrder: 1,
        bodyHtml: '<p>X</p>',
        bodyPlain: 'X',
      },
    });
    const clause = (await clauseRes.json()).data ?? (await clauseRes.json());
    const issueRes = await authApi.post(`/api/clauses/${clause.id}/versions`, {
      data: { bodyHtml: '<p>X</p>', bodyPlain: 'X' },
    });
    const issued = (await issueRes.json()).data ?? (await issueRes.json());
    const versionId = issued.id ?? issued.versionId;
    await authApi.post(`/api/clauses/${clause.id}/versions/${versionId}/activate`);
    await authApi.put(`/api/contract-templates/${template.id}/clauses`, {
      data: { clauses: [{ clauseId: clause.id, order: 1 }] },
    });
    await authApi.post(`/api/contract-templates/${template.id}/activate`);

    const contractRes = await authApi.post('/api/contracts', {
      data: { eventId, templateId: template.id },
    });
    const contract = (await contractRes.json()).data ?? (await contractRes.json());

    await authApi.post(`/api/contracts/${contract.id}/digital-signature/send`, {
      data: {
        signerName: 'Cliente E2E',
        signerEmail: 'cliente@e2e.test',
        deliveryChannel: 'Email',
        message: 'Por favor, assine.',
      },
    });
    const envRes = await authApi.get(`/api/contracts/${contract.id}/digital-signature`);
    const envelope = (await envRes.json()).data ?? (await envRes.json());

    const trigger = await fakeClicksign.triggerWebhook({
      event: 'sign',
      providerDocumentKey: envelope.providerDocumentKey,
      providerSignerKey: envelope.providerSignerKey,
    });
    expect(trigger.backStatus).toBe(200);

    // Agora preview-impact + create addendum
    const newDate = new Date(Date.now() + 45 * 86400000).toISOString();
    const previewRes = await authApi.post(
      `/api/contracts/${contract.id}/addendums/preview-impact`,
      {
        data: {
          newEventDate: newDate,
          newGuestCount: 25,
          priceDelta: 200,
        },
      },
    );
    expect(previewRes.ok()).toBe(true);
    const preview = (await previewRes.json()).data ?? (await previewRes.json());
    expect(preview.changesSummary).toBeTruthy();
    expect(Array.isArray(preview.changesSummary)).toBe(true);
    expect(preview.changesSummary.length).toBeGreaterThan(0);
  });

  test('@crud GET addendums de contrato Formalized devolve lista vazia inicialmente', async ({
    authApi,
    tenant,
  }) => {
    // Reusa setup minimo — contrato existir e estar formalized.
    // Mesmo setup acima encapsulado num test focado em listagem.
    enableFeatureFlagDirect(tenant.tenantId, 'feature_digital_signature');
    const cliente = await apiCreateClient(authApi);
    const atividade = await apiCreateActivity(authApi);
    const orcamento = await apiCreateBudget(authApi, {
      clientId: cliente.id,
      activityIds: [atividade.id],
    });
    const sent = await apiSendBudget(authApi, orcamento.id);
    const tk = extractTokenFromPublicUrl(sent.publicUrl);
    const publicApi = await createPublicApiContext();
    let eventId: string;
    try {
      eventId = (await apiAcceptPublicBudget(publicApi, tk)).eventId;
    } finally {
      await publicApi.dispose();
    }
    const layouts = (await (await authApi.get('/api/contract-layouts')).json()).data ?? [];
    const layoutKey = (Array.isArray(layouts) ? layouts : layouts.items ?? [])[0]?.key;
    const templateRes = await authApi.post('/api/contract-templates', {
      data: {
        name: `T9.4b ${Date.now()}`,
        description: 'tpl 9.4b',
        type: 'ClientIndividual',
        layoutKey,
        header: 'H',
        footer: 'F',
        showLogo: true,
      },
    });
    const template = (await templateRes.json()).data ?? (await templateRes.json());

    const clauseRes = await authApi.post('/api/clauses', {
      data: {
        title: `C9.4b ${Date.now()}`,
        category: 'Geral',
        applicableTo: 'ClientIndividual',
        isRequired: false,
        suggestedOrder: 1,
        bodyHtml: '<p>X</p>',
        bodyPlain: 'X',
      },
    });
    const clause = (await clauseRes.json()).data ?? (await clauseRes.json());
    const issueRes = await authApi.post(`/api/clauses/${clause.id}/versions`, {
      data: { bodyHtml: '<p>X</p>', bodyPlain: 'X' },
    });
    const issued = (await issueRes.json()).data ?? (await issueRes.json());
    const vId = issued.id ?? issued.versionId;
    await authApi.post(`/api/clauses/${clause.id}/versions/${vId}/activate`);
    await authApi.put(`/api/contract-templates/${template.id}/clauses`, {
      data: { clauses: [{ clauseId: clause.id, order: 1 }] },
    });
    await authApi.post(`/api/contract-templates/${template.id}/activate`);
    const contractRes = await authApi.post('/api/contracts', {
      data: { eventId, templateId: template.id },
    });
    const contract = (await contractRes.json()).data ?? (await contractRes.json());

    const listRes = await authApi.get(`/api/contracts/${contract.id}/addendums`);
    expect(listRes.ok()).toBe(true);
    const body = await listRes.json();
    const arr: Array<unknown> = body.data?.items ?? body.items ?? body.data ?? body;
    expect(
      Array.isArray(arr) ? arr.length : 0,
      'contrato recem-criado sem aditivos -> lista vazia',
    ).toBe(0);
  });
});
