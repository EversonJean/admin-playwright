import type { APIResponse } from '@playwright/test';

/**
 * Le o body de uma APIResponse UMA VEZ e desempacota o envelope Result do
 * back (`{ isError, data, errors }`) automaticamente. Substitui o anti-
 * padrao `(await res.json()).data ?? (await res.json())` que tentava ler
 * o stream duas vezes (funciona por sorte em Playwright pq response.json()
 * eh cacheado, mas eh confuso).
 *
 * Exemplo:
 *   const lead = await readJson<{ id: string; status: string }>(res);
 */
export async function readJson<T = unknown>(res: APIResponse): Promise<T> {
  const body = (await res.json()) as { data?: T } | T;
  return ((body as { data?: T }).data ?? body) as T;
}

/**
 * Falha um teste com mensagem rica (status + body) quando uma response
 * nao eh 2xx. Substitui o mix `throw new Error(\`POST X ${status}: ${text}\`)`
 * + `expect(res.ok()).toBe(true)` por uma chamada unica e padronizada.
 *
 * Uso tipico:
 *   const res = await api.post('/api/foo', { data: {...} });
 *   await assertOk(res, 'POST /api/foo');
 *   const data = await readJson(res);
 */
export async function assertOk(res: APIResponse, op: string): Promise<void> {
  if (!res.ok()) {
    const body = await res.text().catch(() => '');
    throw new Error(`${op} falhou (${res.status()}): ${body.slice(0, 500)}`);
  }
}

/**
 * Desempacota uma resposta de lista paginada. Fixa o contrato em
 * `body.data.items[]` (padrao do back AdminBackend). Aceita variantes
 * estaveis (`body.items`, `body.data` array direto), mas FALHA explicito
 * em shapes inesperados em vez de cair em `[]` silenciosamente — assim
 * uma regressao de contrato eh detectada no spec, nao mascarada.
 *
 * Casos cobertos (padrao -> compat):
 *   { data: { items: T[], total, page, pageSize } }   // PagedListDto<T>
 *   { items: T[] }                                     // sem envelope
 *   { data: T[] }                                      // lista nao paginada
 *   T[]                                                // resposta crua
 *
 * Casos REJEITADOS (lanca Error explicito):
 *   { data: { ... shape totalmente diferente } }
 *   { items: { items: T[] } }  // double-wrap nao planejado
 */
export async function unwrapList<T = unknown>(res: APIResponse): Promise<T[]> {
  const raw = (await res.json()) as unknown;
  const items = extractItems<T>(raw);
  if (items === null) {
    const preview = JSON.stringify(raw).slice(0, 200);
    throw new Error(
      `unwrapList: shape inesperado, esperado data.items[] ou items[]; recebido: ${preview}`,
    );
  }
  return items;
}

function extractItems<T>(raw: unknown): T[] | null {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    // Envelope Result: { data: ... }
    if ('data' in obj) {
      const data = obj.data;
      if (Array.isArray(data)) return data as T[];
      if (data && typeof data === 'object') {
        const d = data as Record<string, unknown>;
        if (Array.isArray(d.items)) return d.items as T[];
      }
    }
    // Sem envelope: { items: T[] }
    if (Array.isArray(obj.items)) return obj.items as T[];
  }
  return null;
}
