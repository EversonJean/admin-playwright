import type { FastifyRequest } from 'fastify';

/**
 * Extrai o TenantId que o back deve propagar via header `X-Tenant-Id` em
 * cada chamada externa em E2E. O back não faz isso em produção (provider
 * externo não precisa saber de tenant), mas em E2E é a única forma de
 * isolarmos inbox por tenant nos specs paralelos. Convencionado em
 * `appsettings.E2E.json` via `*:E2E:PropagateTenantHeader=true`.
 */
export function tenantFromRequest(req: FastifyRequest): string | null {
  const raw = req.headers['x-tenant-id'];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw ?? null;
}
