import { createHmac } from 'node:crypto';
import { APIRequestContext, Browser, BrowserContext, Page, request as playwrightRequest } from '@playwright/test';

import { authTest as test, expect } from '../../fixtures/auth.fixture';
import {
  CSRF_HEADER,
  REFRESH_COOKIE,
  SignupResult,
  apiStepUp,
  createApiContext,
  createBearerApiContext,
  refreshCookieHeader,
  signupAndConfirm,
} from '../../helpers/api-client';
import { apiCompleteOnboarding } from '../../helpers/api-entities';
import {
  backdateUserCreatedAtDirect,
  countMagicLinkTokensDirect,
  seedSuperAdminDirect,
  seedUserWithRoleDirect,
  setTenantOnboardedDirect,
} from '../../helpers/db-helper';
import { EXTERNAL_CALENDAR_STEP_UP_ACTION, STEP_UP_HEADER } from '../../helpers/external-calendar';
import { FakeEmailEntry, fakeEmail, fakeGoogleCalendar } from '../../helpers/fake-providers';
import { apiErrorCodes, assertOk, readJson, unwrapList } from '../../helpers/response';
import { setupPortalUser } from '../../helpers/setup-flows';
import {
  SUPER_ADMIN_EMAIL,
  SUPER_ADMIN_PASSWORD,
  getSuperAdminTokens,
  reserveSuperAdminTotpCode,
} from '../../helpers/super-admin-session';
import { fakeTenant } from '../../helpers/test-data';
import { msUntilTimeStep, totpCode, totpTimeStep } from '../../helpers/totp';

/**
 * Fluxo: 17.5 — Sessão, MFA obrigatório e tokens de uso único
 * Diagrama: — (cenários E4, E5, E12, E40-E44, E53-E56 e E81-E86 do registro e2e
 * de `docs/implementar/PLANO-SEGURANCA.md`)
 *
 * Fonte do comportamento: PLANO-SEGURANCA §4 (SEG-B, MFA exigido pelo servidor),
 * §11 (SEG-I, sessão e tokens de uso único) e §13 (SEG-K, sessão em cookie
 * HttpOnly). O spec afirma o plano; divergência é falha de código, não de
 * asserção.
 */

const FRONT_URL = process.env.FRONT_URL ?? 'http://localhost:4200';
const SUPER_ADMIN_URL = process.env.SUPER_ADMIN_URL ?? 'http://localhost:4201';

/** Dica de sessão do `TokenStorage` do front (`'1'`, nunca um token). */
const SESSION_HINT_KEY = 'auth_session';

/**
 * Chave JWT do `appsettings.E2E.json` do back (HS256). Só para forjar um access
 * token VENCIDO no E55: o logout precisa funcionar sem access token válido.
 */
const E2E_JWT_KEY = 'dev-only-secret-change-in-production-min-32-chars';

/** Credenciais do cliente OAuth que o fake do Google confere (`appsettings.E2E.json`). */
const FAKE_GOOGLE_CLIENT_ID = 'fake-google-client-id-e2e.apps.googleusercontent.com';
const FAKE_GOOGLE_CLIENT_SECRET = 'fake-google-calendar-secret-e2e';

const COMMON_PASSWORD = 'Password1';
const REUSE_EVENT = 'RefreshTokenReuseDetected';

// ─── API anônima ────────────────────────────────────────────────────────────

interface AnonCall {
  status: number;
  /** Corpo cru: é nele que se procura `refreshToken`. */
  text: string;
  /** `data` do envelope (ou o corpo inteiro, sem envelope). */
  body: Record<string, unknown>;
  codes: string[];
  /** Valor do cookie `recreativo_refresh` gravado por esta resposta; null se não gravou. */
  refreshCookie: string | null;
  setCookies: string[];
}

/**
 * POST num contexto HTTP NOVO e descartado: o `APIRequestContext` guarda os
 * cookies do `Set-Cookie`, e um jar compartilhado mandaria o refresh de uma
 * sessão nas chamadas de outra. Cookie, quando a chamada precisa, vai no header.
 */
async function postAnon(
  path: string,
  data?: unknown,
  headers: Record<string, string> = {},
): Promise<AnonCall> {
  const api = await createApiContext();
  try {
    const res = await api.post(path, { data, headers });
    const text = await res.text();
    let parsed: { data?: Record<string, unknown>; errors?: Array<{ code: string }> } = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    const setCookies = res
      .headersArray()
      .filter((h) => h.name.toLowerCase() === 'set-cookie')
      .map((h) => h.value);
    const refresh = setCookies.find((v) => v.startsWith(`${REFRESH_COOKIE}=`));
    const refreshValue = refresh ? refresh.slice(REFRESH_COOKIE.length + 1).split(';')[0] : '';
    return {
      status: res.status(),
      text,
      body: (parsed.data ?? (parsed as Record<string, unknown>)) as Record<string, unknown>,
      codes: (parsed.errors ?? []).map((e) => e.code),
      refreshCookie: refreshValue === '' ? null : refreshValue,
      setCookies,
    };
  } finally {
    await api.dispose();
  }
}

function loginAnon(email: string, password: string, extra: Record<string, unknown> = {}): Promise<AnonCall> {
  return postAnon('/api/auth/login', { email, password, ...extra });
}

function refreshAnon(refreshToken: string): Promise<AnonCall> {
  return postAnon('/api/auth/refresh', undefined, { ...refreshCookieHeader(refreshToken), ...CSRF_HEADER });
}

/** §13 item 1: nenhuma resposta que abre ou renova sessão traz o refresh no corpo. */
function expectNoRefreshTokenInBody(call: AnonCall, label: string): void {
  expect(call.text, `${label}: corpo sem "refreshToken"`).not.toMatch(/"refresh_?token"\s*:/i);
  if (call.refreshCookie) {
    expect(call.text, `${label}: o valor do cookie não aparece no corpo`).not.toContain(call.refreshCookie);
  }
}

/** Data do atributo `expires` do `Set-Cookie` do refresh; null em cookie de sessão. */
function refreshCookieExpiresMs(call: AnonCall): number | null {
  const header = call.setCookies.find((v) => v.startsWith(`${REFRESH_COOKIE}=`));
  const match = header?.match(/expires=([^;]+)/i);
  return match ? Date.parse(match[1]) : null;
}

/** Tenant novo (signup + confirmação + login pela API), com o nome da empresa. */
async function signupWithCompany(): Promise<SignupResult & { companyName: string }> {
  const fake = fakeTenant();
  const api = await createApiContext();
  try {
    const result = await signupAndConfirm(api, {
      companyName: fake.companyName,
      adminName: fake.adminName,
      adminEmail: fake.adminEmail,
      adminPassword: fake.adminPassword,
    });
    return { ...result, companyName: fake.companyName };
  } finally {
    await api.dispose();
  }
}

/** Eventos `RefreshTokenReuseDetected` do próprio usuário (`GET /api/auth/security-events`). */
async function reuseEvents(api: APIRequestContext): Promise<Array<{ type: string; severity: string }>> {
  const res = await api.get('/api/auth/security-events?page=1&pageSize=100');
  await assertOk(res, 'GET /api/auth/security-events');
  const items = await unwrapList<{ type: string; severity: string }>(res);
  return items.filter((e) => String(e.type) === REUSE_EVENT);
}

/**
 * Cópia VENCIDA de um access token: mesmo cabeçalho e claims, `exp` no passado,
 * assinada com a chave do E2E.
 */
function expiredCopyOf(accessToken: string): string {
  const [header, payload] = accessToken.split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  claims.exp = now - 120;
  claims.nbf = now - 3600;
  claims.iat = now - 3600;
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', E2E_JWT_KEY).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

// ─── TOTP e e-mail ──────────────────────────────────────────────────────────

/**
 * Código de um período ainda não gasto pela conta: o back recusa período igual
 * ou anterior ao último aceito (`LastUsedTimeStep`, Etapa 235) e aceita um de
 * folga para frente; além disso espera.
 */
async function freshTotp(secret: string, lastStep: number): Promise<{ code: string; step: number }> {
  const now = totpTimeStep();
  const step = Math.max(now, lastStep + 1);
  if (step > now + 1) {
    await new Promise((resolve) => setTimeout(resolve, msUntilTimeStep(step - 1) + 250));
  }
  return { code: totpCode(secret, step), step };
}

/** Cadastra o TOTP da conta autenticada e devolve o segredo, o período gasto e os códigos de recuperação. */
async function apiEnrollTotp(api: APIRequestContext): Promise<{ secret: string; lastStep: number; backupCodes: string[] }> {
  const enroll = await api.post('/api/auth/mfa/enroll');
  await assertOk(enroll, 'POST /api/auth/mfa/enroll');
  const { secret } = await readJson<{ secret: string }>(enroll);
  const step = totpTimeStep();
  const verify = await api.post('/api/auth/mfa/enroll/verify', { data: { code: totpCode(secret, step) } });
  await assertOk(verify, 'POST /api/auth/mfa/enroll/verify');
  const { codes } = await readJson<{ codes: string[] }>(verify);
  return { secret, lastStep: step, backupCodes: codes };
}

async function emailsTo(to: string, sinceMs: number): Promise<FakeEmailEntry[]> {
  const items = await fakeEmail.emails({ to: to.toLowerCase() });
  return items.filter((e) => Date.parse(e.receivedAt) >= sinceMs);
}

async function waitEmail(to: string, subjectPart: string, sinceMs: number): Promise<FakeEmailEntry> {
  let found: FakeEmailEntry | undefined;
  await expect
    .poll(
      async () => {
        found = (await emailsTo(to, sinceMs)).find((e) => e.subject.includes(subjectPart));
        return found !== undefined;
      },
      { timeout: 30_000, intervals: [500, 1_000], message: `e-mail "${subjectPart}" para ${to}` },
    )
    .toBe(true);
  return found!;
}

/**
 * Barreira para afirmar a AUSÊNCIA de um e-mail sem espera fixa: pede o reset
 * de senha da mesma conta, que sai do mesmo jeito que o link mágico (envio fora
 * do caminho da resposta, `_ = Send…Async`), e espera ele chegar. O que a ação
 * anterior fosse mandar já teria saído. Devolve o id do e-mail da barreira, para
 * tirá-lo da conferência.
 */
async function emailBarrier(to: string, sinceMs: number): Promise<string> {
  const res = await postAnon('/api/auth/forgot-password', { email: to });
  expect(res.status, 'pedido de reset da barreira').toBeLessThan(300);
  let found: FakeEmailEntry | undefined;
  await expect
    .poll(
      async () => {
        found = (await emailsTo(to, sinceMs)).find((e) => e.bodyHtml.includes('/reset-password?token='));
        return found !== undefined;
      },
      { timeout: 30_000, intervals: [500, 1_000], message: `e-mail de reset (barreira) para ${to}` },
    )
    .toBe(true);
  return found!.id;
}

function magicLinkFrom(mail: FakeEmailEntry): string {
  const href = mail.bodyHtml.match(/href="([^"]*\/auth\/magic-link\/consume\?token=[^"]+)"/)?.[1];
  if (!href) throw new Error(`e-mail sem link mágico: ${mail.bodyHtml.slice(0, 300)}`);
  return href.replace(/&amp;/g, '&');
}

/** `id_token` do fake do Google para a conta (o mesmo caminho do popup do GIS: código e troca). */
async function fakeGoogleIdToken(sub: string, email: string): Promise<string> {
  const authorized = await fakeGoogleCalendar.authorize({ sub, email });
  const ctx = await playwrightRequest.newContext();
  try {
    const res = await ctx.post(`${fakeGoogleCalendar.baseUrl}/token`, {
      form: {
        client_id: FAKE_GOOGLE_CLIENT_ID,
        client_secret: FAKE_GOOGLE_CLIENT_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: 'postmessage',
        code: authorized.code,
      },
    });
    await assertOk(res, 'POST fake google /token');
    const body = (await res.json()) as { id_token?: string };
    if (!body.id_token) throw new Error('fake do Google sem id_token');
    return body.id_token;
  } finally {
    await ctx.dispose();
  }
}

// ─── Super Admin ────────────────────────────────────────────────────────────

/** Impersonação pela API (Super Admin semeado, step-up com TOTP): devolve o código de handoff. */
async function apiImpersonationHandoff(tenantId: string): Promise<string> {
  const tokens = await getSuperAdminTokens();
  const saApi = await createBearerApiContext(tokens.accessToken);
  try {
    const stepUp = await apiStepUp(saApi, SUPER_ADMIN_PASSWORD, 'tenant.impersonate', await reserveSuperAdminTotpCode());
    const res = await saApi.post(`/api/super-admin/tenants/${tenantId}/impersonate`, {
      data: { reason: 'Suporte E2E: conferir a sessão (17.5)' },
      headers: { [STEP_UP_HEADER]: stepUp },
    });
    await assertOk(res, 'POST /api/super-admin/tenants/{id}/impersonate');
    return (await readJson<{ handoffCode: string }>(res)).handoffCode;
  } finally {
    await saApi.dispose();
  }
}

// ─── UI ─────────────────────────────────────────────────────────────────────

/**
 * Sessão própria num contexto: o cookie de refresh e a dica de sessão SÓ na
 * origem do app do tenant. O `addSessionToContext` grava a dica em toda origem,
 * e o painel (outra porta do mesmo `localhost`, que divide o cookie) renovaria
 * a sessão do dono ao ser aberto — o que em produção, com hosts distintos, não
 * acontece.
 */
async function addOwnSession(context: BrowserContext, refreshToken: string): Promise<void> {
  const origin = new URL(FRONT_URL).origin;
  await context.addCookies([
    {
      name: REFRESH_COOKIE,
      value: refreshToken,
      domain: new URL(FRONT_URL).hostname,
      path: '/api/auth',
      httpOnly: true,
      secure: true,
      sameSite: 'Strict',
    },
  ]);
  await context.addInitScript(
    ({ key, appOrigin }) => {
      if (location.origin === appOrigin) localStorage.setItem(key, '1');
    },
    { key: SESSION_HINT_KEY, appOrigin: origin },
  );
}

async function newAppContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({
    baseURL: FRONT_URL,
    ignoreHTTPSErrors: true,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  });
}

async function fillLogin(page: Page, email: string, password: string, remember?: boolean): Promise<void> {
  await page.getByTestId('login-email').fill(email);
  await page.getByTestId('login-password').fill(password);
  if (remember !== undefined) {
    const box = page.getByTestId('login-remember').locator('input[type="checkbox"]');
    if ((await box.isChecked()) !== remember) await box.click({ force: true });
  }
  await page.getByTestId('login-submit').click();
}

/** Último `Authorization: Bearer` que a página mandou para a API (opcionalmente de uma origem). */
function trackBearer(page: Page, origin?: string): () => string | null {
  let last: string | null = null;
  page.on('request', (req) => {
    const auth = req.headers()['authorization'];
    if (!auth?.startsWith('Bearer ') || !req.url().includes('/api/')) return;
    if (origin && !req.url().startsWith(origin)) return;
    last = auth.slice('Bearer '.length);
  });
  return () => last;
}

/** Quantas vezes a aba chegou a uma URL (navegação de documento ou do roteador). */
function countArrivals(page: Page, pathPart: string): () => number {
  let count = 0;
  let current = '';
  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (url.includes(pathPart) && !current.includes(pathPart)) count++;
    current = url;
  });
  return () => count;
}

/** Quantos 403 da API a aba recebeu e quantos requests da API ainda estão em voo. */
function trackApiForbidden(page: Page): { forbidden: () => number; inFlight: () => number } {
  let forbidden = 0;
  let inFlight = 0;
  const isApi = (url: string) => url.includes('/api/');
  page.on('request', (req) => {
    if (isApi(req.url())) inFlight++;
  });
  const settle = (req: { url(): string }) => {
    if (isApi(req.url())) inFlight--;
  };
  page.on('requestfinished', settle);
  page.on('requestfailed', settle);
  page.on('response', (res) => {
    if (isApi(res.url()) && res.status() === 403) forbidden++;
  });
  return { forbidden: () => forbidden, inFlight: () => inFlight };
}

/**
 * Espera os 403 da API pararem de chegar: pelo menos um recebido, nenhum
 * request da API em voo e a contagem igual em duas leituras seguidas.
 */
async function waitForbiddenSettled(api: { forbidden: () => number; inFlight: () => number }): Promise<void> {
  let previous = -1;
  await expect
    .poll(
      () => {
        const now = api.forbidden();
        const settled = now > 0 && now === previous && api.inFlight() === 0;
        previous = now;
        return settled;
      },
      { timeout: 30_000, intervals: [500], message: '403 do shell estabilizados' },
    )
    .toBe(true);
}

/** Conta, na página, cada snackbar distinta que mostrou o texto (o Material troca uma pela outra). */
async function installToastCounter(page: Page, text: string): Promise<() => Promise<number>> {
  await page.addInitScript((needle) => {
    const w = window as unknown as { __e2eToastCount: number };
    w.__e2eToastCount = 0;
    const seen = new WeakSet<Element>();
    setInterval(() => {
      document.querySelectorAll('mat-snack-bar-container').forEach((el) => {
        if (!seen.has(el) && (el.textContent ?? '').includes(needle)) {
          seen.add(el);
          w.__e2eToastCount++;
        }
      });
    }, 50);
  }, text);
  return () => page.evaluate(() => (window as unknown as { __e2eToastCount: number }).__e2eToastCount);
}

/** Cadastro do TOTP pela tela `mfa-setup` (app do tenant e painel), até o passo final. */
async function enrollTotpViaUi(page: Page): Promise<void> {
  await page.getByTestId('mfa-setup-start').click();
  await expect(page.getByTestId('mfa-step-scan')).toBeVisible();
  await expect(page.getByTestId('mfa-qr-image')).toBeVisible();
  // O segredo é o mesmo do QR; fica no "Não consigo escanear" (um <details>
  // fechado, por isso textContent e não innerText): o spec não lê a imagem.
  const secret = ((await page.getByTestId('mfa-secret').textContent()) ?? '').replace(/\s+/g, '');
  expect(secret, 'segredo do TOTP do QR').toMatch(/^[A-Z2-7]+=*$/);
  await page.getByTestId('mfa-scan-next').click();
  await page.getByTestId('mfa-verify-code').fill(totpCode(secret, totpTimeStep()));
  await page.getByTestId('mfa-verify-submit').click();
  // O cadastro gera e faz o hash BCrypt dos 10 códigos de recuperação: no modo leve passa de 10 s.
  await expect(page.getByTestId('mfa-step-codes')).toBeVisible({ timeout: 45_000 });
  await page.getByTestId('mfa-codes-finish').click();
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('mfa-step-done')).toBeVisible();
}

/** Pede o link mágico pela tela, partindo do login ("Acesso do colaborador (link por e-mail)"). */
async function requestMagicLinkViaUi(page: Page, email: string): Promise<void> {
  await page.goto('/auth/login');
  await expect(page.getByTestId('login-magic-link')).toContainText('Acesso do colaborador');
  await page.getByTestId('login-magic-link').click();
  await page.waitForURL(/\/auth\/magic-link(\?|$)/);
  await page.getByTestId('magic-link-email').fill(email);
  const sent = page.waitForResponse((r) => r.url().includes('/api/auth/magic-link') && r.request().method() === 'POST');
  await page.getByTestId('magic-link-submit').click();
  expect((await sent).status(), 'pedido de link mágico responde neutro').toBeLessThan(300);
  await expect(page.getByTestId('magic-link-sent')).toBeVisible();
}

/** Texto da snackbar sem o id de correlação (que muda a cada request). */
function normalizeSnack(text: string): string {
  return text
    .replace(/\s*[—-]\s*id:\s*\S+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ════════════════════════════════════════════════════════════════════════════

test.describe('Fluxo 17.5 — Sessão, MFA obrigatório e tokens de uso único', () => {
  // ─── §4 SEG-B — MFA exigido pelo servidor ─────────────────────────────────

  test('E4 @flow Super Admin sem MFA toma 403 Auth.MfaEnrollmentRequired no painel; o cadastro passa', async () => {
    const sa = seedSuperAdminDirect('sa-sem-mfa');

    const login = await loginAnon(sa.email, sa.password);
    expect(login.status, `login do Super Admin sem MFA: ${login.text.slice(0, 200)}`).toBe(200);
    expect(login.body.mfaRequired, 'sem inscrição não há desafio no login').not.toBe(true);

    const saApi = await createBearerApiContext(String(login.body.accessToken));
    try {
      const tenants = await saApi.get('/api/super-admin/tenants');
      expect(tenants.status()).toBe(403);
      expect(await apiErrorCodes(tenants)).toContain('Auth.MfaEnrollmentRequired');

      // Rotas do cadastro estão na allowlist do filtro.
      const status = await saApi.get('/api/auth/mfa/status');
      expect(status.status()).toBe(200);
    } finally {
      await saApi.dispose();
    }
  });

  test('E5 @flow Owner com TOTP pede link mágico: resposta neutra e nenhum token emitido', async ({
    authApi,
    tenant,
  }) => {
    await apiEnrollTotp(authApi);
    const since = Date.now() - 1_000;

    const res = await postAnon('/api/auth/magic-link', { email: tenant.email });
    expect(res.status, 'pedido neutro').toBeLessThan(300);
    expect(res.text, 'resposta sem token').not.toMatch(/token/i);

    // Nenhum link nasceu para a conta (D4: link mágico só para o portal)...
    expect(countMagicLinkTokensDirect(tenant.email)).toBe(0);
    // ...e nenhum e-mail com link foi enviado (conferido depois da barreira).
    const barrierId = await emailBarrier(tenant.email, since);
    const mails = (await emailsTo(tenant.email, since)).filter((m) => m.id !== barrierId);
    expect(mails.filter((m) => m.bodyHtml.includes('/auth/magic-link/consume'))).toHaveLength(0);
  });

  test('E81 @flow Owner sem MFA depois da carência vai uma vez ao cadastro, com um aviso; cadastrado, o app libera sem relogar', async ({
    browser,
    authApi,
    authPage,
  }) => {
    test.setTimeout(150_000);

    const owner = await signupWithCompany();
    // Antes de qualquer request autenticado: a carência sai do snapshot em cache.
    backdateUserCreatedAtDirect(owner.userId, 8);
    setTenantOnboardedDirect(owner.tenantId);

    const ownerApi = await createBearerApiContext(owner.accessToken);
    try {
      const blocked = await ownerApi.get('/api/clients');
      expect(blocked.status()).toBe(403);
      expect(await apiErrorCodes(blocked)).toContain('Auth.MfaEnrollmentRequired');
      expect((await ownerApi.get('/api/me/permissions')).status(), 'bootstrap do shell na allowlist').toBe(200);
    } finally {
      await ownerApi.dispose();
    }

    const context = await newAppContext(browser);
    try {
      await addOwnSession(context, owner.refreshToken);
      const page = await context.newPage();
      const toasts = await installToastCounter(page, 'Ative a verificação em duas etapas');
      const arrivals = countArrivals(page, '/app/settings/mfa/setup');
      const bearer = trackBearer(page, FRONT_URL);
      const apiForbidden = trackApiForbidden(page);

      await page.goto('/app/clients/list');
      await page.waitForURL(/\/app\/settings\/mfa\/setup/);
      await expect(page.getByTestId('mfa-step-intro')).toBeVisible();
      // O menu e as permissões carregam (o shell vem da allowlist).
      await expect(page.locator('[data-testid^="nav-group-toggle-"]').first()).toBeVisible();
      await expect(page.getByTestId('user-menu-trigger')).toBeVisible();

      // Os 403 do shell que chegam depois não levam de novo nem avisam de novo:
      // conferido só depois que eles param de chegar.
      await waitForbiddenSettled(apiForbidden);
      expect(await toasts(), 'um aviso só').toBe(1);
      expect(arrivals(), 'uma ida só ao cadastro').toBe(1);
      expect(page.url()).toContain('/app/settings/mfa/setup');

      await enrollTotpViaUi(page);

      // Request seguinte, sem relogar: navegação no app e o MESMO access token.
      const tokenBefore = bearer();
      expect(tokenBefore, 'access token em uso pela aba').toBeTruthy();
      const budgets = page.waitForResponse(
        (r) => r.url().includes('/api/budgets') && r.request().method() === 'GET',
      );
      await page.getByTestId('nav-group-toggle-Orçamentos').click();
      await page.getByTestId('nav-sub-/app/budgets/list').click();
      expect((await budgets).status(), 'lista de orçamentos liberada').toBe(200);
      await expect(page).toHaveURL(/\/app\/budgets\/list/);

      const sameTokenApi = await createBearerApiContext(tokenBefore!);
      try {
        expect((await sameTokenApi.get('/api/clients')).status(), 'mesmo token, liberado').toBe(200);
      } finally {
        await sameTokenApi.dispose();
      }
    } finally {
      await context.close();
    }

    // Owner dentro da carência navega normal, com o banner.
    await apiCompleteOnboarding(authApi);
    await authPage.goto('/app/clients/list');
    await expect(authPage.getByTestId('mfa-grace-banner-shell')).toBeVisible();
    await expect(authPage).toHaveURL(/\/app\/clients/);
  });

  test('E82 @flow Super Admin sem MFA vai ao cadastro do painel e volta; impersonação navega dono sem MFA', async ({
    browser,
  }) => {
    test.setTimeout(180_000);

    const sa = seedSuperAdminDirect('sa-painel');
    const panel = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
    try {
      const page = await panel.newPage();
      await page.goto(`${SUPER_ADMIN_URL}/auth/login`);
      await fillLogin(page, sa.email, sa.password);
      await page.waitForURL(/\/super-admin\/mfa\/setup/);

      for (const path of ['/super-admin/tenants', '/super-admin/plans']) {
        await page.goto(`${SUPER_ADMIN_URL}${path}`);
        await page.waitForURL(/\/super-admin\/mfa\/setup/);
      }

      await enrollTotpViaUi(page);
      await page.getByTestId('mfa-done-manage').click();
      await expect(page).toHaveURL(new RegExp(`${SUPER_ADMIN_URL}/super-admin/?$`));

      const tenants = page.waitForResponse(
        (r) => r.url().includes('/api/super-admin/tenants') && r.request().method() === 'GET',
      );
      await page.goto(`${SUPER_ADMIN_URL}/super-admin/tenants`);
      expect((await tenants).status(), 'painel liberado depois do cadastro').toBe(200);
      await expect(page).toHaveURL(/\/super-admin\/tenants/);
    } finally {
      await panel.close();
    }

    // Impersonação (Super Admin semeado, com MFA) na empresa de um dono ainda sem MFA.
    const owner = await signupWithCompany();
    backdateUserCreatedAtDirect(owner.userId, 8);
    setTenantOnboardedDirect(owner.tenantId);
    const ownerApi = await createBearerApiContext(owner.accessToken);
    try {
      const blocked = await ownerApi.get('/api/clients');
      expect(blocked.status(), 'o próprio dono está barrado').toBe(403);
      expect(await apiErrorCodes(blocked)).toContain('Auth.MfaEnrollmentRequired');
    } finally {
      await ownerApi.dispose();
    }

    const handoff = await apiImpersonationHandoff(owner.tenantId);
    const tenantApp = await newAppContext(browser);
    try {
      const page = await tenantApp.newPage();
      await page.goto(`/impersonation?code=${encodeURIComponent(handoff)}`);
      await expect(page.getByTestId('impersonation-banner')).toBeVisible({ timeout: 30_000 });

      const clients = page.waitForResponse(
        (r) => r.url().includes('/api/clients') && r.request().method() === 'GET',
      );
      await page.goto('/app/clients/list');
      expect((await clients).status(), 'impersonação fora do filtro do MFA').toBe(200);
      await expect(page).toHaveURL(/\/app\/clients/);
      await expect(page.getByTestId('impersonation-banner')).toBeVisible();
    } finally {
      await tenantApp.close();
    }
  });

  test('E83 @flow impersonar pela ficha: motivo, senha e TOTP; código do login recusado, o seguinte abre só leitura', async ({
    browser,
  }) => {
    test.setTimeout(180_000);

    const target = await signupWithCompany();
    setTenantOnboardedDirect(target.tenantId);

    const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
    try {
      const page = await context.newPage();
      const tenantBearer = trackBearer(page, FRONT_URL);

      await page.goto(`${SUPER_ADMIN_URL}/auth/login`);
      await fillLogin(page, SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD);
      await page.waitForURL(/\/auth\/mfa\/challenge/);
      const loginCode = await reserveSuperAdminTotpCode();
      await page.getByTestId('mfa-code').fill(loginCode);
      await page.getByTestId('mfa-submit').click();
      await page.waitForURL(/\/super-admin(\/|$)/);

      await page.goto(`${SUPER_ADMIN_URL}/super-admin/tenants/${target.tenantId}`);
      await page.getByTestId('tenant-impersonate').click();
      await page.getByTestId('impersonate-reason').fill('Suporte E2E: conferir a sessão somente leitura');
      await page.getByTestId('impersonate-confirm').click();

      // O mesmo código do login, no mesmo período: recusado, com o aviso de esperar o próximo.
      await page.getByTestId('step-up-password').fill(SUPER_ADMIN_PASSWORD);
      await page.getByTestId('step-up-mfa-code').fill(loginCode);
      const refused = page.waitForResponse(
        (r) => r.url().includes('/api/auth/step-up') && r.request().method() === 'POST',
      );
      await page.getByTestId('step-up-submit').click();
      expect((await refused).ok(), 'código do login reaproveitado').toBe(false);
      await expect(page.getByTestId('step-up-error')).toContainText(/esper\w* o pr[oó]ximo/i);

      // O código seguinte abre a sessão.
      const nextCode = await reserveSuperAdminTotpCode();
      await page.getByTestId('step-up-password').fill(SUPER_ADMIN_PASSWORD);
      await page.getByTestId('step-up-mfa-code').fill(nextCode);
      await page.getByTestId('step-up-submit').click();

      await expect(page.getByTestId('impersonation-banner')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('impersonation-banner')).toContainText('somente leitura');
      expect(page.url().startsWith(FRONT_URL), 'sessão aberta no app do tenant').toBe(true);

      // Só leitura de verdade: escrita com o token da sessão impersonada é recusada.
      await expect.poll(() => tenantBearer(), { message: 'token da sessão impersonada' }).not.toBeNull();
      const impersonated = await createBearerApiContext(tenantBearer()!);
      try {
        const write = await impersonated.post('/api/clients', {
          data: { name: `Cliente E2E ${Date.now()}`, type: 'PF' },
        });
        expect(write.status()).toBe(403);
        expect(await apiErrorCodes(write)).toContain('Impersonation.ReadOnly');
      } finally {
        await impersonated.dispose();
      }
    } finally {
      await context.close();
    }
  });

  test('E84 @flow step-up de "desativar MFA" não serve para outra ação; pedido sem ação dá 400', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(120_000);

    const ownerToken = await apiStepUp(authApi, tenant.password, 'mfa_disable');

    const plan = await authApi.post('/api/billing/change-plan', {
      data: { planCode: 'plan_pro', billingPeriod: 'Monthly' },
      headers: { [STEP_UP_HEADER]: ownerToken },
    });
    expect(plan.status(), 'trocar o plano').toBe(403);
    expect(await apiErrorCodes(plan)).toContain('Auth.StepUpRequired');

    const calendar = await authApi.post('/api/calendar/google/connect', {
      data: { code: 'codigo-qualquer', nonce: 'nonce-qualquer' },
      headers: { [STEP_UP_HEADER]: ownerToken },
    });
    expect(calendar.status(), `conectar a agenda (${EXTERNAL_CALENDAR_STEP_UP_ACTION})`).toBe(403);
    expect(await apiErrorCodes(calendar)).toContain('Auth.StepUpRequired');

    const sa = await getSuperAdminTokens();
    const saApi = await createBearerApiContext(sa.accessToken);
    try {
      const saToken = await apiStepUp(saApi, SUPER_ADMIN_PASSWORD, 'mfa_disable', await reserveSuperAdminTotpCode());
      const impersonate = await saApi.post(`/api/super-admin/tenants/${tenant.tenantId}/impersonate`, {
        data: { reason: 'Suporte E2E: step-up de outra ação' },
        headers: { [STEP_UP_HEADER]: saToken },
      });
      expect(impersonate.status(), 'impersonar').toBe(403);
      expect(await apiErrorCodes(impersonate)).toContain('Auth.StepUpRequired');
    } finally {
      await saApi.dispose();
    }

    const noAction = await authApi.post('/api/auth/step-up', {
      data: { password: tenant.password, mfaCode: null, backupCode: null },
    });
    expect(noAction.status(), 'step-up sem ação').toBe(400);
  });

  test('E85 @flow colaborador com TOTP entra pelo link do e-mail e passa pelo desafio; Admin e Manager não recebem link', async ({
    browser,
    authApi,
    tenant,
  }) => {
    test.setTimeout(150_000);
    const since = Date.now() - 1_000;

    const admin = seedUserWithRoleDirect({ tenantId: tenant.tenantId, role: 'Admin', emailPrefix: 'admin-link' });
    const manager = seedUserWithRoleDirect({ tenantId: tenant.tenantId, role: 'Manager', emailPrefix: 'manager-link' });

    const adminContext = await newAppContext(browser);
    try {
      await requestMagicLinkViaUi(await adminContext.newPage(), admin.email);
    } finally {
      await adminContext.close();
    }
    const managerRequest = await postAnon('/api/auth/magic-link', { email: manager.email });
    expect(managerRequest.status, 'resposta neutra para o Manager').toBeLessThan(300);
    expect(managerRequest.text).not.toMatch(/token/i);

    const portal = await setupPortalUser(authApi, tenant.tenantId);
    let totp: { secret: string; lastStep: number };
    try {
      totp = await apiEnrollTotp(portal.portalApi);
    } finally {
      await portal.portalApi.dispose();
    }

    const portalContext = await newAppContext(browser);
    try {
      const page = await portalContext.newPage();
      await requestMagicLinkViaUi(page, portal.email);
      const mail = await waitEmail(portal.email, 'link de acesso', since);

      await page.goto(magicLinkFrom(mail));
      await page.waitForURL(/\/auth\/mfa\/challenge/);
      const { code } = await freshTotp(totp.secret, totp.lastStep);
      await page.getByTestId('mfa-code').fill(code);
      await page.getByTestId('mfa-submit').click();
      await page.waitForURL(/\/portal(\/|\?|$)/);
    } finally {
      await portalContext.close();
    }

    // O link do colaborador já chegou; os pedidos do Admin e do Manager vieram antes.
    for (const user of [admin, manager]) {
      expect(await emailsTo(user.email, since), `nenhum e-mail para ${user.email}`).toHaveLength(0);
      expect(countMagicLinkTokensDirect(user.email), `nenhum link emitido para ${user.email}`).toBe(0);
    }
  });

  test('E86 @flow OTP do MFA por e-mail: o assunto não traz o código e o corpo traz', async ({ tenant }) => {
    test.setTimeout(120_000);

    const manager = seedUserWithRoleDirect({ tenantId: tenant.tenantId, role: 'Manager', emailPrefix: 'manager-otp' });
    const first = await loginAnon(manager.email, manager.password);
    expect(first.status).toBe(200);
    const managerApi = await createBearerApiContext(String(first.body.accessToken));
    try {
      await apiEnrollTotp(managerApi);
    } finally {
      await managerApi.dispose();
    }

    const challenge = await loginAnon(manager.email, manager.password);
    expect(challenge.body.mfaRequired, 'login com MFA cadastrado pede o desafio').toBe(true);
    const mfaSessionToken = String(challenge.body.mfaSessionToken);

    const since = Date.now() - 1_000;
    const send = await postAnon('/api/auth/mfa/email-otp/send', { mfaSessionToken });
    expect(send.status, `envio do OTP: ${send.text.slice(0, 200)}`).toBeLessThan(300);

    const mail = await waitEmail(manager.email, 'verificação', since);
    const bodyText = mail.bodyHtml.replace(/<[^>]+>/g, ' ');
    const code = bodyText.match(/\b(\d{6,8})\b/)?.[1];
    expect(code, 'o corpo traz o código').toBeTruthy();
    expect(mail.subject).not.toContain(code!);
    expect(mail.subject, 'nenhum número no assunto').not.toMatch(/\d{4,}/);
  });

  // ─── §11 SEG-I — Sessão e tokens de uso único ─────────────────────────────

  test('E40 @flow refresh reapresentado depois de 30 s derruba a família e grava o evento Critical; rotação não passa do teto', async ({
    browser,
    authApi,
    tenant,
  }) => {
    test.setTimeout(180_000);
    await apiCompleteOnboarding(authApi);

    // Teto absoluto: renovar sem parar não estende a validade da emissão original.
    const original = await loginAnon(tenant.email, tenant.password);
    expect(original.status).toBe(200);
    const ceilingMs = Date.parse(String(original.body.refreshExpiresAt));
    expect(Number.isNaN(ceilingMs), 'refreshExpiresAt no corpo do login').toBe(false);
    let cookie = original.refreshCookie!;
    for (let i = 0; i < 3; i++) {
      const rotated = await refreshAnon(cookie);
      expect(rotated.status, `rotação ${i + 1}`).toBe(200);
      const expiresMs = Date.parse(String(rotated.body.refreshExpiresAt));
      expect(expiresMs, `rotação ${i + 1} dentro do teto`).toBeLessThanOrEqual(ceilingMs + 1_000);
      const cookieExpires = refreshCookieExpiresMs(rotated);
      if (cookieExpires !== null) expect(cookieExpires).toBeLessThanOrEqual(ceilingMs + 1_000);
      cookie = rotated.refreshCookie!;
    }

    // Sessão A renovada para B; A reapresentado.
    const a = await loginAnon(tenant.email, tenant.password);
    const cookieA = a.refreshCookie!;
    const toB = await refreshAnon(cookieA);
    expect(toB.status).toBe(200);
    const cookieB = toB.refreshCookie!;
    const rotatedAt = Date.now();

    expect(await reuseEvents(authApi), 'sem reuso antes do teste').toHaveLength(0);

    const reuseStatuses: number[] = [];
    let detectedAt = 0;
    await expect
      .poll(
        async () => {
          reuseStatuses.push((await refreshAnon(cookieA)).status);
          const found = (await reuseEvents(authApi)).length > 0;
          if (found && detectedAt === 0) detectedAt = Date.now();
          return found;
        },
        { timeout: 75_000, intervals: [5_000], message: 'evento de reuso de refresh token' },
      )
      .toBe(true);

    expect(new Set(reuseStatuses), 'refresh A reapresentado sempre 401').toEqual(new Set([401]));
    expect(detectedAt - rotatedAt, 'dentro dos 30 s só 401, sem derrubar a família').toBeGreaterThanOrEqual(29_000);

    const afterB = await refreshAnon(cookieB);
    expect(afterB.status, 'a sessão B caiu junto').toBe(401);

    const events = await reuseEvents(authApi);
    expect(events.map((e) => String(e.severity))).toContain('Critical');

    // O evento aparece na tela de eventos de segurança.
    const viewer = await loginAnon(tenant.email, tenant.password);
    const context = await newAppContext(browser);
    try {
      await addOwnSession(context, viewer.refreshCookie!);
      const page = await context.newPage();
      await page.goto('/app/settings/security');
      await expect(page.getByTestId('events-list')).toContainText('Reuso de sessão detectado');
    } finally {
      await context.close();
    }
  });

  test('E41 @flow reset de senha derruba a outra aba no próximo request; de dois resets só o mais novo vale', async ({
    browser,
    authPage,
    authApi,
    api,
    tenant,
  }) => {
    test.setTimeout(120_000);
    await apiCompleteOnboarding(authApi);

    await authPage.goto('/app');
    await expect(authPage.getByTestId('tenant-name')).toBeVisible();

    const forgot = async (): Promise<string> => {
      const res = await api.post('/api/auth/forgot-password', { data: { email: tenant.email } });
      await assertOk(res, 'POST /api/auth/forgot-password');
      const token = (await readJson<{ resetToken: string | null }>(res)).resetToken;
      expect(token, 'resetToken devolvido no E2E').toBeTruthy();
      return token!;
    };
    const older = await forgot();
    const newer = await forgot();
    expect(newer).not.toBe(older);

    const newPassword = `Nova${Date.now()}Ab`;
    const resetContext = await newAppContext(browser);
    try {
      const resetTab = await resetContext.newPage();
      const submitReset = async (token: string) => {
        await resetTab.goto(`/auth/reset-password?token=${encodeURIComponent(token)}`);
        await resetTab.getByTestId('reset-new-password').fill(newPassword);
        await resetTab.getByTestId('reset-confirm-password').fill(newPassword);
        const response = resetTab.waitForResponse(
          (r) => r.url().includes('/api/auth/reset-password') && r.request().method() === 'POST',
        );
        await resetTab.getByTestId('reset-submit').click();
        return response;
      };

      const olderRes = await submitReset(older);
      expect(olderRes.ok(), 'o link mais antigo foi invalidado').toBe(false);
      expect(await apiErrorCodes(olderRes)).toContain('Auth.InvalidResetToken');

      const newerRes = await submitReset(newer);
      expect(newerRes.ok(), 'o link mais novo funciona').toBe(true);
    } finally {
      await resetContext.close();
    }

    // A aba logada com a senha antiga: o próximo request toma 401 e ela volta ao login.
    const unauthorized = authPage.waitForResponse(
      (r) => r.url().includes('/api/') && !r.url().includes('/api/auth/') && r.status() === 401,
    );
    await authPage.getByTestId('user-menu-trigger').click();
    await authPage.getByTestId('user-menu-settings').click();
    await unauthorized;
    await authPage.waitForURL(/\/auth\/login/);
  });

  test('E42 @flow e-mail inexistente, senha errada e conta bloqueada dão a mesma mensagem genérica', async ({
    page,
    tenant,
  }) => {
    test.setTimeout(120_000);

    const attempt = async (email: string, password: string) => {
      await page.goto('/auth/login');
      const response = page.waitForResponse(
        (r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST',
      );
      await fillLogin(page, email, password);
      const res = await response;
      const bar = page.locator('mat-snack-bar-container').last();
      await expect(bar).toBeVisible();
      return { status: res.status(), codes: await apiErrorCodes(res), text: normalizeSnack(await bar.innerText()) };
    };

    const unknown = await attempt(`naoexiste-${Date.now()}@e2e.test`, 'Qualquer@123');
    const wrong = await attempt(tenant.email, 'Senha@Errada123');

    // Bloqueio por tentativas: 10 falhas (a de cima conta uma).
    for (let i = 0; i < 9; i++) {
      await loginAnon(tenant.email, `Errada@${i}Xyz`);
    }
    const lockedCheck = await loginAnon(tenant.email, tenant.password);
    expect(lockedCheck.status, 'conta bloqueada recusa até a senha certa').toBe(401);

    const locked = await attempt(tenant.email, tenant.password);

    for (const [label, result] of [
      ['e-mail inexistente', unknown],
      ['senha errada', wrong],
      ['conta bloqueada', locked],
    ] as const) {
      expect(result.status, label).toBe(401);
      expect(result.codes, label).toEqual(['Auth.InvalidCredentials']);
      expect(result.text, `${label}: sem falar de bloqueio nem de horário`).not.toMatch(
        /bloque|tentativa|minuto|hor[aá]rio|\d{1,2}:\d{2}|aguarde/i,
      );
    }
    expect(wrong.text).toBe(unknown.text);
    expect(locked.text).toBe(unknown.text);
  });

  test('E43 @flow cadastro com e-mail já cadastrado mostra a mesma tela e não manda e-mail', async ({
    page,
    tenant,
  }) => {
    test.setTimeout(120_000);

    // Os e-mails do próprio cadastro da fixture (verificação e novo acesso)
    // chegam em segundo plano: a contagem começa depois deles.
    await expect
      .poll(async () => (await emailsTo(tenant.email, 0)).filter((m) => m.subject.includes('Confirme')).length, {
        timeout: 30_000,
        message: 'verificação do cadastro da fixture',
      })
      .toBeGreaterThan(0);
    const since = Date.now();

    const submitSignup = async (email: string) => {
      const fake = fakeTenant();
      await page.goto('/auth/signup');
      await page.getByTestId('signup-company').fill(fake.companyName);
      await page.getByTestId('signup-user').fill(fake.adminName);
      await page.getByTestId('signup-email').fill(email);
      await page.getByTestId('signup-password').fill(fake.adminPassword);
      await page.getByTestId('signup-confirm-password').fill(fake.adminPassword);
      await page.getByTestId('signup-terms').locator('input[type="checkbox"]').check({ force: true });
      const response = page.waitForResponse(
        (r) => r.url().includes('/api/auth/signup') && r.request().method() === 'POST',
      );
      await page.getByTestId('signup-submit').click();
      const res = await response;
      await page.waitForURL(/\/auth\/signup-sent/);
      const message = (await page.getByTestId('signup-sent-message').innerText())
        .replace(email, '<email>')
        .replace(/\s+/g, ' ')
        .trim();
      return { status: res.status(), message };
    };

    const brandNew = fakeTenant().adminEmail;
    const fresh = await submitSignup(brandNew);
    const existing = await submitSignup(tenant.email);

    expect(existing.status, 'mesma resposta do cadastro novo').toBe(fresh.status);
    expect(existing.message, 'mesma tela de "verifique seu e-mail"').toBe(fresh.message);

    // O cadastro novo recebe a verificação; o e-mail já cadastrado não recebe nada.
    await expect
      .poll(async () => (await emailsTo(brandNew, since)).length, { timeout: 30_000, message: 'verificação do cadastro novo' })
      .toBeGreaterThan(0);
    const barrierId = await emailBarrier(tenant.email, since);
    // "Novo acesso detectado" vem do login da fixture (best-effort, sem ordem); não do cadastro.
    const toExisting = (await emailsTo(tenant.email, since)).filter(
      (m) => m.id !== barrierId && !m.subject.startsWith('Novo acesso'),
    );
    expect(toExisting.map((m) => m.subject), 'nenhum e-mail do cadastro repetido').toEqual([]);
  });

  test('E44 @flow senha comum que passa na validação local é recusada pelo back no cadastro, no reset e no convite', async ({
    page,
    api,
    authApi,
    tenant,
  }) => {
    test.setTimeout(120_000);

    // Cadastro
    const fake = fakeTenant();
    await page.goto('/auth/signup');
    await page.getByTestId('signup-company').fill(fake.companyName);
    await page.getByTestId('signup-user').fill(fake.adminName);
    await page.getByTestId('signup-email').fill(fake.adminEmail);
    await page.getByTestId('signup-password').fill(COMMON_PASSWORD);
    await page.getByTestId('signup-confirm-password').fill(COMMON_PASSWORD);
    await page.getByTestId('signup-terms').locator('input[type="checkbox"]').check({ force: true });
    const signup = page.waitForResponse((r) => r.url().includes('/api/auth/signup') && r.request().method() === 'POST');
    await page.getByTestId('signup-submit').click();
    const signupRes = await signup;
    expect(signupRes.status()).toBe(400);
    expect(await apiErrorCodes(signupRes)).toContain('Auth.WeakPassword');
    await expect(page.getByTestId('signup-password-error')).toBeVisible();
    await expect(page).toHaveURL(/\/auth\/signup$/);

    // Reset
    const forgot = await api.post('/api/auth/forgot-password', { data: { email: tenant.email } });
    await assertOk(forgot, 'POST /api/auth/forgot-password');
    const resetToken = (await readJson<{ resetToken: string }>(forgot)).resetToken;
    await page.goto(`/auth/reset-password?token=${encodeURIComponent(resetToken)}`);
    await page.getByTestId('reset-new-password').fill(COMMON_PASSWORD);
    await page.getByTestId('reset-confirm-password').fill(COMMON_PASSWORD);
    const reset = page.waitForResponse((r) => r.url().includes('/api/auth/reset-password') && r.request().method() === 'POST');
    await page.getByTestId('reset-submit').click();
    const resetRes = await reset;
    expect(resetRes.status()).toBe(400);
    expect(await apiErrorCodes(resetRes)).toContain('Auth.WeakPassword');
    await expect(page.getByTestId('reset-password-error')).toBeVisible();

    // Aceite de convite
    const invite = await authApi.post('/api/invitations', {
      data: { email: `convite-senha-${Date.now()}@e2e.test`, role: 'Manager' },
    });
    await assertOk(invite, 'POST /api/invitations');
    const inviteToken = (await readJson<{ inviteToken: string }>(invite)).inviteToken;
    await page.goto(`/auth/accept-invitation?token=${encodeURIComponent(inviteToken)}`);
    await page.getByTestId('accept-username').fill('Convidado E2E');
    await page.getByTestId('accept-password').fill(COMMON_PASSWORD);
    await page.getByTestId('accept-confirm').fill(COMMON_PASSWORD);
    const accept = page.waitForResponse((r) => /\/api\/invitations\/[^/]+\/accept/.test(r.url()) && r.request().method() === 'POST');
    await page.getByTestId('accept-submit').click();
    const acceptRes = await accept;
    expect(acceptRes.status()).toBe(400);
    expect(await apiErrorCodes(acceptRes)).toContain('Auth.WeakPassword');
    await expect(page.getByTestId('accept-password-error')).toBeVisible();
  });

  // ─── §13 SEG-K — Sessão do front em cookie HttpOnly ───────────────────────

  test('E12 @flow depois do login nenhum token em localStorage/sessionStorage; F5 mantém a sessão', async ({
    page,
    authApi,
    tenant,
  }) => {
    await apiCompleteOnboarding(authApi);

    await page.goto('/auth/login');
    await fillLogin(page, tenant.email, tenant.password);
    await page.waitForURL(/\/app(\/|$)/);
    await expect(page.getByTestId('tenant-name')).toBeVisible();

    const refresh = (await page.context().cookies()).find((c) => c.name === REFRESH_COOKIE);
    expect(refresh, 'refresh no cookie').toBeTruthy();
    expect(refresh!.httpOnly, 'cookie HttpOnly').toBe(true);

    const storage = await page.evaluate(() => {
      const dump = (s: Storage) =>
        Array.from({ length: s.length }, (_, i) => {
          const key = s.key(i) ?? '';
          return [key, s.getItem(key) ?? ''] as [string, string];
        });
      return [...dump(localStorage), ...dump(sessionStorage)];
    });
    for (const [key, value] of storage) {
      expect(key, 'nenhuma chave de token').not.toMatch(/token/i);
      expect(value, `${key}: nenhum JWT`).not.toMatch(/eyJ[\w-]+\.[\w-]+\./);
      expect(value, `${key}: nem o refresh`).not.toContain(refresh!.value);
    }

    await page.reload();
    await expect(page.getByTestId('tenant-name')).toBeVisible();
    expect(page.url(), 'F5 mantém a sessão').not.toMatch(/\/auth\/login/);
  });

  /** Três abas logadas no mesmo navegador (a do `authPage` e duas novas), todas em `/app`. */
  async function openThreeTabs(authPage: Page, companyName: string): Promise<[Page, Page, Page]> {
    const context = authPage.context();
    const tab1 = authPage;
    await tab1.goto('/app');
    await expect(tab1.getByTestId('tenant-name')).toHaveText(companyName);
    const tab2 = await context.newPage();
    await tab2.goto('/app');
    await expect(tab2.getByTestId('tenant-name')).toHaveText(companyName);
    const tab3 = await context.newPage();
    return [tab1, tab2, tab3];
  }

  test('E53 @flow abas: abrir a terceira e recarregar duas juntas não derruba nem acusa reuso; sair numa leva as outras ao login', async ({
    authPage,
    authApi,
    tenant,
  }) => {
    test.setTimeout(150_000);
    await apiCompleteOnboarding(authApi);
    const [tab1, tab2, tab3] = await openThreeTabs(authPage, tenant.companyName);

    // Terceira aba e as duas primeiras recarregando ao mesmo tempo.
    await Promise.all([tab3.goto('/app'), tab1.reload(), tab2.reload()]);
    for (const tab of [tab1, tab2, tab3]) {
      await expect(tab.getByTestId('tenant-name')).toHaveText(tenant.companyName);
      expect(tab.url(), 'nenhuma aba derrubada').not.toMatch(/\/auth\/login/);
    }
    expect(await reuseEvents(authApi), 'nenhum "reuso de refresh token"').toHaveLength(0);

    // Sair numa aba leva as outras ao login.
    await tab1.getByTestId('user-menu-trigger').click();
    await tab1.getByTestId('user-menu-logout').click();
    await tab1.waitForURL(/\/auth\/login/);
    await tab2.waitForURL(/\/auth\/login/);
    await tab3.waitForURL(/\/auth\/login/);
  });

  test('E53 @flow abas: logar com outro usuário numa aba troca as outras para ele, com o menu e a empresa dele', async ({
    authPage,
    authApi,
    tenant,
  }) => {
    test.setTimeout(150_000);
    await apiCompleteOnboarding(authApi);
    const [tab1, tab2, tab3] = await openThreeTabs(authPage, tenant.companyName);
    await tab3.goto('/app');
    await expect(tab3.getByTestId('tenant-name')).toHaveText(tenant.companyName);

    const other = await signupWithCompany();
    const otherApi = await createBearerApiContext(other.accessToken);
    try {
      await apiCompleteOnboarding(otherApi);
    } finally {
      await otherApi.dispose();
    }
    // A aba vai ao login com a sessão do primeiro usuário ainda viva no navegador.
    await tab1.goto('/auth/login');
    const login = tab1.waitForResponse((r) => r.url().includes('/api/auth/login') && r.request().method() === 'POST');
    await fillLogin(tab1, other.email, other.password);
    const loginRes = await login;
    expect(
      loginRes.status(),
      `login do outro usuário com uma sessão aberta no navegador: ${(await loginRes.text()).slice(0, 200)}`,
    ).toBe(200);
    await tab1.waitForURL(/\/app(\/|$)/);
    await expect(tab1.getByTestId('tenant-name')).toHaveText(other.companyName);
    for (const tab of [tab2, tab3]) {
      await expect(tab.getByTestId('tenant-name')).toHaveText(other.companyName);
      await expect(tab.locator('[data-testid^="nav-group-toggle-"]').first()).toBeVisible();
    }
  });

  test('E54 @flow refresh sem cookie 401, sem X-CSRF 400; nenhuma resposta de sessão traz refreshToken no corpo', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(150_000);

    const noCookie = await postAnon('/api/auth/refresh', undefined, { ...CSRF_HEADER });
    expect(noCookie.status).toBe(401);
    expect(noCookie.codes).toContain('Auth.InvalidRefreshToken');

    const login = await loginAnon(tenant.email, tenant.password);
    expect(login.status).toBe(200);
    expect(login.refreshCookie, 'login grava o cookie').toBeTruthy();
    expectNoRefreshTokenInBody(login, 'login');

    const noCsrf = await postAnon('/api/auth/refresh', undefined, refreshCookieHeader(login.refreshCookie!));
    expect(noCsrf.status).toBe(400);
    expect(noCsrf.codes).toContain('Auth.CsrfHeaderMissing');

    const refreshed = await refreshAnon(login.refreshCookie!);
    expect(refreshed.status).toBe(200);
    expect(refreshed.refreshCookie, 'renovação grava o cookie').toBeTruthy();
    expectNoRefreshTokenInBody(refreshed, 'renovação');

    // Google: vincula a conta e entra por ela (antes do MFA, que pediria o desafio).
    const sub = `e2e-sub-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const link = await authApi.post('/api/auth/link-google', {
      data: { idToken: await fakeGoogleIdToken(sub, tenant.email) },
    });
    await assertOk(link, 'POST /api/auth/link-google');
    const google = await postAnon('/api/auth/google', {
      idToken: await fakeGoogleIdToken(sub, tenant.email),
      companyName: null,
      invitationToken: null,
    });
    expect(google.status, `login Google: ${google.text.slice(0, 200)}`).toBe(200);
    expect(google.refreshCookie, 'Google grava o cookie').toBeTruthy();
    expectNoRefreshTokenInBody(google, 'Google');

    // MFA: desafio, verificação por TOTP e por código de recuperação.
    const mfa = await apiEnrollTotp(authApi);
    const challenge = await loginAnon(tenant.email, tenant.password);
    expect(challenge.body.mfaRequired).toBe(true);
    expectNoRefreshTokenInBody(challenge, 'login com desafio');
    const { code } = await freshTotp(mfa.secret, mfa.lastStep);
    const verified = await postAnon('/api/auth/mfa/verify', {
      mfaSessionToken: challenge.body.mfaSessionToken,
      method: 'Totp',
      code,
      trustDevice: false,
    });
    expect(verified.status, `mfa/verify: ${verified.text.slice(0, 200)}`).toBe(200);
    expect(verified.refreshCookie, 'mfa/verify grava o cookie').toBeTruthy();
    expectNoRefreshTokenInBody(verified, 'mfa/verify');

    const challenge2 = await loginAnon(tenant.email, tenant.password);
    const backup = await postAnon('/api/auth/mfa/verify-backup', {
      mfaSessionToken: challenge2.body.mfaSessionToken,
      backupCode: mfa.backupCodes[0],
      trustDevice: false,
    });
    expect(backup.status, `mfa/verify-backup: ${backup.text.slice(0, 200)}`).toBe(200);
    expect(backup.refreshCookie, 'mfa/verify-backup grava o cookie').toBeTruthy();
    expectNoRefreshTokenInBody(backup, 'mfa/verify-backup');

    // Link mágico (colaborador do portal, sem MFA).
    const portal = await setupPortalUser(authApi, tenant.tenantId);
    await portal.portalApi.dispose();
    const since = Date.now() - 1_000;
    const request = await postAnon('/api/auth/magic-link', { email: portal.email });
    expect(request.status).toBeLessThan(300);
    const mail = await waitEmail(portal.email, 'link de acesso', since);
    const token = new URL(magicLinkFrom(mail)).searchParams.get('token');
    const consumed = await postAnon('/api/auth/magic-link/consume', { token });
    expect(consumed.status, `magic-link/consume: ${consumed.text.slice(0, 200)}`).toBe(200);
    expect(consumed.refreshCookie, 'link mágico grava o cookie').toBeTruthy();
    expectNoRefreshTokenInBody(consumed, 'link mágico');
  });

  test('E55 @flow sair com access token vencido revoga a sessão e ela some da lista; fim da impersonação não desloga a outra aba', async ({
    browser,
    authApi,
    tenant,
  }) => {
    test.setTimeout(150_000);
    await apiCompleteOnboarding(authApi);

    const context = await newAppContext(browser);
    try {
      await addOwnSession(context, tenant.refreshToken);
      const tabB = await context.newPage();

      // Sessão A, noutro dispositivo.
      const a = await loginAnon(tenant.email, tenant.password);
      const cookieA = a.refreshCookie!;
      const apiA = await createBearerApiContext(String(a.body.accessToken));
      let sessionAId: string;
      try {
        const sessions = await apiA.get('/api/auth/sessions', { headers: refreshCookieHeader(cookieA) });
        await assertOk(sessions, 'GET /api/auth/sessions');
        const current = (await unwrapList<{ id: string; current: boolean }>(sessions)).find((s) => s.current);
        expect(current, 'a sessão A marcada como atual pelo cookie').toBeTruthy();
        sessionAId = current!.id;
      } finally {
        await apiA.dispose();
      }

      await tabB.goto('/app/settings/security');
      await expect(tabB.getByTestId(`session-revoke-${sessionAId}`)).toBeVisible();

      // Sair com o access token já vencido: o cookie basta.
      const logout = await postAnon('/api/auth/logout', undefined, {
        ...refreshCookieHeader(cookieA),
        Authorization: `Bearer ${expiredCopyOf(String(a.body.accessToken))}`,
      });
      expect(logout.status, `logout: ${logout.text.slice(0, 200)}`).toBeLessThan(300);
      expect((await refreshAnon(cookieA)).status, 'a sessão A foi revogada').toBe(401);

      await tabB.reload();
      await expect(tabB.getByTestId('session-current-badge')).toBeVisible();
      await expect(tabB.getByTestId(`session-revoke-${sessionAId}`)).toHaveCount(0);

      // Impersonação noutra aba do mesmo navegador; encerrá-la não desloga a sessão própria.
      const target = await signupWithCompany();
      setTenantOnboardedDirect(target.tenantId);
      const handoff = await apiImpersonationHandoff(target.tenantId);
      const tabI = await context.newPage();
      await tabI.goto(`/impersonation?code=${encodeURIComponent(handoff)}`);
      await expect(tabI.getByTestId('impersonation-banner')).toBeVisible({ timeout: 30_000 });
      await tabI.getByTestId('impersonation-banner-exit').click();
      await tabI.waitForURL((url) => !url.href.startsWith(`${FRONT_URL}/app`));

      await tabB.reload();
      await expect(tabB.getByTestId('session-current-badge')).toBeVisible();
      expect(tabB.url(), 'a aba da sessão própria continua logada').toContain('/app/settings/security');
    } finally {
      await context.close();
    }
  });

  test('E56 @flow sem "lembrar-me", navegador reaberto cai no login; com "lembrar-me", entra direto', async ({
    browser,
    authApi,
    tenant,
  }) => {
    test.setTimeout(120_000);
    await apiCompleteOnboarding(authApi);

    // Navegador "reaberto": contexto novo só com os cookies persistentes e o localStorage.
    const reopenAfterLogin = async (remember: boolean): Promise<BrowserContext> => {
      const first = await newAppContext(browser);
      try {
        const page = await first.newPage();
        await page.goto('/auth/login');
        await fillLogin(page, tenant.email, tenant.password, remember);
        await page.waitForURL(/\/app(\/|$)/);
        await expect(page.getByTestId('tenant-name')).toBeVisible();
        const state = await first.storageState();
        return await browser.newContext({
          baseURL: FRONT_URL,
          ignoreHTTPSErrors: true,
          storageState: {
            cookies: state.cookies.filter((c) => c.expires > 0), // -1 = cookie de sessão
            origins: state.origins,
          },
        });
      } finally {
        await first.close();
      }
    };

    const forgotten = await reopenAfterLogin(false);
    try {
      const page = await forgotten.newPage();
      await page.goto('/app');
      await expect(page).toHaveURL(/\/auth\/login/);
    } finally {
      await forgotten.close();
    }

    const remembered = await reopenAfterLogin(true);
    try {
      const page = await remembered.newPage();
      await page.goto('/app');
      await expect(page.getByTestId('tenant-name')).toBeVisible();
      expect(page.url()).not.toMatch(/\/auth\/login/);
    } finally {
      await remembered.close();
    }
  });
});
