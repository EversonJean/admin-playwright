import { APIRequestContext, Page, Response } from '@playwright/test';

import { authTest as test, expect } from '../../fixtures/auth.fixture';
import {
  apiStepUp,
  createApiContext,
  createBearerApiContext,
  loginViaApi,
  openPageWithTokens,
} from '../../helpers/api-client';
import { apiCompleteOnboarding } from '../../helpers/api-entities';
import {
  apiAssignCollaborator,
  apiConfirmCollaborator,
  apiStartEvent,
} from '../../helpers/api-event-flow';
import {
  enableFeatureFlagDirect,
  seedUserWithRoleDirect,
  seedWhatsappChannelDirect,
  setSubscriptionPlanDirect,
  setUserRoleDirect,
  userIdByEmailDirect,
} from '../../helpers/db-helper';
import { fakeOpenAi } from '../../helpers/fake-providers';
import { apiErrorCodes, assertOk, readJson } from '../../helpers/response';
import { setupAcceptedEvent, setupPortalUser } from '../../helpers/setup-flows';
import { EventDTO } from '../../helpers/types';
import { snack } from '../../helpers/ui';
import { isoDate, nextSaturday, tenantToday } from '../../helpers/week-staffing';
import {
  enableWhatsAppFeaturesDirect,
  fakeTextsTo,
  receiveInbound,
  toE164Br,
  uid,
} from '../../helpers/whatsapp-flow';

/**
 * Fluxo: 17.12 — IA: SSRF do provedor BYOK, chave na troca de endereço, step-up e
 * confirmação das escritas do assistente
 * Diagrama: — (cenários E152-E155, E157 e E158 do registro e2e de
 * `docs/implementar/PLANO-SEGURANCA.md`, §7 SEG-E, Etapa 240; o E156 é manual)
 *
 * [NOTA] O provedor BYOK com endereço interno é recusado em TODO ambiente,
 * inclusive no E2E: nenhum provedor do tenant aponta para o fake em `localhost`.
 * Os endereços públicos daqui não precisam responder (o cadastro aceita nome
 * que não resolve; o "Testar conexão" é o único que tenta conectar). O E158 usa
 * o provedor GLOBAL do `appsettings.E2E.json`, que aponta para o fake da OpenAI.
 */

const PROVIDERS_ROUTE = '/app/settings/ai-providers';
const STEP_UP_ACTION = 'ai_provider.update';
const STEP_UP_HEADER = 'X-Step-Up-Token';

/** Endereço público de verdade: o guard resolve o DNS e o aceita (ou aceita o nome que não resolve). */
const PUBLIC_URL = 'https://api.openai.com/v1';
const OTHER_PUBLIC_URL = 'https://api.anthropic.com/v1';

interface ProviderDto {
  id: string;
  kind: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  priority: number;
  hasApiKey: boolean;
}

/**
 * Horário de hoje que contém o "agora" no fuso do tenant novo
 * (`America/Sao_Paulo`): uma hora antes e uma depois, presas ao dia. Iniciar e
 * finalizar pelo assistente só valem numa janela em torno do horário previsto
 * (`CollaboratorAssistant.OutsideEventWindow`); com o horário fixo das 14:00, o
 * "sim" do encerramento era recusado de madrugada.
 */
function timesAroundNow(): { startTime: string; endTime: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const minutes = Number(parts.find((p) => p.type === 'hour')!.value) * 60 + Number(parts.find((p) => p.type === 'minute')!.value);
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return { startTime: hhmm(Math.max(0, minutes - 60)), endTime: hhmm(Math.min(23 * 60 + 59, minutes + 60)) };
}

async function apiListProviders(api: APIRequestContext): Promise<ProviderDto[]> {
  const res = await api.get('/api/ai-provider-config');
  await assertOk(res, 'GET /api/ai-provider-config');
  return readJson<ProviderDto[]>(res);
}

async function apiCreateProvider(
  api: APIRequestContext,
  input: Partial<Pick<ProviderDto, 'kind' | 'baseUrl' | 'model' | 'priority' | 'enabled'>> & { apiKey?: string } = {},
): Promise<ProviderDto> {
  const res = await api.post('/api/ai-provider-config', {
    data: {
      kind: input.kind ?? 'OpenAiCompatible',
      baseUrl: input.baseUrl ?? PUBLIC_URL,
      model: input.model ?? 'gpt-4o-mini',
      apiKey: input.apiKey ?? 'sk-e2e-original',
      priority: input.priority ?? 0,
      enabled: input.enabled ?? true,
    },
  });
  await assertOk(res, 'POST /api/ai-provider-config');
  return readJson<ProviderDto>(res);
}

async function apiGetProvider(api: APIRequestContext, id: string): Promise<ProviderDto> {
  const found = (await apiListProviders(api)).find((p) => p.id === id);
  expect(found, `provedor ${id} na lista`).toBeTruthy();
  return found!;
}

/** Tenant com a IA ligada e o assistente de configuração concluído (spec de UI). */
async function prepareAiTenant(api: APIRequestContext, tenantId: string): Promise<void> {
  enableFeatureFlagDirect(tenantId, 'feature_ai');
  await apiCompleteOnboarding(api);
}

function isProviderPut(r: Response, id: string): boolean {
  return r.request().method() === 'PUT' && new URL(r.url()).pathname === `/api/ai-provider-config/${id}`;
}

/** Abre o formulário de edição e espera o provedor carregar. */
async function openEditForm(page: Page, id: string, model: string): Promise<void> {
  await page.goto(`${PROVIDERS_ROUTE}/${id}`);
  // Primeira carga do app no worker: o formulário só aparece depois da lista.
  await expect(page.getByTestId('ai-provider-form-model')).toHaveValue(model, { timeout: 30_000 });
}

/** Confirma a identidade no diálogo de step-up com a senha. */
async function confirmPassword(page: Page, password: string): Promise<void> {
  await expect(page.getByTestId('step-up-password')).toBeVisible();
  await page.getByTestId('step-up-password').fill(password);
  await page.getByTestId('step-up-submit').click();
}

test.describe('Fluxo 17.12 — IA: provedor BYOK e custo (SEG-E)', () => {
  // ─── E152 — URL interna recusada pela tela ──────────────────────────────
  test('E152 @crud provedor com endereço interno: a tela mostra "URL não permitida" no campo e no aviso, nada é gravado; o público é aceito', async ({
    authPage,
    authApi,
    tenant,
  }) => {
    await prepareAiTenant(authApi, tenant.tenantId);
    await authPage.goto(`${PROVIDERS_ROUTE}/new`);
    await authPage.getByTestId('ai-provider-form-model').fill('gpt-4o-mini');
    await authPage.getByTestId('ai-provider-form-api-key').fill('sk-e2e-ssrf');

    for (const url of ['http://169.254.169.254/', 'http://localhost:11434/v1', 'https://10.0.0.5/v1']) {
      await authPage.getByTestId('ai-provider-form-base-url').fill(url);
      const created = authPage.waitForResponse(
        (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/ai-provider-config',
      );
      await authPage.getByTestId('ai-provider-form-save').click();
      const res = await created;
      expect(res.status(), `cadastro com ${url}`).toBe(400);
      expect(await apiErrorCodes(res)).toContain('Ai.ProviderUrlNotAllowed');

      const fieldError = authPage.getByTestId('ai-provider-form-base-url-not-allowed');
      await expect(fieldError, `erro no campo para ${url}`).toContainText('URL não permitida');
      await expect(fieldError, 'o campo diz o motivo').toContainText(/endereços internos|rede privada/);
      await expect(snack(authPage, 'URL não permitida'), `aviso para ${url}`).toBeVisible();
      await expect(authPage).toHaveURL(/\/ai-providers\/new$/);
    }

    expect(await apiListProviders(authApi), 'nada gravado com URL interna').toHaveLength(0);

    // Endereço público: aceito.
    await authPage.getByTestId('ai-provider-form-base-url').fill(PUBLIC_URL);
    const created = authPage.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/ai-provider-config',
    );
    await authPage.getByTestId('ai-provider-form-save').click();
    expect((await created).status(), 'cadastro com endereço público').toBe(200);
    await authPage.waitForURL(new RegExp(`${PROVIDERS_ROUTE}$`));
    const providers = await apiListProviders(authApi);
    expect(providers).toHaveLength(1);
    expect(providers[0]!.baseUrl).toBe(PUBLIC_URL);
    expect(providers[0]!.hasApiKey).toBe(true);
  });

  // ─── E153 — Editar pede a senha ─────────────────────────────────────────
  test('E153 @crud editar e ligar/desligar o provedor pedem a senha; cancelar não salva; erro corrigido não pede a senha de novo', async ({
    authPage,
    authApi,
    tenant,
  }) => {
    test.setTimeout(120_000);
    await prepareAiTenant(authApi, tenant.tenantId);
    const provider = await apiCreateProvider(authApi, { model: 'gpt-4o-mini' });

    // Salvar abre o diálogo; cancelar não salva nada.
    await openEditForm(authPage, provider.id, 'gpt-4o-mini');
    await authPage.getByTestId('ai-provider-form-model').fill('gpt-4.1-mini');
    const firstPut = authPage.waitForResponse((r) => isProviderPut(r, provider.id));
    await authPage.getByTestId('ai-provider-form-save').click();
    const firstRes = await firstPut;
    expect(firstRes.status(), 'PUT sem a senha confirmada').toBe(403);
    expect(await apiErrorCodes(firstRes)).toContain('Auth.StepUpRequired');
    await expect(authPage.getByTestId('step-up-password'), 'o diálogo de confirmação de identidade abre').toBeVisible();
    await authPage.getByTestId('step-up-cancel').click();
    await expect(authPage.getByTestId('step-up-password')).toHaveCount(0);
    await expect(authPage).toHaveURL(new RegExp(`${PROVIDERS_ROUTE}/${provider.id}$`));
    expect((await apiGetProvider(authApi, provider.id)).model, 'cancelar não salvou').toBe('gpt-4o-mini');

    // Com a senha, salva.
    await authPage.getByTestId('ai-provider-form-save').click();
    await confirmPassword(authPage, tenant.password);
    await authPage.waitForURL(new RegExp(`${PROVIDERS_ROUTE}$`));
    expect((await apiGetProvider(authApi, provider.id)).model, 'com a senha, salvou').toBe('gpt-4.1-mini');

    // Ligar/desligar pela lista também pede; cancelar devolve o botão à posição salva.
    const toggle = authPage.getByTestId('ai-provider-toggle').getByRole('switch');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(authPage.getByTestId('step-up-password'), 'desligar também pede a senha').toBeVisible();
    await authPage.getByTestId('step-up-cancel').click();
    await expect(toggle, 'cancelar volta o botão à posição salva').toHaveAttribute('aria-checked', 'true');
    expect((await apiGetProvider(authApi, provider.id)).enabled, 'cancelar não desligou').toBe(true);

    await toggle.click();
    await confirmPassword(authPage, tenant.password);
    await expect(authPage.getByTestId('ai-provider-disabled-chip')).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect((await apiGetProvider(authApi, provider.id)).enabled, 'com a senha, desligou').toBe(false);

    // Erro de validação depois da senha; corrigido, salvar de novo não pede a senha.
    await openEditForm(authPage, provider.id, 'gpt-4.1-mini');
    let stepUps = 0;
    authPage.on('request', (req) => {
      if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/auth/step-up') stepUps++;
    });
    await authPage.getByTestId('ai-provider-form-base-url').fill('http://169.254.169.254/');
    await authPage.getByTestId('ai-provider-form-api-key').fill('sk-e2e-rotated');
    await authPage.getByTestId('ai-provider-form-save').click();
    await confirmPassword(authPage, tenant.password);
    await expect(authPage.getByTestId('ai-provider-form-base-url-not-allowed')).toContainText('URL não permitida');
    expect(stepUps, 'uma confirmação de identidade').toBe(1);

    await authPage.getByTestId('ai-provider-form-base-url').fill(OTHER_PUBLIC_URL);
    const fixedPut = authPage.waitForResponse((r) => isProviderPut(r, provider.id));
    await authPage.getByTestId('ai-provider-form-save').click();
    const fixedRes = await fixedPut;
    expect(fixedRes.status(), 'o salvar corrigido passa direto').toBe(200);
    expect(fixedRes.request().headers()[STEP_UP_HEADER.toLowerCase()], 'reusa o token da confirmação anterior').toBeTruthy();
    await authPage.waitForURL(new RegExp(`${PROVIDERS_ROUTE}$`));
    expect(stepUps, 'o salvar corrigido não pediu a senha outra vez').toBe(1);
    await expect(authPage.getByTestId('step-up-password')).toHaveCount(0);
    expect((await apiGetProvider(authApi, provider.id)).baseUrl).toBe(OTHER_PUBLIC_URL);
  });

  // ─── E154 — Trocar a URL exige a chave de novo ──────────────────────────
  test('E154 @crud trocar a base URL sem a chave: a tela exige a chave antes de enviar; o PUT direto dá 400 e nada muda; com a chave nova salva', async ({
    authPage,
    authApi,
    tenant,
  }) => {
    test.setTimeout(90_000);
    await prepareAiTenant(authApi, tenant.tenantId);
    const provider = await apiCreateProvider(authApi, { model: 'gpt-4o-mini', apiKey: 'sk-e2e-old' });

    // Tela: avisa e exige a chave, sem enviar o PUT.
    await openEditForm(authPage, provider.id, 'gpt-4o-mini');
    let puts = 0;
    authPage.on('request', (req) => {
      if (req.method() === 'PUT' && new URL(req.url()).pathname === `/api/ai-provider-config/${provider.id}`) puts++;
    });
    await expect(authPage.getByTestId('ai-provider-form-api-key-keep-hint')).toBeVisible();
    await authPage.getByTestId('ai-provider-form-base-url').fill(OTHER_PUBLIC_URL);
    await expect(authPage.getByTestId('ai-provider-form-api-key-endpoint-hint'), 'a tela avisa').toContainText(
      'informe a chave de API de novo',
    );
    await authPage.getByTestId('ai-provider-form-save').click();
    await expect(authPage.getByTestId('ai-provider-form-api-key-required'), 'a tela exige a chave').toBeVisible();
    await expect(authPage.getByTestId('step-up-password')).toHaveCount(0);
    expect(puts, 'nada foi enviado sem a chave').toBe(0);

    // O mesmo PUT direto na API (com a identidade confirmada): 400, e nada muda.
    const token = await apiStepUp(authApi, tenant.password, STEP_UP_ACTION);
    const direct = await authApi.put(`/api/ai-provider-config/${provider.id}`, {
      headers: { [STEP_UP_HEADER]: token },
      data: { kind: provider.kind, baseUrl: OTHER_PUBLIC_URL, model: provider.model, priority: 0, enabled: true },
    });
    expect(direct.status(), 'PUT trocando a URL sem a chave').toBe(400);
    expect(await apiErrorCodes(direct)).toContain('TenantAiProviderConfig.ApiKeyRequiredOnEndpointChange');
    expect(await direct.text(), 'a mensagem pede a chave de novo').toMatch(/informa\w* a chave de API de novo/);
    const unchanged = await apiGetProvider(authApi, provider.id);
    expect(unchanged.baseUrl, 'a URL antiga continua').toBe(PUBLIC_URL);
    expect(unchanged.hasApiKey, 'a chave antiga continua').toBe(true);

    // Com a chave nova: salva e mostra "chave configurada".
    await authPage.getByTestId('ai-provider-form-api-key').fill('sk-e2e-new');
    await authPage.getByTestId('ai-provider-form-save').click();
    await confirmPassword(authPage, tenant.password);
    await authPage.waitForURL(new RegExp(`${PROVIDERS_ROUTE}$`));
    await expect(authPage.getByTestId('ai-provider-haskey-chip')).toContainText('Chave configurada');
    await expect(authPage.getByTestId('ai-provider-list')).toContainText(OTHER_PUBLIC_URL);
    const saved = await apiGetProvider(authApi, provider.id);
    expect(saved.baseUrl).toBe(OTHER_PUBLIC_URL);
    expect(saved.hasApiKey).toBe(true);
  });

  // ─── E155 — "Testar conexão" com mensagem genérica ──────────────────────
  test('E155 @crud "Testar conexão" de endereço que não responde: mensagem genérica, sem host, porta nem exceção, na tela e na API', async ({
    authPage,
    authApi,
    tenant,
  }) => {
    test.setTimeout(90_000);
    await prepareAiTenant(authApi, tenant.tenantId);
    const host = `ia-e2e-${uid()}.invalid`;
    const provider = await apiCreateProvider(authApi, { baseUrl: `https://${host}:8443/v1` });

    const leaks = [host, '8443', 'Exception', 'No such host', 'nodename', 'HttpRequest', 'SocketException'];

    await authPage.goto(PROVIDERS_ROUTE);
    await authPage.getByTestId('ai-provider-test').click();
    const result = authPage.getByTestId('ai-provider-test-result');
    await expect(result).toContainText('Não foi possível conectar ao provedor', { timeout: 30_000 });
    const shown = await result.innerText();
    for (const leak of leaks) expect(shown, `a tela não mostra "${leak}"`).not.toContain(leak);

    const res = await authApi.post(`/api/ai-provider-config/${provider.id}/test`);
    await assertOk(res, 'POST /api/ai-provider-config/{id}/test');
    const raw = await res.text();
    const body = JSON.parse(raw) as { data: { success: boolean; message: string } };
    expect(body.data.success).toBe(false);
    expect(body.data.message).toMatch(/^Não foi possível conectar ao provedor/);
    for (const leak of leaks) expect(raw, `a API não devolve "${leak}"`).not.toContain(leak);
  });

  // ─── E157 — Permissão x plano ───────────────────────────────────────────
  test('E157 @flow Manager no PUT direto: 403 com a mensagem de permissão', async ({ authApi, tenant }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_ai');
    const provider = await apiCreateProvider(authApi);
    const manager = seedUserWithRoleDirect({ tenantId: tenant.tenantId, role: 'Manager', emailPrefix: 'mgr-ai' });
    const anon = await createApiContext();
    const { accessToken } = await loginViaApi(anon, manager.email, manager.password);
    await anon.dispose();
    const managerApi = await createBearerApiContext(accessToken);
    try {
      const res = await managerApi.put(`/api/ai-provider-config/${provider.id}`, {
        data: { kind: provider.kind, baseUrl: provider.baseUrl, model: 'gpt-4.1', priority: 0, enabled: true },
      });
      expect(res.status(), 'Manager sem ai.manageproviders').toBe(403);
      expect(await apiErrorCodes(res)).toContain('Auth.PermissionDenied');
      expect(await res.text()).toContain('Permissão necessária: ai.manageproviders');
    } finally {
      await managerApi.dispose();
    }
    expect((await apiGetProvider(authApi, provider.id)).model).toBe('gpt-4o-mini');
  });

  test('E157 @crud Admin rebaixado a Manager com a tela aberta: salvar mostra a mensagem de permissão do back, não a de plano', async ({
    authApi,
    browser,
    tenant,
  }) => {
    test.setTimeout(90_000);
    await prepareAiTenant(authApi, tenant.tenantId);
    const provider = await apiCreateProvider(authApi, { model: 'gpt-4o-mini' });
    const admin = seedUserWithRoleDirect({ tenantId: tenant.tenantId, role: 'Admin', emailPrefix: 'adm-ai' });
    const adminId = userIdByEmailDirect(admin.email);
    const anon = await createApiContext();
    const tokens = await loginViaApi(anon, admin.email, admin.password);
    await anon.dispose();

    const page = await openPageWithTokens(browser, tokens);
    try {
      await openEditForm(page, provider.id, 'gpt-4o-mini');

      // Rebaixado com a tela aberta: papel novo e carimbo novo; o Owner faz o
      // back esquecer o estado em cache do token (o "desbloquear" de um ativo).
      setUserRoleDirect(adminId, 'Manager');
      const forget = await authApi.put(`/api/users/${adminId}/status`, { data: { status: 'Active' } });
      await assertOk(forget, 'PUT /api/users/{id}/status');

      await page.getByTestId('ai-provider-form-model').fill('gpt-4.1');
      await page.getByTestId('ai-provider-form-save').click();
      await expect(snack(page, 'Permissão necessária: ai.manageproviders'), 'a mensagem de permissão do back').toBeVisible();
      await expect(snack(page, 'Seu plano não inclui o recurso de IA')).toHaveCount(0);
      expect((await apiGetProvider(authApi, provider.id)).model).toBe('gpt-4o-mini');
    } finally {
      await page.context().close();
    }
  });

  test('E157 @crud empresa sem feature_ai continua vendo o bloqueio de plano', async ({ authPage, authApi, tenant }) => {
    // `feature_ai` só pelo plano do signup (`plan_professional`): um add-on
    // semeado seguiria liberando a IA depois da troca de plano.
    await apiCompleteOnboarding(authApi);
    const provider = await apiCreateProvider(authApi, { model: 'gpt-4o-mini' });
    await openEditForm(authPage, provider.id, 'gpt-4o-mini');

    // O plano perde a IA com a tela aberta.
    setSubscriptionPlanDirect(tenant.tenantId, 'plan_free');
    await authPage.getByTestId('ai-provider-form-model').fill('gpt-4.1');
    const blocked = authPage.waitForResponse(
      async (r) => isProviderPut(r, provider.id) && (await apiErrorCodes(r)).includes('Entitlement.NotIncludedInPlan'),
    );
    await authPage.getByTestId('ai-provider-form-save').click();
    // Se a confirmação de identidade vier antes do bloqueio de plano, confirma.
    const first = await Promise.race([
      blocked.then(() => 'blocked' as const),
      authPage
        .getByTestId('step-up-password')
        .waitFor()
        .then(() => 'step-up' as const)
        .catch(() => 'none' as const),
    ]);
    if (first === 'step-up') await confirmPassword(authPage, tenant.password);
    const res = await blocked;
    expect(res.status()).toBe(403);
    await expect(snack(authPage, 'Seu plano não inclui o recurso de IA')).toBeVisible();
    await expect(snack(authPage, 'Permissão necessária')).toHaveCount(0);

    // Navegando de novo, a rota cai no bloqueio de plano.
    await authPage.goto(PROVIDERS_ROUTE);
    await authPage.waitForURL(/\/app\/billing\/blocked/);
    expect(new URL(authPage.url()).searchParams.get('feature')).toBe('feature_ai');
  });

  // ─── E158 — Assistente do colaborador confirma Decline e Finish ─────────
  test.describe('E158 assistente do colaborador no modo IA', () => {
    /**
     * Tenant com o modo IA do assistente ligado (add-on, card da Central de IA e
     * o canal do WhatsApp), o colaborador com o número vinculado e escalado e
     * confirmado numa festa de `eventDate` cujo local é único (o `match` do fake
     * da OpenAI: o rótulo do evento candidato vai no prompt).
     */
    async function setupAssistant(
      api: APIRequestContext,
      tenantId: string,
      opts: { eventDate: string; leader: boolean; startTime?: string; endTime?: string },
    ): Promise<{ eventId: string; location: string; say: (text: string, expected: RegExp) => Promise<string> }> {
      enableWhatsAppFeaturesDirect(tenantId);
      enableFeatureFlagDirect(tenantId, 'feature_ai');
      enableFeatureFlagDirect(tenantId, 'feature_ai_collaborator_assistant');
      // O modo IA do assistente tem opt-in próprio (fora da Central de IA).
      const aiConfig = await api.put('/api/collaborator-assistant/ai-config', { data: { aiEnabled: true } });
      await assertOk(aiConfig, 'PUT /api/collaborator-assistant/ai-config');
      const phoneNumberId = seedWhatsappChannelDirect(tenantId);
      const config = await api.put('/api/collaborator-assistant/whatsapp-config', {
        data: {
          enabled: true,
          requirePhoneVerification: true,
          whatsappCommissionsEnabled: true,
          whatsappLeaderPhoneEnabled: true,
        },
      });
      await assertOk(config, 'PUT /api/collaborator-assistant/whatsapp-config');

      const location = `Salao E158 ${uid()}`;
      const { eventId } = await setupAcceptedEvent(api, {
        budget: { eventDate: opts.eventDate, eventLocation: location, startTime: opts.startTime, endTime: opts.endTime },
      });

      const portal = await setupPortalUser(api, tenantId);
      try {
        await apiAssignCollaborator(api, eventId, portal.collaboratorId, { isLeader: opts.leader });
        // A recusa só vale para escala ainda pendente (`EventCollaborator`):
        // a festa a encerrar tem a escala confirmada; a recusável, não.
        if (opts.leader) await apiConfirmCollaborator(api, eventId, portal.collaboratorId);

        const profileRes = await portal.portalApi.get('/api/portal/profile');
        await assertOk(profileRes, 'GET /api/portal/profile');
        const phone = toE164Br((await readJson<{ phone: string }>(profileRes)).phone);

        const say = async (text: string, expected: RegExp): Promise<string> => {
          const since = new Date().toISOString();
          await receiveInbound(phoneNumberId, phone, text);
          let reply = '';
          await expect
            .poll(
              async () => {
                reply = (await fakeTextsTo(phone, since)).join('\n');
                return reply;
              },
              { message: `resposta do assistente a "${text}"`, timeout: 30_000 },
            )
            .toMatch(expected);
          return reply;
        };

        const code = await portal.portalApi.post('/api/portal/whatsapp-link-code');
        await assertOk(code, 'POST /api/portal/whatsapp-link-code');
        await say(`vincular ${(await readJson<{ code: string }>(code)).code}`, /Seu WhatsApp está vinculado/);

        return { eventId, location, say };
      } finally {
        await portal.portalApi.dispose();
      }
    }

    async function assignmentStatus(api: APIRequestContext, eventId: string): Promise<string | undefined> {
      const res = await api.get(`/api/events/${eventId}`);
      await assertOk(res, 'GET /api/events/{id}');
      const ev = await readJson<EventDTO>(res);
      return ev.collaborators[0]?.confirmationStatus;
    }

    async function eventStatus(api: APIRequestContext, eventId: string): Promise<string> {
      const res = await api.get(`/api/events/${eventId}`);
      await assertOk(res, 'GET /api/events/{id}');
      return (await readJson<EventDTO>(res)).status;
    }

    test('E158 @flow "não vou poder ir sábado, me manda o briefing": recebe o briefing e o pedido do motivo; a escala só cai com o motivo, e "não" a mantém', async ({
      authApi,
      tenant,
    }) => {
      test.setTimeout(180_000);
      const { eventId, location, say } = await setupAssistant(authApi, tenant.tenantId, {
        eventDate: nextSaturday(),
        leader: false,
      });
      const declineAndBriefing = JSON.stringify({
        intents: [
          { commandKey: 'Decline', confidence: 0.95, eventIndex: 1, reason: 'não vou poder ir', rating: null, text: null },
          { commandKey: 'Briefing', confidence: 0.95, eventIndex: 1, reason: null, rating: null, text: null },
        ],
      });
      const phrase = 'não vou poder ir sábado, me manda o briefing';
      const assigned = await assignmentStatus(authApi, eventId);
      expect(assigned, 'escala de pé antes da conversa').toBeTruthy();
      expect(assigned).not.toBe('Declined');

      // Briefing + pedido do motivo; a escala segue de pé.
      await fakeOpenAi.scriptNext(location, declineAndBriefing);
      const first = await say(phrase, /escreva o motivo da recusa/);
      expect(first, 'recebe o briefing').toContain('Briefing da festa');
      expect(await assignmentStatus(authApi, eventId), 'a escala segue como estava').toBe(assigned);

      // "não" mantém a escala.
      const kept = await say('não', /mantive a sua escala/);
      expect(kept).not.toContain('Recusa registrada');
      expect(await assignmentStatus(authApi, eventId), '"não" mantém a escala').toBe(assigned);

      // De novo, agora com o motivo escrito: a recusa vale.
      await fakeOpenAi.scriptNext(location, declineAndBriefing);
      await say(phrase, /escreva o motivo da recusa/);
      expect(await assignmentStatus(authApi, eventId), 'antes do motivo, a escala segue').toBe(assigned);
      await say('Tenho um compromisso de família no sábado', /Recusa registrada/);
      expect(await assignmentStatus(authApi, eventId), 'com o motivo, a escala é recusada').toBe('Declined');
    });

    test('E158 @flow "encerra a festa" pede sim/não antes de encerrar', async ({ authApi, tenant }) => {
      test.setTimeout(180_000);
      const { eventId, location, say } = await setupAssistant(authApi, tenant.tenantId, {
        eventDate: isoDate(tenantToday()),
        leader: true,
        ...timesAroundNow(),
      });
      await apiStartEvent(authApi, eventId);
      expect(await eventStatus(authApi, eventId)).toBe('InProgress');

      await fakeOpenAi.scriptNext(
        location,
        JSON.stringify({
          intents: [{ commandKey: 'Finish', confidence: 0.95, eventIndex: 1, reason: null, rating: null, text: null }],
        }),
      );
      const question = await say('encerra a festa', /Confirma\? \(responda \*sim\* ou \*não\*\)/);
      expect(question).toContain('encerrar a festa');
      expect(await eventStatus(authApi, eventId), 'nada encerrado antes do sim').toBe('InProgress');

      await say('sim', /Festa encerrada/);
      expect(await eventStatus(authApi, eventId), 'com o sim, a festa encerra').toBe('Completed');
    });
  });
});
