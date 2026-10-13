import { APIRequestContext, APIResponse } from '@playwright/test';

import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createApiContext, createBearerMultipartContext } from '../../helpers/api-client';
import { apiSetAiFeature } from '../../helpers/api-entities';
import {
  apiCreatePublicEvent,
  apiCreateTicketSaleLink,
  apiCreateTicketType,
  apiListTicketParticipants,
  createPublicApiContext,
} from '../../helpers/api-event-flow';
import { docxBytes, pngBytes } from '../../helpers/binary-files';
import { enableFeatureFlagDirect, setTenantSubdomainDirect } from '../../helpers/db-helper';
import { apiErrorCodes, assertOk, readJson, unwrapList } from '../../helpers/response';

/**
 * Fluxo: 17.8 — Limites de entrada e abuso anônimo
 * Diagrama: — (cenários E114, E115, E116, E118, E120 e E121 do registro e2e de
 * `docs/implementar/PLANO-SEGURANCA.md`)
 *
 * Fonte do comportamento: PLANO-SEGURANCA §12 (SEG-J): itens 1 (tetos do pedido
 * público de ingresso e reservas em aberto por telefone), 2 (DOCX na importação
 * de modelo e no `generate-clause`), 4 (corpo de ~1 MB em toda rota, uploads
 * com o próprio teto), 5 (honeypot do lead público, D11), 8 e 9b (magic bytes,
 * nome e teto de anexos do bug), 10 (400 sem mensagem do desserializador) e 12
 * (front do ingresso e do lead). O spec afirma o plano; divergência é falha de
 * código, não de asserção.
 */

/** Sufixo único só com letras. */
function uid(): string {
  return Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
}

/** Celular de Curitiba único do teste: a contagem de reservas em aberto é por telefone. */
function uniquePhone(): string {
  return `419${String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0')}`;
}

async function withPublicApi<T>(fn: (api: APIRequestContext) => Promise<T>): Promise<T> {
  const api = await createPublicApiContext();
  try {
    return await fn(api);
  } finally {
    await api.dispose();
  }
}

/** Evento aberto ao público com `typeCount` tipos de ingresso ativos (sem teto) e o link de venda. */
async function setupTicketSale(
  api: APIRequestContext,
  tenantId: string,
  typeCount = 1,
): Promise<{ eventId: string; typeIds: string[]; saleToken: string }> {
  enableFeatureFlagDirect(tenantId, 'feature_ticketing');
  const event = await apiCreatePublicEvent(api, { title: `Evento público E2E ${uid()}` });
  const typeIds: string[] = [];
  for (let i = 0; i < typeCount; i++) {
    const type = await apiCreateTicketType(api, event.id, { name: `Tipo ${i + 1} ${uid()}`, price: 10 });
    typeIds.push(type.id);
  }
  const link = await apiCreateTicketSaleLink(api, event.id);
  return { eventId: event.id, typeIds, saleToken: link.token };
}

/** POST do pedido público sem lançar: o teste lê status e códigos. */
function postOrder(
  publicApi: APIRequestContext,
  saleToken: string,
  lines: Array<{ ticketTypeId: string; quantity: number }>,
  phone = uniquePhone(),
): Promise<APIResponse> {
  return publicApi.post(`/api/public/tickets/${saleToken}/orders`, {
    data: {
      buyer: {
        responsibleName: `Comprador E2E ${uid()}`,
        childrenNames: ['Criança E2E'],
        primaryPhone: phone,
        marketingConsent: false,
      },
      lines,
      intent: 'PayOnArrival',
      idempotencyKey: `e2e-${uid()}-${Date.now()}`,
    },
  });
}

/** 400 de validação com um código de campo que contém `field` (o caminho da propriedade). */
async function expectFieldError(res: APIResponse, field: RegExp, label: string): Promise<void> {
  expect(res.status(), `${label}: status`).toBe(400);
  const codes = await apiErrorCodes(res);
  expect(codes.some((c) => field.test(c)), `${label}: campo no erro (${codes.join(', ')})`).toBe(true);
}

interface BugCreated {
  id: string;
}

async function createBug(api: APIRequestContext): Promise<string> {
  const res = await api.post('/api/bugs', {
    data: {
      title: `Bug E2E ${uid()}`,
      description: 'Descrição do bug (E2E).',
      stepsToReproduce: null,
      affectedModule: 'Eventos',
      severity: 'Low',
      context: {
        currentUrl: 'http://localhost:4200/app/events',
        currentModule: 'events',
        browser: 'Chromium',
        device: 'Desktop',
        os: 'Windows',
        screenResolution: '1920x1080',
        appVersion: 'e2e',
        apiVersion: null,
        lastConsoleError: null,
      },
    },
  });
  await assertOk(res, 'POST /api/bugs');
  return (await readJson<BugCreated>(res)).id;
}

function attach(
  api: APIRequestContext,
  bugId: string,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<APIResponse> {
  return api.post(`/api/bugs/${bugId}/attachments`, { multipart: { file } });
}

/** A API segue de pé: `/health` responde e uma rota autenticada também. */
async function expectApiAlive(authApi: APIRequestContext): Promise<void> {
  const anon = await createApiContext();
  try {
    expect((await anon.get('/health')).status(), '/health depois do arquivo').toBe(200);
  } finally {
    await anon.dispose();
  }
  expect((await authApi.get('/api/clients?pageSize=1')).status(), 'rota autenticada depois do arquivo').toBe(200);
}

const ONE_GB = 1024 * 1024 * 1024;

// ════════════════════════════════════════════════════════════════════════════

test.describe('Fluxo 17.8 — Limites de entrada e abuso anônimo', () => {
  // ─── §12 item 1 — venda pública de ingresso ──────────────────────────────

  test('E114 @flow pedido público acima dos tetos: 400 com o campo e nenhum ingresso; dentro dos tetos segue criando', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(120_000);
    const sale = await setupTicketSale(authApi, tenant.tenantId, 21);
    const [first, second] = sale.typeIds as [string, string];

    await withPublicApi(async (publicApi) => {
      const perLine = await postOrder(publicApi, sale.saleToken, [{ ticketTypeId: first, quantity: 21 }]);
      await expectFieldError(perLine, /Lines\[0\]\.Quantity/i, '21 numa linha');

      const manyTypes = await postOrder(
        publicApi,
        sale.saleToken,
        sale.typeIds.map((ticketTypeId) => ({ ticketTypeId, quantity: 1 })),
      );
      await expectFieldError(manyTypes, /^Lines/i, '21 tipos no pedido');

      const overflow = await postOrder(publicApi, sale.saleToken, [
        { ticketTypeId: first, quantity: 2_147_483_647 },
        { ticketTypeId: second, quantity: 2_147_483_647 },
      ]);
      await expectFieldError(overflow, /^Lines/i, 'duas linhas int.MaxValue');
    });

    expect(await apiListTicketParticipants(authApi, sale.eventId), 'nenhum pedido emitido').toEqual([]);

    // Dentro dos tetos o pedido continua criando.
    await withPublicApi(async (publicApi) => {
      const ok = await postOrder(publicApi, sale.saleToken, [{ ticketTypeId: first, quantity: 20 }]);
      expect(ok.status(), `pedido de 20 do mesmo tipo: ${await ok.text()}`).toBeLessThan(300);
    });
    const participants = await apiListTicketParticipants(authApi, sale.eventId);
    expect(participants, 'o pedido dentro do teto foi emitido').toHaveLength(1);
  });

  test('E114 @flow na tela, o "+" para no 20º do tipo e no 50º do pedido, com o aviso', async ({
    authApi,
    tenant,
    page,
  }) => {
    test.setTimeout(120_000);
    const sale = await setupTicketSale(authApi, tenant.tenantId, 3);
    const [a, b, c] = sale.typeIds as [string, string, string];

    await page.goto(`/tickets/${sale.saleToken}`);
    await expect(page.getByTestId(`ticket-type-${a}`)).toBeVisible();

    const plus = (id: string) => page.getByTestId(`ticket-plus-${id}`);
    for (let i = 0; i < 20; i++) await plus(a).click();
    await expect(plus(a), '+ do tipo A travado no 20º').toBeDisabled();
    await expect(page.getByTestId(`ticket-line-limit-${a}`)).toContainText('20');

    for (let i = 0; i < 20; i++) await plus(b).click();
    await expect(plus(b), '+ do tipo B travado no 20º').toBeDisabled();

    for (let i = 0; i < 10; i++) await plus(c).click();
    await expect(plus(c), '+ do tipo C travado no 50º do pedido').toBeDisabled();
    await expect(page.getByTestId('ticket-order-limit')).toContainText('50');
  });

  test('E115 @flow o mesmo telefone na 4ª reserva em aberto do evento toma 409; outro telefone segue comprando', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(120_000);
    const sale = await setupTicketSale(authApi, tenant.tenantId, 1);
    const typeId = sale.typeIds[0]!;
    const phone = uniquePhone();

    await withPublicApi(async (publicApi) => {
      for (let i = 1; i <= 3; i++) {
        const res = await postOrder(publicApi, sale.saleToken, [{ ticketTypeId: typeId, quantity: 1 }], phone);
        expect(res.status(), `reserva ${i} do mesmo telefone: ${await res.text()}`).toBeLessThan(300);
      }

      const fourth = await postOrder(publicApi, sale.saleToken, [{ ticketTypeId: typeId, quantity: 1 }], phone);
      expect(fourth.status(), '4ª reserva em aberto').toBe(409);
      const body = (await fourth.json()) as { errors?: Array<{ code: string; description: string }> };
      expect(body.errors?.map((e) => e.code)).toContain('PublicTicketSale.TooManyOpenOrders');
      expect(body.errors?.[0]?.description ?? '').toMatch(/pedidos aguardando pagamento/i);

      const other = await postOrder(publicApi, sale.saleToken, [{ ticketTypeId: typeId, quantity: 1 }]);
      expect(other.status(), `outro telefone: ${await other.text()}`).toBeLessThan(300);
    });
  });

  // ─── §12 item 5 (D11) — honeypot do lead público ─────────────────────────

  test('E116 @flow lead com o campo isca preenchido: agradecimento pela tela e 201 pela API, e nenhum lead; sem a isca, o lead nasce', async ({
    authApi,
    tenant,
    page,
  }) => {
    test.setTimeout(120_000);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_leads');
    const tag = uid();
    const slug = setTenantSubdomainDirect(tenant.tenantId, `festa-${tag}`);
    const uiName = `Robo Tela ${tag}`;
    const apiBotName = `Robo Api ${tag}`;
    const humanName = `Pessoa Real ${tag}`;

    // Pela tela: o robô preenche o campo escondido e recebe o mesmo agradecimento.
    const leadPosts: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/api/public/leads/')) leadPosts.push(r.url());
    });
    await page.goto(`/leads/by-slug/${slug}`);
    await expect(page.getByTestId('public-lead-form-card')).toBeVisible();
    await page.getByTestId('public-lead-name').fill(uiName);
    await page.getByTestId('public-lead-phone').fill('41999887766');
    await page.getByTestId('public-lead-website').fill('https://spam.example', { force: true });
    await page.getByTestId('public-lead-submit').click();
    await expect(page.getByTestId('public-lead-submitted')).toBeVisible();

    // Direto na API: 201 com id, como se tivesse gravado.
    await withPublicApi(async (publicApi) => {
      const bot = await publicApi.post(`/api/public/leads/by-slug/${slug}`, {
        data: { name: apiBotName, whatsAppPhone: '41999887755', website: 'https://spam.example', captchaToken: null },
      });
      expect(bot.status(), `honeypot pela API: ${await bot.text()}`).toBe(201);
      const created = await readJson<{ leadId: string }>(bot);
      expect(created.leadId).toMatch(/^[0-9a-f-]{36}$/i);
      expect((await authApi.get(`/api/leads/${created.leadId}`)).status(), 'o id devolvido não existe').toBe(404);

      // O mesmo envio sem a isca cria o lead.
      const human = await publicApi.post(`/api/public/leads/by-slug/${slug}`, {
        data: { name: humanName, whatsAppPhone: '41999887744', website: '', captchaToken: null },
      });
      expect(human.status(), `lead sem a isca: ${await human.text()}`).toBe(201);
    });

    const list = await authApi.get(`/api/leads?search=${encodeURIComponent(tag)}&pageSize=50`);
    await assertOk(list, 'GET /api/leads');
    const names = (await unwrapList<{ name: string }>(list)).map((l) => l.name);
    expect(names, 'só o lead sem a isca entrou no Kanban').toEqual([humanName]);
  });

  // ─── §12 itens 8 e 9b — anexos do bug ────────────────────────────────────

  test('E118 @flow anexo de bug: 11º toma 409, HTML rotulado image/png e nome de 256 caracteres tomam 400', async ({
    tenant,
    authApi,
  }) => {
    test.setTimeout(120_000);
    const upload = await createBearerMultipartContext(tenant.accessToken);
    try {
      const bugId = await createBug(authApi);
      const png = pngBytes();

      const html = await attach(upload, bugId, {
        name: 'print.png',
        mimeType: 'image/png',
        buffer: Buffer.from('<html><body><script>alert(1)</script></body></html>', 'utf8'),
      });
      expect(html.status(), 'HTML rotulado image/png').toBe(400);
      const htmlBody = (await html.json()) as { errors?: Array<{ description: string }> };
      expect(htmlBody.errors?.[0]?.description ?? '').toMatch(/não corresponde/i);

      const longName = await attach(upload, bugId, {
        name: `${'a'.repeat(252)}.png`,
        mimeType: 'image/png',
        buffer: png,
      });
      expect(longName.status(), 'nome de 256 caracteres').toBe(400);

      for (let i = 1; i <= 10; i++) {
        const res = await attach(upload, bugId, { name: `print-${i}.png`, mimeType: 'image/png', buffer: png });
        expect(res.status(), `anexo ${i}: ${await res.text()}`).toBe(201);
      }

      const eleventh = await attach(upload, bugId, { name: 'print-11.png', mimeType: 'image/png', buffer: png });
      expect(eleventh.status(), '11º anexo').toBe(409);
      const body = (await eleventh.json()) as { errors?: Array<{ code: string; description: string }> };
      expect(body.errors?.[0]?.code).toBe('Bug.TooManyAttachments');
      expect(body.errors?.[0]?.description ?? '', 'mensagem do teto de 10 anexos').toMatch(/10 anexos/);
    } finally {
      await upload.dispose();
    }
  });

  // ─── §12 itens 4 e 10 — teto do corpo e 400 sem detalhe do .NET ─────────

  test('E120 @flow corpo de 2 MB dá 413 com envelope; logo de 500 KB e anexo de 20 MB passam; tipo errado dá "Valor inválido."', async ({
    tenant,
    authApi,
  }) => {
    test.setTimeout(180_000);

    // Corpo de 2 MB num endpoint comum. O Kestrel responde 413 assim que o
    // Content-Length passa do teto e pode fechar a conexão com o corpo ainda
    // subindo: o cliente às vezes vê ECONNRESET antes de ler a resposta. Só esse
    // erro de transporte se repete; qualquer resposta HTTP é a que vale.
    const bigData = { type: 'PF', name: `Cliente ${uid()}`, notes: 'x'.repeat(2 * 1024 * 1024) };
    let big: APIResponse | null = null;
    for (let attempt = 1; attempt <= 5 && !big; attempt++) {
      try {
        big = await authApi.post('/api/clients', { data: bigData });
      } catch (err) {
        if (!/ECONNRESET|EPIPE|socket hang up/i.test(String(err)) || attempt === 5) throw err;
      }
    }
    if (!big) throw new Error('corpo de 2 MB sem resposta');
    expect(big.status(), 'corpo de 2 MB').toBe(413);
    const bigBody = (await big.json()) as { isError?: boolean; errors?: Array<{ code: string }> };
    expect(bigBody.isError, 'envelope de erro').toBe(true);
    expect(bigBody.errors?.map((e) => e.code)).toContain('Request.TooLarge');

    // Logo de ~500 KB no cadastro da empresa continua aceito.
    const companyRes = await authApi.get('/api/company');
    await assertOk(companyRes, 'GET /api/company');
    const company = await readJson<Record<string, unknown>>(companyRes);
    const logo = pngBytes({ width: 200, height: 80, totalBytes: 500_000 });
    const put = await authApi.put('/api/company', {
      data: {
        name: company.name,
        legalName: company.legalName ?? null,
        document: company.document ?? null,
        timezone: company.timezone ?? 'America/Sao_Paulo',
        logoBase64: `data:image/png;base64,${logo.toString('base64')}`,
        contactEmail: company.contactEmail ?? null,
        contactPhone: company.contactPhone ?? null,
        address: company.address ?? null,
        billingEmail: company.billingEmail ?? null,
        businessSegments: null,
      },
    });
    expect(put.status(), `logo de 500 KB: ${(await put.text()).slice(0, 300)}`).toBeLessThan(300);

    // Anexo de bug de 20 MB continua aceito.
    const upload = await createBearerMultipartContext(tenant.accessToken);
    try {
      const bugId = await createBug(authApi);
      const res = await attach(upload, bugId, {
        name: 'video-grande.png',
        mimeType: 'image/png',
        buffer: pngBytes({ totalBytes: 20 * 1024 * 1024 }),
      });
      expect(res.status(), `anexo de 20 MB: ${(await res.text()).slice(0, 300)}`).toBe(201);
    } finally {
      await upload.dispose();
    }

    // JSON com tipo errado: 400 "Valor inválido." sem a mensagem do desserializador.
    const wrongType = await authApi.post('/api/clients', {
      data: { type: 'PF', name: { nested: true }, email: null, phone: '41999999999' },
    });
    expect(wrongType.status(), 'tipo errado no JSON').toBe(400);
    const text = await wrongType.text();
    const parsed = JSON.parse(text) as { isError?: boolean; errors?: Array<{ description: string }> };
    expect(parsed.isError).toBe(true);
    expect(parsed.errors?.map((e) => e.description)).toContain('Valor inválido.');
    expect(text, 'sem detalhe do .NET').not.toMatch(/System\.|could not be converted|JSON value|Path:|LineNumber/i);
  });

  // ─── §12 item 2 — DOCX zip bomb ──────────────────────────────────────────

  test('E121 @flow DOCX que declara 1 GB descompactado é recusado com mensagem na importação de modelo e no generate-clause; a API segue respondendo', async ({
    authApi,
  }) => {
    test.setTimeout(120_000);
    await apiSetAiFeature(authApi, 'ai_contract_template_import', true);
    await apiSetAiFeature(authApi, 'ai_generate_clause', true);
    const bomb = docxBytes(`Contrato de recreação ${uid()}`, { declaredDocumentBytes: ONE_GB });
    const fileBase64 = bomb.toString('base64');

    const importRes = await authApi.post('/api/contracts/template-imports', {
      data: { fileBase64, fileName: `modelo-${uid()}.docx` },
    });
    expect(importRes.status(), 'importação de modelo com zip bomb').toBe(400);
    const importBody = (await importRes.json()) as { errors?: Array<{ code: string; description: string }> };
    expect(importBody.errors?.[0]?.code).toBe('Ai.InvalidReferenceFile');
    expect(importBody.errors?.[0]?.description ?? '', 'mensagem para o gestor').not.toBe('');
    await expectApiAlive(authApi);

    const clauseRes = await authApi.post('/api/ai/generate-clause', {
      data: {
        prompt: `Cláusula de cancelamento ${uid()}`,
        category: 'Geral',
        applicableTo: ['ClientIndividual'],
        tone: 'Formal',
        referenceFile: { fileBase64, fileName: 'referencia.docx' },
      },
    });
    expect(clauseRes.status(), 'generate-clause com zip bomb').toBe(400);
    const clauseBody = (await clauseRes.json()) as { errors?: Array<{ code: string; description: string }> };
    expect(clauseBody.errors?.[0]?.code).toBe('Ai.InvalidReferenceFile');
    expect(clauseBody.errors?.[0]?.description ?? '').not.toBe('');
    await expectApiAlive(authApi);
  });
});
