import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Storage de documentos do back no E2E (`DocumentStorage:LocalRootPath` do
 * `appsettings.E2E.json`, relativo à pasta do projeto Api): `<root>/<bucket>/<key>`.
 * É onde o `ConversationMediaDownloadWorker` grava a mídia recebida arquivada.
 */
const STORAGE_ROOT = path.resolve(__dirname, '../../admin-backend/.local-storage/documents');

/** Arquivo da key no storage local, em qualquer bucket, ou null. */
export function storedDocumentFile(key: string): string | null {
  if (!existsSync(STORAGE_ROOT)) return null;
  for (const bucket of readdirSync(STORAGE_ROOT)) {
    const candidate = path.join(STORAGE_ROOT, bucket, ...key.split('/'));
    if (existsSync(candidate)) return candidate;
  }
  return null;
}
