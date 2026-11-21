import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import { assertOk, readJson } from './response';

/**
 * Conferência da festa pela equipe (PLANO-ESTOQUE-DO-RECREADOR §5, ER-C,
 * Etapa 333): o recreador confirmado confere as sete seções no Portal e o
 * Events grava um hash por seção na linha da escala; a comparação é na
 * leitura, então mudar a festa deixa a conferência `Outdated` com as seções
 * que mudaram.
 */

export type EventInfoSection =
  | 'Schedule'
  | 'Place'
  | 'Children'
  | 'Activities'
  | 'Venue'
  | 'Restrictions'
  | 'DayContact';

/** As sete seções, na ordem do enum do back (a da tela e a de `changedSections`). */
export const EVENT_INFO_SECTIONS: readonly EventInfoSection[] = [
  'Schedule',
  'Place',
  'Children',
  'Activities',
  'Venue',
  'Restrictions',
  'DayContact',
];

export type EventInfoReviewStatus = 'NotReviewed' | 'Current' | 'Outdated';

/** `EventInfoReviewDto` (Portal). */
export interface EventInfoReview {
  status: EventInfoReviewStatus;
  reviewedAt: string | null;
  changedSections: EventInfoSection[];
  token: string;
  canReview: boolean;
}

/** `EventInfoReviewReminderRecipientDto` ("Pedir conferência"). */
export interface EventInfoReviewReminderRecipient {
  collaboratorId: string;
  name: string;
  status: EventInfoReviewStatus;
  changedSections: EventInfoSection[];
  inAppSent: boolean;
  whatsappSent: boolean;
  whatsappSkippedReason: string | null;
}

/** GET /api/portal/my-events/{id}/info-review — cru, para o teste afirmar o status. */
export function getInfoReview(portalApi: APIRequestContext, eventId: string): Promise<APIResponse> {
  return portalApi.get(`/api/portal/my-events/${eventId}/info-review`);
}

/** GET /api/portal/my-events/{id}/info-review (200 esperado). */
export async function apiGetInfoReview(portalApi: APIRequestContext, eventId: string): Promise<EventInfoReview> {
  const res = await getInfoReview(portalApi, eventId);
  await assertOk(res, 'GET /api/portal/my-events/{id}/info-review');
  return readJson<EventInfoReview>(res);
}

/** POST /api/portal/my-events/{id}/info-review ("Conferi tudo") — cru. */
export function postInfoReview(portalApi: APIRequestContext, eventId: string, token: string): Promise<APIResponse> {
  return portalApi.post(`/api/portal/my-events/${eventId}/info-review`, { data: { token } });
}

/** Lê o token atual e confere a festa pela API (pré-condição). */
export async function apiReviewEventInfo(portalApi: APIRequestContext, eventId: string): Promise<EventInfoReview> {
  const { token } = await apiGetInfoReview(portalApi, eventId);
  const res = await postInfoReview(portalApi, eventId, token);
  await assertOk(res, 'POST /api/portal/my-events/{id}/info-review');
  return readJson<EventInfoReview>(res);
}

/** POST /api/events/{id}/info-review/remind ("Pedir conferência") — cru. */
export function remindInfoReview(api: APIRequestContext, eventId: string): Promise<APIResponse> {
  return api.post(`/api/events/${eventId}/info-review/remind`, { data: {} });
}

/** A coluna "Conferiu a festa" de um colaborador na aba Equipe do detalhe do evento. */
export function teamInfoReviewCell(page: Page, collaboratorId: string) {
  return page.getByTestId(`event-detail-team-info-review-${collaboratorId}`);
}

/** Abre a aba Equipe do detalhe do evento (o `data-testid` do `<mat-tab>` não chega ao DOM). */
export async function openTeamTab(page: Page, eventId: string): Promise<void> {
  await page.goto(`/app/events/${eventId}`);
  await page.getByRole('tab', { name: 'Equipe', exact: true }).click();
}

/** A caixa de uma seção no card "Conferir a festa" do Portal. */
export function infoReviewCheckbox(page: Page, section: EventInfoSection) {
  return page.getByTestId(`portal-event-detail-info-review-checkbox-${section}`).locator('input[type="checkbox"]');
}
