import { APIRequestContext, APIResponse, Browser, BrowserContext, Page, request } from '@playwright/test';
import { confirmEmailDirect } from './db-helper';
import { fakeTenant } from './test-data';

const BACK_URL = process.env.BACK_URL ?? 'https://localhost:1501';
const FRONT_URL = process.env.FRONT_URL ?? 'http://localhost:4200';

/**
 * Etapa 232 (SEG-K) — o refresh token não vem mais no JSON do login: vive só no
 * cookie HttpOnly `recreativo_refresh` (`Path=/api/auth`, `SameSite=Strict`,
 * `Secure`). O `/api/auth/refresh` lê esse cookie e exige o header `X-CSRF`.
 */
export const REFRESH_COOKIE = 'recreativo_refresh';
export const CSRF_HEADER = { 'X-CSRF': '1' } as const;

/**
 * Dica de sessão que o `TokenStorage` do front lê no boot para restaurar a
 * sessão pelo cookie (`'1'`, nunca um token). Sem ela o boot não chama o
 * `/auth/refresh` e a página sobe deslogada.
 */
const SESSION_HINT_KEY = 'auth_session';

export interface SignupResult {
  email: string;
  password: string;
  accessToken: string;
  /** Valor do cookie `recreativo_refresh` emitido no login (não vem mais no JSON). */
  refreshToken: string;
  userId: string;
  tenantId: string;
}

/** Valor do cookie de refresh no `Set-Cookie` de uma resposta de login/refresh. */
export function readRefreshCookie(res: APIResponse): string {
  const prefix = `${REFRESH_COOKIE}=`;
  const header = res
    .headersArray()
    .find((h) => h.name.toLowerCase() === 'set-cookie' && h.value.startsWith(prefix));
  const value = header?.value.slice(prefix.length).split(';')[0] ?? '';
  if (value === '') {
    throw new Error(`Resposta de ${res.url()} sem o cookie ${REFRESH_COOKIE}`);
  }
  return value;
}

/** Header `Cookie` para mandar o refresh por um `APIRequestContext` que não tem o cookie no jar. */
export function refreshCookieHeader(refreshToken: string): Record<string, string> {
  return { Cookie: `${REFRESH_COOKIE}=${refreshToken}` };
}

/**
 * Sessão num contexto de navegador: o cookie de refresh (mesmos atributos que
 * o back grava, para o `Set-Cookie` da rotação sobrescrever este e não criar um
 * segundo) e a dica de sessão antes de qualquer script da página. O boot do
 * front chama `/api/auth/refresh` e obtém o access token.
 */
export async function addSessionToContext(context: BrowserContext, refreshToken: string): Promise<void> {
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
  await context.addInitScript((key) => localStorage.setItem(key, '1'), SESSION_HINT_KEY);
}

/**
 * Cria APIRequestContext novo pra chamadas diretas no back (ignora HTTPS cert).
 */
export async function createApiContext(): Promise<APIRequestContext> {
  return await request.newContext({
    baseURL: BACK_URL,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { 'Content-Type': 'application/json' },
  });
}

/**
 * Cria um tenant novo via signup público, confirma o email direto no DB
 * (bypass do fluxo de verificação) e devolve tokens prontos pra usar.
 *
 * Espelha: `docs/fluxos/negocio-1.1-criar-conta-empresa.mmd`
 */
export async function signupAndConfirm(
  api: APIRequestContext,
  input: {
    companyName: string;
    adminName: string;
    adminEmail: string;
    adminPassword: string;
  },
): Promise<SignupResult> {
  const signupRes = await api.post('/api/auth/signup', {
    data: {
      companyName: input.companyName,
      userName: input.adminName,
      email: input.adminEmail,
      password: input.adminPassword,
    },
  });

  if (!signupRes.ok()) {
    const body = await signupRes.text();
    throw new Error(`Signup falhou (${signupRes.status()}): ${body}`);
  }

  confirmEmailDirect(input.adminEmail);

  const loginRes = await api.post('/api/auth/login', {
    data: { email: input.adminEmail, password: input.adminPassword },
  });

  if (!loginRes.ok()) {
    const body = await loginRes.text();
    throw new Error(`Login pós-confirmação falhou (${loginRes.status()}): ${body}`);
  }

  const loginBody = await loginRes.json();
  // Backend envelopa em Result: { isError, data: {...}, errors }
  const payload = loginBody.data ?? loginBody;

  return {
    email: input.adminEmail,
    password: input.adminPassword,
    accessToken: payload.accessToken ?? payload.token,
    refreshToken: readRefreshCookie(loginRes),
    userId: payload.userId ?? payload.user?.id,
    tenantId: payload.tenantId ?? payload.user?.tenantId,
  };
}

/**
 * Login simples — usado quando o tenant já existe (storageState reuse).
 */
export async function loginViaApi(
  api: APIRequestContext,
  email: string,
  password: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await api.post('/api/auth/login', { data: { email, password } });
  if (!res.ok()) {
    throw new Error(`Login falhou (${res.status()}): ${await res.text()}`);
  }
  const body = await res.json();
  // Backend envelopa em Result: { isError, data: {...}, errors }
  const payload = body.data ?? body;
  return {
    accessToken: payload.accessToken ?? payload.token,
    refreshToken: readRefreshCookie(res),
  };
}

/**
 * POST /api/auth/step-up — confirmação de senha antes de ação sensível
 * (Etapa 86). Devolve o token que vai no header `X-Step-Up-Token` da ação.
 * Usuário sem MFA (o admin do signup, os seedados) confirma só com a senha.
 *
 * Etapa 235 (SEG-B): `action` é obrigatória e o token só vale para ela (a
 * string do `[RequiresStepUp]` do endpoint: `external_calendar.connect`,
 * `tenant.impersonate`, ...). O Super Admin manda também o TOTP, reservado por
 * `reserveSuperAdminTotpCode()` (`helpers/super-admin-session.ts`) para não
 * repetir o período do login.
 */
export async function apiStepUp(
  api: APIRequestContext,
  password: string,
  action: string,
  mfaCode: string | null = null,
): Promise<string> {
  const res = await api.post('/api/auth/step-up', {
    data: { password, action, mfaCode, backupCode: null },
  });
  if (!res.ok()) {
    throw new Error(`Step-up falhou (${res.status()}): ${await res.text()}`);
  }
  const body = await res.json();
  const payload = body.data ?? body;
  return payload.stepUpToken as string;
}

/**
 * APIRequestContext com o Bearer de OUTRO usuário (role seedado por
 * `seedUserWithRoleDirect`, ou o admin de outro tenant). Quem chama dá `dispose`.
 */
export async function createBearerApiContext(accessToken: string): Promise<APIRequestContext> {
  return await request.newContext({
    baseURL: BACK_URL,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
  });
}

/**
 * APIRequestContext com o Bearer e SEM `Content-Type` fixo, para upload
 * `multipart`: o Playwright não sobrescreve um `Content-Type` que já vem dos
 * `extraHTTPHeaders`, e o `application/json` dos outros contextos chegaria ao
 * back no lugar do `multipart/form-data; boundary=…`. Quem chama dá `dispose`.
 */
export async function createBearerMultipartContext(accessToken: string): Promise<APIRequestContext> {
  return await request.newContext({
    baseURL: BACK_URL,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { Authorization: `Bearer ${accessToken}` },
  });
}

/**
 * Página autenticada como outro usuário, do mesmo jeito do `authPage` da
 * fixture (cookie de refresh + dica de sessão antes do boot). Quem chama fecha
 * o contexto (`page.context().close()`).
 */
export async function openPageWithTokens(
  browser: Browser,
  tokens: { refreshToken: string },
): Promise<Page> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  await addSessionToContext(context, tokens.refreshToken);
  return context.newPage();
}

/**
 * Tenant novo (signup + confirmação) fora da fixture: o "outro tenant" de um
 * teste que já usa `authTest` e precisa provar isolamento.
 */
export async function signupNewTenant(): Promise<SignupResult> {
  const fake = fakeTenant();
  const api = await createApiContext();
  try {
    return await signupAndConfirm(api, {
      companyName: fake.companyName,
      adminName: fake.adminName,
      adminEmail: fake.adminEmail,
      adminPassword: fake.adminPassword,
    });
  } finally {
    await api.dispose();
  }
}

/**
 * Health check do back — usado em smoke test.
 */
export async function isBackendHealthy(): Promise<boolean> {
  const api = await createApiContext();
  try {
    const res = await api.get('/health');
    return res.ok();
  } finally {
    await api.dispose();
  }
}
