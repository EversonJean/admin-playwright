import { APIRequestContext, APIResponse, Page, expect } from '@playwright/test';
import { apiCreateActivity, apiCreateCollaborator, apiCreateProduct } from './api-entities';
import {
  apiAssignCollaborator,
  apiCompleteEvent,
  apiConfirmCollaborator,
  apiStartEvent,
} from './api-event-flow';
import { tenantDayPlus, uniqueSuffix } from './rain-plan';
import { assertOk, readJson, unwrapList } from './response';
import { setupAcceptedEvent } from './setup-flows';

/**
 * Margem de crianças a mais no material da festa (PLANO-ESTOQUE-DO-RECREADOR
 * §6, ER-D, Etapa 334): contrato do GET/PUT `material-margin`, da sugestão, das
 * linhas de material e dos números de estoque que a margem mexe (reserva,
 * saldo, painel de faltas, lista de compras), mais a festa-molde dos specs.
 *
 * A festa-molde tem 20 crianças e uma atividade com um consumível a 1 unidade
 * por criança (perda 0): a margem aparece em unidades inteiras, igual ao número
 * de crianças extras.
 */

export const MATERIAL_MARGIN_SETTING_KEY = 'MATERIAL_EXTRA_CHILDREN_PERCENT';
export const MARGIN_CHILDREN = 20;

export type MaterialMarginSource = 'Tenant' | 'Event' | 'None';

export interface EventMaterialMargin {
  childrenCount: number;
  extraChildren: number;
  marginSource: MaterialMarginSource;
  extraChildrenOverride: number | null;
  tenantPercent: number;
}

export interface MaterialMarginSuggestion {
  eventsMeasured: number;
  eventsWithMoreChildren: number;
  p90ExtraPercent: number | null;
  suggestedPercent: number | null;
}

export interface EventMaterialLine {
  id: string;
  productId: string;
  predictedQty: number;
  totalCost: number;
  marginQty: number;
  qtyToTake: number;
}

export interface MarginChecklistItem {
  id: string;
  productId: string | null;
  quantity: number | null;
  scope: string;
  marginChildren: number | null;
}

// ─────────────────────────── margem da festa ───────────────────────────

const marginUrl = (eventId: string) => `/api/events/${eventId}/material-margin`;

export function getMaterialMargin(api: APIRequestContext, eventId: string): Promise<APIResponse> {
  return api.get(marginUrl(eventId));
}

/** PUT cru: o chamador confere o status (403, 404, 409). `null` = padrão da empresa, 0 = sem margem. */
export function putMaterialMargin(
  api: APIRequestContext,
  eventId: string,
  extraChildrenOverride: number | null,
): Promise<APIResponse> {
  return api.put(marginUrl(eventId), { data: { extraChildrenOverride } });
}

export async function apiGetMaterialMargin(api: APIRequestContext, eventId: string): Promise<EventMaterialMargin> {
  const res = await getMaterialMargin(api, eventId);
  await assertOk(res, 'GET material-margin');
  return readJson<EventMaterialMargin>(res);
}

export function getMaterialMarginSuggestion(api: APIRequestContext): Promise<APIResponse> {
  return api.get('/api/events/material-margin/suggestion');
}

export async function apiGetMaterialMarginSuggestion(api: APIRequestContext): Promise<MaterialMarginSuggestion> {
  const res = await getMaterialMarginSuggestion(api);
  await assertOk(res, 'GET material-margin/suggestion');
  return readJson<MaterialMarginSuggestion>(res);
}

export async function apiGetMaterialLines(api: APIRequestContext, eventId: string): Promise<EventMaterialLine[]> {
  const res = await api.get(`/api/events/${eventId}/material-lines`);
  await assertOk(res, 'GET material-lines');
  return (await readJson<EventMaterialLine[]>(res)).map((l) => ({
    ...l,
    predictedQty: Number(l.predictedQty),
    totalCost: Number(l.totalCost),
    marginQty: Number(l.marginQty),
    qtyToTake: Number(l.qtyToTake),
  }));
}

/** Item da lista "o que levar" (admin ou Portal) do produto dado, na lista principal. */
export async function checklistItemOf(
  api: APIRequestContext,
  url: string,
  productId: string,
): Promise<MarginChecklistItem | undefined> {
  const res = await api.get(url);
  await assertOk(res, `GET ${url}`);
  const dto = await readJson<{ groups: Array<{ scope: string; items: MarginChecklistItem[] }> }>(res);
  return dto.groups
    .filter((g) => g.scope === 'Main')
    .flatMap((g) => g.items)
    .find((i) => i.productId === productId);
}

export const adminChecklistUrl = (eventId: string) => `/api/events/${eventId}/material-checklist`;
export const portalChecklistUrl = (eventId: string) => `/api/portal/my-events/${eventId}/material-checklist`;

// ─────────────────────────── estoque ───────────────────────────

export async function apiPurchase(api: APIRequestContext, productId: string, quantity: number): Promise<void> {
  await assertOk(
    await api.post('/api/stock/movements', {
      data: { productId, type: 'Purchase', quantity, unitCost: 1.5, supplierName: 'Fornecedor E2E' },
    }),
    'POST /api/stock/movements',
  );
}

/** Soma das reservas ATIVAS da festa no produto (0 sem reserva). */
export async function activeReservationOf(api: APIRequestContext, eventId: string, productId: string): Promise<number> {
  const res = await api.get(`/api/stock/reservations?eventId=${eventId}&pageSize=100`);
  await assertOk(res, 'GET /api/stock/reservations');
  const rows = await unwrapList<{ productId: string; eventId: string | null; status: string; quantity: number }>(res);
  return rows
    .filter((r) => r.status === 'Active' && r.eventId === eventId && r.productId === productId)
    .reduce((sum, r) => sum + Number(r.quantity), 0);
}

export async function apiStockBalance(api: APIRequestContext, productId: string) {
  const res = await api.get(`/api/stock/balances/${productId}`);
  await assertOk(res, 'GET /api/stock/balances/{id}');
  const b = await readJson<{ currentBalance: number; reservedQuantity: number; availableQuantity: number }>(res);
  return {
    current: Number(b.currentBalance),
    reserved: Number(b.reservedQuantity),
    available: Number(b.availableQuantity),
  };
}

/** Painel de faltas da festa: crianças extras incluídas e o previsto do produto. */
export async function apiShortageOf(api: APIRequestContext, eventId: string, productId: string) {
  const res = await api.get(`/api/events/${eventId}/material-shortage`);
  await assertOk(res, 'GET material-shortage');
  const dto = await readJson<{
    extraChildren: number;
    covered: Array<{ productId: string; predictedQty: number }>;
    missing: Array<{ productId: string; predictedQty: number }>;
  }>(res);
  const line = [...dto.covered, ...dto.missing].find((l) => l.productId === productId);
  return { extraChildren: dto.extraChildren, predictedQty: line ? Number(line.predictedQty) : null };
}

// ─────────────────────────── cenário ───────────────────────────

export interface MarginParty {
  eventId: string;
  clientId: string;
  activityId: string;
  /** Consumível a 1 unidade por criança, R$ 1,50 a unidade. */
  product: { id: string; name: string };
}

/**
 * Festa aceita de 20 crianças (`MARGIN_CHILDREN`) com uma atividade que usa um
 * consumível a 1 un. por criança. `extraProducts` acrescenta outros
 * consumíveis à mesma atividade (mesma conta).
 */
export async function setupMarginParty(
  api: APIRequestContext,
  opts: { eventDate?: string; extraProducts?: number; clientId?: string } = {},
): Promise<MarginParty & { extraProducts: Array<{ id: string; name: string }> }> {
  const s = uniqueSuffix();
  const product = await apiCreateProduct(api, { name: `Bexiga ${s}` });
  const extraProducts: Array<{ id: string; name: string }> = [];
  for (let i = 0; i < (opts.extraProducts ?? 0); i++) {
    extraProducts.push(await apiCreateProduct(api, { name: `Giz ${i + 1} ${s}` }));
  }
  const activity = await apiCreateActivity(api, {
    name: `Oficina de bexiga ${s}`,
    status: 'Active',
    activityProducts: [product, ...extraProducts].map((p) => ({ productId: p.id, qtyPerChild: 1, isChecklistOnly: false })),
  });
  const { eventId, clienteId } = await setupAcceptedEvent(api, {
    clientId: opts.clientId,
    activityIds: [activity.id],
    budget: {
      eventDate: opts.eventDate ?? tenantDayPlus(5),
      startTime: '14:00',
      endTime: '18:00',
      childrenCount: MARGIN_CHILDREN,
    },
  });
  return { eventId, clientId: clienteId, activityId: activity.id, product, extraProducts };
}

/** Escala um líder confirmado e inicia a festa (fica `InProgress`). */
export async function startWithLeader(api: APIRequestContext, eventId: string): Promise<void> {
  const leader = await apiCreateCollaborator(api);
  await apiAssignCollaborator(api, eventId, leader.id, { isLeader: true });
  await apiConfirmCollaborator(api, eventId, leader.id);
  await apiStartEvent(api, eventId);
}

/** Escala um líder confirmado, inicia e conclui a festa. */
export async function completeWithLeader(api: APIRequestContext, eventId: string): Promise<void> {
  await startWithLeader(api, eventId);
  await apiCompleteEvent(api, eventId);
}

/** Presentes lançados na festa concluída (`POST actual-children`). */
export async function apiRegisterActualChildren(api: APIRequestContext, eventId: string, count: number): Promise<void> {
  await assertOk(
    await api.post(`/api/events/${eventId}/actual-children`, { data: { actualChildrenCount: count } }),
    'POST actual-children',
  );
}

// ─────────────────────────── tela ───────────────────────────

/** Abre a aba Materiais do detalhe e espera a faixa da margem pronta. */
export async function openMaterialsTab(page: Page, eventId: string): Promise<void> {
  await page.goto(`/app/events/${eventId}`);
  await page.getByRole('tab', { name: 'Materiais', exact: true }).click();
  await expect(page.getByTestId('material-margin-strip')).toBeVisible({ timeout: 20_000 });
}

/** Abre a aba Checklist do detalhe e espera o item do material. */
export async function openChecklistTab(page: Page, eventId: string, itemId: string): Promise<void> {
  await page.goto(`/app/events/${eventId}`);
  await page.getByRole('tab', { name: 'Checklist', exact: true }).click();
  await expect(page.getByTestId(`material-checklist-item-${itemId}`)).toBeVisible({ timeout: 20_000 });
}

/**
 * "Ajustar nesta festa" pela faixa: `'none'` = sem margem, número = crianças a
 * mais. O rádio se marca pelo `input` dentro do `mat-radio-button`: o clique no
 * centro do host não acerta o rótulo e não marca.
 */
export async function adjustMarginInUi(page: Page, choice: 'tenant' | 'none' | number): Promise<void> {
  await page.getByTestId('material-margin-adjust').click();
  const key = typeof choice === 'number' ? 'custom' : choice;
  await page.getByTestId(`material-margin-choice-${key}`).getByRole('radio').check();
  if (typeof choice === 'number') {
    await page.getByTestId('material-margin-extra-input').fill(String(choice));
  }
  await page.getByTestId('material-margin-save').click();
}
