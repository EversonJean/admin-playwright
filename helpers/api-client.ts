import { APIRequestContext, Browser, Page, request } from '@playwright/test';
import { confirmEmailDirect } from './db-helper';
import { fakeTenant } from './test-data';

const BACK_URL = process.env.BACK_URL ?? 'https://localhost:1501';

export interface SignupResult {
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  userId: string;
  tenantId: string;
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
    refreshToken: payload.refreshToken,
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
    refreshToken: payload.refreshToken,
  };
}

/**
 * POST /api/auth/step-up — confirmação de senha antes de ação sensível
 * (Etapa 86). Devolve o token que vai no header `X-Step-Up-Token` da ação.
 * Usuário sem MFA (o admin do signup, os seedados) confirma só com a senha.
 */
export async function apiStepUp(api: APIRequestContext, password: string): Promise<string> {
  const res = await api.post('/api/auth/step-up', { data: { password, mfaCode: null, backupCode: null } });
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
 * Página autenticada como outro usuário, do mesmo jeito do `authPage` da
 * fixture (tokens no localStorage antes do boot). Quem chama fecha o contexto
 * (`page.context().close()`).
 */
export async function openPageWithTokens(
  browser: Browser,
  tokens: { accessToken: string; refreshToken?: string | null },
): Promise<Page> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  await context.addInitScript(
    ({ access, refresh }) => {
      localStorage.setItem('access_token', access);
      if (refresh) localStorage.setItem('refresh_token', refresh);
    },
    { access: tokens.accessToken, refresh: tokens.refreshToken ?? null },
  );
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
