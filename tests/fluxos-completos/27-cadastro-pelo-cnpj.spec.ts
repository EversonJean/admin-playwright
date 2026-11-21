import { APIRequestContext, Page, Response } from '@playwright/test';

import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCompleteOnboarding, apiCreateClient } from '../../helpers/api-entities';
import {
  apiAcceptPublicBudget,
  apiGetEvent,
  apiSendBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
  publicAcceptBody,
} from '../../helpers/api-event-flow';
import { apiErrorCodes, assertOk, readJson } from '../../helpers/response';
import { loginAsRole, openSessionPage } from '../../helpers/setup-flows';
import { snack } from '../../helpers/ui';

/**
 * Fluxo completo 27 — Cadastro pelo CNPJ (assistente, Configurações e cadastro
 * rápido do contratante PJ).
 * Plano: docs/implementar/PLANO-PREENCHIMENTO-POR-CNPJ.md, cenários E4 a E7 e
 * E9 do registro e2e (§4 itens 1 a 3; §5 itens 2, 5 e 9, decisão 11; §6 item 1).
 * Diagrama: — (cenários do registro e2e do plano).
 *
 * A consulta passa pelo back com `CompanyRegistry:Provider=Fake` no
 * `appsettings.E2E.json` (decisão 17): os CNPJs abaixo são os fixos do
 * `FakeCnpjLookupProvider`. O "Localizar" do endereço usa o fake do Google Maps
 * (`fake-providers/google-maps`), que devolve sugestões e coordenadas.
 *
 * O spec afirma o plano; divergência é falha de código, não de asserção.
 */

/** Ativa, recreação, sede completa em São Paulo (SP: o fuso não muda). */
const RECREATION_CNPJ = '11222333000181';
/** Baixada na Receita. */
const INACTIVE_CNPJ = '44555666000181';
/** Alfanumérico, parque temático em Cuiabá (MT: fuso America/Cuiaba, segmento PublicEvent). */
const ALPHANUMERIC_CNPJ = '12ABC34501DE35';
/** DV válido, fora da base: "não encontrado". */
const NOT_FOUND_CNPJ = '55666777000181';

const CNPJ_LOOKUP_URL = /\/api\/company-registry\/cnpj\//;

interface CompanyAddress {
  zipCode?: string | null;
  street?: string | null;
  number?: string | null;
  complement?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  state?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

interface Company {
  name: string;
  legalName: string | null;
  document: string | null;
  timezone: string;
  contactEmail: string | null;
  contactPhone: string | null;
  address: CompanyAddress | null;
  businessSegments: string;
  businessSegmentsAnswered: boolean;
}

async function getCompany(api: APIRequestContext): Promise<Company> {
  const res = await api.get('/api/company');
  await assertOk(res, 'GET /api/company');
  return readJson<Company>(res);
}

function alnum(value: string | null | undefined): string {
  return (value ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

function digits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

/** Corpo de uma resposta vista pela página, sem o envelope `{ data }` do back. */
async function responseData<T>(res: Response): Promise<T> {
  const body = (await res.json()) as { data?: T } | T;
  return ((body as { data?: T }).data ?? body) as T;
}

interface SavedClient {
  type: string;
  name: string;
  document: string | null;
  email: string | null;
  phone: string | null;
  address: CompanyAddress | null;
}

async function getClient(api: APIRequestContext, id: string): Promise<SavedClient> {
  const res = await api.get(`/api/clients/${id}`);
  await assertOk(res, 'GET /api/clients/{id}');
  return readJson<SavedClient>(res);
}

/** Os sete campos da residência no corpo do aceite, iguais aos do cadastro. */
function residenceOf(address: CompanyAddress | null): Record<string, string | null> {
  return {
    zipCode: address?.zipCode ?? null,
    street: address?.street ?? null,
    number: address?.number ?? null,
    complement: address?.complement ?? null,
    neighborhood: address?.neighborhood ?? null,
    city: address?.city ?? null,
    state: address?.state ?? null,
  };
}

function isoDaysFromToday(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Abre o assistente e espera a hidratação do cadastro (o nome da empresa do
 * cadastro inicial no campo): a consulta automática só arma depois dela
 * (decisão 16), e digitar antes faria o CNPJ contar como "já visto".
 */
async function openWizard(page: Page): Promise<void> {
  await page.goto('/app/onboarding');
  await expect(page.getByTestId('onboarding-page')).toBeVisible();
  await expect(page.getByTestId('onboarding-tradename')).not.toHaveValue('', { timeout: 15_000 });
  await expect(page.getByTestId('onboarding-save-company')).toBeEnabled({ timeout: 15_000 });
}

/** Digita o CNPJ no passo Empresa e espera a consulta automática voltar. */
async function typeCnpjAndWaitLookup(page: Page, cnpj: string): Promise<number> {
  const lookup = page.waitForResponse((r) => CNPJ_LOOKUP_URL.test(r.url()) && r.request().method() === 'GET');
  await page.getByTestId('onboarding-document').fill(cnpj);
  return (await lookup).status();
}

/** "Continuar" do passo Empresa e espera o passo Plano. */
async function saveCompanyStep(page: Page): Promise<void> {
  const save = page.waitForResponse((r) => /\/api\/company$/.test(r.url()) && r.request().method() === 'PUT');
  await page.getByTestId('onboarding-save-company').click();
  const res = await save;
  expect(res.ok(), `PUT /api/company respondeu ${res.status()}`).toBe(true);
  await expect(page.getByTestId('onboarding-plan-step')).toBeVisible();
}

test.describe('Fluxo completo 27 — Cadastro pelo CNPJ', () => {
  test('E4 @flow headquarters located with "Localizar" in the wizard is saved with coordinates and the displacement is calculated', async ({
    authPage,
    authApi,
  }) => {
    test.setTimeout(180_000);
    await openWizard(authPage);

    // A Receita traz a sede sem coordenadas: o aviso da CN-B pede o "Localizar".
    expect(await typeCnpjAndWaitLookup(authPage, RECREATION_CNPJ)).toBe(200);
    await expect(authPage.getByTestId('address-form-summary')).toHaveValue(/paulista/i);
    await expect(authPage.getByTestId('onboarding-address-coordinates-warning-locate')).toContainText(
      'Clique em Localizar para confirmar a sede no mapa',
    );
    // Aviso, não bloqueio (§4 item 3).
    await expect(authPage.getByTestId('onboarding-save-company')).toBeEnabled();

    // "Localizar": busca no Google (fake), escolhe a sugestão e confirma.
    await authPage.getByTestId('address-form-find-address').click();
    const query = authPage.getByTestId('find-address-query');
    await expect(query).toBeVisible();
    await query.fill('Avenida Paulista 1000 Sao Paulo');
    await authPage.locator('[data-testid^="find-address-option-"]').first().click();
    const confirm = authPage.getByTestId('find-address-confirm');
    await expect(confirm).toBeEnabled({ timeout: 15_000 });
    await confirm.click();
    await expect(authPage.getByTestId('find-address-query')).toHaveCount(0);

    // O fake do Places não devolve bairro; quem confirma completa à mão, como
    // faria com um endereço real sem bairro.
    const neighborhood = authPage.getByTestId('address-form-neighborhood');
    if (!(await neighborhood.isVisible())) await authPage.getByTestId('address-form-toggle-manual').click();
    if ((await neighborhood.inputValue()) === '') await neighborhood.fill('Centro');

    await expect(authPage.getByTestId('onboarding-address-coordinates-warning')).toHaveCount(0);
    await saveCompanyStep(authPage);

    // §4 itens 1 e 2: a sede gravada tem coordenadas.
    const company = await getCompany(authApi);
    expect(company.address, 'sede gravada').not.toBeNull();
    expect(typeof company.address!.latitude, 'latitude da sede').toBe('number');
    expect(typeof company.address!.longitude, 'longitude da sede').toBe('number');

    // O primeiro orçamento calcula o deslocamento a partir da sede: a prévia que
    // o "Calcular deslocamento" do orçamento pede (`POST /api/displacement/preview`,
    // sem origem manual = sede da empresa).
    const rule = await authApi.post('/api/displacement-rules', {
      data: {
        name: `Deslocamento E2E ${Date.now()}`,
        roundTrip: false,
        perCollaborator: false,
        minimumCharge: 0,
        bands: [{ fromKm: 0, toKm: null, mode: 'FixedAmount', amount: 50 }],
      },
    });
    await assertOk(rule, 'POST /api/displacement-rules');
    const ruleId = (await readJson<{ id: string }>(rule)).id;

    const preview = await authApi.post('/api/displacement/preview', {
      data: {
        ruleId,
        collaboratorCount: 1,
        destinationAddress: {
          zipCode: '80010-000',
          street: 'Rua XV de Novembro',
          number: '100',
          complement: null,
          neighborhood: 'Centro',
          city: 'Curitiba',
          state: 'PR',
          latitude: -25.4284,
          longitude: -49.2733,
        },
      },
    });
    const codes = preview.ok() ? [] : await apiErrorCodes(preview);
    expect(codes, 'a prévia não recusa a origem').not.toContain('Displacement.OriginCoordinatesMissing');
    expect(preview.status(), `prévia do deslocamento: ${codes.join(', ')}`).toBe(200);
    const fee = await readJson<{ fee: number; distanceKm: number }>(preview);
    expect(fee.distanceKm).toBeGreaterThan(0);
    expect(fee.fee).toBe(50);
  });

  test('E5 @flow new company types the CNPJ in the wizard, gets the registry data and Settings shows the same', async ({
    authPage,
    authApi,
  }) => {
    test.setTimeout(180_000);
    await openWizard(authPage);

    // Empresa nova, campos ainda por preencher: só o vazio recebe a Receita.
    await authPage.getByTestId('onboarding-tradename').fill('');
    await authPage.getByTestId('onboarding-contact-email').fill('');

    expect(await typeCnpjAndWaitLookup(authPage, ALPHANUMERIC_CNPJ)).toBe(200);
    await expect(authPage.getByTestId('onboarding-document')).toHaveValue('12.ABC.345/01DE-35');

    await expect(authPage.getByTestId('onboarding-tradename')).toHaveValue('PARQUE ENCANTADO');
    await expect(authPage.getByTestId('onboarding-legal-name')).toHaveValue('PARQUE ENCANTADO DIVERSOES S.A.');
    await expect(authPage.getByTestId('onboarding-contact-email')).toHaveValue('contato@parqueencantado.com.br');
    expect(digits(await authPage.getByTestId('onboarding-contact-phone').inputValue())).toBe('6533334444');
    await expect(authPage.getByTestId('onboarding-contact-email-registry-hint')).toContainText('Veio da Receita');
    await expect(authPage.getByTestId('onboarding-contact-phone-registry-hint')).toContainText('Veio da Receita');
    await expect(authPage.getByTestId('address-form-summary')).toHaveValue(/getulio vargas/i);
    await expect(authPage.getByTestId('address-form-summary')).toHaveValue(/cuiab/i);
    await expect(authPage.getByTestId('onboarding-timezone')).toContainText('Cuiabá');
    await expect(
      authPage.getByTestId('onboarding-segment-PublicEvent').locator('input[type="checkbox"]'),
    ).toBeChecked();
    await expect(
      authPage.getByTestId('onboarding-segment-Recreation').locator('input[type="checkbox"]'),
    ).not.toBeChecked();
    await expect(authPage.getByTestId('onboarding-cnpj-inactive-warning')).toHaveCount(0);

    // Conclui o assistente.
    await saveCompanyStep(authPage);
    await authPage.getByTestId('onboarding-plan-next').click();
    await authPage.getByTestId('onboarding-catalog-next').click();
    await authPage.getByTestId('onboarding-invite-next').click();
    await authPage.getByTestId('onboarding-finish').click();
    await authPage.waitForURL((url) => /\/app(\/|$)/.test(url.pathname) && !url.pathname.includes('onboarding'), {
      timeout: 15_000,
    });

    const company = await getCompany(authApi);
    expect(company.name).toBe('PARQUE ENCANTADO');
    expect(company.legalName).toBe('PARQUE ENCANTADO DIVERSOES S.A.');
    expect(alnum(company.document)).toBe(ALPHANUMERIC_CNPJ);
    expect(company.timezone).toBe('America/Cuiaba');
    expect(company.contactEmail).toBe('contato@parqueencantado.com.br');
    expect(digits(company.contactPhone)).toBe('6533334444');
    expect(company.address?.city ?? '').toMatch(/cuiab/i);
    expect(company.businessSegmentsAnswered).toBe(true);
    expect(company.businessSegments).toContain('PublicEvent');

    // Configurações → Empresa mostra os mesmos dados.
    await authPage.goto('/app/settings/company');
    await expect(authPage.getByTestId('company-form')).toBeVisible();
    await expect(authPage.getByTestId('company-name')).toHaveValue('PARQUE ENCANTADO');
    await expect(authPage.getByTestId('company-legal-name')).toHaveValue('PARQUE ENCANTADO DIVERSOES S.A.');
    expect(alnum(await authPage.getByTestId('company-document').inputValue())).toBe(ALPHANUMERIC_CNPJ);
    await expect(authPage.getByTestId('company-contact-email')).toHaveValue('contato@parqueencantado.com.br');
    expect(digits(await authPage.getByTestId('company-contact-phone').inputValue())).toBe('6533334444');
    await expect(authPage.getByTestId('company-timezone')).toContainText('Cuiabá');
    await expect(
      authPage.getByTestId('company-segment-PublicEvent').locator('input[type="checkbox"]'),
    ).toBeChecked();
    const summary = authPage.getByTestId('company-form').getByTestId('address-form-summary');
    await expect(summary).toHaveValue(/getulio vargas/i);
    await expect(summary).toHaveValue(/cuiab/i);
  });

  test('E6 @flow what the person typed is kept, with the option to use the registry values', async ({
    authPage,
    authApi,
  }) => {
    test.setTimeout(180_000);
    await openWizard(authPage);

    const typedLegalName = 'Minha Razao Digitada Ltda';
    await authPage.getByTestId('onboarding-legal-name').fill(typedLegalName);
    await authPage.getByTestId('onboarding-contact-phone').fill('(41) 98888-7777');

    expect(await typeCnpjAndWaitLookup(authPage, RECREATION_CNPJ)).toBe(200);

    // O vazio recebe a Receita (a sede); o digitado fica.
    await expect(authPage.getByTestId('address-form-summary')).toHaveValue(/paulista/i);
    await expect(authPage.getByTestId('onboarding-legal-name')).toHaveValue(typedLegalName);
    expect(digits(await authPage.getByTestId('onboarding-contact-phone').inputValue())).toBe('41988887777');

    // Snackbar de divergência com a ação "Usar os da Receita" (§5 item 9).
    const divergence = snack(authPage, /Mantivemos o que você digitou em \d+ campos?/);
    await expect(divergence).toBeVisible();
    await divergence.getByRole('button', { name: 'Usar os da Receita' }).click();
    await expect(authPage.getByTestId('onboarding-legal-name')).toHaveValue('ALEGRIA RECREACAO INFANTIL LTDA');
    expect(digits(await authPage.getByTestId('onboarding-contact-phone').inputValue())).toBe('1133334444');

    // Trocado pela ação da pessoa, é o da Receita que vai para o cadastro.
    await saveCompanyStep(authPage);
    const company = await getCompany(authApi);
    expect(company.legalName).toBe('ALEGRIA RECREACAO INFANTIL LTDA');
  });

  test('E6 @flow inactive CNPJ warns without blocking the wizard', async ({ authPage, authApi }) => {
    test.setTimeout(180_000);
    await openWizard(authPage);

    expect(await typeCnpjAndWaitLookup(authPage, INACTIVE_CNPJ)).toBe(200);
    await expect(authPage.getByTestId('onboarding-cnpj-inactive-warning')).toContainText(
      'Este CNPJ está BAIXADA na Receita',
    );
    await expect(authPage.getByTestId('onboarding-legal-name')).toHaveValue('FESTA ANTIGA EVENTOS LTDA');

    // Aviso, não bloqueio (decisão 9).
    await expect(authPage.getByTestId('onboarding-save-company')).toBeEnabled();
    await saveCompanyStep(authPage);

    const company = await getCompany(authApi);
    expect(alnum(company.document)).toBe(INACTIVE_CNPJ);
    expect(company.legalName).toBe('FESTA ANTIGA EVENTOS LTDA');
  });

  test('E6 @flow CNPJ not found shows the message and manual filling goes on', async ({ authPage, authApi }) => {
    test.setTimeout(180_000);
    await openWizard(authPage);

    expect(await typeCnpjAndWaitLookup(authPage, NOT_FOUND_CNPJ)).toBe(404);
    await expect(authPage.getByTestId('cnpj-lookup-error')).toContainText('CNPJ não encontrado na base pública');
    await expect(authPage.getByTestId('onboarding-legal-name')).toHaveValue('');

    const manualLegalName = 'Empresa Preenchida a Mao Ltda';
    await authPage.getByTestId('onboarding-legal-name').fill(manualLegalName);
    await saveCompanyStep(authPage);

    const company = await getCompany(authApi);
    expect(company.legalName).toBe(manualLegalName);
    expect(alnum(company.document)).toBe(NOT_FOUND_CNPJ);
  });

  test('E7 @flow Financial user does not see the lookup button and the direct GET is 403', async ({
    browser,
    authPage,
    authApi,
    tenant,
  }) => {
    test.setTimeout(120_000);
    await apiCompleteOnboarding(authApi);
    const client = await apiCreateClient(authApi, {
      type: 'PJ',
      name: `Escola Cnpj ${Date.now()}`,
      document: RECREATION_CNPJ,
    });

    // Controle: o Owner vê o botão no mesmo cadastro PJ.
    await authPage.goto(`/app/clients/${client.id}`);
    await expect(authPage.getByTestId('client-form-document')).not.toHaveValue('');
    await expect(authPage.getByTestId('cnpj-lookup-button')).toBeVisible();

    const financial = await loginAsRole(tenant.tenantId, 'Financial');
    const session = await openSessionPage(browser, financial.tokens);
    try {
      // Decisão 11: a consulta é do Owner, Admin e Manager; o Financial não a tem.
      const res = await financial.api.get(`/api/company-registry/cnpj/${RECREATION_CNPJ}`);
      expect(res.status(), 'GET direto do Financial').toBe(403);

      await session.page.goto(`/app/clients/${client.id}`);
      await expect(session.page.getByTestId('client-form-page')).toBeVisible();
      await expect(session.page.getByTestId('client-form-document')).not.toHaveValue('', { timeout: 15_000 });
      await expect(session.page.getByTestId('cnpj-lookup')).toHaveCount(0);
      await expect(session.page.getByTestId('cnpj-lookup-button')).toHaveCount(0);
    } finally {
      await session.context.close();
      await financial.api.dispose();
    }
  });

  test('E9 @flow Manager builds a budget for a new school: the CNPJ fills the quick client, the budget is accepted and the event has this client', async ({
    browser,
    authApi,
    tenant,
  }) => {
    test.setTimeout(240_000);
    await apiCompleteOnboarding(authApi);

    const manager = await loginAsRole(tenant.tenantId, 'Manager');
    const session = await openSessionPage(browser, manager.tokens);
    const page = session.page;
    try {
      await page.goto('/app/budgets/quick');
      await expect(page.getByTestId('budget-form-page')).toBeVisible();
      await expect(page.getByTestId('budget-form-save')).toBeEnabled({ timeout: 15_000 });

      // Cliente novo pelo cadastro rápido do orçamento.
      await page.getByTestId('budget-form-clientId').click();
      await page.getByTestId('budget-form-create-entity-option').click();
      const dialog = page.locator('mat-dialog-container');
      await expect(dialog.getByTestId('client-quick-create-tabs')).toBeVisible();
      await dialog.getByRole('tab', { name: 'Cadastro completo', exact: true }).click();

      await dialog.getByTestId('client-quick-create-document').fill(RECREATION_CNPJ);
      const lookup = page.waitForResponse((r) => CNPJ_LOOKUP_URL.test(r.url()) && r.request().method() === 'GET');
      await dialog.getByTestId('cnpj-lookup-button').click();
      expect((await lookup).status()).toBe(200);

      // Decisão 19: o nome do cliente PJ recebe a razão social.
      const legalName = 'ALEGRIA RECREACAO INFANTIL LTDA';
      await expect(dialog.getByTestId('client-quick-create-name-full')).toHaveValue(legalName);
      await expect(dialog.getByTestId('client-quick-create-email')).toHaveValue('contato@alegriafestas.com.br');
      expect(digits(await dialog.getByTestId('client-quick-create-phone-full').inputValue())).toBe('1133334444');
      await expect(dialog.getByTestId('address-form-summary')).toHaveValue(/paulista/i);

      const createClient = page.waitForResponse(
        (r) => /\/api\/clients$/.test(r.url()) && r.request().method() === 'POST',
      );
      await dialog.getByTestId('client-quick-create-save').click();
      const createdClientRes = await createClient;
      expect(createdClientRes.ok(), `POST /api/clients respondeu ${createdClientRes.status()}`).toBe(true);
      const clientId = (await responseData<{ id: string }>(createdClientRes)).id;

      // O cliente volta ao orçamento já selecionado.
      await expect(snack(page, 'Cliente cadastrado e selecionado')).toBeVisible();
      await expect(page.getByTestId('budget-form-clientId')).toContainText(legalName);

      // Monta e salva o orçamento.
      await page.getByTestId('budget-form-eventDate').fill(isoDaysFromToday(30));
      await page.getByTestId('budget-form-eventDate').blur();
      await page.getByTestId('budget-form-validUntil').fill(isoDaysFromToday(14));
      await page.getByTestId('budget-form-eventStartTime').fill('14:00');
      await page.getByTestId('budget-form-eventEndTime').fill('17:00');
      await page.getByTestId('budget-form-childrenCount').fill('20');
      await page.getByTestId('budget-form-eventLocation').fill('Escola Alegria, São Paulo');

      const createBudget = page.waitForResponse(
        (r) => /\/api\/budgets$/.test(r.url()) && r.request().method() === 'POST',
      );
      await page.getByTestId('budget-form-save').click();
      const createdBudgetRes = await createBudget;
      expect(createdBudgetRes.ok(), `POST /api/budgets respondeu ${createdBudgetRes.status()}`).toBe(true);
      const budget = await responseData<{ id: string; clientId: string }>(createdBudgetRes);
      expect(budget.clientId).toBe(clientId);

      // O cadastro gravado é o PJ preenchido pela Receita (§6 item 1).
      const client = await getClient(manager.api, clientId);
      expect(client.type).toBe('PJ');
      expect(client.name).toBe(legalName);
      expect(alnum(client.document)).toBe(RECREATION_CNPJ);
      expect(client.email).toBe('contato@alegriafestas.com.br');
      expect(digits(client.phone)).toBe('1133334444');
      expect(client.address?.street ?? '').toMatch(/paulista/i);
      expect(digits(client.address?.zipCode)).toBe('01310100');

      // O cliente aceita o orçamento pelo link público, confirmando como residência
      // o endereço do cadastro: o aceite troca a residência quando a digitada
      // difere (Etapa 209, `IClientAddressAppService`), e o corpo padrão do helper
      // (Curitiba) sobrescreveria o endereço da Receita.
      const sent = await apiSendBudget(manager.api, budget.id);
      const publicApi = await createPublicApiContext();
      let eventId: string;
      try {
        const acceptBody = { ...publicAcceptBody(), clientAddress: residenceOf(client.address) };
        eventId = (await apiAcceptPublicBudget(publicApi, extractTokenFromPublicUrl(sent.publicUrl), acceptBody))
          .eventId;
      } finally {
        await publicApi.dispose();
      }

      // O evento nasce com esse contratante.
      const event = (await apiGetEvent(manager.api, eventId)) as { clientId?: string; clientName?: string };
      expect(event.clientId).toBe(clientId);
      expect(event.clientName).toBe(legalName);

      // E o cadastro segue o preenchido pela Receita depois do aceite.
      const afterAccept = await getClient(manager.api, clientId);
      expect(afterAccept.name).toBe(legalName);
      expect(alnum(afterAccept.document)).toBe(RECREATION_CNPJ);
      expect(afterAccept.address?.street ?? '').toMatch(/paulista/i);
      expect(digits(afterAccept.address?.zipCode)).toBe('01310100');
    } finally {
      await session.context.close();
      await manager.api.dispose();
    }
  });
});
