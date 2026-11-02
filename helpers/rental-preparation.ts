import { APIRequestContext, APIResponse, Page, expect } from '@playwright/test';
import {
  NotificationItem,
  PreparationStepInput,
  apiCreateActivity,
  apiCreateClient,
  apiCreateProduct,
} from './api-entities';
import { apiCompleteEvent, apiStartEvent } from './api-event-flow';
import { enableFeatureFlagDirect } from './db-helper';
import { fakeAddress } from './test-data';
import { assertOk, readJson } from './response';
import { setupConfirmedPortalCollaborator, tenantDayPlus, uniqueSuffix } from './rain-plan';

/**
 * Pré-condições e leituras dos specs da preparação dos equipamentos locados
 * (`docs/implementar/PLANO-PREPARACAO-DE-EQUIPAMENTOS.md`, PE-A a PE-H):
 * `tests/fluxos-completos/12` a `17` e `tests/15-locacao/15.3`. Unidades em
 * lote e troca de unidade (PE-E) e transporte (PE-H) nas seções do fim.
 *
 * Locação é add-on (`feature_equipment_rental`): o `setupReservedRental` liga o
 * entitlement por SQL, cria tipo, unidade e locação pela API e leva a locação a
 * `Reserved`, a transição em que a preparação nasce (§4 item 1).
 */

// ─────────────────────────── contratos (o que o spec lê) ───────────────────────────

export type RentalStatus =
  | 'Draft'
  | 'Reserved'
  | 'Confirmed'
  | 'Preparing'
  | 'Dispatched'
  | 'Delivered'
  | 'InUse'
  | 'Returned'
  | 'Completed'
  | 'Canceled';

export type SetupRequirementCategory = 'Equipment' | 'Accessory' | 'Safety' | 'Power' | 'Transport';

export interface SetupRequirementInput {
  name: string;
  category: SetupRequirementCategory;
  isMandatory: boolean;
}

export interface RentalItem {
  id: string;
  equipmentUnitId: string;
  equipmentUnitAssetCode: string;
  equipmentTypeName: string;
}

export interface Rental {
  id: string;
  rentalNumber: string;
  clientId: string;
  eventId: string | null;
  status: RentalStatus;
  items: RentalItem[];
  inspections: Array<{ id: string; rentalItemId: string; type: string; checklistCompleted: boolean }>;
  /** PE-E (Etapa 255) — os itens por tipo ("Cadeira infantil × 20"); `openDamageCount` desde a 256. */
  itemGroups?: Array<{
    equipmentTypeId: string;
    equipmentTypeName: string;
    quantity: number;
    rentalItemIds: string[];
    openDamageCount?: number;
  }>;
}

export type PreparationCheckStatus = 'Pending' | 'Done' | 'Failed' | 'NotApplicable';

export interface RentalPreparationCheck {
  id: string;
  rentalItemId: string;
  source: 'PreparationStep' | 'SetupRequirement' | 'Manual';
  title: string;
  category: string;
  isMandatory: boolean;
  status: PreparationCheckStatus;
  /** PE-B item 8 — obrigatório que falhou: `SwapUnit`, `OpenCorrectiveMaintenance`. */
  suggestedActions?: string[];
}

export interface RentalPreparationEntry {
  kind: 'Scheduled' | 'Postponed' | 'Executed' | 'NotExecuted' | 'Reopened';
  date: string | null;
  previousDate: string | null;
  reason: string | null;
}

export interface RentalPreparation {
  id: string | null;
  rentalId: string;
  rentalNumber: string;
  isMaterialized: boolean;
  isLocked: boolean;
  status: 'Pending' | 'Scheduled' | 'Done' | 'Canceled';
  requiresMaintenance: boolean;
  dueOn: string;
  scheduledFor: string | null;
  responsibleCollaboratorId: string | null;
  pendingMandatoryCount: number;
  postponeCount: number;
  units: Array<{ rentalItemId: string; assetCode: string; checks: RentalPreparationCheck[] }>;
  entries: RentalPreparationEntry[];
}

export interface EventChecklistItem {
  id: string;
  title: string;
  description: string | null;
  isDone: boolean;
  systemKey: string | null;
}

/** Chave do item de sistema da preparação no checklist do evento (decisão 19). */
export const RENTAL_PREPARATION_KEY = 'rental.preparation';

// ─────────────────────────── cadastro ───────────────────────────

/**
 * POST /api/equipment-types — tipo com o checklist de preparação (PE-A) e os
 * requisitos ("o que levar"). Sem passo nem requisito, a locação do tipo não
 * ganha preparação (decisão 16).
 */
export async function apiCreateEquipmentType(
  api: APIRequestContext,
  opts: { name?: string; steps?: PreparationStepInput[]; requirements?: SetupRequirementInput[] } = {},
): Promise<{ id: string; name: string }> {
  const suffix = uniqueSuffix();
  const name = opts.name ?? `Pula-pula E2E ${suffix}`;
  const res = await api.post('/api/equipment-types', {
    data: {
      name,
      code: `EQ${suffix}`.toUpperCase().slice(0, 20),
      category: 'Inflatable',
      requiresPower: true,
      setupTimeMinutes: 30,
      teardownTimeMinutes: 20,
      minMonitors: 1,
      pricing: {
        basePriceDaily: 250,
        basePriceHourly: 40,
        extraHourPrice: 30,
        setupFee: 0,
        deliveryFeePerKm: 0,
        depositAmount: 0,
        lateReturnFeePerHour: 50,
        damageFeeMinimum: 200,
      },
      setupRequirements: (opts.requirements ?? []).map((r) => ({ ...r, notes: null })),
      description: 'Tipo do e2e da preparação',
      preparationSteps: (opts.steps ?? []).map((s) => ({ ...s, instructions: s.instructions ?? null })),
    },
  });
  await assertOk(res, 'POST /api/equipment-types');
  const type = await readJson<{ id: string }>(res);
  return { id: type.id, name };
}

/** POST /api/equipment-units — uma unidade do tipo, patrimônio único. */
export async function apiCreateEquipmentUnit(
  api: APIRequestContext,
  equipmentTypeId: string,
): Promise<{ id: string; assetCode: string }> {
  const assetCode = `PAT-${uniqueSuffix()}`.toUpperCase();
  const res = await api.post('/api/equipment-units', {
    data: {
      equipmentTypeId,
      assetCode,
      acquisitionDate: tenantDayPlus(-30),
      acquisitionCost: 1500,
      condition: 'Good',
    },
  });
  await assertOk(res, 'POST /api/equipment-units');
  const unit = await readJson<{ id: string }>(res);
  return { id: unit.id, assetCode };
}

/**
 * POST /api/rentals — locação em `Draft` com entrega em `deliveryDate` (data
 * civil do tenant) e retirada no mesmo dia. `eventId` nulo = locação avulsa.
 * `deliveryAddress` troca o endereço padrão (sem coordenada) — por exemplo, por
 * um com `latitude`/`longitude` para virar parada da rota do dia (PE-H).
 */
export async function apiCreateRental(
  api: APIRequestContext,
  input: {
    clientId: string;
    eventId?: string | null;
    deliveryDate: string;
    unitIds: string[];
    deliveryAddress?: Record<string, unknown>;
  },
): Promise<Rental> {
  const res = await api.post('/api/rentals', {
    data: {
      clientId: input.clientId,
      eventId: input.eventId ?? null,
      budgetId: null,
      deliveryAddress: input.deliveryAddress ?? fakeAddress(),
      deliveryDate: input.deliveryDate,
      deliveryTime: '10:00:00',
      usageStart: `${input.deliveryDate}T17:00:00Z`,
      usageEnd: `${input.deliveryDate}T21:00:00Z`,
      pickupDate: input.deliveryDate,
      pickupTime: '20:00:00',
      includeMonitor: false,
      monitorCollaboratorId: null,
      discount: 0,
      notes: null,
      items: input.unitIds.map((equipmentUnitId) => ({ equipmentUnitId })),
    },
  });
  await assertOk(res, 'POST /api/rentals');
  return readJson<Rental>(res);
}

/** POST /api/rentals/{id}/transition — devolve a resposta crua (o spec afirma a recusa). */
export function transitionRental(api: APIRequestContext, rentalId: string, status: RentalStatus): Promise<APIResponse> {
  return api.post(`/api/rentals/${rentalId}/transition`, { data: { status } });
}

/** Leva a locação pelos status dados, na ordem, exigindo sucesso em cada um. */
export async function apiTransitionRental(
  api: APIRequestContext,
  rentalId: string,
  ...statuses: RentalStatus[]
): Promise<void> {
  for (const status of statuses) {
    await assertOk(await transitionRental(api, rentalId, status), `transition → ${status}`);
  }
}

export async function apiGetRental(api: APIRequestContext, rentalId: string): Promise<Rental> {
  const res = await api.get(`/api/rentals/${rentalId}`);
  await assertOk(res, 'GET /api/rentals/{id}');
  return readJson<Rental>(res);
}

// ─────────────────────────── preparação ───────────────────────────

export async function apiGetRentalPreparation(api: APIRequestContext, rentalId: string): Promise<RentalPreparation> {
  const res = await api.get(`/api/rentals/${rentalId}/preparation`);
  await assertOk(res, 'GET /api/rentals/{id}/preparation');
  return readJson<RentalPreparation>(res);
}

/** Todos os itens da preparação, unidade a unidade. */
export function preparationChecks(preparation: RentalPreparation): RentalPreparationCheck[] {
  return preparation.units.flatMap((u) => u.checks);
}

/** POST .../preparation/checks/{checkId}/complete — devolve a resposta crua. */
export function completePreparationCheck(
  api: APIRequestContext,
  rentalId: string,
  checkId: string,
  status: Exclude<PreparationCheckStatus, 'Pending'> = 'Done',
  notes: string | null = null,
): Promise<APIResponse> {
  return api.post(`/api/rentals/${rentalId}/preparation/checks/${checkId}/complete`, { data: { status, notes } });
}

/** POST .../preparation/schedule — devolve a resposta crua. */
export function scheduleRentalPreparation(
  api: APIRequestContext,
  rentalId: string,
  input: { date: string; responsibleCollaboratorId?: string | null; notifyChannels?: Array<'Portal' | 'WhatsApp'> },
): Promise<APIResponse> {
  return api.post(`/api/rentals/${rentalId}/preparation/schedule`, {
    data: {
      date: input.date,
      responsibleCollaboratorId: input.responsibleCollaboratorId ?? null,
      notifyChannels: input.notifyChannels ?? null,
    },
  });
}

// ─────────────────────────── checklist do evento e avisos ───────────────────────────

/** GET /api/events/{id}/checklist — as tarefas do evento (inclui os itens de sistema). */
export async function apiGetEventChecklist(api: APIRequestContext, eventId: string): Promise<EventChecklistItem[]> {
  const res = await api.get(`/api/events/${eventId}/checklist`);
  await assertOk(res, 'GET /api/events/{id}/checklist');
  return (await readJson<{ items: EventChecklistItem[] }>(res)).items;
}

/** O item `rental.preparation` do checklist do evento, ou `undefined`. */
export async function rentalPreparationItem(
  api: APIRequestContext,
  eventId: string,
): Promise<EventChecklistItem | undefined> {
  return (await apiGetEventChecklist(api, eventId)).find((i) => i.systemKey === RENTAL_PREPARATION_KEY);
}

/** GET /api/notifications?pendingAcknowledgement=true — os avisos com ciência pendente do usuário. */
export async function apiListPendingAcknowledgement(api: APIRequestContext): Promise<NotificationItem[]> {
  const res = await api.get('/api/notifications?pendingAcknowledgement=true&pageSize=50');
  await assertOk(res, 'GET /api/notifications?pendingAcknowledgement=true');
  const data = await readJson<NotificationItem[] | { items: NotificationItem[] }>(res);
  return Array.isArray(data) ? data : data.items;
}

// ─────────────────────────── cenário ───────────────────────────

/** Passos de limpeza e revisão de um inflável: dois obrigatórios e um opcional. */
export const INFLATABLE_STEPS: PreparationStepInput[] = [
  { title: 'Higienizar a lona', category: 'Cleaning', isMandatory: true },
  { title: 'Testar o soprador', category: 'FunctionalTest', isMandatory: true },
  { title: 'Conferir as costuras', category: 'Safety', isMandatory: false },
];

export interface ReservedRental {
  rental: Rental;
  type: { id: string; name: string };
  unit: { id: string; assetCode: string };
  clientId: string;
}

/**
 * Locação `Reserved` de uma unidade de um tipo novo. Liga o add-on de locação
 * no tenant (idempotente para o spec: cada chamada insere uma ativação). Sem
 * `deliveryDate`, a entrega fica em 20 dias, fora da janela do aviso D-7.
 */
export async function setupReservedRental(
  api: APIRequestContext,
  tenantId: string,
  opts: {
    eventId?: string | null;
    clientId?: string;
    deliveryDate?: string;
    steps?: PreparationStepInput[];
    requirements?: SetupRequirementInput[];
    typeName?: string;
    enableAddOn?: boolean;
    deliveryAddress?: Record<string, unknown>;
  } = {},
): Promise<ReservedRental> {
  if (opts.enableAddOn !== false) enableFeatureFlagDirect(tenantId, 'feature_equipment_rental');
  const type = await apiCreateEquipmentType(api, {
    name: opts.typeName,
    steps: opts.steps ?? INFLATABLE_STEPS,
    requirements: opts.requirements ?? [],
  });
  const unit = await apiCreateEquipmentUnit(api, type.id);
  const clientId = opts.clientId ?? (await apiCreateClient(api)).id;
  const draft = await apiCreateRental(api, {
    clientId,
    eventId: opts.eventId ?? null,
    deliveryDate: opts.deliveryDate ?? tenantDayPlus(20),
    unitIds: [unit.id],
    deliveryAddress: opts.deliveryAddress,
  });
  await apiTransitionRental(api, draft.id, 'Reserved');
  return { rental: await apiGetRental(api, draft.id), type, unit, clientId };
}

// ─────────────────────────── tela ───────────────────────────

/** A aba "Preparação" do detalhe da locação (o `data-testid` do `<mat-tab>` não chega ao DOM). */
export function preparationTab(page: Page) {
  return page.getByRole('tab', { name: 'Preparação', exact: true });
}

/** Abre o detalhe da locação na aba Preparação (`?tab=preparation`) e espera a aba carregar. */
export async function openRentalPreparationTab(page: Page, rentalId: string): Promise<void> {
  await page.goto(`/app/rentals/${rentalId}?tab=preparation`);
  await expect(preparationTab(page)).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 });
  await expect(page.getByTestId('rental-preparation-summary')).toBeVisible({ timeout: 20_000 });
}

// ─────────────────────────── unidades em lote e troca (PE-E) ───────────────────────────

export type EquipmentUnitStatus =
  | 'Available'
  | 'Reserved'
  | 'InTransit'
  | 'Deployed'
  | 'Rented'
  | 'Returning'
  | 'InMaintenance'
  | 'Retired';

export interface EquipmentUnitListItem {
  id: string;
  equipmentTypeId: string;
  assetCode: string;
  condition: string;
  status: EquipmentUnitStatus;
  hasOpenDamage?: boolean;
}

export interface AvailableEquipmentUnits {
  equipmentTypeId: string;
  requested: number;
  availableCount: number;
  withOpenDamageCount: number;
  units: Array<{ id: string; assetCode: string; condition: string }>;
}

/** POST /api/equipment-units/batch — devolve a resposta crua (o spec afirma 403/409). */
export function createEquipmentUnitBatch(
  api: APIRequestContext,
  input: { equipmentTypeId: string; quantity: number; assetCodePrefix: string; startNumber?: number },
): Promise<APIResponse> {
  return api.post('/api/equipment-units/batch', {
    data: {
      equipmentTypeId: input.equipmentTypeId,
      quantity: input.quantity,
      assetCodePrefix: input.assetCodePrefix,
      startNumber: input.startNumber ?? 1,
      condition: 'Good',
      acquisitionDate: null,
      acquisitionCost: null,
    },
  });
}

/** O lote criado, na ordem do patrimônio. */
export async function apiCreateEquipmentUnitBatch(
  api: APIRequestContext,
  input: { equipmentTypeId: string; quantity: number; assetCodePrefix: string; startNumber?: number },
): Promise<EquipmentUnitListItem[]> {
  const res = await createEquipmentUnitBatch(api, input);
  await assertOk(res, 'POST /api/equipment-units/batch');
  return readJson<EquipmentUnitListItem[]>(res);
}

export async function apiGetEquipmentUnit(api: APIRequestContext, unitId: string): Promise<EquipmentUnitListItem> {
  const res = await api.get(`/api/equipment-units/${unitId}`);
  await assertOk(res, 'GET /api/equipment-units/{id}');
  return readJson<EquipmentUnitListItem>(res);
}

/**
 * GET /api/equipment-units/available — as N primeiras livres do tipo na janela
 * do dia (`date` civil, das 00:00 às 23:59 UTC, a convenção da locação).
 */
export async function apiListAvailableUnits(
  api: APIRequestContext,
  input: { equipmentTypeId: string; date: string; quantity: number },
): Promise<AvailableEquipmentUnits> {
  const query = new URLSearchParams({
    typeId: input.equipmentTypeId,
    from: `${input.date}T00:00:00Z`,
    to: `${input.date}T23:59:00Z`,
    quantity: String(input.quantity),
  });
  const res = await api.get(`/api/equipment-units/available?${query.toString()}`);
  await assertOk(res, 'GET /api/equipment-units/available');
  return readJson<AvailableEquipmentUnits>(res);
}

/** POST /api/rentals/{id}/items/{itemId}/swap — devolve a resposta crua. */
export function swapRentalItemUnit(
  api: APIRequestContext,
  rentalId: string,
  rentalItemId: string,
  newUnitId: string,
): Promise<APIResponse> {
  return api.post(`/api/rentals/${rentalId}/items/${rentalItemId}/swap`, { data: { newUnitId } });
}

/** POST /api/rentals/{id}/inspections/batch ("todas OK, exceto…") — devolve a resposta crua. */
export function inspectRentalBatch(
  api: APIRequestContext,
  rentalId: string,
  input: {
    type: 'Outbound' | 'Inbound';
    defaultCondition?: 'Perfect' | 'MinorWear' | 'Damaged' | 'Unusable';
    exceptions?: Array<{ rentalItemId: string; condition: 'Perfect' | 'MinorWear' | 'Damaged' | 'Unusable'; notes?: string }>;
  },
): Promise<APIResponse> {
  return api.post(`/api/rentals/${rentalId}/inspections/batch`, {
    data: {
      type: input.type,
      defaultCondition: input.defaultCondition ?? 'Perfect',
      checklistCompleted: true,
      rentalItemIds: null,
      exceptions: (input.exceptions ?? []).map((e) => ({ ...e, notes: e.notes ?? null })),
    },
  });
}

/** GET /api/damage-reports?rentalId= — as avarias da locação. */
export async function apiListRentalDamageReports(
  api: APIRequestContext,
  rentalId: string,
): Promise<Array<{ id: string; rentalItemId: string; equipmentUnitId: string; isOpen: boolean }>> {
  const res = await api.get(`/api/damage-reports?rentalId=${rentalId}&pageSize=100`);
  await assertOk(res, 'GET /api/damage-reports');
  return (await readJson<{ items: Array<{ id: string; rentalItemId: string; equipmentUnitId: string; isOpen: boolean }> }>(res))
    .items;
}

// ─────────────────────────── transporte (PE-H) ───────────────────────────

/** Chave do item de sistema do transporte no checklist do evento (§10 item 5). */
export const RENTAL_TRANSPORT_KEY = 'rental.transport';

export type LogisticsLegKind = 'Delivery' | 'Pickup';

export interface LogisticsLegInput {
  kind: LogisticsLegKind;
  vehicleId?: string | null;
  departureDate?: string | null;
  departureTime?: string | null;
  loadingMinutes?: number;
  crew?: Array<{ collaboratorId: string; isDriver?: boolean }>;
  notes?: string | null;
}

export interface RentalLogistics {
  rentalId: string;
  rentalNumber: string;
  canPlan: boolean;
  crewNotifiedAt: string | null;
  crewOutdated: boolean;
  legs: Array<{
    id: string | null;
    kind: LogisticsLegKind;
    vehicleId: string | null;
    vehicleName: string | null;
    isComplete: boolean;
    crew: Array<{
      collaboratorId: string;
      isDriver: boolean;
      notifiedAt: string | null;
      acknowledgedAt: string | null;
      acknowledgedVia: string | null;
    }>;
  }>;
  alerts: Array<{ code: string; kind: LogisticsLegKind | null; message: string }>;
}

/** POST /api/routing/vehicles — veículo ativo com nome único. */
export async function apiCreateVehicle(
  api: APIRequestContext,
  opts: { name?: string; plate?: string } = {},
): Promise<{ id: string; name: string }> {
  const name = opts.name ?? `Fiorino E2E ${uniqueSuffix()}`;
  const res = await api.post('/api/routing/vehicles', {
    data: {
      name,
      plate: opts.plate ?? null,
      maxLoadKg: 650,
      cargoLengthM: 1.9,
      cargoWidthM: 1.3,
      cargoHeightM: 1.2,
      status: 'Active',
    },
  });
  await assertOk(res, 'POST /api/routing/vehicles');
  return { id: (await readJson<{ id: string }>(res)).id, name };
}

/** PUT /api/rentals/{id}/logistics (estado completo) — devolve a resposta crua. */
export function putRentalLogistics(
  api: APIRequestContext,
  rentalId: string,
  legs: LogisticsLegInput[],
): Promise<APIResponse> {
  return api.put(`/api/rentals/${rentalId}/logistics`, {
    data: {
      legs: legs.map((l) => ({
        kind: l.kind,
        vehicleId: l.vehicleId ?? null,
        departureDate: l.departureDate ?? null,
        departureTime: l.departureTime ?? null,
        loadingMinutes: l.loadingMinutes ?? 0,
        crew: (l.crew ?? []).map((c) => ({ collaboratorId: c.collaboratorId, isDriver: c.isDriver ?? false })),
        notes: l.notes ?? null,
      })),
    },
  });
}

/**
 * As duas pernas completas (veículo, motorista e saída antes do horário que a
 * perna atende), no dia da locação criada pelo `apiCreateRental` (entrega 10:00,
 * retirada 20:00).
 */
export function completeLegs(input: {
  date: string;
  vehicleId: string;
  driverId: string;
  helperIds?: string[];
}): LogisticsLegInput[] {
  const crew = [
    { collaboratorId: input.driverId, isDriver: true },
    ...(input.helperIds ?? []).map((collaboratorId) => ({ collaboratorId, isDriver: false })),
  ];
  return [
    { kind: 'Delivery', vehicleId: input.vehicleId, departureDate: input.date, departureTime: '07:00:00', loadingMinutes: 30, crew },
    { kind: 'Pickup', vehicleId: input.vehicleId, departureDate: input.date, departureTime: '18:30:00', loadingMinutes: 15, crew },
  ];
}

export async function apiPutRentalLogistics(
  api: APIRequestContext,
  rentalId: string,
  legs: LogisticsLegInput[],
): Promise<RentalLogistics> {
  const res = await putRentalLogistics(api, rentalId, legs);
  await assertOk(res, 'PUT /api/rentals/{id}/logistics');
  return readJson<RentalLogistics>(res);
}

export async function apiGetRentalLogistics(api: APIRequestContext, rentalId: string): Promise<RentalLogistics> {
  const res = await api.get(`/api/rentals/${rentalId}/logistics`);
  await assertOk(res, 'GET /api/rentals/{id}/logistics');
  return readJson<RentalLogistics>(res);
}

/** POST /api/rentals/{id}/logistics/notify-crew — devolve a resposta crua. */
export function notifyRentalCrew(
  api: APIRequestContext,
  rentalId: string,
  channels: Array<'Portal' | 'WhatsApp'>,
): Promise<APIResponse> {
  return api.post(`/api/rentals/${rentalId}/logistics/notify-crew`, { data: { channels } });
}

/** O item `rental.transport` do checklist do evento, ou `undefined`. */
export async function rentalTransportItem(
  api: APIRequestContext,
  eventId: string,
): Promise<EventChecklistItem | undefined> {
  return (await apiGetEventChecklist(api, eventId)).find((i) => i.systemKey === RENTAL_TRANSPORT_KEY);
}

// ─────────────────────────── avarias (PE-F e PE-I) ───────────────────────────

export type DamageCondition = 'Perfect' | 'MinorWear' | 'Damaged' | 'Unusable';

/** `DamageReportDto` (Etapas 256 e 269): a mesma forma na lista e no detalhe. */
export interface DamageReport {
  id: string;
  rentalId: string;
  rentalNumber: string;
  clientId: string;
  eventId: string | null;
  eventHasActivePaymentPlan: boolean | null;
  /** Modo de cobrança do EVENTO (`Charged`/`Community`), nulo na locação avulsa. */
  eventChargeMode: 'Charged' | 'Community' | null;
  rentalItemId: string;
  equipmentUnitId: string;
  assetCode: string;
  equipmentTypeId: string;
  equipmentTypeName: string;
  status: 'Reported' | 'UnderRepair' | 'Repaired' | 'WrittenOff';
  isOpen: boolean;
  actualRepairCost: number | null;
  replacementCost: number | null;
  chargeClient: boolean;
  chargeAmount: number | null;
  resolution: 'Pending' | 'ChargedToClient' | 'AbsorbedByCompany';
  /** Como a avaria foi cobrada (`PaymentPlan`/`Manual`). */
  chargeMode: 'PaymentPlan' | 'Manual' | null;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  financialAdjustmentId: string | null;
  expenseId: string | null;
  maintenanceRecordId: string | null;
}

export interface DamageReportList {
  items: DamageReport[];
  total: number;
  totalCharged: number;
  totalAbsorbed: number;
}

/** GET /api/damage-reports — com os filtros dados (`eventId`, `rentalId`, `openOnly`…). */
export async function apiListDamageReports(
  api: APIRequestContext,
  filter: Record<string, string>,
): Promise<DamageReportList> {
  const query = new URLSearchParams({ pageSize: '100', ...filter });
  const res = await api.get(`/api/damage-reports?${query.toString()}`);
  await assertOk(res, 'GET /api/damage-reports');
  return readJson<DamageReportList>(res);
}

export async function apiGetDamageReport(api: APIRequestContext, damageReportId: string): Promise<DamageReport> {
  const res = await api.get(`/api/damage-reports/${damageReportId}`);
  await assertOk(res, 'GET /api/damage-reports/{id}');
  return readJson<DamageReport>(res);
}

/** POST /api/damage-reports/{id}/resolve — devolve a resposta crua (o spec afirma 403/409). */
export function resolveDamageReport(
  api: APIRequestContext,
  damageReportId: string,
  input: { resolution: 'ChargeClient' | 'Absorb'; amount?: number | null; dueOn?: string | null; reason?: string | null },
): Promise<APIResponse> {
  return api.post(`/api/damage-reports/${damageReportId}/resolve`, {
    data: {
      resolution: input.resolution,
      amount: input.amount ?? null,
      dueOn: input.dueOn ?? null,
      reason: input.reason ?? null,
    },
  });
}

/** POST .../start-repair (corretiva aberta hoje, sem previsão) — resposta crua. */
export function startDamageRepair(api: APIRequestContext, damageReportId: string): Promise<APIResponse> {
  return api.post(`/api/damage-reports/${damageReportId}/start-repair`, { data: {} });
}

/** POST .../repaired com o custo real — resposta crua. */
export function markDamageRepaired(
  api: APIRequestContext,
  damageReportId: string,
  actualRepairCost: number,
): Promise<APIResponse> {
  return api.post(`/api/damage-reports/${damageReportId}/repaired`, {
    data: { actualRepairCost, condition: null, completedOn: null },
  });
}

/** POST .../write-off — resposta crua. `replacementCost` nulo = baixa "sem custo". */
export function writeOffDamageReport(
  api: APIRequestContext,
  damageReportId: string,
  input: { replacementCost: number | null; retireUnit: boolean },
): Promise<APIResponse> {
  return api.post(`/api/damage-reports/${damageReportId}/write-off`, { data: input });
}

/**
 * Leva uma locação `Reserved` SEM preparação (tipo sem passo nem requisito,
 * decisão 16) até a volta: saída inspecionada em lote, despacho, entrega, uso e
 * `Returned`; a inspeção de volta em lote marca as unidades dadas com a
 * condição pedida. Devolve as avarias da locação, que nascem dessa inspeção pelo
 * ponto único de criação (§8 item 5).
 */
export async function returnRentalWithDamages(
  api: APIRequestContext,
  rentalId: string,
  damaged: Array<{ rentalItemId: string; condition: DamageCondition; notes: string }>,
): Promise<DamageReport[]> {
  await apiTransitionRental(api, rentalId, 'Confirmed', 'Preparing');
  await assertOk(await inspectRentalBatch(api, rentalId, { type: 'Outbound' }), 'inspeção de saída');
  await apiTransitionRental(api, rentalId, 'Dispatched', 'Delivered', 'InUse', 'Returned');
  await assertOk(
    await inspectRentalBatch(api, rentalId, { type: 'Inbound', defaultCondition: 'Perfect', exceptions: damaged }),
    'inspeção de volta',
  );
  return (await apiListDamageReports(api, { rentalId })).items;
}

// ─────────────────────────── conferência de material (PE-F item 7) ───────────────────────────

export interface ConsumptionRecord {
  id: string;
  productId: string;
  predictedQuantity: number;
  actualQuantity: number | null;
  variance: number | null;
  status: string;
  autoDeducted: boolean;
  lossResolution: 'Absorbed' | 'ChargedToClient' | null;
  lossChargeAmount: number | null;
  lossFinancialAdjustmentId: string | null;
  suggestedLossChargeAmount: number | null;
}

/** GET /api/stock/consumption-reviews/{eventId} — a conferência do gestor. */
export async function apiGetConsumptionReview(api: APIRequestContext, eventId: string): Promise<ConsumptionRecord[]> {
  const res = await api.get(`/api/stock/consumption-reviews/${eventId}`);
  await assertOk(res, 'GET /api/stock/consumption-reviews/{eventId}');
  return (await readJson<{ records: ConsumptionRecord[] }>(res)).records;
}

/** POST /api/stock/consumption-reviews/{eventId}/confirm — resposta crua (o spec afirma 403/409). */
export function confirmConsumptionReview(
  api: APIRequestContext,
  eventId: string,
  corrections: Array<{
    recordId: string;
    lossResolution?: 'Absorbed' | 'ChargedToClient';
    lossChargeAmount?: number | null;
  }>,
): Promise<APIResponse> {
  return api.post(`/api/stock/consumption-reviews/${eventId}/confirm`, {
    data: {
      corrections: corrections.map((c) => ({
        recordId: c.recordId,
        actualQuantity: null,
        reason: null,
        ...(c.lossResolution ? { lossResolution: c.lossResolution } : {}),
        ...(c.lossChargeAmount !== undefined ? { lossChargeAmount: c.lossChargeAmount } : {}),
      })),
    },
  });
}

/**
 * Material reutilizável da festa: produto `isReusable` com estoque comprado ao
 * custo dado e atividade que o leva como item de checklist (sem baixa no
 * `Complete`). Exige `feature_stock` ligado no tenant.
 */
export async function setupReusableMaterialActivity(
  api: APIRequestContext,
  opts: { productName?: string; unitCost: number; stock?: number },
): Promise<{ productId: string; productName: string; activityId: string }> {
  const product = await apiCreateProduct(api, {
    name: opts.productName ?? `Cadeirinha E2E ${uniqueSuffix()}`,
    unitCost: opts.unitCost,
    isReusable: true,
  });
  await assertOk(
    await api.post('/api/stock/movements', {
      data: {
        productId: product.id,
        type: 'Purchase',
        quantity: opts.stock ?? 30,
        unitCost: opts.unitCost,
        supplierName: 'Fornecedor E2E',
      },
    }),
    'POST /api/stock/movements (compra)',
  );
  const activity = await apiCreateActivity(api, {
    activityProducts: [{ productId: product.id, qtyPerChild: 1, isChecklistOnly: true }],
  });
  return { productId: product.id, productName: product.name, activityId: activity.id };
}

/**
 * Festa concluída com o material lançado pelo Portal: o colaborador escalado
 * (líder, confirmado) inicia e conclui pela máquina de estados e lança o real
 * do produto com `extra` unidades a mais que o previsto (a perda do
 * reutilizável, que fica pendente de conferência).
 */
export async function completeEventWithMaterialLoss(
  api: APIRequestContext,
  tenantId: string,
  eventId: string,
  input: { productId: string; extra: number },
): Promise<{ recordId: string }> {
  const { portal } = await setupConfirmedPortalCollaborator(api, tenantId, eventId);
  try {
    await apiStartEvent(api, eventId);
    await apiCompleteEvent(api, eventId);
    const review = await portal.api.get(`/api/portal/my-events/${eventId}/material-consumption`);
    await assertOk(review, 'GET material-consumption (portal)');
    const records = (await readJson<{ records: Array<{ id: string; productId: string; predictedQuantity: number }> }>(review))
      .records;
    const record = records.find((r) => r.productId === input.productId);
    expect(record, 'registro de consumo do reutilizável').toBeTruthy();
    await assertOk(
      await portal.api.post(`/api/portal/my-events/${eventId}/material-consumption`, {
        data: {
          lines: [
            {
              recordId: record!.id,
              actualQuantity: record!.predictedQuantity + input.extra,
              reason: 'Cadeirinha quebrada na festa (E2E)',
            },
          ],
        },
      }),
      'POST material-consumption (portal)',
    );
    return { recordId: record!.id };
  } finally {
    await portal.api.dispose();
  }
}

/** Abre o detalhe da locação na aba Transporte (`?tab=transport`) e espera a aba carregar. */
export async function openRentalTransportTab(page: Page, rentalId: string): Promise<void> {
  await page.goto(`/app/rentals/${rentalId}?tab=transport`);
  await expect(page.getByRole('tab', { name: 'Transporte', exact: true })).toHaveAttribute('aria-selected', 'true', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('rental-transport-summary')).toBeVisible({ timeout: 20_000 });
}
