import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, KeyObject, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * id_token RS256 do fake, no formato do Google (`iss` accounts.google.com,
 * `aud` = client_id, `sub`, `email`, `email_verified`).
 *
 * O back confere a assinatura de verdade (`GoogleIdTokenValidator`): no E2E o
 * `Google:CertificatesUrl` aponta para `GET /oauth2/v3/certs` deste fake, que
 * publica a chave pública aqui gerada. Nada de token sem assinatura.
 *
 * [DECISAO] A chave é gerada na primeira subida e guardada no diretório
 * temporário, e não a cada processo: o Google.Apis.Auth guarda as chaves em
 * cache no back, e com `reuseExistingServer` o back pode seguir vivo enquanto o
 * fake reinicia. Chave nova a cada subida reprovaria todo id_token até o cache
 * do back expirar. Chave de TESTE, sem valor fora do E2E; não vai para o git.
 */

const KEY_FILE = process.env.FAKE_GOOGLE_CALENDAR_KEY_FILE ?? join(tmpdir(), 'fake-google-calendar-e2e-key.pem');

function loadOrCreateKey(): KeyObject {
  if (existsSync(KEY_FILE)) {
    return createPrivateKey(readFileSync(KEY_FILE, 'utf8'));
  }
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return privateKey;
}

const privateKey = loadOrCreateKey();
const publicJwk = createPublicKey(privateKey).export({ format: 'jwk' }) as { kty: string; n: string; e: string };

/** `kid` derivado da chave: chave nova, `kid` novo — o cache do back não confunde as duas. */
export const KEY_ID = `fake-${createHash('sha256').update(publicJwk.n).digest('hex').slice(0, 16)}`;

export const GOOGLE_ISSUER = 'https://accounts.google.com';

export function jwks(): { keys: Array<Record<string, string>> } {
  return { keys: [{ kty: publicJwk.kty, n: publicJwk.n, e: publicJwk.e, kid: KEY_ID, alg: 'RS256', use: 'sig' }] };
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function signIdToken(input: { sub: string; email: string; audience: string; clientId: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', kid: KEY_ID, typ: 'JWT' };
  const payload = {
    iss: GOOGLE_ISSUER,
    azp: input.clientId,
    aud: input.audience,
    sub: input.sub,
    email: input.email,
    email_verified: true,
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const signature = sign('sha256', Buffer.from(signingInput), privateKey).toString('base64url');
  return `${signingInput}.${signature}`;
}
