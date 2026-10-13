import { createHmac } from 'node:crypto';

/**
 * TOTP (RFC 6238) sem dependência de npm: SHA-1, períodos de 30 s, 6 dígitos —
 * o mesmo do `TotpService` do back e de Google Authenticator/Authy.
 *
 * Etapa 235 (SEG-B): o Super Admin semeado no E2E nasce com TOTP de segredo
 * conhecido e o back exige o código no login e no step-up; os specs calculam o
 * código daqui (`helpers/super-admin-session.ts`).
 */

export const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Período TOTP (`floor(unix / 30)`) de um instante; default, agora. */
export function totpTimeStep(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** Milissegundos até o início do período `timeStep`; 0 se ele já começou. */
export function msUntilTimeStep(timeStep: number, nowMs: number = Date.now()): number {
  return Math.max(0, timeStep * TOTP_PERIOD_SECONDS * 1000 - nowMs);
}

/** Código de 6 dígitos do período `timeStep` para o segredo base32 (RFC 4648, sem padding). */
export function totpCode(secretBase32: string, timeStep: number): string {
  const key = base32Decode(secretBase32);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(timeStep));

  const hmac = createHmac('sha1', key).update(counter).digest();
  // Truncamento dinâmico (RFC 4226 §5.3).
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return binary.toString().padStart(TOTP_DIGITS, '0');
}

function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) throw new Error(`Segredo TOTP com caractere fora do base32: "${char}"`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
