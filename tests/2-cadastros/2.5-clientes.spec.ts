import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { apiCompleteOnboarding, apiCreateClient, apiListClients } from '../../helpers/api-entities';
import { getClientDocumentColumnsDirect } from '../../helpers/db-helper';
import { assertOk, readJson } from '../../helpers/response';

/**
 * Fluxo: 2.5 — Clientes
 * Diagrama: docs/fluxos/negocio-2.5-clientes.mmd
 */

test.describe('Fluxo 2.5 — Clientes', () => {
  // Tenant recém-criado cai no assistente de configuração (onboardingGuard).
  test.beforeEach(async ({ authApi }) => {
    await apiCompleteOnboarding(authApi);
  });

  test('@flow tela de listagem carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/clients/list', { ready: 'clients-list-page' });
  });

  test('@flow tela de criação carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/clients/new', { ready: 'client-form-page' });
  });

  test('@flow criar cliente via API + aparece na listagem', async ({ authApi }) => {
    const created = await apiCreateClient(authApi);
    expect(created.id).toBeTruthy();
    const list = await apiListClients(authApi);
    const items = (list as { items?: unknown[] }).items ?? (list as unknown as { data?: { items?: unknown[] } }).data?.items ?? [];
    expect(items.length).toBeGreaterThan(0);
  });

  test('@crud cria cliente via UI e valida no back', async ({ authPage, authApi }) => {
    const nome = `Cliente E2E ${Date.now()}`;
    // CPF válido de teste (algoritmo Mod 11 OK)
    const cpf = '11144477735';

    await authPage.goto('/app/clients/new');
    // type já tem default 'PF', status já tem default 'Active'
    await authPage.getByTestId('client-form-name').fill(nome);
    await authPage.getByTestId('client-form-document').fill(cpf);
    // Telefone é obrigatório no cadastro (CreateClientValidator): o cliente chega pelo WhatsApp.
    await authPage.getByTestId('client-form-phone').fill('41999990000');
    await authPage.getByTestId('client-form-save').click();

    await authPage.waitForURL(/\/app\/clients\/list(\?|$)/, { timeout: 10_000 });

    const res = await authApi.get('/api/clients');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const items = body.data?.items ?? body.items ?? body.data ?? body;
    const list = Array.isArray(items) ? items : items.items ?? [];
    expect(list.some((c: { name?: string }) => c.name === nome)).toBe(true);
  });

  /**
   * E1 do registro e2e de `docs/implementar/PLANO-PREENCHIMENTO-POR-CNPJ.md`
   * (Etapa 277, §3 itens 2 e 10): o CNPJ alfanumérico passa pela máscara (letra
   * em maiúscula), grava normalizado, aparece formatado na lista, é achado pela
   * busca por documento completo (com e sem máscara) e fica cifrado no banco.
   */
  test('@crud E1 PJ client with alphanumeric CNPJ is saved, shown formatted, found by document and encrypted', async ({
    authPage,
    authApi,
  }) => {
    test.setTimeout(120_000);
    const cnpj = '12ABC34501DE35';
    const formatted = '12.ABC.345/01DE-35';
    const name = `Parque Alfa ${letters()}`;

    await authPage.goto('/app/clients/new');
    await expect(authPage.getByTestId('client-form-page')).toBeVisible();
    await authPage.getByTestId('client-form-type').getByText('Pessoa jurídica').click();
    await authPage.getByTestId('client-form-name').fill(name);
    // Minúsculas de propósito: a máscara passa a letra para maiúscula (§3 item 10).
    const documentInput = authPage.getByTestId('client-form-document');
    await documentInput.fill('12abc34501de35');
    await expect(documentInput).toHaveValue(formatted);
    await expect(authPage.getByTestId('client-form-document-characters-error')).toHaveCount(0);
    await authPage.getByTestId('client-form-phone').fill('41999990000');
    await authPage.getByTestId('client-form-save').click();
    await authPage.waitForURL(/\/app\/clients\/list(\?|$)/, { timeout: 15_000 });

    // Busca por documento completo, com e sem máscara (§3 item 2).
    for (const search of [cnpj, formatted]) {
      const res = await authApi.get(`/api/clients?search=${encodeURIComponent(search)}&pageSize=50`);
      await assertOk(res, `GET /api/clients?search=${search}`);
      const data = await readJson<{ items: ClientRow[] } | ClientRow[]>(res);
      const rows = Array.isArray(data) ? data : data.items;
      expect(rows.map((r) => r.name), `busca "${search}" acha o cliente`).toContain(name);
      const row = rows.find((r) => r.name === name)!;
      expect(row.type).toBe('PJ');
      expect(row.document, 'documento gravado normalizado, letras em maiúsculas').toBe(cnpj);
    }

    // Na lista: achado pela busca e exibido formatado.
    const listRes = await authApi.get(`/api/clients?search=${cnpj}&pageSize=50`);
    const listData = await readJson<{ items: ClientRow[] } | ClientRow[]>(listRes);
    const clientId = (Array.isArray(listData) ? listData : listData.items).find((r) => r.name === name)!.id;

    await authPage.goto('/app/clients/list');
    const table = authPage.getByTestId('clients-table');
    await expect(table).toBeVisible();
    const reload = authPage.waitForResponse(
      (r) => r.request().method() === 'GET' && /\/api\/clients(\?|$)/.test(r.url()),
    );
    await authPage.getByTestId('clients-search').fill(formatted);
    await reload;
    await expect(table).toContainText(name);
    await expect(table).toContainText(formatted);

    // No banco: cifrado no formato v2, sem o número em claro, com o hash da busca.
    const columns = getClientDocumentColumnsDirect(clientId);
    expect(columns.document, 'documento cifrado').toMatch(/^v2:/);
    expect(columns.document.toUpperCase(), 'sem o CNPJ em claro').not.toContain(cnpj);
    expect(columns.documentHash, 'com DocumentHash').toMatch(/^[0-9A-Fa-f]{64}$/);
  });
});

interface ClientRow {
  id: string;
  name: string;
  type?: string;
  document?: string | null;
}

/** Sufixo só com letras: o nome não pode casar com a busca por documento. */
function letters(): string {
  return Array.from({ length: 8 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
}
