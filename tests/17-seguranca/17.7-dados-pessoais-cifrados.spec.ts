import { APIRequestContext, Page } from '@playwright/test';

import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import { apiCompleteOnboarding, apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import {
  apiCreateBudget,
  apiGetPublicBudget,
  apiSendBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';
import { getClientDocumentColumnsDirect, getFormDataPersonalColumnsDirect } from '../../helpers/db-helper';
import { assertOk, readJson } from '../../helpers/response';
import { setupAcceptedEvent } from '../../helpers/setup-flows';
import { fakeCnpj, fakeCpf, formatCnpj, formatCpf } from '../../helpers/test-data';

/**
 * Fluxo: 17.7 — Dados pessoais cifrados: documento do cliente e formulário pós-aceite
 * Diagrama: — (cenários E72 a E75 do registro e2e de
 * `docs/implementados/PLANO-SEGURANCA.md`)
 *
 * Fonte do comportamento: PLANO-SEGURANCA §14 itens 3 e 4 (SEG-L, criptografia
 * autenticada; CPF/CNPJ e restrições cifrados, busca pelo hash do documento
 * completo, sem ordenação pelo documento), decisão D7 e os ajustes da Etapa
 * 234 (aceite PJ pelo `SubmitPublicEventFormDto`, CPF com letra recusado). O
 * spec afirma o plano; divergência é falha de código, não de asserção.
 */

const FRONT_URL = process.env.FRONT_URL ?? 'http://localhost:4200';

/** Sufixo só com letras: o documento procurado não pode casar com nome nem e-mail. */
function uid(): string {
  return Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
}

interface ClientRow {
  id: string;
  name: string;
}

async function searchClients(api: APIRequestContext, search: string): Promise<ClientRow[]> {
  const res = await api.get(`/api/clients?search=${encodeURIComponent(search)}&pageSize=50`);
  await assertOk(res, 'GET /api/clients?search=');
  const data = await readJson<{ items: ClientRow[] } | ClientRow[]>(res);
  return Array.isArray(data) ? data : data.items;
}

/** Digita a busca da lista de clientes e espera a lista terminar de recarregar. */
async function searchInList(page: Page, text: string): Promise<void> {
  const reload = page.waitForResponse(
    (r) => r.request().method() === 'GET' && /\/api\/clients(\?|$)/.test(r.url()),
  );
  await page.getByTestId('clients-search').fill(text);
  await reload;
}

/** O valor que ficou no campo de documento depois de digitar `typed`: letra recusada fica fora. */
async function letterRefusedInField(page: Page, inputTestId: string, errorTestId: string, typed: string) {
  const input = page.getByTestId(inputTestId);
  await input.fill(typed);
  await input.blur();
  const value = await input.inputValue();
  const errorShown = await page.getByTestId(errorTestId).isVisible();
  return { value, errorShown, refused: errorShown || !/[A-Za-z]/.test(value) };
}

test.describe('Fluxo 17.7 — Dados pessoais cifrados', () => {
  test('E72 @flow lista de clientes: documento completo acha com e sem máscara, trecho não acha, coluna Documento não ordena; banco com v2: e hash', async ({
    authApi,
    authPage,
  }) => {
    test.setTimeout(120_000);
    await apiCompleteOnboarding(authApi);
    const cpf = fakeCpf();
    const cnpj = fakeCnpj();
    const pf = await apiCreateClient(authApi, {
      name: `Cliente Pf ${uid()}`,
      email: `pf-${uid()}@e2e.test`,
      document: cpf,
    });
    const pj = await apiCreateClient(authApi, {
      type: 'PJ',
      name: `Empresa Pj ${uid()}`,
      email: `pj-${uid()}@e2e.test`,
      document: cnpj,
    });
    const pfName = String(pf.name);
    const pjName = String(pj.name);

    // No banco: cifrado no formato novo, com o hash da busca.
    for (const [label, id, digits] of [
      ['CPF', pf.id, cpf],
      ['CNPJ', pj.id, cnpj],
    ] as const) {
      const row = getClientDocumentColumnsDirect(id);
      expect(row.document, `${label} cifrado`).toMatch(/^v2:/);
      expect(row.document, `${label} sem o número em claro`).not.toContain(digits);
      expect(row.documentHash, `${label} com DocumentHash`).toMatch(/^[0-9A-Fa-f]{64}$/);
    }

    await authPage.goto('/app/clients/list');
    await expect(authPage.getByTestId('clients-table')).toBeVisible();
    const table = authPage.getByTestId('clients-table');

    for (const search of [cpf, formatCpf(cpf)]) {
      await searchInList(authPage, search);
      await expect(table, `busca "${search}" acha o cliente PF`).toContainText(pfName);
      await expect(table).not.toContainText(pjName);
    }
    for (const search of [cnpj, formatCnpj(cnpj)]) {
      await searchInList(authPage, search);
      await expect(table, `busca "${search}" acha o cliente PJ`).toContainText(pjName);
      await expect(table).not.toContainText(pfName);
    }

    // Um trecho do documento não acha nada.
    await searchInList(authPage, cpf.slice(0, 6));
    await expect(authPage.getByTestId('clients-empty')).toBeVisible();
    await searchInList(authPage, cnpj.slice(2, 10));
    await expect(authPage.getByTestId('clients-empty')).toBeVisible();

    // A coluna Documento não ordena (o Nome ordena, como controle).
    await searchInList(authPage, '');
    const header = authPage.getByTestId('clients-header-document');
    await expect(header).toBeVisible();
    await expect(header.locator('.mat-sort-header-container')).toHaveCount(0);
    await expect(
      authPage.locator('th').filter({ hasText: 'Nome' }).locator('.mat-sort-header-container'),
    ).toHaveCount(1);
  });

  test('E73 @flow o mesmo CPF em dois tenants: a busca de cada empresa acha só o próprio cliente', async ({
    authApi,
  }) => {
    const cpf = fakeCpf();
    const nameA = `Cliente Do A ${uid()}`;
    const nameB = `Cliente Do B ${uid()}`;
    await apiCreateClient(authApi, { name: nameA, email: `a-${uid()}@e2e.test`, document: cpf });

    const b = await signupNewTenant();
    const bApi = await createBearerApiContext(b.accessToken);
    try {
      await apiCreateClient(bApi, { name: nameB, email: `b-${uid()}@e2e.test`, document: cpf });

      for (const search of [cpf, formatCpf(cpf)]) {
        const fromA = (await searchClients(authApi, search)).map((c) => c.name);
        expect(fromA, `tenant A busca "${search}"`).toEqual([nameA]);
        const fromB = (await searchClients(bApi, search)).map((c) => c.name);
        expect(fromB, `tenant B busca "${search}"`).toEqual([nameB]);
      }
    } finally {
      await bApi.dispose();
    }
  });

  test.describe('E74 aceite público por contratante PJ', () => {
    /** Orçamento enviado para um cliente PJ; abre a página e o diálogo de aceite. */
    async function openAcceptDialog(page: Page, api: APIRequestContext): Promise<string> {
      const client = await apiCreateClient(api, {
        type: 'PJ',
        name: `Empresa Contratante ${uid()}`,
        email: `pj-${uid()}@e2e.test`,
        document: fakeCnpj(),
      });
      const activity = await apiCreateActivity(api);
      const budget = await apiCreateBudget(api, { clientId: client.id, activityIds: [activity.id] });
      const token = extractTokenFromPublicUrl((await apiSendBudget(api, budget.id)).publicUrl);
      await page.goto(`/budgets/${token}`);
      await page.getByTestId('public-budget-accept').click();
      await expect(page.getByTestId('accept-dialog-name')).toBeVisible();
      return token;
    }

    test('E74 @crud CNPJ formatado no aceite: o aceite conclui e o evento nasce', async ({ authApi, page }) => {
      const token = await openAcceptDialog(page, authApi);
      const cnpj = '11.222.333/0001-81';
      await page.getByTestId('accept-dialog-cpf').fill(cnpj);
      await expect(page.getByTestId('accept-dialog-cpf')).toHaveValue(cnpj);
      await page.getByTestId('accept-dialog-next').click();
      // Orçamento sem endereço estruturado: o local é o da residência.
      await page.getByTestId('accept-dialog-event-address-same-as-residence').click();

      const acceptRequest = page.waitForRequest(
        (r) => r.method() === 'POST' && /\/api\/public\/budgets\/[^/]+\/accept$/.test(r.url()),
      );
      await page.getByTestId('accept-dialog-confirm').click();
      const request = await acceptRequest;
      const sentBody = request.postDataJSON() as { formData?: { clientCpf?: string | null } };
      expect(sentBody.formData?.clientCpf, 'o CNPJ vai como digitado').toBe(cnpj);
      const response = await request.response();
      expect(response?.status(), 'o aceite passa').toBe(200);

      await expect(page.getByTestId('public-budget-accepted-title')).toBeVisible();
      const publicApi = await createPublicApiContext();
      try {
        const budget = await apiGetPublicBudget(publicApi, token);
        expect(budget.status).toBe('Accepted');
        expect(budget.eventId, 'o evento nasceu').toBeTruthy();
      } finally {
        await publicApi.dispose();
      }
    });

    test('E74 @flow documento com letra: erro no campo, e o aceite não chega ao back', async ({ authApi, page }) => {
      await openAcceptDialog(page, authApi);
      const acceptCalls: number[] = [];
      page.on('request', (r) => {
        if (r.method() === 'POST' && /\/api\/public\/budgets\/[^/]+\/accept$/.test(r.url())) acceptCalls.push(1);
      });
      const input = page.getByTestId('accept-dialog-cpf');
      await input.fill('11.222.333/0001-8A');
      await input.blur();

      // O plano: a letra é recusada com a mensagem do campo.
      await expect
        .soft(page.getByTestId('accept-dialog-cpf-error'), 'mensagem do campo para a letra')
        .toBeVisible();

      // O que sair do campo não leva a letra, e o aceite não chega ao back por isso.
      expect(await input.inputValue(), 'valor do campo').not.toMatch(/[A-Za-z]/);
      await page.getByTestId('accept-dialog-next').click();
      expect(acceptCalls, 'nenhum POST de aceite').toEqual([]);
    });
  });

  test('E75 @flow formulário com CPF e restrições pelo link: aba do gestor em claro, banco com v2:; CPF com letra recusado no campo, no público e na aba interna', async ({
    authApi,
    authPage,
    browser,
  }) => {
    test.setTimeout(150_000);
    await apiCompleteOnboarding(authApi);
    const { eventId } = await setupAcceptedEvent(authApi);
    const issued = await authApi.post(`/api/events/${eventId}/form-link`);
    await assertOk(issued, 'POST form-link');
    const url = (await readJson<{ url: string }>(issued)).url;
    const token = url.substring(url.indexOf('/event-form/') + '/event-form/'.length);

    const cpf = fakeCpf();
    const restrictions = `Alergia a amendoim e lactose ${uid()}`;

    // O cliente preenche pelo link público.
    const publicContext = await browser.newContext({ ignoreHTTPSErrors: true, baseURL: FRONT_URL });
    try {
      const page = await publicContext.newPage();
      await page.goto(`/event-form/${token}`);
      await page.getByTestId('public-form-clientCpf').fill(formatCpf(cpf));
      await page.getByTestId('public-form-step1-next').click();
      await page.getByTestId('public-form-restrictions').fill(restrictions);
      await page.getByTestId('public-form-step2-next').click();
      await page.getByTestId('public-form-confirm-btn').click();
      await expect(page.getByTestId('public-form-confirmed')).toBeVisible();

      // No banco, os dois cifrados.
      const row = getFormDataPersonalColumnsDirect(eventId);
      expect(row.clientCpf).toMatch(/^v2:/);
      expect(row.clientCpf).not.toContain(cpf);
      expect(row.restrictions).toMatch(/^v2:/);
      expect(row.restrictions).not.toContain('amendoim');

      // CPF com letra, no campo do formulário público: recusado.
      await page.goto(`/event-form/${token}`);
      const publicField = await letterRefusedInField(
        page,
        'public-form-clientCpf',
        'public-form-clientCpf-error',
        '123.456.789-0A',
      );
      expect(publicField.refused, `campo público com "${publicField.value}"`).toBe(true);
    } finally {
      await publicContext.close();
    }

    // CPF com letra pela rota pública e pela interna: 400, e o gravado não muda.
    const publicApi = await createPublicApiContext();
    try {
      const put = await publicApi.put(`/api/public/events/${token}/form`, {
        data: { clientCpf: '123.456.789-0A', isConfirmed: false },
      });
      expect(put.status(), 'PUT público com letra no CPF').toBe(400);
    } finally {
      await publicApi.dispose();
    }
    const patch = await authApi.patch(`/api/events/${eventId}/form-data`, { data: { clientCpf: '123.456.789-0A' } });
    expect(patch.status(), 'PATCH interno com letra no CPF').toBe(400);
    const internal = await authApi.get(`/api/events/${eventId}/form-data`);
    await assertOk(internal, 'GET form-data');
    const data = await readJson<{ clientCpf: string | null; restrictions: string | null }>(internal);
    expect((data.clientCpf ?? '').replace(/\D/g, '')).toBe(cpf);
    expect(data.restrictions).toBe(restrictions);

    // A aba "Dados do cliente" do gestor mostra os dois em claro.
    await authPage.goto(`/app/events/${eventId}`);
    await authPage.getByRole('tab', { name: 'Dados do cliente', exact: true }).click();
    await expect(authPage.getByTestId('field-clientCpf')).toHaveValue(formatCpf(cpf));
    await expect(authPage.getByTestId('field-restrictions')).toHaveValue(restrictions);

    // E o campo da aba interna recusa a letra.
    const internalField = await letterRefusedInField(
      authPage,
      'field-clientCpf',
      'field-clientCpf-error',
      '123.456.789-0A',
    );
    expect(internalField.refused, `campo interno com "${internalField.value}"`).toBe(true);
  });
});
