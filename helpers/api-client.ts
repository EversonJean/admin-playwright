import { APIRequestContext, request } from '@playwright/test';
import { confirmEmailDirect } from './db-helper';

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
  return {
    accessToken: body.accessToken ?? body.token,
    refreshToken: body.refreshToken,
  };
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
