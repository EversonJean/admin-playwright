import type { APIRequestContext, APIResponse } from '@playwright/test';
import { apiCreateCollaborator, apiCreateProduct } from './api-entities';
import { enableFeatureFlagDirect, execSql } from './db-helper';
import { uniqueSuffix } from './rain-plan';
import { assertOk, readJson, unwrapList } from './response';
import { RoleSession, loginPortalCollaborator } from './setup-flows';

/**
 * Estoque de casa do recreador (PLANO-ESTOQUE-DO-RECREADOR, ER-A e ER-B,
 * Etapas 331 e 332): o local `CollaboratorHome` com saldo, a correção pedida
 * pelo Portal, a contagem completa e a revisão do gestor.
 *
 * O local nasce pelo CRUD de locais (tipo `CollaboratorHome` com responsável)
 * e o saldo por compra direto nele, em vez da guarda aprovada na conferência
 * pós-festa (Etapa 166): o que a correção e a contagem leem é o local de casa
 * ativo do colaborador e o saldo dele, venha de onde vier.
 */

export type StockCountKind = 'Correction' | 'FullCount';
export type StockCountOrigin = 'Collaborator' | 'Manager' | 'Schedule';
export type StockCountStatus = 'Open' | 'Submitted' | 'Reviewed' | 'Canceled';
export type StockCountLineDecision = 'Pending' | 'Approved' | 'Rejected' | 'NoChange';
export type StockCountLineReason =
  | 'Broken'
  | 'Lost'
  | 'UsedUp'
  | 'Found'
  | 'ReceivedOutsideSystem'
  | 'Miscounted'
  | 'Other';

/** `StockCountLineDto` (gestor). */
export interface StockCountLine {
  id: string;
  productId: string;
  productName: string;
  systemQuantityAtSubmit: number;
  countedQuantity: number | null;
  difference: number;
  currentBalance: number;
  reason: StockCountLineReason | null;
  decision: StockCountLineDecision;
  decisionNote: string | null;
  appliedQuantity: number | null;
  stockMovementId: string | null;
}

/** `StockCountDto` (gestor). */
export interface StockCount {
  id: string;
  number: number;
  kind: StockCountKind;
  origin: StockCountOrigin;
  status: StockCountStatus;
  locationId: string;
  collaboratorId: string;
  dueOn: string | null;
  reviewedAt: string | null;
  reviewedByUserId: string | null;
  rowVersion: number;
  lines: StockCountLine[];
}

/** `StockCountListItemDto` (fila do gestor). */
export interface StockCountListItem {
  id: string;
  number: number;
  kind: StockCountKind;
  origin: StockCountOrigin;
  status: StockCountStatus;
  locationId: string;
}

/** `MyStockCountLineDto` (Portal). */
export interface MyStockCountLine {
  id: string;
  productId: string;
  productName: string;
  countedQuantity: number | null;
  difference: number;
  decision: StockCountLineDecision;
  currentSystemQuantity: number | null;
}

/** `MyStockCountDto` (Portal). */
export interface MyStockCount {
  id: string;
  number: number;
  kind: StockCountKind;
  status: StockCountStatus;
  dueOn: string | null;
  lines: MyStockCountLine[];
}

/** `MyStockDto` (Portal, "Meu estoque"). */
export interface MyStock {
  locationId: string | null;
  locationName: string | null;
  items: Array<{ productId: string; productName: string; quantity: number }>;
  activeCount: { id: string; number: number; kind: StockCountKind; status: StockCountStatus } | null;
  canCorrect: boolean;
}

/** `StockLocationListItemDto` com os campos da Etapa 332. */
export interface StockLocationListItem {
  id: string;
  name: string;
  type: string;
  collaboratorId: string | null;
  lastReviewedCountAt: string | null;
  activeCountId: string | null;
  activeCountStatus: StockCountStatus | null;
  activeCountDueOn: string | null;
  collaboratorHasPortal: boolean;
}

export interface HomeProduct {
  id: string;
  name: string;
  quantity: number;
}

export interface HomeStock {
  collaboratorId: string;
  firstName: string;
  locationId: string;
  products: HomeProduct[];
  /** Usuário do Portal do colaborador; ausente com `withPortal: false`. O chamador faz `api.dispose()`. */
  portal?: RoleSession;
}

/**
 * Colaborador com o local de casa ativo e saldo dos produtos pedidos. Liga
 * `feature_stock` (idempotente para o teste: o signup já traz o estoque, e o
 * INSERT a mais não muda nada). `withPortal` (padrão) cria o usuário do Portal.
 */
export async function setupHomeStock(
  api: APIRequestContext,
  tenantId: string,
  opts: {
    firstName?: string;
    phone?: string;
    withPortal?: boolean;
    products?: Array<{ name?: string; quantity: number; isReusable?: boolean; unitCost?: number }>;
  } = {},
): Promise<HomeStock> {
  enableFeatureFlagDirect(tenantId, 'feature_stock');
  const suffix = uniqueSuffix();
  const firstName = opts.firstName ?? 'Ana';
  const collaborator = await apiCreateCollaborator(api, {
    name: `${firstName} E2E ${suffix}`,
    ...(opts.phone ? { phone: opts.phone } : {}),
  });

  const locationRes = await api.post('/api/stock/locations', {
    data: {
      name: `Casa de ${firstName} ${suffix}`,
      type: 'CollaboratorHome',
      collaboratorId: collaborator.id,
      address: null,
      notes: null,
    },
  });
  await assertOk(locationRes, 'POST /api/stock/locations (casa)');
  const location = await readJson<{ id: string }>(locationRes);

  const specs = opts.products ?? [{ quantity: 5, isReusable: true, unitCost: 20 }];
  const products: HomeProduct[] = [];
  for (const spec of specs) {
    const unitCost = spec.unitCost ?? 10;
    const product = await apiCreateProduct(api, {
      name: spec.name ?? `Bola E2E ${uniqueSuffix()}`,
      isReusable: spec.isReusable ?? true,
      unitCost,
    });
    await assertOk(
      await api.post('/api/stock/movements', {
        data: {
          productId: product.id,
          type: 'Purchase',
          quantity: spec.quantity,
          unitCost,
          supplierName: 'Fornecedor E2E',
          locationId: location.id,
        },
      }),
      'POST /api/stock/movements (compra para a casa)',
    );
    products.push({ id: product.id, name: product.name, quantity: spec.quantity });
  }

  const portal = opts.withPortal === false ? undefined : await loginPortalCollaborator(tenantId, collaborator.id);
  return { collaboratorId: collaborator.id, firstName, locationId: location.id, products, portal };
}

/**
 * Recua a criação do local em `days` dias: sem contagem completa revisada, a
 * referência do agendamento é a criação do local (§4.1 regra 2), e o local
 * recém-criado nunca está "vencido".
 */
export function backdateStockLocationCreatedAtDirect(locationId: string, days: number): void {
  const safe = locationId.replace(/'/g, "''");
  execSql(`
    UPDATE "StockLocations"
       SET "CreatedAt" = "CreatedAt" - interval '${Math.trunc(days)} days'
     WHERE "Id" = '${safe}';
  `);
}

/**
 * O motivo gravado no movimento do razão. A lista de movimentações não traz o
 * motivo e não há detalhe por id na API: a asserção "Contagem #N — quebrou"
 * (§3.1 regra 6) só se faz no banco.
 */
export function stockMovementReasonDirect(movementId: string): string {
  const safe = movementId.replace(/'/g, "''");
  return execSql(`SELECT "Reason" FROM "StockMovements" WHERE "Id" = '${safe}';`);
}

/** GET /api/portal/my-stock. */
export async function apiGetMyStock(portalApi: APIRequestContext): Promise<MyStock> {
  const res = await portalApi.get('/api/portal/my-stock');
  await assertOk(res, 'GET /api/portal/my-stock');
  return readJson<MyStock>(res);
}

/** GET /api/stock/counts/{id} (gestor). */
export async function apiGetStockCount(api: APIRequestContext, countId: string): Promise<StockCount> {
  const res = await api.get(`/api/stock/counts/${countId}`);
  await assertOk(res, 'GET /api/stock/counts/{id}');
  return readJson<StockCount>(res);
}

/** GET /api/stock/counts (fila do gestor), com os filtros dados. */
export async function apiListStockCounts(
  api: APIRequestContext,
  filter: { status?: StockCountStatus; locationId?: string; kind?: StockCountKind } = {},
): Promise<StockCountListItem[]> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filter)) if (v) params.set(k, v);
  const res = await api.get(`/api/stock/counts?${params.toString()}`);
  await assertOk(res, 'GET /api/stock/counts');
  return unwrapList<StockCountListItem>(res);
}

/** POST /api/stock/counts/{id}/review — cru, para o teste afirmar o status. */
export function reviewStockCount(
  api: APIRequestContext,
  countId: string,
  rowVersion: number,
  lines: Array<{ lineId: string; decision: 'Approved' | 'Rejected'; note?: string | null }>,
): Promise<APIResponse> {
  return api.post(`/api/stock/counts/${countId}/review`, {
    data: { rowVersion, lines: lines.map((l) => ({ ...l, note: l.note ?? null })) },
  });
}

/** Lê a contagem e aprova todas as linhas pendentes (gestor). */
export async function apiApproveAllPending(api: APIRequestContext, countId: string): Promise<StockCount> {
  const count = await apiGetStockCount(api, countId);
  const pending = count.lines.filter((l) => l.decision === 'Pending');
  await assertOk(
    await reviewStockCount(
      api,
      countId,
      count.rowVersion,
      pending.map((l) => ({ lineId: l.id, decision: 'Approved' as const })),
    ),
    'POST /api/stock/counts/{id}/review',
  );
  return apiGetStockCount(api, countId);
}

/** POST /api/stock/locations/{id}/counts ("Pedir contagem") — cru. */
export function requestStockCount(
  api: APIRequestContext,
  locationId: string,
  body: { dueInDays?: number | null; note?: string | null } = {},
): Promise<APIResponse> {
  return api.post(`/api/stock/locations/${locationId}/counts`, {
    data: { dueInDays: body.dueInDays ?? null, note: body.note ?? null },
  });
}

/** POST /api/portal/my-stock/corrections — cru. */
export function createStockCorrection(
  portalApi: APIRequestContext,
  lines: Array<{ productId: string; countedQuantity: number; reason: StockCountLineReason | null; note?: string | null }>,
): Promise<APIResponse> {
  return portalApi.post('/api/portal/my-stock/corrections', {
    data: { lines: lines.map((l) => ({ ...l, note: l.note ?? null })) },
  });
}

/** PUT /api/portal/my-stock/counts/{id}/lines — cru. */
export function saveStockCountLines(
  portalApi: APIRequestContext,
  countId: string,
  lines: Array<{ productId: string; countedQuantity: number | null; reason?: StockCountLineReason | null; note?: string | null }>,
): Promise<APIResponse> {
  return portalApi.put(`/api/portal/my-stock/counts/${countId}/lines`, {
    data: { lines: lines.map((l) => ({ ...l, reason: l.reason ?? null, note: l.note ?? null })) },
  });
}

/** POST /api/portal/my-stock/counts/{id}/submit — cru. */
export function submitStockCount(portalApi: APIRequestContext, countId: string): Promise<APIResponse> {
  return portalApi.post(`/api/portal/my-stock/counts/${countId}/submit`, { data: {} });
}

/** GET /api/stock/locations — a linha de um local. */
export async function apiGetStockLocationItem(api: APIRequestContext, locationId: string): Promise<StockLocationListItem> {
  const res = await api.get('/api/stock/locations');
  await assertOk(res, 'GET /api/stock/locations');
  const item = (await unwrapList<StockLocationListItem>(res)).find((l) => l.id === locationId);
  if (!item) throw new Error(`o local ${locationId} não está em GET /api/stock/locations`);
  return item;
}
