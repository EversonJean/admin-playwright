import { createCipheriv, hkdfSync, randomBytes } from 'crypto';

/**
 * Cifra um segredo no formato que o `AesEncryptionService` do back lê
 * (Etapa 234): `v2:k1:base64(nonce[12] | cipher | tag[16])`, AES-256-GCM com a
 * chave de dados derivada por HKDF-SHA256 (salt vazio, info
 * `recreativo:data-protection:v2:k1`) da `AesEncryption:KeyBase64` do
 * `appsettings.E2E.json`, e o AAD da linha `{Entidade}|{TenantId}|{Id}`
 * (`EncryptionContext`).
 *
 * Existe para semear direto no banco o que só o back sabe gravar cifrado: o
 * token do canal WhatsApp do tenant (Etapa 242 — o envio sai pelo canal do
 * tenant e o back decifra o token com o AAD da linha). Semear é mais barato que o
 * `connect` (troca do `code` com `WhatsApp:AppId`, que só o back subido pelo
 * `playwright.config.ts` recebe, e submissão de todo o catálogo à WABA); o E143
 * do `17.11` é quem exercita o `connect` de verdade.
 *
 * [ALERTA] Chave trocada no `appsettings.E2E.json`, ou nome da entidade
 * renomeado no back, e o token deixa de decifrar: o envio recusa com
 * `WhatsAppOutbound.ChannelNotConfigured`. A chave vem de `E2E_AES_KEY_BASE64`
 * quando o ambiente a define.
 */
const AES_KEY_BASE64 =
  process.env.E2E_AES_KEY_BASE64 ?? 'dGVzdC1vbmx5LWtleS1mb3ItZGV2LTMyLWJ5dGVzISE=';
const DATA_KEY_INFO = 'recreativo:data-protection:v2:k1';
const KEY_ID = 'k1';

function dataKey(): Buffer {
  const master = Buffer.from(AES_KEY_BASE64, 'base64');
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), DATA_KEY_INFO, 32));
}

/** AAD de `EncryptionContext.For<TEntity>(tenantId, id)` no back. */
export function rowAssociatedData(entity: string, tenantId: string, id: string): string {
  return `${entity}|${tenantId.toLowerCase()}|${id.toLowerCase()}`;
}

export function encryptForBackend(plaintext: string, associatedData: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', dataKey(), nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v2:${KEY_ID}:${Buffer.concat([nonce, encrypted, tag]).toString('base64')}`;
}
