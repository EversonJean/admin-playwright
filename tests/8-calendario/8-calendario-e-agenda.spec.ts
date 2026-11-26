import type { APIRequestContext } from '@playwright/test';

import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiErrorBody, apiFormalizeContractManually, apiListContractAddendums } from '../../helpers/addendums';
import { smokeRoute } from '../../helpers/smoke';
import { apiCreateCollaborator, apiCompleteOnboarding, apiSetSettingParameter } from '../../helpers/api-entities';
import { apiPatchEvent } from '../../helpers/api-event-flow';
import { assertOk, readJson } from '../../helpers/response';
import { setupDraftContract } from '../../helpers/setup-flows';
import { calendarCard, dragCalendarCard } from '../../helpers/ui';

/**
 * Fluxo: 8 — Calendário e agenda
 * Diagrama: docs/fluxos/negocio-8-calendario-e-agenda.mmd
 * Cenário: docs/cenarios-de-teste/8-calendario/8-calendario-e-agenda.md (CF-05, CE-07, CE-08)
 *
 * Endpoint principal: GET /api/collaborators/:id/schedule?fromUtc=&toUtc=
 * devolve eventos do colaborador no periodo (vista de calendario).
 *
 * PLANO-ADITIVOS-COM-APROVACAO §6 (AD-D) item 8, A1, A2 e §7 (AD-E) item 2:
 * festa com contrato formalizado não muda de data pelo arrasto; o card volta e
 * abre o diálogo da proposta de aditivo (desde a Etapa 289; propor pela janela é
 * o 9.9). Mover só o horário mantendo a duração passa com
 * `CONTRACT_SCHEDULE_SAME_DURATION_FREE` ligado; com ele desligado, ou com outra
 * duração, a recusa é `Events.ChangeRequiresAddendum`.
 */

const SAME_DURATION_FREE = 'CONTRACT_SCHEDULE_SAME_DURATION_FREE';

interface Schedule {
  eventDate: string;
  startTime: string;
  endTime: string;
  clientName: string | null;
}

async function schedule(api: APIRequestContext, eventId: string): Promise<Schedule> {
  const res = await api.get(`/api/events/${eventId}`);
  await assertOk(res, 'GET /api/events/{id}');
  const ev = await readJson<Schedule>(res);
  return { eventDate: ev.eventDate, startTime: ev.startTime, endTime: ev.endTime, clientName: ev.clientName };
}

function isoPlus(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function hhmm(time: string): string {
  return time.slice(0, 5);
}

/** `HH:mm` mais N minutos (sem virar o dia). */
function shiftTime(time: string, minutes: number): string {
  const [h, m] = hhmm(time).split(':').map(Number);
  const total = h! * 60 + m! + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function brDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

test.describe('Fluxo 8 — Calendário e agenda', () => {
  test('@flow tela de calendário carrega autenticada', async ({ authPage, authApi }) => {
    await apiCompleteOnboarding(authApi);
    await smokeRoute(authPage, '/app/schedule/calendar', { ready: 'calendar-page' });
  });

  test('@crud GET schedule de colab novo retorna lista vazia no periodo', async ({
    authApi,
  }) => {
    const colab = await apiCreateCollaborator(authApi);
    const from = new Date(Date.now() - 30 * 86400000).toISOString();
    const to = new Date(Date.now() + 60 * 86400000).toISOString();
    const res = await authApi.get(
      `/api/collaborators/${colab.id}/schedule?fromUtc=${from}&toUtc=${to}`,
    );
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const data = body.data ?? body;
    // Colab novo sem eventos -> array vazio (ou objeto com items vazio)
    const items: Array<unknown> = Array.isArray(data) ? data : data.items ?? data.events ?? [];
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBe(0);
  });

  test('@flow festa com contrato assinado: arrastar volta o card e abre a proposta de aditivo; so o horario com a mesma duracao passa', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.slow(); // orçamento, aceite, contrato formalizado e o calendário pela tela
    const { eventId, contractId } = await setupDraftContract(authApi, tenant.tenantId);
    // No mês que o calendário abre: a festa daqui a 3 dias, o alvo no dia seguinte.
    const day = isoPlus(3);
    const target = isoPlus(4);
    await apiPatchEvent(authApi, eventId, { eventDate: day });
    await apiFormalizeContractManually(authApi, contractId);
    const before = await schedule(authApi, eventId);
    expect(before.eventDate).toBe(day);

    // CE-07 — arrastar para outro dia: o card volta e abre a janela da proposta.
    await apiCompleteOnboarding(authApi);
    await authPage.goto('/app/schedule/calendar');
    await expect(authPage.getByTestId('calendar-page')).toBeVisible();
    await dragCalendarCard(authPage, day, String(before.clientName), target);

    await expect(authPage.getByTestId('contract-change-title')).toHaveText(
      'Contrato assinado: estas mudanças viram um aditivo novo',
    );
    const dateRow = authPage.getByTestId('contract-change-row-date');
    await expect(dateRow, 'a data antiga e a nova').toContainText(brDate(day));
    await expect(dateRow).toContainText(brDate(target));
    await expect(calendarCard(authPage, day, String(before.clientName)), 'o card voltou para o dia de antes').toBeVisible();
    await authPage.getByTestId('contract-change-cancel').click();
    await expect(authPage.getByTestId('contract-change-title')).toHaveCount(0);
    expect(await schedule(authApi, eventId), 'cancelar não muda nada').toEqual(before);
    expect(await apiListContractAddendums(authApi, contractId), 'nenhum aditivo').toHaveLength(0);

    // A mesma recusa pela API, com os campos do contrato no corpo.
    const datePatch = await authApi.patch(`/api/events/${eventId}`, { data: { eventDate: target } });
    expect(datePatch.status()).toBe(409);
    const dateErr = await apiErrorBody(datePatch);
    expect(dateErr.codes).toContain('Events.ChangeRequiresAddendum');
    expect(JSON.stringify(dateErr.data ?? {})).toMatch(/eventDate/i);

    // CE-08 — outra duração recusa mesmo com o horário livre ligado (o padrão).
    const longer = await authApi.patch(`/api/events/${eventId}`, {
      data: { startTime: hhmm(before.startTime), endTime: shiftTime(before.endTime, 60) },
    });
    expect(longer.status(), 'mudar a duração').toBe(409);
    expect((await apiErrorBody(longer)).codes).toContain('Events.ChangeRequiresAddendum');

    // CE-08 — com o parâmetro desligado, nem a mesma duração passa.
    const sameDuration = { startTime: shiftTime(before.startTime, 60), endTime: shiftTime(before.endTime, 60) };
    await apiSetSettingParameter(authApi, SAME_DURATION_FREE, 'false');
    const lockedTime = await authApi.patch(`/api/events/${eventId}`, { data: sameDuration });
    expect(lockedTime.status(), 'mesma duração com o parâmetro desligado').toBe(409);
    expect((await apiErrorBody(lockedTime)).codes).toContain('Events.ChangeRequiresAddendum');
    expect(await schedule(authApi, eventId), 'nada mudou nas recusas').toEqual(before);

    // CF-05 — ligado de novo, só o horário com a mesma duração grava direto, sem aditivo.
    await apiSetSettingParameter(authApi, SAME_DURATION_FREE, 'true');
    await apiPatchEvent(authApi, eventId, sameDuration);
    const moved = await schedule(authApi, eventId);
    expect(moved.eventDate).toBe(day);
    expect(hhmm(moved.startTime)).toBe(sameDuration.startTime);
    expect(hhmm(moved.endTime)).toBe(sameDuration.endTime);
    expect(await apiListContractAddendums(authApi, contractId), 'sem aditivo').toHaveLength(0);
  });
});
