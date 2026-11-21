import { APIRequestContext } from '@playwright/test';
import { assertOk, readJson } from './response';

/**
 * Termo de entrega aceito pelo cliente (Etapa 330,
 * `docs/implementar/PLANO-CICLO-COMPLETO-DOS-BRINQUEDOS.md` §9, CB-G):
 * modelo do termo da empresa, emissão na locação e aceite pelo link público.
 * Usado pela massa da FC-24 (`seeds/flows/full-flows.ts`) e pelo spec que o
 * `/e2e-plano` escrever.
 */

/** `RentalHandoverTermDto` — o termo emitido (o token só no `Pending` vigente). */
export interface RentalHandoverTerm {
  id: string;
  status: 'Pending' | 'Accepted' | 'Superseded' | 'Expired';
  text: string;
  textSha256: string;
  publicToken: string | null;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedByName: string | null;
}

/** `PublicRentalTermDto` — o que a página pública do termo lê. */
export interface PublicRentalTerm {
  companyName: string;
  rentalNumber: string;
  text: string;
  textSha256: string;
  status: 'Pending' | 'Accepted';
  acceptedAt: string | null;
  acceptedByFirstName: string | null;
}

/** PUT /api/rental-term-template — grava o modelo do termo da empresa (variáveis do catálogo). */
export async function apiPutRentalTermTemplate(
  api: APIRequestContext,
  template: { title: string; body: string },
): Promise<void> {
  await assertOk(await api.put('/api/rental-term-template', { data: template }), 'PUT /api/rental-term-template');
}

/** POST /api/rentals/{id}/handover-term — emite o termo (locação de `Confirmed` a `InUse`). */
export async function apiIssueRentalHandoverTerm(api: APIRequestContext, rentalId: string): Promise<RentalHandoverTerm> {
  const res = await api.post(`/api/rentals/${rentalId}/handover-term`, { data: {} });
  await assertOk(res, 'POST /api/rentals/{id}/handover-term');
  return readJson<RentalHandoverTerm>(res);
}

/** Endereço da página pública do termo, como a aba "Termo de entrega" monta. */
export function rentalTermPublicUrl(frontUrl: string, publicToken: string): string {
  return `${frontUrl}/rental-terms/${encodeURIComponent(publicToken)}`;
}

/**
 * POST /api/public/rental-terms/{token}/accept — o aceite pelo link, num
 * contexto SEM sessão (`createPublicApiContext`): o tenant vem do token.
 */
export async function apiAcceptRentalTermByLink(
  publicApi: APIRequestContext,
  publicToken: string,
  input: { name: string; document?: string | null; textSha256: string },
): Promise<PublicRentalTerm> {
  const res = await publicApi.post(`/api/public/rental-terms/${encodeURIComponent(publicToken)}/accept`, {
    data: { name: input.name, document: input.document ?? null, agree: true, textSha256: input.textSha256 },
  });
  await assertOk(res, 'POST /api/public/rental-terms/{token}/accept');
  return readJson<PublicRentalTerm>(res);
}
