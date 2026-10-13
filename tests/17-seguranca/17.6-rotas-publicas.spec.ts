import { createHash } from 'node:crypto';
import { APIRequestContext, Page, Route } from '@playwright/test';

import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { SignupResult, createApiContext, createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import {
  apiCompleteOnboarding,
  apiCreateActivity,
  apiCreateClient,
  apiCreateCollaborator,
  apiSetSettingParameter,
} from '../../helpers/api-entities';
import {
  apiAcceptPublicBudget,
  apiAssignCollaborator,
  apiCompleteEvent,
  apiConfirmCollaborator,
  apiCreateBudget,
  apiCreatePublicEvent,
  apiCreatePublicTicketOrder,
  apiCreateTicketOrderStatusLink,
  apiCreateTicketSaleLink,
  apiCreateTicketType,
  apiListTicketParticipants,
  apiRegisterDeferredTicketSale,
  apiSendBudget,
  apiStartEvent,
  createPublicApiContext,
  extractTokenFromPublicUrl,
  publicAcceptBody,
} from '../../helpers/api-event-flow';
import {
  dataExportRowJsonDirect,
  enableFeatureFlagDirect,
  enableTicketingGatewayDirect,
  expireEventFormLinkDirect,
  setBudgetEventCategoryDirect,
  softDeleteEventDirect,
  tableColumnsDirect,
} from '../../helpers/db-helper';
import { fakeEmail } from '../../helpers/fake-providers';
import { compactText, pdfText } from '../../helpers/pdf-text';
import { apiErrorCodes, assertOk, readJson } from '../../helpers/response';
import { loginAsRole, setupAcceptedEvent } from '../../helpers/setup-flows';
import { fakeCpf, fakeTenant, formatCpf } from '../../helpers/test-data';
import { snack } from '../../helpers/ui';

/**
 * Fluxo: 17.6 — Rotas públicas: saída escapada, tenant fechado e links com hash
 * Diagrama: — (cenários E7, E8, E11, E30 e E61 a E67 do registro e2e de
 * `docs/implementar/PLANO-SEGURANCA.md`)
 *
 * Fonte do comportamento: PLANO-SEGURANCA §6 (SEG-D, toda saída escapada), §9
 * (SEG-G, filtro de tenant fechado por padrão) e §10 (SEG-H, links públicos com
 * token em hash, expiração e dado mínimo), mais os ajustes registrados das
 * Etapas 230, 233 e 237. O spec afirma o plano; divergência é falha de código,
 * não de asserção.
 */

// ─── Utilitários do spec ────────────────────────────────────────────────────

async function withPublicApi<T>(fn: (api: APIRequestContext) => Promise<T>): Promise<T> {
  const api = await createPublicApiContext();
  try {
    return await fn(api);
  } finally {
    await api.dispose();
  }
}

/** Sufixo único só com letras: o documento procurado não pode casar com nome nem e-mail. */
function uid(): string {
  return Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
}

/**
 * POST /api/events/{id}/form-link — emite (ou devolve o vigente) o link do
 * formulário pós-aceite (Etapa 233: o aceite não emite mais token; quem emite
 * é o gestor). Devolve a URL e o token cru, o trecho depois de `/event-form/`.
 */
async function issueFormLink(api: APIRequestContext, eventId: string): Promise<{ url: string; token: string }> {
  const res = await api.post(`/api/events/${eventId}/form-link`);
  await assertOk(res, 'POST /api/events/{id}/form-link');
  const link = await readJson<{ url: string | null }>(res);
  expect(link.url, 'o POST emite o link').toBeTruthy();
  const url = link.url!;
  const marker = '/event-form/';
  expect(url).toContain(marker);
  return { url, token: url.substring(url.indexOf(marker) + marker.length).split(/[?#]/)[0]! };
}

/** Evento comercial concluído pela máquina de estados (equipe com líder, iniciar, concluir). */
async function completeCommercialEvent(api: APIRequestContext, eventId: string): Promise<void> {
  const collaborator = await apiCreateCollaborator(api);
  await apiAssignCollaborator(api, eventId, collaborator.id, { isLeader: true });
  await apiConfirmCollaborator(api, eventId, collaborator.id);
  await apiStartEvent(api, eventId);
  await apiCompleteEvent(api, eventId);
}

/** Evento aberto ao público com um lote ativo e o link de venda. */
async function setupTicketSale(
  api: APIRequestContext,
  tenantId: string,
  opts: { withSaleLink?: boolean } = {},
): Promise<{ eventId: string; typeId: string; saleToken: string | null; saleUrl: string | null }> {
  enableFeatureFlagDirect(tenantId, 'feature_ticketing');
  const event = await apiCreatePublicEvent(api, { title: `Evento público E2E ${uid()}` });
  const type = await apiCreateTicketType(api, event.id);
  if (opts.withSaleLink === false) return { eventId: event.id, typeId: type.id, saleToken: null, saleUrl: null };
  const link = await apiCreateTicketSaleLink(api, event.id);
  return { eventId: event.id, typeId: type.id, saleToken: link.token, saleUrl: link.url };
}

interface CompletedExport {
  id: string;
  downloadUrl: string;
  token: string;
}

/**
 * Pede a exportação dos próprios dados e espera o processamento: a listagem
 * passa a trazer o `downloadUrl` (montado da cópia cifrada; o banco guarda o
 * hash).
 */
async function requestCompletedExport(api: APIRequestContext): Promise<CompletedExport> {
  const res = await api.post('/api/privacy/export-user-data', { data: {} });
  await assertOk(res, 'POST /api/privacy/export-user-data');
  const created = await readJson<{ id: string }>(res);

  let found: { id: string; status: string; downloadUrl: string | null } | undefined;
  await expect
    .poll(
      async () => {
        const list = await api.get('/api/privacy/exports');
        await assertOk(list, 'GET /api/privacy/exports');
        const body = await readJson<
          Array<{ id: string; status: string; downloadUrl: string | null }> | { items: Array<{ id: string; status: string; downloadUrl: string | null }> }
        >(list);
        const items = Array.isArray(body) ? body : body.items;
        found = items.find((e) => e.id === created.id);
        return found?.status === 'Completed' && !!found.downloadUrl;
      },
      { message: 'a exportação conclui e a listagem traz o link', timeout: 90_000, intervals: [1_000, 2_000, 3_000] },
    )
    .toBe(true);

  const downloadUrl = found!.downloadUrl!;
  const token = downloadUrl.split('/').pop()!;
  return { id: created.id, downloadUrl, token };
}

/** API autenticada como o dono de outro tenant (o "B"); quem chama dá `dispose`. */
async function otherTenant(): Promise<{ tenant: SignupResult; api: APIRequestContext }> {
  const tenant = await signupNewTenant();
  return { tenant, api: await createBearerApiContext(tenant.accessToken) };
}

async function listChecklist(api: APIRequestContext, eventId: string): Promise<Array<{ title: string }>> {
  const res = await api.get(`/api/events/${eventId}/checklist`);
  await assertOk(res, 'GET /api/events/{id}/checklist');
  const data = await readJson<Array<{ title: string }> | { items: Array<{ title: string }> }>(res);
  return Array.isArray(data) ? data : data.items;
}

async function createCategoryWithChecklistItem(
  api: APIRequestContext,
  itemTitle: string,
): Promise<string> {
  const category = await api.post('/api/event-categories', {
    data: { name: `Categoria E2E ${uid()}`, group: 'Festa' },
  });
  await assertOk(category, 'POST /api/event-categories');
  const { id } = await readJson<{ id: string }>(category);
  const item = await api.post(`/api/event-categories/${id}/checklist-templates`, {
    data: { title: itemTitle, description: null, sortOrder: 1 },
  });
  await assertOk(item, 'POST checklist-template');
  return id;
}

/** A página não navega para fora do front: nenhuma requisição ao host proibido. */
function trackRequestsTo(page: Page, host: string): string[] {
  const hits: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes(host)) hits.push(r.url());
  });
  return hits;
}

// ════════════════════════════════════════════════════════════════════════════

test.describe('Fluxo 17.6 — Rotas públicas: saída escapada, tenant fechado e links com hash', () => {
  // ─── §6 SEG-D — toda saída escapada ──────────────────────────────────────

  test('E7 @flow cadastro com nome da empresa em HTML: o e-mail de confirmação mostra o texto, sem virar link', async ({
    page,
  }) => {
    const fake = fakeTenant();
    const companyName = '<a href=https://x>boleto</a>';
    const api = await createApiContext();
    try {
      const res = await api.post('/api/auth/signup', {
        data: {
          companyName,
          userName: fake.adminName,
          email: fake.adminEmail,
          password: fake.adminPassword,
        },
      });
      await assertOk(res, 'POST /api/auth/signup');
    } finally {
      await api.dispose();
    }

    let bodyHtml = '';
    let subject = '';
    await expect
      .poll(
        async () => {
          const mails = await fakeEmail.emails({ to: fake.adminEmail });
          const mail = mails.find((m) => m.to.toLowerCase() === fake.adminEmail.toLowerCase());
          bodyHtml = mail?.bodyHtml ?? '';
          subject = mail?.subject ?? '';
          return bodyHtml.length > 0;
        },
        { message: 'o e-mail de confirmação chega ao fake', timeout: 30_000 },
      )
      .toBe(true);

    // O renderer codifica o valor uma vez: nem o HTML cru, nem a codificação dupla.
    expect(bodyHtml).toContain('&lt;a href=https://x&gt;boleto&lt;/a&gt;');
    expect(bodyHtml).not.toContain('<a href=https://x>');
    expect(bodyHtml).not.toContain('&amp;lt;');
    // O assunto é texto puro: não leva entidade HTML.
    expect(subject).not.toMatch(/&(lt|gt|amp);/);

    // Aberto num navegador, o e-mail mostra o texto digitado e nenhum link para x.
    await page.setContent(bodyHtml);
    await expect(page.locator('body')).toContainText('<a href=https://x>boleto</a>');
    await expect(page.locator('a[href="https://x"]')).toHaveCount(0);
  });

  test('E8 @flow aceite público com nome "Maria<!--": a minuta e o contrato formalizado trazem todas as cláusulas', async ({
    authApi,
  }) => {
    test.setTimeout(150_000);
    const tag = uid();
    const clauseTexts = [
      `Primeira clausula ${tag} termina depois do nome do contratante.`,
      `Segunda clausula ${tag} trata do pagamento em duas parcelas.`,
      `Terceira clausula ${tag} elege o foro da comarca de Curitiba.`,
    ];

    // Contrato no aceite: chave do tenant ligada + modelo default da categoria.
    await apiSetSettingParameter(authApi, 'CONTRACT_AT_ACCEPTANCE', 'true');
    const categoryRes = await authApi.post('/api/event-categories', {
      data: { name: `Categoria contrato ${tag}`, group: 'Festa' },
    });
    await assertOk(categoryRes, 'POST /api/event-categories');
    const categoryId = (await readJson<{ id: string }>(categoryRes)).id;

    const layoutsRes = await authApi.get('/api/contract-layouts');
    await assertOk(layoutsRes, 'GET /api/contract-layouts');
    const layoutsBody = await readJson<Array<{ key: string }> | { items: Array<{ key: string }> }>(layoutsRes);
    const layoutKey = (Array.isArray(layoutsBody) ? layoutsBody : layoutsBody.items)[0]?.key;
    expect(layoutKey, 'catálogo de layouts semeado').toBeTruthy();

    const clauseIds: string[] = [];
    for (const [index, text] of clauseTexts.entries()) {
      // A primeira cláusula leva a variável do nome: é ali que o "<!--" entra.
      const bodyHtml = index === 0 ? `<p>Contratante: <strong>{cliente.nome}</strong>. ${text}</p>` : `<p>${text}</p>`;
      const bodyPlain = index === 0 ? `Contratante: {cliente.nome}. ${text}` : text;
      const clauseRes = await authApi.post('/api/clauses', {
        data: {
          title: `Clausula ${index + 1} ${tag}`,
          category: 'Geral',
          applicableTo: 1,
          isRequired: false,
          suggestedOrder: index + 1,
          bodyHtml,
          bodyPlain,
        },
      });
      await assertOk(clauseRes, 'POST /api/clauses');
      const clause = await readJson<{ id: string }>(clauseRes);
      const versionRes = await authApi.post(`/api/clauses/${clause.id}/versions`, { data: { bodyHtml, bodyPlain } });
      await assertOk(versionRes, 'POST clause version');
      const version = await readJson<{ id?: string; versionId?: string }>(versionRes);
      await assertOk(
        await authApi.post(`/api/clauses/${clause.id}/versions/${version.id ?? version.versionId}/activate`),
        'activate clause version',
      );
      clauseIds.push(clause.id);
    }

    const templateRes = await authApi.post('/api/contract-templates', {
      data: {
        name: `Modelo ${tag}`,
        description: 'Modelo do E8',
        type: 'ClientIndividual',
        layoutKey,
        header: 'Cabecalho',
        footer: 'Rodape',
        showLogo: false,
      },
    });
    await assertOk(templateRes, 'POST /api/contract-templates');
    const templateId = (await readJson<{ id: string }>(templateRes)).id;
    await assertOk(
      await authApi.put(`/api/contract-templates/${templateId}/clauses`, {
        data: { clauses: clauseIds.map((clauseId, i) => ({ clauseId, order: i + 1 })) },
      }),
      'PUT template clauses',
    );
    await assertOk(await authApi.post(`/api/contract-templates/${templateId}/activate`), 'activate template');
    await assertOk(
      await authApi.put(`/api/contract-templates/${templateId}/default-categories`, {
        data: { categoryIds: [categoryId] },
      }),
      'PUT default-categories',
    );

    // O contrato formalizado sai do cadastro do cliente; a minuta, do que ele
    // digita no aceite. Os dois com o nome que abre um comentário HTML.
    const name = 'Maria<!--';
    const client = await apiCreateClient(authApi, { name, email: `maria-${tag}@e2e.test` });
    const activity = await apiCreateActivity(authApi);
    const budget = await apiCreateBudget(authApi, {
      clientId: client.id,
      activityIds: [activity.id],
      eventCategoryId: categoryId,
    });
    const sent = await apiSendBudget(authApi, budget.id);
    const token = extractTokenFromPublicUrl(sent.publicUrl);

    const cpf = fakeCpf();
    const phone = '41999998888';
    const clientAddress = publicAcceptBody().clientAddress;

    const { previewPdf, previewHash, eventId } = await withPublicApi(async (publicApi) => {
      const preview = await publicApi.post(`/api/public/budgets/${token}/contract-preview`, {
        data: { clientName: name, clientDocument: cpf, clientEmail: null, clientPhone: phone, clientAddress },
      });
      await assertOk(preview, 'POST contract-preview');
      const hash = preview.headers()['x-contract-pdf-sha256'];
      expect(hash, 'a minuta devolve o hash no header').toBeTruthy();
      const pdf = await preview.body();

      const accepted = await apiAcceptPublicBudget(publicApi, token, {
        ...publicAcceptBody(),
        formData: {
          clientFullName: name,
          clientCpf: cpf,
          clientPhone: phone,
          clientEmail: null,
          isConfirmed: true,
        },
        acceptedContractPdfHash: hash,
      });
      return { previewPdf: pdf, previewHash: hash, eventId: accepted.eventId };
    });
    expect(previewHash).toBeTruthy();

    // A minuta que o cliente leu: o nome literal e as três cláusulas inteiras.
    const previewText = compactText(pdfText(previewPdf));
    expect(previewText, 'nome do contratante literal na minuta').toContain(compactText(name));
    for (const text of clauseTexts) expect(previewText, `minuta com: ${text}`).toContain(compactText(text));

    // O contrato formalizado no aceite: o mesmo, no PDF guardado.
    const byEvent = await authApi.get(`/api/contracts/by-event/${eventId}`);
    await assertOk(byEvent, 'GET /api/contracts/by-event/{eventId}');
    const contractData = await readJson<{ id: string } | Array<{ id: string }>>(byEvent);
    const contract = Array.isArray(contractData) ? contractData[0] : contractData;
    expect(contract?.id, 'o aceite formalizou o contrato').toBeTruthy();
    const pdfRes = await authApi.get(`/api/contracts/${contract!.id}/pdf`);
    await assertOk(pdfRes, 'GET /api/contracts/{id}/pdf');
    const contractText = compactText(pdfText(await pdfRes.body()));
    expect(contractText, 'nome do contratante literal no contrato').toContain(compactText(name));
    for (const text of clauseTexts) expect(contractText, `contrato com: ${text}`).toContain(compactText(text));
    expect(contractText, 'a entidade não vaza para o papel').not.toContain('&lt;');
  });

  // ─── §9 SEG-G — filtro de tenant fechado por padrão ──────────────────────

  test('E11 @flow rota pública de ingresso com o pedido de outro tenant dá 404', async ({ authApi, tenant }) => {
    test.setTimeout(150_000);
    const b = await otherTenant();
    try {
      // Link de venda do A com o token de status de um pedido do B (o fiado
      // do B, com o link da página do pedido que o gestor dele envia).
      const saleA = await setupTicketSale(authApi, tenant.tenantId);
      const saleB = await setupTicketSale(b.api, b.tenant.tenantId);
      const buyerB = `Fiado Do B ${uid()}`;
      await apiRegisterDeferredTicketSale(b.api, saleB.eventId, saleB.typeId, buyerB);
      const orderB = (await apiListTicketParticipants(b.api, saleB.eventId)).find(
        (p) => p.responsibleName === buyerB,
      );
      expect(orderB, 'o pedido do B existe').toBeTruthy();
      const { statusToken: statusTokenB } = await apiCreateTicketOrderStatusLink(
        b.api,
        saleB.eventId,
        orderB!.orderId,
      );

      await withPublicApi(async (publicApi) => {
        const own = await publicApi.get(`/api/public/tickets/${saleB.saleToken}/orders/${statusTokenB}`);
        expect(own.status(), 'controle: o pedido abre pelo link do próprio evento').toBe(200);

        // As três rotas do pedido, cada uma afirmada por si (soft): a falha de
        // uma não esconde o resultado das outras.
        const crossed = await publicApi.get(`/api/public/tickets/${saleA.saleToken}/orders/${statusTokenB}`);
        expect.soft(crossed.status(), 'link do A + pedido do B').toBe(404);

        const payCrossed = await publicApi.post(
          `/api/public/tickets/${saleA.saleToken}/orders/${statusTokenB}/payment-link`,
        );
        expect.soft(payCrossed.status(), 'pagamento com link do A + pedido do B').toBe(404);

        const feedbackCrossed = await publicApi.post(
          `/api/public/tickets/${saleA.saleToken}/orders/${statusTokenB}/feedback`,
          { data: { npsScore: 10, comment: null } },
        );
        expect.soft(feedbackCrossed.status(), 'avaliação com link do A + pedido do B').toBe(404);
      });
    } finally {
      await b.api.dispose();
    }
  });

  test('E11 @flow download público do export com o id de um tenant e o token do outro dá 404', async ({ authApi }) => {
    test.setTimeout(240_000);
    const b = await otherTenant();
    try {
      const exportA = await requestCompletedExport(authApi);
      const exportB = await requestCompletedExport(b.api);
      await withPublicApi(async (publicApi) => {
        const own = await publicApi.get(`/api/privacy/exports/${exportB.id}/download/${exportB.token}`);
        expect(own.status(), 'controle: o export do B baixa com o token do B').toBe(200);

        const idBTokenA = await publicApi.get(`/api/privacy/exports/${exportB.id}/download/${exportA.token}`);
        expect(idBTokenA.status(), 'export do B com o token do A').toBe(404);

        const idATokenB = await publicApi.get(`/api/privacy/exports/${exportA.id}/download/${exportB.token}`);
        expect(idATokenB.status(), 'export do A com o token do B').toBe(404);
      });
    } finally {
      await b.api.dispose();
    }
  });

  test('E30 @flow orçamento com categoria de outro tenant é recusado; gravada antes, o aceite não copia o checklist dela', async ({
    authApi,
  }) => {
    test.setTimeout(150_000);
    const b = await otherTenant();
    try {
      const tag = uid();
      const itemOfB = `Item do tenant B ${tag}`;
      const itemOfA = `Item do tenant A ${tag}`;
      const categoryOfB = await createCategoryWithChecklistItem(b.api, itemOfB);
      const categoryOfA = await createCategoryWithChecklistItem(authApi, itemOfA);

      const client = await apiCreateClient(authApi);
      const activity = await apiCreateActivity(authApi);

      // 1) Criar o orçamento do A apontando para a categoria do B: recusado.
      const refused = await authApi.post('/api/budgets', {
        data: {
          clientId: client.id,
          eventDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
          eventStartTime: '14:00',
          eventEndTime: '18:00',
          eventLocation: 'Salão de festas E2E, Curitiba',
          childrenCount: 15,
          validUntil: new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10),
          teamSize: 2,
          teamPricePerCollaborator: 200,
          displacementFee: 0,
          items: [{ activityId: activity.id, quantity: 1 }],
          eventCategoryId: categoryOfB,
        },
      });
      expect(refused.status(), 'categoria de outro tenant no orçamento').toBe(400);
      expect(await apiErrorCodes(refused)).toContain('EventCategoryId');

      // Controle: com a categoria do próprio tenant, o aceite copia o checklist dela.
      const own = await setupAcceptedEvent(authApi, {
        clientId: client.id,
        activityIds: [activity.id],
        budget: { eventCategoryId: categoryOfA },
      });
      const ownItems = await listChecklist(authApi, own.eventId);
      expect(ownItems.map((i) => i.title), 'controle: checklist da categoria do A').toContain(itemOfA);

      // 2) Categoria do B já gravada no orçamento do A (dado anterior à Etapa 230): o aceite segue
      //    e o evento nasce sem nenhum item do checklist do B.
      const budget = await apiCreateBudget(authApi, { clientId: client.id, activityIds: [activity.id] });
      const sent = await apiSendBudget(authApi, budget.id);
      setBudgetEventCategoryDirect(budget.id, categoryOfB);
      const accepted = await withPublicApi((publicApi) =>
        apiAcceptPublicBudget(publicApi, extractTokenFromPublicUrl(sent.publicUrl)),
      );
      const items = await listChecklist(authApi, accepted.eventId);
      expect(items.map((i) => i.title), 'nenhum item do checklist do B').not.toContain(itemOfB);
      expect(items, 'evento sem itens de checklist').toHaveLength(0);
    } finally {
      await b.api.dispose();
    }
  });

  // ─── §10 SEG-H — links públicos: hash, expiração e dado mínimo ────────────

  test('E61 @flow formulário de evento cancelado, excluído ou depois de D+1: GET e PUT dão 404 e a página diz "link inválido ou expirado"', async ({
    authApi,
    page,
  }) => {
    test.setTimeout(180_000);
    const cases: Array<{ label: string; close: (eventId: string) => Promise<void> }> = [
      {
        label: 'cancelado',
        close: async (eventId) => {
          const res = await authApi.post(`/api/events/${eventId}/cancel`, { data: { reason: 'Cancelado no E2E' } });
          await assertOk(res, 'POST /api/events/{id}/cancel');
        },
      },
      { label: 'excluído', close: async (eventId) => softDeleteEventDirect(eventId) },
      { label: 'depois do fim de D+1', close: async (eventId) => expireEventFormLinkDirect(eventId) },
    ];

    for (const c of cases) {
      const { eventId } = await setupAcceptedEvent(authApi);
      const { token } = await issueFormLink(authApi, eventId);

      await withPublicApi(async (publicApi) => {
        const before = await publicApi.get(`/api/public/events/${token}/form`);
        expect(before.status(), `controle (${c.label}): o link abre antes`).toBe(200);
      });

      await c.close(eventId);

      await withPublicApi(async (publicApi) => {
        const get = await publicApi.get(`/api/public/events/${token}/form`);
        expect(get.status(), `GET do formulário (${c.label})`).toBe(404);
        const put = await publicApi.put(`/api/public/events/${token}/form`, {
          data: { clientFullName: 'Cliente E2E', isConfirmed: false },
        });
        expect(put.status(), `PUT do formulário (${c.label})`).toBe(404);
      });

      await page.goto(`/event-form/${token}`);
      const invalid = page.getByTestId('public-form-invalid-link');
      await expect(invalid, `página do link (${c.label})`).toBeVisible();
      await expect(invalid).toContainText('Link inválido ou expirado');
    }
  });

  test.describe('E62 diálogo "Link do formulário" depois de fechar o orçamento', () => {
    test.beforeEach(async ({ authApi }) => {
      await apiCompleteOnboarding(authApi);
    });

    /** Orçamento em rascunho e o "Fechar orçamento" pela tela; devolve o evento criado. */
    async function closeBudgetInForm(page: Page, api: APIRequestContext): Promise<string> {
      const client = await apiCreateClient(api);
      const activity = await apiCreateActivity(api);
      const budget = await apiCreateBudget(api, { clientId: client.id, activityIds: [activity.id] });
      await page.goto(`/app/budgets/${budget.id}`);
      const acceptResponse = page.waitForResponse(
        (r) => r.request().method() === 'POST' && /\/api\/budgets\/[0-9a-f-]+\/accept$/i.test(r.url()),
      );
      await page.getByTestId('budget-form-accept').click();
      await page.getByTestId('confirm-ok').click();
      const res = await acceptResponse;
      expect(res.ok(), 'o fechamento do orçamento').toBe(true);
      const body = (await res.json()) as { data?: { anchorEventId?: string } };
      const eventId = body.data?.anchorEventId;
      expect(eventId, 'o fechamento devolve o evento').toBeTruthy();
      return eventId!;
    }

    test('E62 @crud "Gerar link" emite; reabrir mostra o MESMO link', async ({ authPage, authApi }) => {
      const eventId = await closeBudgetInForm(authPage, authApi);

      // O GET só lê: o evento recém-aceito ainda não tem link.
      await expect(authPage.getByTestId('form-link-empty')).toBeVisible();
      await authPage.getByTestId('form-link-issue').click();
      const urlBox = authPage.getByTestId('form-link-url');
      await expect(urlBox).toContainText('/event-form/');
      const shown = (await urlBox.innerText()).trim();

      // Reabrir (GET) e pedir de novo (POST) devolvem o mesmo link, sem rotacionar.
      const reopened = await authApi.get(`/api/events/${eventId}/form-link`);
      await assertOk(reopened, 'GET form-link');
      expect((await readJson<{ url: string }>(reopened)).url).toBe(shown);
      const again = await authApi.post(`/api/events/${eventId}/form-link`);
      await assertOk(again, 'POST form-link');
      expect((await readJson<{ url: string }>(again)).url).toBe(shown);

      // E o link abre o formulário.
      await withPublicApi(async (publicApi) => {
        const token = shown.substring(shown.indexOf('/event-form/') + '/event-form/'.length);
        expect((await publicApi.get(`/api/public/events/${token}/form`)).status()).toBe(200);
      });
    });

    test('E62 @flow sem events.update o diálogo pede a quem pode editar; o back recusa a emissão', async ({
      authPage,
      authApi,
      tenant,
    }) => {
      // O fechamento exige `budgets.update` e o diálogo só abre depois dele;
      // nenhum perfil padrão tem `budgets.update` sem `events.update`. A tela
      // recebe a lista de permissions sem `events.update` (o back continua
      // valendo, conferido abaixo com um usuário Financial de verdade).
      await authPage.route('**/api/me/permissions', async (route: Route) => {
        const response = await route.fetch();
        const body = (await response.json()) as {
          data?: { permissions: string[] };
          permissions?: string[];
        };
        const holder = body.data ?? body;
        holder.permissions = (holder.permissions ?? []).filter((p) => p !== 'events.update');
        await route.fulfill({ response, json: body });
      });

      const eventId = await closeBudgetInForm(authPage, authApi);
      await expect(authPage.getByTestId('form-link-empty')).toBeVisible();
      await expect(authPage.getByTestId('form-link-issue')).toHaveCount(0);
      await expect(authPage.getByTestId('form-link-issue-forbidden')).toContainText(
        'Peça a quem pode editar eventos',
      );

      const financial = await loginAsRole(tenant.tenantId, 'Financial');
      try {
        const read = await financial.api.get(`/api/events/${eventId}/form-link`);
        expect(read.status(), 'ler o link só exige events.read').toBe(200);
        const issue = await financial.api.post(`/api/events/${eventId}/form-link`);
        expect(issue.status(), 'emitir exige events.update').toBe(403);
      } finally {
        await financial.api.dispose();
      }
    });

    test('E62 @flow evento concluído: o diálogo diz que o formulário não está mais disponível', async ({
      authPage,
      authApi,
    }) => {
      // O diálogo só abre logo depois do fechamento. O GET do link é segurado
      // até o evento ser concluído pela máquina de estados, e então segue ao back.
      let completedEventId: string | null = null;
      await authPage.route('**/api/events/*/form-link', async (route: Route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const eventId = /\/api\/events\/([0-9a-f-]+)\/form-link/i.exec(route.request().url())![1]!;
        await completeCommercialEvent(authApi, eventId);
        completedEventId = eventId;
        await route.continue();
      });

      const eventId = await closeBudgetInForm(authPage, authApi);
      const closed = authPage.getByTestId('form-link-closed');
      await expect(closed).toBeVisible({ timeout: 30_000 });
      await expect(closed).toContainText('não está mais disponível');
      expect(completedEventId).toBe(eventId);

      const issue = await authApi.post(`/api/events/${eventId}/form-link`);
      expect(issue.status()).toBe(409);
      expect(await apiErrorCodes(issue)).toContain('Event.FormLinkClosed');
    });
  });

  test('E63 @flow venda direta PF: CPF mascarado na dica e no formData, em branco mantém o gravado; venda via parceiro sem prefill', async ({
    authApi,
    page,
  }) => {
    test.setTimeout(150_000);
    const cpf = fakeCpf();
    const masked = `***.***.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
    const client = await apiCreateClient(authApi, {
      name: `Cliente Cpf ${uid()}`,
      email: `cliente-${uid()}@e2e.test`,
      document: cpf,
    });
    const { eventId } = await setupAcceptedEvent(authApi, { clientId: client.id });
    const { token } = await issueFormLink(authApi, eventId);

    await withPublicApi(async (publicApi) => {
      // Prefill do cadastro: CPF mascarado, e o número inteiro em lugar nenhum da resposta.
      const first = await publicApi.get(`/api/public/events/${token}/form`);
      await assertOk(first, 'GET público');
      const firstText = await first.text();
      const form = await readJson<{ prefill: { clientCpf: string | null } | null }>(first);
      expect(form.prefill?.clientCpf).toBe(masked);
      expect(firstText).not.toContain(cpf);
      expect(firstText).not.toContain(formatCpf(cpf));

      // O cliente grava o CPF: a releitura devolve o `formData` também mascarado.
      const put = await publicApi.put(`/api/public/events/${token}/form`, {
        data: { clientFullName: 'Cliente E2E', clientCpf: formatCpf(cpf), isConfirmed: false },
      });
      await assertOk(put, 'PUT público com CPF');
      const second = await publicApi.get(`/api/public/events/${token}/form`);
      await assertOk(second, 'GET público depois do envio');
      const secondText = await second.text();
      const reread = await readJson<{ formData: { clientCpf: string | null } | null }>(second);
      expect(reread.formData?.clientCpf).toBe(masked);
      expect(secondText).not.toContain(cpf);
      expect(secondText).not.toContain(formatCpf(cpf));
    });

    // Na tela, o CPF é dica sob o campo, que abre vazio; confirmar com ele em branco mantém o gravado.
    await page.goto(`/event-form/${token}`);
    await expect(page.getByTestId('public-form-clientCpf-hint')).toContainText(masked);
    await expect(page.getByTestId('public-form-clientCpf')).toHaveValue('');
    await page.getByTestId('public-form-step1-next').click();
    await page.getByTestId('public-form-step2-next').click();
    await page.getByTestId('public-form-confirm-btn').click();
    await expect(page.getByTestId('public-form-confirmed')).toBeVisible();

    const internal = await authApi.get(`/api/events/${eventId}/form-data`);
    await assertOk(internal, 'GET /api/events/{id}/form-data');
    const stored = await readJson<{ clientCpf: string | null }>(internal);
    expect((stored.clientCpf ?? '').replace(/\D/g, ''), 'o CPF gravado continua o mesmo').toBe(cpf);

    // Venda via parceiro: o cadastro é do salão, e o link vai à família.
    const partner = await authApi.post('/api/clients', {
      data: {
        type: 'PF',
        name: `Parceiro Pf ${uid()}`,
        document: fakeCpf(),
        phone: '41988887777',
        email: `parceiro-${uid()}@e2e.test`,
        isPartner: true,
        partnerCategory: 'Buffet',
      },
    });
    await assertOk(partner, 'POST parceiro');
    const partnerId = (await readJson<{ id: string }>(partner)).id;
    const partnerEvent = await setupAcceptedEvent(authApi, {
      clientId: partnerId,
      budget: { partnerSale: { endCustomerName: 'Família Souza', celebrantName: 'João', celebrantAge: 5 } },
    });
    const partnerLink = await issueFormLink(authApi, partnerEvent.eventId);
    await withPublicApi(async (publicApi) => {
      const res = await publicApi.get(`/api/public/events/${partnerLink.token}/form`);
      await assertOk(res, 'GET público da venda via parceiro');
      const form = await readJson<{ prefill: unknown }>(res);
      expect(form.prefill, 'venda via parceiro sem prefill').toBeNull();
    });
  });

  test('E64 @flow compra pelo link: URL com ?order=, F5 mantém o pedido e, pago, mostra o QR; o código curto não abre', async ({
    authApi,
    tenant,
    page,
  }) => {
    test.setTimeout(150_000);
    const sale = await setupTicketSale(authApi, tenant.tenantId);

    await page.goto(`/tickets/${sale.saleToken}`);
    await page.getByTestId(`ticket-plus-${sale.typeId}`).click();
    const buyer = `Comprador ${uid()}`;
    await page.getByTestId('buyer-name').fill(buyer);
    await page.getByTestId('buyer-child-0').fill('Criança E2E');
    await page.getByTestId('buyer-phone').fill('41999990000');
    await page.getByTestId('ticket-submit').click();
    await expect(page.getByTestId('ticket-status')).toBeVisible();

    await expect(page).toHaveURL(/[?&]order=[A-Za-z0-9_-]{32,}/);
    const statusToken = new URL(page.url()).searchParams.get('order')!;
    expect(new URL(page.url()).searchParams.has('code')).toBe(false);
    const shortCode = (await page.getByTestId('ticket-short-code').innerText()).trim();
    expect(statusToken).not.toBe(shortCode);

    // F5 com o pedido pendente: a página continua no pedido.
    await page.reload();
    await expect(page.getByTestId('ticket-status')).toBeVisible();
    await expect(page.getByTestId('ticket-short-code')).toHaveText(shortCode);

    // Pago, o F5 mostra o ingresso com o QR.
    const order = (await apiListTicketParticipants(authApi, sale.eventId)).find((p) => p.shortCode === shortCode);
    expect(order, 'o pedido aparece para o gestor').toBeTruthy();
    await assertOk(
      await authApi.post(`/api/events/${sale.eventId}/ticketing/orders/${order!.orderId}/confirm-payment`, {
        data: { paymentMethod: 'Pix', note: null },
      }),
      'confirm-payment',
    );
    await page.reload();
    await expect(page.getByTestId('ticket-short-code')).toHaveText(shortCode);
    await expect(page.getByTestId('ticket-qrs')).toBeVisible();
    await expect(page.getByTestId('ticket-qrs').locator('p.font-mono')).not.toHaveCount(0);

    // O código curto não abre o pedido.
    await withPublicApi(async (publicApi) => {
      const byCode = await publicApi.get(`/api/public/tickets/${sale.saleToken}/orders/${shortCode}`);
      expect(byCode.status(), 'pedido pelo código curto').toBe(404);
    });
  });

  test('E64 @flow pedido pelo código curto dá 404 e pelo token abre; ?code= antigo vira "formato antigo" sem chamada à API', async ({
    authApi,
    tenant,
    page,
  }) => {
    test.setTimeout(120_000);
    // Um pedido qualquer do evento (o fiado do caderno), com o link de status que o gestor envia.
    const sale = await setupTicketSale(authApi, tenant.tenantId);
    const buyer = `Fiado Codigo ${uid()}`;
    await apiRegisterDeferredTicketSale(authApi, sale.eventId, sale.typeId, buyer);
    const order = (await apiListTicketParticipants(authApi, sale.eventId)).find((p) => p.responsibleName === buyer);
    expect(order, 'o pedido existe').toBeTruthy();
    const { statusToken } = await apiCreateTicketOrderStatusLink(authApi, sale.eventId, order!.orderId);

    await withPublicApi(async (publicApi) => {
      const byToken = await publicApi.get(`/api/public/tickets/${sale.saleToken}/orders/${statusToken}`);
      expect(byToken.status(), 'pedido pelo token de status').toBe(200);
      const byCode = await publicApi.get(`/api/public/tickets/${sale.saleToken}/orders/${order!.shortCode}`);
      expect(byCode.status(), 'pedido pelo código curto').toBe(404);
    });

    // Link do formato antigo: a página diz que é antigo sem chamar a API.
    const apiCalls: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/public/tickets')) apiCalls.push(r.url());
    });
    await page.goto(`/tickets/${sale.saleToken}?code=${order!.shortCode}`);
    await expect(page.getByTestId('ticket-legacy-order-link')).toContainText('formato antigo');
    expect(apiCalls, 'nenhuma chamada à API pública de ingressos').toEqual([]);
  });

  test('E65 @flow fiado: "Cobrar" leva o link ?order= que abre o pedido; sem link de venda, a cobrança sai sem link e o motivo aparece', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(150_000);
    await apiCompleteOnboarding(authApi);
    const withLink = await setupTicketSale(authApi, tenant.tenantId);
    const withoutLink = await setupTicketSale(authApi, tenant.tenantId, { withSaleLink: false });

    const buyerWith = `Fiado Com Link ${uid()}`;
    const buyerWithout = `Fiado Sem Link ${uid()}`;
    await apiRegisterDeferredTicketSale(authApi, withLink.eventId, withLink.typeId, buyerWith);
    await apiRegisterDeferredTicketSale(authApi, withoutLink.eventId, withoutLink.typeId, buyerWithout);
    const orderWith = (await apiListTicketParticipants(authApi, withLink.eventId)).find(
      (p) => p.responsibleName === buyerWith,
    )!;
    const orderWithout = (await apiListTicketParticipants(authApi, withoutLink.eventId)).find(
      (p) => p.responsibleName === buyerWithout,
    )!;
    expect(orderWith.isDeferredPayment && orderWithout.isDeferredPayment).toBe(true);

    // A conversa do WhatsApp abre numa aba nova; aqui ela não sai para a internet.
    await authPage.context().route('https://wa.me/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>wa.me</body></html>' }),
    );

    const chargeText = async (eventId: string, orderId: string): Promise<string> => {
      await authPage.goto(`/app/events/${eventId}`);
      await authPage.getByRole('tab', { name: 'Ingressos', exact: true }).click();
      const button = authPage.getByTestId(`ticketing-charge-${orderId}`);
      await expect(button).toBeVisible();
      const popupPromise = authPage.waitForEvent('popup');
      await button.click();
      const popup = await popupPromise;
      await popup.waitForURL(/wa\.me/);
      const text = new URL(popup.url()).searchParams.get('text') ?? '';
      await popup.close();
      return text;
    };

    // Com link de venda: a mensagem leva a página do pedido pelo token de status.
    const message = await chargeText(withLink.eventId, orderWith.orderId);
    const link = /(https?:\/\/\S+\?order=[A-Za-z0-9_-]+)/.exec(message)?.[1];
    expect(link, `mensagem com o link do pedido: ${message}`).toBeTruthy();
    expect(link).not.toContain('code=');
    // A origem do link é a do `PublicLinkBaseUrl` do back (no E2E, o domínio de
    // produção); o caminho e o token são o que se confere, no front do teste.
    const target = new URL(link!);
    expect(target.pathname).toBe(`/tickets/${withLink.saleToken}`);
    const orderPage = await authPage.context().newPage();
    try {
      await orderPage.goto(`${target.pathname}${target.search}`);
      await expect(orderPage.getByTestId('ticket-status')).toBeVisible();
      await expect(orderPage.getByTestId('ticket-short-code')).toHaveText(orderWith.shortCode);
    } finally {
      await orderPage.close();
    }

    // Sem link de venda ativo: a cobrança sai sem link, e a tela diz por quê.
    const messageWithout = await chargeText(withoutLink.eventId, orderWithout.orderId);
    expect(messageWithout).not.toMatch(/https?:\/\//);
    await expect(snack(authPage, 'não tem link de venda ativo')).toBeVisible();
  });

  test('E66 @flow "Pagar com cartão" com endereço de gateway fora da lista: mensagem na página e nenhuma navegação', async ({
    authApi,
    tenant,
    page,
  }) => {
    test.setTimeout(120_000);
    const sale = await setupTicketSale(authApi, tenant.tenantId);
    await apiSetSettingParameter(authApi, 'TICKETING_PIX_KEY', 'pix-e2e@recreativo.test');
    // Cartão só aparece com gateway TESTADO: credencial pelo PUT, marca de verificado por SQL.
    await assertOk(
      await authApi.put('/api/ticketing/gateway', {
        data: { kind: 'Asaas', apiKey: 'fake-asaas-key-e2e', webhookSecret: 'fake-webhook-secret-e2e', isSandbox: true },
      }),
      'PUT /api/ticketing/gateway',
    );
    enableTicketingGatewayDirect(tenant.tenantId);

    const order = await withPublicApi((publicApi) =>
      apiCreatePublicTicketOrder(publicApi, sale.saleToken!, sale.typeId, { intent: 'PixNow' }),
    );

    // O provider do back fala com o Asaas real (endereço fixo); o "gateway
    // fake" é a resposta do payment-link com o checkout do fake-asaas, fora da
    // lista do front.
    await page.route('**/api/public/tickets/*/orders/*/payment-link', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ isError: false, data: { url: 'https://fake-asaas.local/i/pay_e2e' }, errors: [] }),
      }),
    );
    await page.route('https://fake-asaas.local/**', (route) => route.abort());
    const gatewayHits = trackRequestsTo(page, 'fake-asaas.local');

    await page.goto(`/tickets/${sale.saleToken}?order=${order.statusToken}`);
    await page.getByTestId('ticket-pay-card').click();
    await expect(page.getByTestId('ticket-card-error')).toContainText('não é de um gateway reconhecido');
    expect(new URL(page.url()).pathname).toBe(`/tickets/${sale.saleToken}`);
    expect(gatewayHits, 'nenhuma navegação ao gateway fora da lista').toEqual([]);
  });

  test('E67 @flow export LGPD concluído: banco só com o hash do token; link da listagem baixa e token trocado dá 404', async ({
    authApi,
  }) => {
    test.setTimeout(150_000);
    const exported = await requestCompletedExport(authApi);

    // Nenhuma coluna guarda o token cru: a antiga saiu e a linha não o contém.
    const columns = tableColumnsDirect('DataExportRequests');
    expect(columns).toContain('DownloadTokenHash');
    expect(columns).not.toContain('DownloadToken');
    const row = dataExportRowJsonDirect(exported.id);
    expect(row, 'a linha existe').toBeTruthy();
    expect(row, 'o token cru não está em coluna nenhuma').not.toContain(exported.token);
    const stored = JSON.parse(row) as { DownloadTokenHash: string };
    expect(stored.DownloadTokenHash.toUpperCase()).toBe(
      createHash('sha256').update(exported.token, 'utf8').digest('hex').toUpperCase(),
    );

    await withPublicApi(async (publicApi) => {
      const ok = await publicApi.get(exported.downloadUrl);
      expect(ok.status(), 'download pela URL da listagem').toBe(200);

      const swapped = exported.token.slice(0, -1) + (exported.token.endsWith('A') ? 'B' : 'A');
      const wrong = await publicApi.get(`/api/privacy/exports/${exported.id}/download/${swapped}`);
      expect(wrong.status(), 'token trocado').toBe(404);
    });
  });
});
