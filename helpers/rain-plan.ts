import { APIRequestContext, APIResponse, Page, expect } from '@playwright/test';
import {
  ActivityProductInput,
  ActivityRainInput,
  CreatedEntity,
  apiCreateActivity,
  apiCreateCollaborator,
} from './api-entities';
import { apiAssignCollaborator, apiConfirmCollaborator } from './api-event-flow';
import { RoleSession, loginPortalCollaborator, setupAcceptedEvent } from './setup-flows';
import { assertOk, readJson } from './response';
import { isoDate, tenantToday } from './week-staffing';

/**
 * Pré-condições e leituras dos specs do Plano B de chuva
 * (`docs/implementados/PLANO-PLANO-B-DE-CHUVA.md`, Etapas 222 a 227):
 * `tests/6-eventos/6.8`, `tests/fluxos-completos/10`, `tests/2-cadastros/2.1.2`
 * e `tests/13-portal-colaborador/13.5`.
 *
 * O provedor de clima do E2E é o fake do próprio back
 * (`Weather:FakeRainyDayOffsets = [1]`): AMANHÃ, no fuso pedido, chove 85% e
 * 4 mm das 12h às 18h; os outros dias são secos (10%). A festa do teste é das
 * 14h às 18h, então a pior hora cai dentro da chuva.
 */

const DAY_MS = 86_400_000;

/** Data (YYYY-MM-DD) de hoje + `days` no fuso do tenant (America/Sao_Paulo). */
export function tenantDayPlus(days: number): string {
  return isoDate(new Date(tenantToday().getTime() + days * DAY_MS));
}

/** A festa de amanhã: o único dia em que o fake de clima chove. */
export function rainyDay(): string {
  return tenantDayPlus(1);
}

/** Sufixo curto para nomes únicos do teste. */
export function uniqueSuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

// ─────────────────────────── contratos (o que o spec lê) ───────────────────────────

export type RainPlanStatus = 'Draft' | 'Ready' | 'Activated';
export type RainPlanItemSource = 'Manual' | 'Rule' | 'Ai';

export interface RainPlanItem {
  id: string;
  activityId: string | null;
  title: string;
  activityName: string | null;
  description: string | null;
  replacesActivityId: string | null;
  replacesActivityName: string | null;
  durationMinutes: number | null;
  groups: number | null;
  sortOrder: number;
  source: RainPlanItemSource;
  isStale: boolean;
  staleReason: string | null;
}

export interface RainPlan {
  id: string;
  status: RainPlanStatus;
  notes: string | null;
  activatedAt: string | null;
  activationReason: string | null;
  deactivatedAt: string | null;
  items: RainPlanItem[];
  rainRiskNotifiedOn: string | null;
}

export interface RainPlanView {
  eventId: string;
  venueExposure: 'OpenAir' | 'Sheltered' | 'Unknown';
  hasRainBackupArea: boolean | null;
  rainBackupAreaSquareMeters: number | null;
  childrenCount: number;
  canEdit: boolean;
  catalogHasIndoorActivities: boolean;
  plan: RainPlan | null;
}

export interface RainPlanItemInput {
  activityId?: string | null;
  title?: string | null;
  description?: string | null;
  replacesActivityId?: string | null;
  durationMinutes?: number | null;
  groups?: number | null;
  source?: RainPlanItemSource;
}

export interface RainPlanCandidate {
  activityId: string;
  name: string;
  replacesActivityId: string | null;
  isSubstitute: boolean;
  groups: number;
  groupSize: number;
  isSuggested: boolean;
  reasons: string[];
}

export interface RainPlanSuggestions {
  childrenCount: number;
  areaSquareMeters: number | null;
  candidates: RainPlanCandidate[];
}

export interface RainForecastView {
  forecast: {
    worstHour: number;
    precipitationProbability: number;
    precipitationMm: number;
    reachesThreshold: boolean;
  } | null;
  unavailableReason: 'Disabled' | 'OutOfRange' | 'NoLocation' | 'Unavailable' | null;
}

export interface ChecklistItem {
  id: string;
  title: string;
  quantity: number | null;
  productId: string | null;
  source: 'System' | 'Manager' | 'Collaborator';
  scope: 'Main' | 'RainPlan';
  status: 'Pending' | 'Checked' | 'Skipped';
  isStale: boolean;
}

export interface ChecklistGroup {
  activityId: string;
  activityName: string;
  scope: 'Main' | 'RainPlan';
  isInEvent: boolean;
  items: ChecklistItem[];
}

export interface MaterialChecklist {
  total: number;
  pending: number;
  groups: ChecklistGroup[];
  scopes: Array<{ scope: 'Main' | 'RainPlan'; total: number; pending: number }>;
}

export interface ReadinessRequirement {
  key: string;
  level: string;
  isMet: boolean;
}

// ─────────────────────────── chamadas ───────────────────────────

const base = (eventId: string) => `/api/events/${eventId}/rain-plan`;

/** GET da aba Plano B (o plano vem em `plan`, nulo sem plano). */
export async function apiGetRainPlan(api: APIRequestContext, eventId: string): Promise<RainPlanView> {
  const res = await api.get(base(eventId));
  await assertOk(res, 'GET rain-plan');
  return readJson<RainPlanView>(res);
}

/** PUT do Plano B sem lançar: para o spec ler o status da recusa. */
export function putRainPlan(
  api: APIRequestContext,
  eventId: string,
  items: RainPlanItemInput[],
  notes: string | null = null,
): Promise<APIResponse> {
  return api.put(base(eventId), {
    data: {
      notes,
      items: items.map((i) => ({
        activityId: i.activityId ?? null,
        title: i.title ?? null,
        description: i.description ?? null,
        replacesActivityId: i.replacesActivityId ?? null,
        durationMinutes: i.durationMinutes ?? null,
        groups: i.groups ?? null,
        source: i.source ?? 'Manual',
      })),
    },
  });
}

/** PUT do Plano B (estado completo); lança se o back recusar. */
export async function apiPutRainPlan(
  api: APIRequestContext,
  eventId: string,
  items: RainPlanItemInput[],
  notes: string | null = null,
): Promise<RainPlanView> {
  const res = await putRainPlan(api, eventId, items, notes);
  await assertOk(res, 'PUT rain-plan');
  return readJson<RainPlanView>(res);
}

export async function apiSuggestRainPlan(api: APIRequestContext, eventId: string): Promise<RainPlanSuggestions> {
  const res = await api.post(`${base(eventId)}/suggestions`);
  await assertOk(res, 'POST rain-plan/suggestions');
  return readJson<RainPlanSuggestions>(res);
}

export async function apiActivateRainPlan(
  api: APIRequestContext,
  eventId: string,
  reason: string | null = null,
): Promise<RainPlanView> {
  const res = await api.post(`${base(eventId)}/activate`, { data: { reason } });
  await assertOk(res, 'POST rain-plan/activate');
  return readJson<RainPlanView>(res);
}

export async function apiDeactivateRainPlan(api: APIRequestContext, eventId: string): Promise<RainPlanView> {
  const res = await api.post(`${base(eventId)}/deactivate`);
  await assertOk(res, 'POST rain-plan/deactivate');
  return readJson<RainPlanView>(res);
}

export async function apiGetRainForecast(api: APIRequestContext, eventId: string): Promise<RainForecastView> {
  const res = await api.get(`${base(eventId)}/forecast`);
  await assertOk(res, 'GET rain-plan/forecast');
  return readJson<RainForecastView>(res);
}

/** PATCH /api/events/{id}/form-data — a aba "Dados do cliente" do gestor. */
export async function apiPatchFormData(
  api: APIRequestContext,
  eventId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const res = await api.patch(`/api/events/${eventId}/form-data`, { data });
  await assertOk(res, 'PATCH form-data');
}

/** Local descoberto e externo, com (ou sem) área coberta de apoio. */
export function apiSetOpenAirVenue(
  api: APIRequestContext,
  eventId: string,
  areaSquareMeters: number | null = 30,
): Promise<void> {
  return apiPatchFormData(api, eventId, {
    isCovered: false,
    isIndoor: false,
    hasRainBackupArea: areaSquareMeters !== null,
    rainBackupAreaSquareMeters: areaSquareMeters,
    rainBackupAreaDescription: areaSquareMeters !== null ? 'Garagem coberta (E2E)' : null,
  });
}

/** Local coberto e interno (`Sheltered`). */
export function apiSetShelteredVenue(api: APIRequestContext, eventId: string): Promise<void> {
  return apiPatchFormData(api, eventId, { isCovered: true, isIndoor: true });
}

export async function apiGetMaterialChecklist(api: APIRequestContext, eventId: string): Promise<MaterialChecklist> {
  const res = await api.get(`/api/events/${eventId}/material-checklist`);
  await assertOk(res, 'GET material-checklist');
  return readJson<MaterialChecklist>(res);
}

export async function apiGetReadiness(api: APIRequestContext, eventId: string): Promise<ReadinessRequirement[]> {
  const res = await api.get(`/api/events/${eventId}/readiness`);
  await assertOk(res, 'GET readiness');
  return (await readJson<{ requirements: ReadinessRequirement[] }>(res)).requirements;
}

/**
 * Prazo do disparo manual dos gatilhos diários: o job percorre todos os
 * gatilhos do tenant num request só (molde do `11.1.1`).
 */
export const TRIGGER_TIMEOUT = 180_000;

/**
 * POST /api/notifications/trigger-overdue — o gatilho manual da varredura
 * diária (`NotificationTriggerService`), que roda o aviso de chuva
 * (`RainPlanForecastReminderService`) e o lembrete D-N do material.
 */
export async function apiTriggerDailyJob(api: APIRequestContext): Promise<void> {
  await assertOk(
    await api.post('/api/notifications/trigger-overdue', { timeout: TRIGGER_TIMEOUT }),
    'POST /api/notifications/trigger-overdue',
  );
}

// ─────────────────────────── cenário ───────────────────────────

export interface RainActivity extends CreatedEntity {
  name: string;
}

/** Atividade ATIVA com os dados de "Dias de chuva". */
export function apiCreateRainActivity(
  api: APIRequestContext,
  name: string,
  rain: ActivityRainInput & { activityProducts?: ActivityProductInput[]; durationMinutes?: number },
): Promise<RainActivity> {
  return apiCreateActivity(api, {
    name,
    status: 'Active',
    minChildren: 5,
    maxChildren: 30,
    minAgeYears: 3,
    maxAgeYears: 12,
    durationMinutes: rain.durationMinutes ?? 60,
    ...rain,
  });
}

export interface RainParty {
  eventId: string;
  clientId: string;
  /** A atividade contratada (só ao ar livre). */
  contracted: RainActivity;
  suffix: string;
}

/**
 * Festa comercial aceita, com uma atividade contratada "só ao ar livre", no dia
 * pedido (default: amanhã, o dia chuvoso do fake) das 14h às 18h e com o local
 * respondido pelo gestor (default: ao ar livre com área coberta de 30 m²).
 */
export async function setupRainParty(
  api: APIRequestContext,
  opts: {
    eventDate?: string;
    childrenCount?: number;
    venue?: 'OpenAir' | 'Sheltered' | 'None';
    areaSquareMeters?: number | null;
    contracted?: RainActivity;
    contractedProducts?: ActivityProductInput[];
    contractedSubstitutes?: string[];
    clientId?: string;
  } = {},
): Promise<RainParty> {
  const suffix = uniqueSuffix();
  const contracted =
    opts.contracted ??
    (await apiCreateRainActivity(api, `Caça ao tesouro ${suffix}`, {
      indoorSuitability: 'OutdoorOnly',
      activityProducts: opts.contractedProducts,
      rainSubstituteActivityIds: opts.contractedSubstitutes ?? [],
    }));
  const { eventId, clienteId } = await setupAcceptedEvent(api, {
    clientId: opts.clientId,
    activityIds: [contracted.id],
    budget: {
      eventDate: opts.eventDate ?? rainyDay(),
      startTime: '14:00',
      endTime: '18:00',
      childrenCount: opts.childrenCount ?? 26,
      eventLocation: `Quintal E2E ${suffix}`,
    },
  });
  const venue = opts.venue ?? 'OpenAir';
  if (venue === 'OpenAir') {
    await apiSetOpenAirVenue(api, eventId, opts.areaSquareMeters === undefined ? 30 : opts.areaSquareMeters);
  } else if (venue === 'Sheltered') {
    await apiSetShelteredVenue(api, eventId);
  }
  return { eventId, clientId: clienteId, contracted, suffix };
}

/**
 * Colaborador escalado e CONFIRMADO na festa, com usuário do Portal (o
 * "escalado com Portal" do plano). `phone` troca o telefone padrão.
 */
export async function setupConfirmedPortalCollaborator(
  api: APIRequestContext,
  tenantId: string,
  eventId: string,
  opts: { name?: string; phone?: string; isLeader?: boolean } = {},
): Promise<{ collaboratorId: string; portal: RoleSession }> {
  const collaborator = await apiCreateCollaborator(api, {
    ...(opts.name ? { name: opts.name } : {}),
    ...(opts.phone ? { phone: opts.phone } : {}),
  });
  await apiAssignCollaborator(api, eventId, collaborator.id, { isLeader: opts.isLeader ?? true });
  await apiConfirmCollaborator(api, eventId, collaborator.id);
  const portal = await loginPortalCollaborator(tenantId, collaborator.id);
  return { collaboratorId: collaborator.id, portal };
}

/** Usuário do Portal de um colaborador que NÃO está escalado na festa. */
export async function setupUnassignedPortalCollaborator(
  api: APIRequestContext,
  tenantId: string,
): Promise<{ collaboratorId: string; portal: RoleSession }> {
  const collaborator = await apiCreateCollaborator(api);
  const portal = await loginPortalCollaborator(tenantId, collaborator.id);
  return { collaboratorId: collaborator.id, portal };
}

// ─────────────────────────── tela ───────────────────────────

/** A aba "Plano B (chuva)" (o `data-testid` do `<mat-tab>` não chega ao DOM). */
export function rainPlanTab(page: Page) {
  return page.getByRole('tab', { name: 'Plano B (chuva)', exact: true });
}

/** Abre o detalhe da festa direto na aba Plano B (`?tab=rain-plan`) e espera a aba carregar. */
export async function openRainPlanTab(page: Page, eventId: string): Promise<void> {
  await page.goto(`/app/events/${eventId}?tab=rain-plan`);
  await expect(rainPlanTab(page)).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 });
  await expect(page.getByTestId('rain-plan-venue')).toBeVisible({ timeout: 20_000 });
}

/**
 * Guarda o texto que a tela manda para a área de transferência. O `Clipboard`
 * do CDK copia por um `<textarea>` focado e `execCommand('copy')`: o evento
 * `copy` dispara com ele ativo. Chame antes do `goto`.
 */
export async function captureClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    document.addEventListener(
      'copy',
      () => {
        const active = document.activeElement as HTMLTextAreaElement | null;
        (window as unknown as { __copiedText?: string }).__copiedText =
          active && 'value' in active ? active.value : (document.getSelection()?.toString() ?? '');
      },
      true,
    );
  });
}

export async function copiedText(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __copiedText?: string }).__copiedText ?? '');
}
