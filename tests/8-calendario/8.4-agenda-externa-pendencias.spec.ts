import { APIRequestContext, Page } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCompleteOnboarding, apiListNotifications, NotificationItem } from '../../helpers/api-entities';
import {
  createBearerApiContext,
  loginViaApi,
  openPageWithTokens,
  signupNewTenant,
} from '../../helpers/api-client';
import { seedUserWithRoleDirect } from '../../helpers/db-helper';
import { setupAcceptedEvent } from '../../helpers/setup-flows';
import { fakeEmail, fakeGoogleCalendar, FakeGoogleCalendarEvent } from '../../helpers/fake-providers';
import {
  apiConnectGoogleCalendar,
  apiGetGoogleConnection,
  apiGetGooglePendingSummary,
  apiGetLatestGoogleSyncRun,
  apiListGooglePending,
  isActiveSyncRun,
  moveEvent,
  waitConnectionStatus,
  waitForGoogleEvent,
  waitForGoogleSyncIdle,
  waitForGoogleSyncRun,
} from '../../helpers/external-calendar';
import { apiErrorCodes } from '../../helpers/response';
import { snack } from '../../helpers/ui';

/**
 * Fluxo: 8.4 — Agenda externa: central de pendências (reenviar, resolver a causa, espelhar o que falta)
 * Plano: docs/implementar/PLANO-AGENDAS-EXTERNAS.md §5b (GC-F), §3.6, §3.7, §8.1 itens 4 e 6,
 *        decisões 26 a 31 (§9.4); registro e2e §12 (E9, E10, E11, E12, E13, E24, E25, E26)
 * Diagrama: docs/fluxos/negocio-8.4-agenda-externa-pendencias.mmd
 *
 * Integração pelo fake `fake-providers/google-calendar` (porta 1517); cada
 * teste usa um tenant e uma conta Google próprios no fake. O popup do GIS não
 * roda no E2E (plano §12): reconectar é `connect-intent` + código do fake +
 * step-up + `connect`, pela API.
 *
 * Como o spec segura um estado determinístico:
 * - falha transitória: fake em `500` até o spec limpar. O Outbox reenvia com
 *   backoff (1 s, 5 s, 30 s...), então o que importa é a falha continuar ligada
 *   enquanto o spec observa, e ser desligada só no instante da ação;
 * - token revogado: `revokeAccount` + uma mudança no evento que o back tenta espelhar;
 * - agenda apagada SEM perder o estado: modo `404calendar` (toda chamada da
 *   conta dá 404); limpar o modo é "a agenda voltou". Apagar de vez é
 *   `deleteCalendarByHand`.
 */

const CALENDAR_ROUTE = '/app/schedule/calendar';
const SETTINGS_ROUTE = '/app/settings/external-calendars';
const PENDING_ROUTE = '/app/settings/external-calendars/pendencias';

function todayPlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Mesma data do `setupAcceptedEvent` (hoje + 30). */
const EVENT_DATE = todayPlus(30);

/** O dono da conta revoga o acesso no Google; a próxima mudança do evento descobre. */
async function revokeAndDetect(api: APIRequestContext, sub: string, eventId: string): Promise<void> {
  await fakeGoogleCalendar.revokeAccount(sub);
  await moveEvent(api, eventId, 15);
  await waitConnectionStatus(api, 'TokenRevoked');
}

/** A agenda dedicada "some" (404 em tudo) até a próxima mudança do evento descobrir; depois "volta". */
async function calendarGoneAndDetect(api: APIRequestContext, sub: string, eventId: string): Promise<void> {
  await fakeGoogleCalendar.setFailure(sub, '404calendar');
  try {
    await moveEvent(api, eventId, 16);
    await waitConnectionStatus(api, 'CalendarNotFound');
  } finally {
    await fakeGoogleCalendar.clearFailure(sub);
  }
}

/** Eventos vivos de UMA agenda do fake (o `eventFor` olha todas as agendas da conta, inclusive as apagadas). */
async function liveEventsOf(calendarId: string): Promise<FakeGoogleCalendarEvent[]> {
  return (await fakeGoogleCalendar.calendar(calendarId)).events.filter((e) => e.status !== 'cancelled');
}

function markerOf(ev: FakeGoogleCalendarEvent): string | undefined {
  return ev.extendedProperties?.private?.recreativoEventId;
}

async function attemptsOf(api: APIRequestContext, eventId: string): Promise<number> {
  return (await apiListGooglePending(api, 'Failed')).find((i) => i.eventId === eventId)?.attempts ?? 0;
}

function isEventFailure(eventId: string) {
  return (n: NotificationItem) =>
    n.type === 'ExternalCalendarSyncFailed' && n.contextEntityType === 'Event' && n.contextEntityId === eventId;
}

const isAggregatedFailure = (n: NotificationItem) =>
  n.type === 'ExternalCalendarSyncFailed' && n.contextEntityType === 'ExternalCalendarConnection';

/** Abre o sino e a notificação pedida (o card inteiro é o link). */
async function openNotification(page: Page, notificationId: string): Promise<void> {
  await page.getByTestId('notification-bell').click();
  const open = page.getByTestId(`notification-open-${notificationId}`);
  await expect(open).toBeVisible({ timeout: 15_000 });
  await open.click();
}

test.describe('Fluxo 8.4 — Agenda externa: central de pendências', () => {
  // E9 — plano §5b.1 item 8 (decisão 30), §5b.2 itens 1 e 3, §5b.1 item 7 (chip âmbar).
  test('@flow E9 4 falhas em 24 h: 2 avisos por evento e um agregado que abre a central; "Reenviar todas as falhas (4)" zera a aba e o chip volta ao verde', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(420_000);
    await apiCompleteOnboarding(authApi);
    const connected = await apiConnectGoogleCalendar(authApi, tenant.password);
    await waitForGoogleSyncIdle(authApi, { description: 'run AfterConnect do connect' });

    const events: string[] = [];
    for (let i = 0; i < 4; i++) {
      const { eventId } = await setupAcceptedEvent(authApi);
      await waitForGoogleEvent(connected.sub, eventId, (e) => e?.status === 'confirmed', {
        description: `evento ${i + 1} espelhado`,
      });
      events.push(eventId);
    }

    await fakeGoogleCalendar.setFailure(connected.sub, '500');
    let failureOn = true;
    try {
      // Um evento por vez: cada um falha 3 vezes seguidas (o Outbox reenvia em
      // 1 s e 5 s) antes do próximo mudar, então a ordem dos avisos é a dos eventos.
      for (const [i, eventId] of events.entries()) {
        await moveEvent(authApi, eventId, 15);
        await expect
          .poll(() => attemptsOf(authApi, eventId), {
            timeout: 60_000,
            intervals: [1_000],
            message: `evento ${i + 1} falha 3 vezes no Google`,
          })
          .toBeGreaterThanOrEqual(3);

        if (i < 2) {
          // Os 2 primeiros: um aviso por evento.
          await expect
            .poll(async () => (await apiListNotifications(authApi)).some(isEventFailure(eventId)), {
              timeout: 30_000,
              message: `aviso individual do evento ${i + 1}`,
            })
            .toBe(true);
        } else if (i === 2) {
          // Do 3º em diante: um aviso só por (tenant, provedor).
          await expect
            .poll(async () => (await apiListNotifications(authApi)).some(isAggregatedFailure), {
              timeout: 30_000,
              message: 'aviso agregado no 3º evento',
            })
            .toBe(true);
        }
      }

      const notifications = await apiListNotifications(authApi);
      const individual = notifications.filter(
        (n) => n.type === 'ExternalCalendarSyncFailed' && n.contextEntityType === 'Event',
      );
      expect(individual.map((n) => n.contextEntityId).sort(), 'avisos por evento só dos 2 primeiros').toEqual(
        [events[0], events[1]].sort(),
      );
      const aggregated = notifications.filter(isAggregatedFailure);
      expect(aggregated, 'um aviso agregado por provedor').toHaveLength(1);
      expect(aggregated[0]!.message).toContain('Google Agenda');
      expect(aggregated[0]!.message).toContain('Toque para resolver');

      // Chip âmbar com o número no header do calendário.
      await expect
        .poll(async () => (await apiGetGoogleConnection(authApi))?.pendingCount, { timeout: 30_000 })
        .toBe(4);
      await authPage.goto(CALENDAR_ROUTE);
      const chip = authPage.getByTestId('external-calendar-chip-google');
      await expect(chip).toHaveAttribute('data-tone', 'warn', { timeout: 20_000 });
      await expect(authPage.getByTestId('external-calendar-pending-google')).toContainText('4 pendências');

      // A notificação agregada abre a central (sem `eventId`), na aba "Com falha (4)".
      await openNotification(authPage, aggregated[0]!.id);
      await authPage.waitForURL((url) => url.pathname === PENDING_ROUTE && !url.searchParams.has('eventId'), {
        timeout: 15_000,
      });
      await expect(authPage.getByRole('tab', { name: 'Com falha (4)' })).toHaveAttribute('aria-selected', 'true', {
        timeout: 20_000,
      });
      for (const eventId of events) {
        await expect(authPage.getByTestId(`external-calendar-pending-row-${eventId}`)).toBeVisible();
        // Causa traduzida e "falhando desde".
        const cause = authPage.getByTestId(`external-calendar-pending-cause-${eventId}`);
        await expect(cause).toHaveText('Provedor instável');
        await expect(cause).toHaveAttribute('data-kind', 'Transient');
        await expect(authPage.getByTestId(`external-calendar-pending-since-${eventId}`)).not.toHaveText('—');
      }
      await expect(authPage.getByTestId('external-calendar-pending-cause-card')).toContainText('Falhando desde');

      // "Reenviar todas as falhas (4)": confirmação com o número, progresso, aba zerada.
      const resendAll = authPage.getByTestId('external-calendar-pending-resend-failed');
      await expect(resendAll).toContainText('Reenviar todas as falhas (4)');
      await resendAll.click();
      await expect(authPage.getByTestId('confirm-message')).toContainText('4 eventos com falha');
      // O Google volta no instante da confirmação: antes disso o Outbox não acerta nenhum.
      await fakeGoogleCalendar.clearFailure(connected.sub);
      failureOn = false;
      await authPage.getByTestId('confirm-ok').click();

      await expect(authPage.getByTestId('external-calendar-pending-progress')).toBeVisible({ timeout: 10_000 });
      await expect(authPage.getByTestId('external-calendar-pending-progress-label')).toContainText(
        'Reenviando as falhas',
      );
      await expect(snack(authPage, 'Google:')).toBeVisible({ timeout: 120_000 });
      const run = await apiGetLatestGoogleSyncRun(authApi);
      expect(run?.scope).toBe('FailedOnly');
      expect(run?.trigger).toBe('Manual');

      await expect(authPage.getByTestId('external-calendar-pending-all-clear')).toBeVisible({ timeout: 30_000 });
      expect((await apiGetGooglePendingSummary(authApi)).failed).toBe(0);
      for (const eventId of events) {
        const ev = await fakeGoogleCalendar.eventFor(connected.sub, eventId);
        expect(ev?.status).toBe('confirmed');
        expect(ev?.start?.dateTime).toBe(`${EVENT_DATE}T15:00:00`);
      }

      // O chip do calendário volta ao verde.
      await authPage.goto(CALENDAR_ROUTE);
      await expect(authPage.getByTestId('external-calendar-chip-google')).toHaveAttribute('data-tone', 'ok', {
        timeout: 20_000,
      });
      await expect(authPage.getByTestId('external-calendar-pending-google')).toHaveCount(0);
    } finally {
      if (failureOn) await fakeGoogleCalendar.clearFailure(connected.sub);
    }
  });

  // E10 — plano §5b.1 item 5 (regra de preservação, decisão 28), §3.6 (`Missing`), §5b.2 item 1.
  test('@flow E10 reconectar a mesma conta reusa a agenda, preserva os links e roda "Ao reconectar" (FailedOnly); os criados no intervalo ficam em "Nunca espelhados" até "Espelhar todos os que faltam"', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(300_000);
    await apiCompleteOnboarding(authApi);
    const connected = await apiConnectGoogleCalendar(authApi, tenant.password);
    await waitForGoogleSyncIdle(authApi, { description: 'run AfterConnect do connect' });

    const before = await setupAcceptedEvent(authApi);
    const mirrored = await waitForGoogleEvent(connected.sub, before.eventId, (e) => e?.status === 'confirmed', {
      description: 'evento espelhado antes da revogação',
    });
    const externalId = mirrored!.id;

    // Conta desconectada (token revogado); um evento nasce nesse intervalo.
    await revokeAndDetect(authApi, connected.sub, before.eventId);
    const during = await setupAcceptedEvent(authApi);

    // Reconectar com a MESMA conta.
    const reconnected = await apiConnectGoogleCalendar(authApi, tenant.password, {
      sub: connected.sub,
      email: connected.email,
    });
    const google = reconnected.status.connections.find((c) => c.provider === 'google');
    expect(google?.status).toBe('Connected');

    // Reusa a agenda anterior: nenhuma agenda nova na conta.
    expect(reconnected.calendarId).toBe(connected.calendarId);
    const account = await fakeGoogleCalendar.account(connected.sub);
    expect(account.calendars.filter((c) => !c.deleted)).toHaveLength(1);

    // O run "Ao reconectar" só reenvia o que falhou.
    const run = await waitForGoogleSyncRun(authApi, (r) => r?.trigger === 'Reconnected' && !isActiveSyncRun(r), {
      timeoutMs: 120_000,
      intervalMs: 2_000,
      description: 'run Reconnected terminado',
    });
    expect(run!.scope).toBe('FailedOnly');

    // Links preservados: o mesmo evento lá (mesmo id), atualizado, sem duplicata.
    const after = await waitForGoogleEvent(
      connected.sub,
      before.eventId,
      (e) => e?.status === 'confirmed' && e.start?.dateTime === `${EVENT_DATE}T15:00:00`,
      { description: 'evento que falhou volta atualizado no mesmo id' },
    );
    expect(after!.id).toBe(externalId);
    const sameMarker = (await liveEventsOf(connected.calendarId)).filter((e) => markerOf(e) === before.eventId);
    expect(sameMarker).toHaveLength(1);

    // O criado enquanto estava desconectado NÃO foi enviado pelo reconectar.
    expect(await fakeGoogleCalendar.eventFor(connected.sub, during.eventId)).toBeUndefined();
    expect((await apiListGooglePending(authApi, 'Missing')).map((i) => i.eventId)).toContain(during.eventId);

    // O run aparece em "Últimas sincronizações" como "Ao reconectar".
    await authPage.goto(SETTINGS_ROUTE);
    await expect(authPage.getByTestId(`external-calendars-run-${run!.id}`)).toContainText('Ao reconectar', {
      timeout: 20_000,
    });

    // Central, aba "Nunca espelhados (1)": "Espelhar todos os que faltam (1)" leva ao Google.
    await authPage.goto(`${PENDING_ROUTE}?tab=Missing`);
    await expect(authPage.getByRole('tab', { name: 'Nunca espelhados (1)' })).toHaveAttribute(
      'aria-selected',
      'true',
      { timeout: 20_000 },
    );
    await expect(authPage.getByTestId(`external-calendar-pending-row-${during.eventId}`)).toBeVisible();
    const syncMissing = authPage.getByTestId('external-calendar-pending-sync-missing');
    await expect(syncMissing).toContainText('Espelhar todos os que faltam (1)');
    await syncMissing.click();
    await authPage.getByTestId('confirm-ok').click();
    await expect(authPage.getByTestId('external-calendar-pending-progress')).toBeVisible({ timeout: 10_000 });

    await waitForGoogleEvent(connected.sub, during.eventId, (e) => e?.status === 'confirmed', {
      description: 'evento que faltava espelhado pelo lote',
      timeoutMs: 90_000,
    });
    const missingRun = await waitForGoogleSyncRun(authApi, (r) => r?.trigger === 'Manual' && !isActiveSyncRun(r), {
      description: 'run do lote terminado',
    });
    expect(missingRun!.scope).toBe('MissingOnly');
    await expect(authPage.getByTestId('external-calendar-pending-all-clear')).toBeVisible({ timeout: 30_000 });
  });

  // E11 — plano §5b.1 item 5 (decisão 28: conta diferente limpa os ids externos, run FutureAll), §7.
  test('@flow E11 reconectar com outra conta cria agenda nova nela, limpa os ids externos e um run FutureAll recria tudo', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(300_000);
    await apiCompleteOnboarding(authApi);
    const first = await apiConnectGoogleCalendar(authApi, tenant.password);
    await waitForGoogleSyncIdle(authApi, { description: 'run AfterConnect do connect' });

    const a = await setupAcceptedEvent(authApi);
    const b = await setupAcceptedEvent(authApi);
    const oldIds: string[] = [];
    for (const id of [a.eventId, b.eventId]) {
      const ev = await waitForGoogleEvent(first.sub, id, (e) => e?.status === 'confirmed', {
        description: `evento ${id} na conta antiga`,
      });
      oldIds.push(ev!.id);
    }

    await revokeAndDetect(authApi, first.sub, a.eventId);

    // Outra conta Google (sub novo no fake).
    const since = new Date().toISOString();
    const second = await apiConnectGoogleCalendar(authApi, tenant.password);
    expect(second.sub).not.toBe(first.sub);
    expect(second.calendarId).not.toBe(first.calendarId);
    const secondAccount = await fakeGoogleCalendar.account(second.sub);
    expect(secondAccount.calendars.filter((c) => !c.deleted)).toHaveLength(1);
    expect(secondAccount.calendars[0]!.summary).toBe('Recreativo — Eventos');

    const run = await waitForGoogleSyncRun(authApi, (r) => r?.trigger === 'Reconnected' && !isActiveSyncRun(r), {
      timeoutMs: 120_000,
      intervalMs: 2_000,
      description: 'run Reconnected terminado',
    });
    expect(run!.scope).toBe('FutureAll');

    // Tudo recriado na conta nova, na agenda nova.
    for (const id of [a.eventId, b.eventId]) {
      const ev = await waitForGoogleEvent(second.sub, id, (e) => e?.status === 'confirmed', {
        description: `evento ${id} recriado na conta nova`,
      });
      expect(ev!.calendarId).toBe(second.calendarId);
    }

    // Ids externos limpos: depois da troca, nenhuma chamada com os ids da conta antiga.
    for (const oldId of oldIds) {
      expect(await fakeGoogleCalendar.inbox({ path: oldId, since })).toHaveLength(0);
    }
    expect((await apiGetGooglePendingSummary(authApi)).failed).toBe(0);
  });

  // E12 (1/2) — plano §5b.1 item 5 (`ConnectionNeedsAttention`, decisão 31), §5b.2 item 1 (botão da causa), §3.7.
  test('@flow E12 token revogado: card vermelho com "Reconectar" e o lote "Reenviar" recusado com "reconecte primeiro"', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(240_000);
    await apiCompleteOnboarding(authApi);
    const connected = await apiConnectGoogleCalendar(authApi, tenant.password);
    await waitForGoogleSyncIdle(authApi, { description: 'run AfterConnect do connect' });
    const { eventId } = await setupAcceptedEvent(authApi);
    await waitForGoogleEvent(connected.sub, eventId, (e) => e?.status === 'confirmed', { description: 'evento espelhado' });

    await revokeAndDetect(authApi, connected.sub, eventId);

    // A API recusa o lote: reconecte primeiro.
    const resend = await authApi.post('/api/calendar/google/pending/resend-failed');
    expect(resend.status()).toBe(409);
    const body = await resend.json();
    expect(((body.errors ?? []) as Array<{ code: string }>).map((e) => e.code)).toContain(
      'ExternalCalendar.ConnectionNeedsAttention',
    );
    expect(JSON.stringify(body.errors)).toContain('Reconecte');

    // A central: card vermelho com "Reconectar"; o lote não aparece, a tela manda resolver antes.
    await authPage.goto(PENDING_ROUTE);
    const status = authPage.getByTestId('external-calendar-pending-connection-status');
    await expect(status).toHaveText('Reconexão necessária', { timeout: 20_000 });
    await expect(status).toHaveClass(/text-red-700/);
    await expect(authPage.getByTestId('external-calendar-pending-cause')).toHaveAttribute('data-kind', 'Unauthorized');
    await expect(authPage.getByTestId('external-calendar-pending-reconnect')).toBeVisible();
    await expect(authPage.getByTestId('external-calendar-pending-resend-failed')).toHaveCount(0);
    await expect(authPage.getByTestId('external-calendar-pending-resolve-first')).toContainText('Resolva a conexão');
  });

  // E12 (2/2) — plano §5b.1 item 5 (`RecreateCalendarAsync`), §8.1 item 6 (recriar só depois do 404),
  // §3.7 (`CalendarStillExists`), nota da Etapa 216 em §12 (`CalendarNotFound`), §4.2 item 4 (detalhe).
  test('@flow E12 agenda apagada: CalendarNotFound (chip vermelho, detalhe sem "Tentar de novo" e com o link de recriar); "Recriar agenda" só depois do 404 e devolve os eventos na agenda nova', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(300_000);
    await apiCompleteOnboarding(authApi);
    const connected = await apiConnectGoogleCalendar(authApi, tenant.password);
    await waitForGoogleSyncIdle(authApi, { description: 'run AfterConnect do connect' });
    const { eventId } = await setupAcceptedEvent(authApi);
    await waitForGoogleEvent(connected.sub, eventId, (e) => e?.status === 'confirmed', { description: 'evento espelhado' });

    // A agenda some (404 em tudo); depois "volta" (o modo é limpo).
    await calendarGoneAndDetect(authApi, connected.sub, eventId);

    // Chip vermelho no calendário.
    await authPage.goto(CALENDAR_ROUTE);
    await expect(authPage.getByTestId('external-calendar-chip-google')).toHaveAttribute('data-tone', 'error', {
      timeout: 20_000,
    });

    // Detalhe do evento: sem "Tentar de novo", com o link para recriar, que leva à central.
    await authPage.goto(`/app/events/${eventId}`);
    await expect(authPage.getByTestId('event-external-calendar-google')).toBeVisible({ timeout: 20_000 });
    await expect(authPage.getByTestId('event-external-calendar-resync-google')).toHaveCount(0);
    const recreateLink = authPage.getByTestId('event-external-calendar-recreate-google');
    await expect(recreateLink).toBeVisible();
    await recreateLink.click();
    await authPage.waitForURL((url) => url.pathname === PENDING_ROUTE, { timeout: 15_000 });
    await expect(authPage.getByTestId('external-calendar-pending-cause')).toHaveAttribute('data-kind', 'NotFoundCalendar', {
      timeout: 20_000,
    });

    // Com a agenda de volta, recriar é recusado e nada é criado.
    const recreate = authPage.getByTestId('external-calendar-pending-recreate');
    await recreate.click();
    await expect(authPage.getByTestId('confirm-title')).toHaveText('Recriar agenda');
    await authPage.getByTestId('confirm-ok').click();
    await expect(snack(authPage, 'não há nada a recriar')).toBeVisible({ timeout: 15_000 });
    const stillExists = await authApi.post('/api/calendar/google/recreate-calendar');
    expect(stillExists.status()).toBe(409);
    expect(await apiErrorCodes(stillExists)).toContain('ExternalCalendar.CalendarStillExists');
    const unchanged = await fakeGoogleCalendar.account(connected.sub);
    expect(unchanged.calendars, 'nenhuma agenda criada enquanto a antiga existe').toHaveLength(1);

    // A agenda é apagada de vez: o 404 confirma e recriar devolve os eventos na agenda nova.
    await fakeGoogleCalendar.deleteCalendarByHand(connected.calendarId);
    await expect(recreate).toBeEnabled({ timeout: 10_000 });
    await recreate.click();
    await authPage.getByTestId('confirm-ok').click();
    await expect(snack(authPage, 'Agenda recriada')).toBeVisible({ timeout: 15_000 });

    const account = await fakeGoogleCalendar.account(connected.sub);
    const alive = account.calendars.filter((c) => !c.deleted);
    expect(alive).toHaveLength(1);
    const newCalendarId = alive[0]!.id;
    expect(newCalendarId).not.toBe(connected.calendarId);
    await expect
      .poll(async () => (await liveEventsOf(newCalendarId)).some((e) => markerOf(e) === eventId), {
        timeout: 90_000,
        intervals: [2_000],
        message: 'evento de volta na agenda recriada',
      })
      .toBe(true);
    await waitConnectionStatus(authApi, 'Connected');
  });

  // E13 — plano §5b.3 item 7 (RBAC e cross-tenant), §5b.2 item 1 (ações pedem events.update / settings.update),
  // §3.7 (`CalendarLink.NotFound`).
  test('@flow E13 Financial lê a central sem botões e recebe 403 nos lotes; Manager reenvia mas não vê Reconectar/Recriar e recebe 403 no recriar; resend de outro tenant dá 404', async ({
    authApi,
    tenant,
    browser,
  }) => {
    test.setTimeout(360_000);
    await apiCompleteOnboarding(authApi);
    const connected = await apiConnectGoogleCalendar(authApi, tenant.password);
    await waitForGoogleSyncIdle(authApi, { description: 'run AfterConnect do connect' });
    const { eventId } = await setupAcceptedEvent(authApi);
    await waitForGoogleEvent(connected.sub, eventId, (e) => e?.status === 'confirmed', { description: 'evento espelhado' });

    const manager = seedUserWithRoleDirect({ tenantId: tenant.tenantId, role: 'Manager', emailPrefix: 'manager-pend' });
    const financial = seedUserWithRoleDirect({
      tenantId: tenant.tenantId,
      role: 'Financial',
      emailPrefix: 'financial-pend',
    });
    const managerTokens = await loginViaApi(authApi, manager.email, manager.password);
    const financialTokens = await loginViaApi(authApi, financial.email, financial.password);
    const managerApi = await createBearerApiContext(managerTokens.accessToken);
    const financialApi = await createBearerApiContext(financialTokens.accessToken);
    const managerPage = await openPageWithTokens(browser, managerTokens);
    const financialPage = await openPageWithTokens(browser, financialTokens);

    const other = await signupNewTenant();
    const otherApi = await createBearerApiContext(other.accessToken);

    await fakeGoogleCalendar.setFailure(connected.sub, '500');
    let failureOn = true;
    try {
      await moveEvent(authApi, eventId, 15);
      await expect
        .poll(async () => (await apiListGooglePending(authApi, 'Failed')).map((i) => i.eventId), {
          timeout: 60_000,
          intervals: [2_000],
        })
        .toContain(eventId);

      // Financial (`events.read`): lê a central, sem lote nem ação de linha; 403 nos dois lotes.
      await financialPage.goto(PENDING_ROUTE);
      await expect(financialPage.getByTestId(`external-calendar-pending-row-${eventId}`)).toBeVisible({
        timeout: 20_000,
      });
      await expect(financialPage.getByTestId('external-calendar-pending-resend-failed')).toHaveCount(0);
      await expect(financialPage.getByTestId(`external-calendar-pending-resend-${eventId}`)).toHaveCount(0);
      expect((await financialApi.get('/api/calendar/google/pending/summary')).status()).toBe(200);
      expect((await financialApi.post('/api/calendar/google/pending/resend-failed')).status()).toBe(403);
      expect((await financialApi.post('/api/calendar/google/pending/sync-missing')).status()).toBe(403);

      // Manager (`events.update`): reenvia pelo lote.
      await managerPage.goto(PENDING_ROUTE);
      const resendAll = managerPage.getByTestId('external-calendar-pending-resend-failed');
      await expect(resendAll).toBeVisible({ timeout: 20_000 });
      await resendAll.click();
      await expect(managerPage.getByTestId('confirm-title')).toBeVisible();
      await fakeGoogleCalendar.clearFailure(connected.sub);
      failureOn = false;
      await managerPage.getByTestId('confirm-ok').click();
      const run = await waitForGoogleSyncRun(
        authApi,
        (r) => r?.trigger === 'Manual' && r.scope === 'FailedOnly' && !isActiveSyncRun(r),
        { timeoutMs: 90_000, description: 'lote do Manager terminado' },
      );
      expect(run!.requestedByName).toBe('Test Manager');
      await waitForGoogleEvent(
        connected.sub,
        eventId,
        (e) => e?.status === 'confirmed' && e.start?.dateTime === `${EVENT_DATE}T15:00:00`,
        { description: 'reenvio do Manager chega ao Google' },
      );

      // Agenda apagada: o Manager (sem `settings.update`) não vê Reconectar nem Recriar, e o recriar dá 403.
      await calendarGoneAndDetect(authApi, connected.sub, eventId);
      await managerPage.goto(PENDING_ROUTE);
      await expect(managerPage.getByTestId('external-calendar-pending-cause')).toHaveAttribute(
        'data-kind',
        'NotFoundCalendar',
        { timeout: 20_000 },
      );
      await expect(managerPage.getByTestId('external-calendar-pending-ask-admin')).toBeVisible();
      await expect(managerPage.getByTestId('external-calendar-pending-recreate')).toHaveCount(0);
      await expect(managerPage.getByTestId('external-calendar-pending-reconnect')).toHaveCount(0);
      expect((await managerApi.post('/api/calendar/google/recreate-calendar')).status()).toBe(403);

      // `resend` de evento de outro tenant (conectado, para o 409 NotConnected não mascarar): 404.
      await apiConnectGoogleCalendar(otherApi, other.password);
      const cross = await otherApi.post(`/api/calendar/google/events/${eventId}/resend`);
      expect(cross.status()).toBe(404);
      expect(await apiErrorCodes(cross)).toContain('CalendarLink.NotFound');
    } finally {
      if (failureOn) await fakeGoogleCalendar.clearFailure(connected.sub);
      await managerPage.context().close();
      await financialPage.context().close();
      await managerApi.dispose();
      await financialApi.dispose();
      await otherApi.dispose();
    }
  });

  // E24 — plano §5b.2 item 1 (`?eventId=` destaca a linha) e item 2 (sino → central), §4.2.5.
  test('@flow E24 a notificação de UM evento abre "Com falha" com a linha destacada; a de conta desconectada abre a central com "Reconectar"', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(300_000);
    await apiCompleteOnboarding(authApi);
    const connected = await apiConnectGoogleCalendar(authApi, tenant.password);
    await waitForGoogleSyncIdle(authApi, { description: 'run AfterConnect do connect' });
    const { eventId } = await setupAcceptedEvent(authApi);
    await waitForGoogleEvent(connected.sub, eventId, (e) => e?.status === 'confirmed', { description: 'evento espelhado' });

    await fakeGoogleCalendar.setFailure(connected.sub, '500');
    let failure: NotificationItem | undefined;
    try {
      await moveEvent(authApi, eventId, 15);
      await expect
        .poll(
          async () => {
            failure = (await apiListNotifications(authApi)).find(isEventFailure(eventId));
            return failure !== undefined;
          },
          { timeout: 90_000, intervals: [2_000], message: 'aviso de falha do evento' },
        )
        .toBe(true);

      // O aviso de UM evento abre "Com falha" com a linha dele destacada.
      await authPage.goto(CALENDAR_ROUTE);
      await openNotification(authPage, failure!.id);
      await authPage.waitForURL(
        (url) => url.pathname === PENDING_ROUTE && url.searchParams.get('eventId') === eventId,
        { timeout: 15_000 },
      );
      await expect(authPage.getByRole('tab', { name: /^Com falha/ })).toHaveAttribute('aria-selected', 'true', {
        timeout: 20_000,
      });
      await expect(authPage.getByTestId(`external-calendar-pending-row-${eventId}`)).toHaveAttribute(
        'data-highlighted',
        'true',
      );

      // Conta revogada: o aviso de desconexão abre a central com o "Reconectar".
      await fakeGoogleCalendar.revokeAccount(connected.sub);
    } finally {
      await fakeGoogleCalendar.clearFailure(connected.sub);
    }
    await moveEvent(authApi, eventId, 16);
    await waitConnectionStatus(authApi, 'TokenRevoked');
    let disconnected: NotificationItem | undefined;
    await expect
      .poll(
        async () => {
          disconnected = (await apiListNotifications(authApi)).find((n) => n.type === 'ExternalCalendarDisconnected');
          return disconnected !== undefined;
        },
        { timeout: 30_000, message: 'aviso de conta desconectada' },
      )
      .toBe(true);

    await authPage.goto(CALENDAR_ROUTE);
    await openNotification(authPage, disconnected!.id);
    await authPage.waitForURL((url) => url.pathname === PENDING_ROUTE, { timeout: 15_000 });
    await expect(authPage.getByTestId('external-calendar-pending-reconnect')).toBeVisible({ timeout: 20_000 });
  });

  // E25 — plano §8.1 item 4 ("conexão nova ou troca de conta → e-mail ao Owner"; F na reconexão).
  test('@flow E25 reconectar com outra conta Google manda ao Owner o e-mail de conexão dizendo qual conta saiu', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(240_000);
    await apiCompleteOnboarding(authApi);
    const first = await apiConnectGoogleCalendar(authApi, tenant.password);
    await waitForGoogleSyncIdle(authApi, { description: 'run AfterConnect do connect' });
    const { eventId } = await setupAcceptedEvent(authApi);
    await waitForGoogleEvent(first.sub, eventId, (e) => e?.status === 'confirmed', { description: 'evento espelhado' });

    await revokeAndDetect(authApi, first.sub, eventId);
    const second = await apiConnectGoogleCalendar(authApi, tenant.password);
    expect(second.email).not.toBe(first.email);

    const connectionEmails = async () =>
      (await fakeEmail.emails({ to: tenant.email })).filter((m) => m.subject.includes('Agenda externa conectada'));
    await expect
      .poll(async () => (await connectionEmails()).some((m) => m.bodyHtml.includes(second.email)), {
        timeout: 30_000,
        message: 'e-mail de conexão da conta nova ao Owner',
      })
      .toBe(true);
    const replaced = (await connectionEmails()).find((m) => m.bodyHtml.includes(second.email))!;
    expect(replaced.bodyHtml, 'o e-mail diz qual conta saiu').toContain(first.email);
    expect(replaced.bodyHtml).toContain('substituiu a conta');
  });

  // E26 — plano §5b.2 item 2 (portas de entrada), §5b.1 item 7 (`PendingCount` no chip).
  test('@flow E26 as portas de entrada levam à central: chip âmbar do calendário, "Ver pendências (N)" e o "Ver falhas" do Sincronizar', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(360_000);
    await apiCompleteOnboarding(authApi);
    const connected = await apiConnectGoogleCalendar(authApi, tenant.password);
    await waitForGoogleSyncIdle(authApi, { description: 'run AfterConnect do connect' });

    const events: string[] = [];
    for (let i = 0; i < 2; i++) {
      const { eventId } = await setupAcceptedEvent(authApi);
      await waitForGoogleEvent(connected.sub, eventId, (e) => e?.status === 'confirmed', {
        description: `evento ${i + 1} espelhado`,
      });
      events.push(eventId);
    }

    await fakeGoogleCalendar.setFailure(connected.sub, '500');
    let failureOn = true;
    try {
      for (const eventId of events) await moveEvent(authApi, eventId, 15);
      await expect
        .poll(async () => (await apiGetGoogleConnection(authApi))?.pendingCount, {
          timeout: 60_000,
          intervals: [2_000],
          message: 'os dois eventos em falha contam no chip',
        })
        .toBe(2);

      // 1) Chip âmbar com o número no header do calendário.
      await authPage.goto(CALENDAR_ROUTE);
      await expect(authPage.getByTestId('external-calendar-chip-google')).toHaveAttribute('data-tone', 'warn', {
        timeout: 20_000,
      });
      const pendingChip = authPage.getByTestId('external-calendar-pending-google');
      await expect(pendingChip).toContainText('2 pendências');
      await pendingChip.click();
      await authPage.waitForURL((url) => url.pathname === PENDING_ROUTE, { timeout: 15_000 });
      await expect(authPage.getByTestId('external-calendar-pending-title')).toBeVisible({ timeout: 20_000 });
      await expect(authPage.getByRole('tab', { name: 'Com falha (2)' })).toBeVisible();

      // 2) "Ver pendências (N)" em Configurações → Agendas externas.
      await authPage.goto(SETTINGS_ROUTE);
      const pendingLink = authPage.getByTestId('external-calendars-pending-link-google');
      await expect(pendingLink).toContainText('Ver pendências (2)', { timeout: 20_000 });
      await pendingLink.click();
      await authPage.waitForURL((url) => url.pathname === PENDING_ROUTE, { timeout: 15_000 });
      await expect(authPage.getByTestId('external-calendar-pending-title')).toBeVisible({ timeout: 20_000 });

      // 3) O "Ver falhas" do snack do "Sincronizar" abre a central na aba "Com falha".
      await authPage.goto(CALENDAR_ROUTE);
      const button = authPage.getByTestId('external-calendar-sync-button-google');
      await expect(button).toBeVisible({ timeout: 20_000 });
      await button.click();
      await waitForGoogleSyncRun(
        authApi,
        (r) => r?.trigger === 'Manual' && (r.failed >= 2 || !isActiveSyncRun(r)),
        { timeoutMs: 60_000, description: 'a fase de eventos do run conta as falhas' },
      );
      // O Google volta para a caça a órfãos (última fase) e o run termina com falhas.
      await fakeGoogleCalendar.clearFailure(connected.sub);
      failureOn = false;
      const run = await waitForGoogleSyncRun(authApi, (r) => r?.trigger === 'Manual' && !isActiveSyncRun(r), {
        timeoutMs: 180_000,
        intervalMs: 2_000,
        description: 'run manual terminado',
      });
      expect(run!.status).toBe('CompletedWithErrors');

      const warning = snack(authPage, 'Google:');
      await expect(warning).toBeVisible({ timeout: 30_000 });
      await warning.getByRole('button', { name: 'Ver falhas' }).click();
      await authPage.waitForURL(
        (url) => url.pathname === PENDING_ROUTE && url.searchParams.get('tab') === 'Failed',
        { timeout: 15_000 },
      );
      await expect(authPage.getByTestId('external-calendar-pending-title')).toBeVisible({ timeout: 20_000 });
    } finally {
      if (failureOn) await fakeGoogleCalendar.clearFailure(connected.sub);
    }
  });
});
