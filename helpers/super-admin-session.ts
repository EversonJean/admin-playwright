import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APIRequestContext } from '@playwright/test';

import { createApiContext, readRefreshCookie } from './api-client';
import { msUntilTimeStep, totpCode, totpTimeStep } from './totp';

/**
 * Sessão do Super Admin semeado no E2E (`superadmin@dev.local`).
 *
 * Etapa 235 (SEG-B): o back exige o TOTP do Super Admin no login (desafio MFA)
 * e no step-up, e recusa o mesmo código duas vezes no mesmo período de 30 s
 * (`MfaEnrollment.LastUsedTimeStep`). O seed nasce com o segredo abaixo.
 *
 * Duas consequências para a suíte, que roda em paralelo:
 * - **Um login por execução, não por teste.** Cada teste que logasse de novo
 *   gastaria um período inteiro (o código seguinte só vale 30 s depois). O par
 *   de tokens fica num arquivo de estado em `os.tmpdir()`, dividido pelos
 *   workers da mesma execução (mesmo processo pai) e refeito quando vence.
 * - **Nenhum período usado duas vezes.** Login e step-up reservam o código pelo
 *   mesmo arquivo, sob trava entre processos: o período escolhido é o atual ou,
 *   se ele já foi gasto, o seguinte (o back aceita +1); passando disso, espera.
 *   Se o back ainda assim recusar (período gasto por outra execução que este
 *   arquivo não viu), o próximo pedido reserva o período seguinte.
 *
 * O Super Admin não tem "dispositivo de confiança" (o back nunca o emite para
 * esse papel), então o cookie não é saída aqui.
 */

export const SUPER_ADMIN_EMAIL = 'superadmin@dev.local';
export const SUPER_ADMIN_PASSWORD = 'Dev12345!';
/** Segredo TOTP do seed E2E (o mesmo do back; em Development, cadastrar no app autenticador). */
export const SUPER_ADMIN_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

export interface SuperAdminTokens {
  accessToken: string;
  /** Valor do cookie `recreativo_refresh` do login (Etapa 232). */
  refreshToken: string;
}

interface CachedSession extends SuperAdminTokens {
  /** Processo pai dos workers: a sessão vale só para a execução que a criou. */
  runId: number;
  expiresAtMs: number;
}

interface SessionState {
  /** Último período TOTP gasto por estes helpers (login ou step-up). */
  lastTimeStep: number;
  session?: CachedSession;
}

const BACK_URL = process.env.BACK_URL ?? 'https://localhost:1501';
/** Margem antes do vencimento do access token para logar de novo. */
const SESSION_RENEW_MARGIN_MS = 5 * 60_000;
const LOCK_TIMEOUT_MS = 4 * 60_000;
const LOCK_STALE_MS = 3 * 60_000;
const MFA_VERIFY_ATTEMPTS = 4;

// Um arquivo por clone e por back: os dois clones da máquina não dividem estado.
const STATE_KEY = createHash('sha1').update(`${BACK_URL}|${__dirname}`).digest('hex').slice(0, 12);
const STATE_DIR = path.join(os.tmpdir(), 'recreativo-e2e');
const STATE_FILE = path.join(STATE_DIR, `super-admin-${STATE_KEY}.json`);
const LOCK_FILE = `${STATE_FILE}.lock`;

/**
 * Par de tokens do Super Admin, compartilhado pela execução inteira. Loga (com o
 * desafio MFA) só na primeira chamada ou quando o access token está para vencer.
 */
export async function getSuperAdminTokens(): Promise<SuperAdminTokens> {
  return withState(async (state) => {
    const cached = state.session;
    if (
      cached &&
      cached.runId === process.ppid &&
      cached.expiresAtMs - Date.now() > SESSION_RENEW_MARGIN_MS
    ) {
      return { accessToken: cached.accessToken, refreshToken: cached.refreshToken };
    }

    const api = await createApiContext();
    try {
      const tokens = await loginWithState(api, state);
      state.session = { ...tokens, runId: process.ppid, expiresAtMs: jwtExpiresAtMs(tokens.accessToken) };
      return tokens;
    } finally {
      await api.dispose();
    }
  });
}

/**
 * Login novo do Super Admin (senha + desafio MFA), fora do cache: para o spec
 * que precisa de uma sessão própria. Gasta um período TOTP.
 */
export async function loginSuperAdminViaApi(api: APIRequestContext): Promise<SuperAdminTokens> {
  return withState((state) => loginWithState(api, state));
}

/**
 * Código TOTP de um período ainda não gasto pelos helpers, para o step-up do
 * Super Admin (`apiStepUp(api, SUPER_ADMIN_PASSWORD, 'tenant.impersonate', code)`).
 * Pode esperar até o período seguinte.
 */
export async function reserveSuperAdminTotpCode(): Promise<string> {
  return withState(async (state) => reserveTotpCode(state));
}

async function loginWithState(api: APIRequestContext, state: SessionState): Promise<SuperAdminTokens> {
  const loginRes = await api.post('/api/auth/login', {
    data: { email: SUPER_ADMIN_EMAIL, password: SUPER_ADMIN_PASSWORD },
  });
  if (!loginRes.ok()) {
    throw new Error(`Login do Super Admin falhou (${loginRes.status()}): ${await loginRes.text()}`);
  }
  const login = payloadOf(await loginRes.json());

  // Sem desafio (seed antigo, sem TOTP): a sessão já veio.
  if (login.mfaRequired !== true) {
    return { accessToken: String(login.accessToken), refreshToken: readRefreshCookie(loginRes) };
  }

  let lastError = '';
  for (let attempt = 1; attempt <= MFA_VERIFY_ATTEMPTS; attempt++) {
    const code = await reserveTotpCode(state);
    const verifyRes = await api.post('/api/auth/mfa/verify', {
      data: {
        mfaSessionToken: login.mfaSessionToken,
        method: 'Totp',
        code,
        trustDevice: false,
      },
    });
    if (verifyRes.ok()) {
      const verified = payloadOf(await verifyRes.json());
      return { accessToken: String(verified.accessToken), refreshToken: readRefreshCookie(verifyRes) };
    }
    lastError = `${verifyRes.status()}: ${await verifyRes.text()}`;
    // Só código recusado (período já gasto) merece outra tentativa.
    if (verifyRes.status() !== 401) break;
  }
  throw new Error(`Desafio MFA do Super Admin falhou (${lastError})`);
}

/**
 * Reserva o período: o atual, ou o seguinte ao último gasto. O back aceita um
 * período de folga para frente; além disso espera o período anterior começar.
 */
async function reserveTotpCode(state: SessionState): Promise<string> {
  const candidate = Math.max(totpTimeStep(), state.lastTimeStep + 1);
  if (candidate > totpTimeStep() + 1) {
    // 250 ms de folga para não cair na borda do período.
    await sleep(msUntilTimeStep(candidate - 1) + 250);
  }
  state.lastTimeStep = candidate;
  return totpCode(SUPER_ADMIN_TOTP_SECRET, candidate);
}

async function withState<T>(fn: (state: SessionState) => Promise<T>): Promise<T> {
  const release = await acquireLock();
  try {
    const state = readState();
    try {
      return await fn(state);
    } finally {
      // Grava mesmo na falha: o período reservado ficou gasto no back.
      writeState(state);
    }
  } finally {
    release();
  }
}

async function acquireLock(): Promise<() => void> {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.closeSync(fd);
      return () => fs.rmSync(LOCK_FILE, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      removeStaleLock();
      if (Date.now() > deadline) {
        throw new Error(`Trava da sessão do Super Admin ocupada há mais de ${LOCK_TIMEOUT_MS / 1000}s: ${LOCK_FILE}`);
      }
      await sleep(150);
    }
  }
}

/** Trava largada por processo morto (worker derrubado no meio do login). */
function removeStaleLock(): void {
  try {
    if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS) fs.rmSync(LOCK_FILE, { force: true });
  } catch {
    // Sumiu entre o `openSync` e o `statSync`: a próxima volta pega.
  }
}

function readState(): SessionState {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<SessionState>;
    return { lastTimeStep: Number(parsed.lastTimeStep) || 0, session: parsed.session };
  } catch {
    return { lastTimeStep: 0 };
  }
}

function writeState(state: SessionState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
}

/** `exp` do JWT em ms; sem `exp` legível, 0 (a sessão não é reaproveitada). */
function jwtExpiresAtMs(accessToken: string): number {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8')) as {
      exp?: number;
    };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/** Backend envelopa em `ApiResponse`: `{ isError, data: {...}, errors }`. */
function payloadOf(body: { data?: Record<string, unknown> } & Record<string, unknown>): Record<string, unknown> {
  return body.data ?? body;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
