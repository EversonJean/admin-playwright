function uniqueSuffix(): string {
  return Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

export interface FakeMetaTemplate {
  id: string;
  name: string;
  status: 'APPROVED' | 'PENDING' | 'REJECTED' | 'PAUSED';
  rejectedReason?: string;
}

/**
 * Template submetido a uma WABA de tenant (Etapa 242): o back o procura por nome
 * (`GET /:wabaId/message_templates?name=`) e, se não achar, o cria
 * (`POST /:wabaId/message_templates`). Fica por WABA, como na Meta.
 */
export interface FakeWabaTemplate {
  id: string;
  name: string;
  language: string;
  category: string;
  status: 'APPROVED' | 'PENDING' | 'REJECTED' | 'PAUSED';
  rejectedReason?: string;
  /** Handle do exemplo do cabeçalho de documento, quando a submissão mandou. */
  headerHandle?: string;
}

const templates = new Map<string, FakeMetaTemplate>();

/**
 * Numeros de cada WABA, lidos por `GET /:wabaId/phone_numbers` (Etapa 239: o
 * connect do Embedded Signup confere que o `phoneNumberId` e da WABA). WABA nao
 * cadastrada lista vazio, e o connect recebe 400 `PhoneNumberNotInWaba`.
 */
const wabaPhoneNumbers = new Map<string, string[]>();

/** Templates por WABA (Etapa 242). */
const wabaTemplates = new Map<string, FakeWabaTemplate[]>();

/** Sessões de upload resumable abertas (`upload:<id>`), com o tamanho declarado. */
const uploadSessions = new Map<string, { fileName: string; fileLength: number; fileType: string }>();

/**
 * Mídia RECEBIDA que o back baixa (Etapa 106; e2e da Etapa 241): o spec cadastra
 * o binário por `POST /_control/media`, manda o webhook com o `id` e o back faz
 * `GET /:mediaId` (url assinada) e `GET` da url (bytes), com o token do canal.
 */
export interface FakeInboundMedia {
  id: string;
  mimeType: string;
  bytes: Buffer;
}

const inboundMedia = new Map<string, FakeInboundMedia>();

export function reset(): void {
  templates.clear();
  wabaPhoneNumbers.clear();
  wabaTemplates.clear();
  uploadSessions.clear();
  inboundMedia.clear();
}

export function putInboundMedia(media: FakeInboundMedia): FakeInboundMedia {
  inboundMedia.set(media.id, media);
  return media;
}

export function getInboundMedia(id: string): FakeInboundMedia | undefined {
  return inboundMedia.get(id);
}

export function setWabaPhoneNumbers(wabaId: string, phoneNumberIds: string[]): string[] {
  const ids = [...new Set(phoneNumberIds)];
  wabaPhoneNumbers.set(wabaId, ids);
  return ids;
}

export function getWabaPhoneNumbers(wabaId: string): string[] {
  return wabaPhoneNumbers.get(wabaId) ?? [];
}

export function upsertTemplate(input: {
  id?: string;
  name: string;
  status?: FakeMetaTemplate['status'];
  rejectedReason?: string;
}): FakeMetaTemplate {
  const id = input.id ?? `meta_tmpl_${uniqueSuffix()}`;
  const tpl: FakeMetaTemplate = {
    id,
    name: input.name,
    status: input.status ?? 'APPROVED',
    rejectedReason: input.rejectedReason,
  };
  templates.set(id, tpl);
  return tpl;
}

export function getTemplate(id: string): FakeMetaTemplate | undefined {
  return templates.get(id);
}

/** O filtro `name` da Graph casa por prefixo; o back confere nome e idioma exatos. */
export function findWabaTemplates(wabaId: string, namePrefix?: string): FakeWabaTemplate[] {
  const all = wabaTemplates.get(wabaId) ?? [];
  return namePrefix ? all.filter((t) => t.name.startsWith(namePrefix)) : all.slice();
}

export function addWabaTemplate(
  wabaId: string,
  input: Omit<FakeWabaTemplate, 'id' | 'status'> & {
    id?: string;
    status?: FakeWabaTemplate['status'];
  },
): FakeWabaTemplate {
  const tpl: FakeWabaTemplate = {
    ...input,
    id: input.id ?? `waba_tmpl_${uniqueSuffix()}`,
    status: input.status ?? 'APPROVED',
  };
  const list = wabaTemplates.get(wabaId) ?? [];
  // Mesmo nome e idioma na mesma WABA: a Meta recusaria o POST; aqui o
  // pré-cadastro do spec substitui o anterior.
  const kept = list.filter((t) => !(t.name === tpl.name && t.language === tpl.language));
  kept.push(tpl);
  wabaTemplates.set(wabaId, kept);
  return tpl;
}

export function openUploadSession(fileName: string, fileLength: number, fileType: string): string {
  const id = `upload:${uniqueSuffix()}`;
  uploadSessions.set(id, { fileName, fileLength, fileType });
  return id;
}

export function hasUploadSession(id: string): boolean {
  return uploadSessions.has(id);
}
