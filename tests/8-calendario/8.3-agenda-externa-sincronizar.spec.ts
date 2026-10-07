import { randomUUID } from 'crypto';
import { APIRequestContext } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCompleteOnboarding } from '../../helpers/api-entities';
import {
  createBearerApiContext,
  loginViaApi,
  openPageWithTokens,
  signupNewTenant,
} from '../../helpers/api-client';
import { seedUserWithRoleDirect } from '../../helpers/db-helper';
import { setupAcceptedEvent } from '../../helpers/setup-flows';
import { fakeGoogleCalendar } from '../../helpers/fake-providers';
import {
  apiConnectGoogleCalendar,
  apiGetLatestGoogleSyncRun,
  apiListEventsBySyncStatus,
  isActiveSyncRun,
  waitForGoogleEvent,
  waitForGoogleSyncIdle,
  waitForGoogleSyncRun,
} from '../../helpers/external-calendar';
import { apiErrorCodes } from '../../helpers/response';
import { snack } from '../../helpers/ui';

/**
 * Fluxo: 8.3 — Agenda externa: "Sincronizar" e reconciliação
 * Plano: docs/implementar/fase2/PLANO-AGENDAS-EXTERNAS.md §5 (GC-B), §3.7, §8.1 itens 2, 6, 11 e 14;
 *        registro e2e §12 (E7, E8, E18, E19, E20)
 * Diagrama: docs/fluxos/negocio-8.3-agenda-externa-sincronizar.mmd
 *
 * Integração pelo fake `fake-providers/google-calendar` (porta 1517); cada
 * teste usa um tenant e uma conta Google próprios no fake. O cooldown de 5 min
 * do "Sincronizar" manual (§8.1 item 6) é por tenant, então cada teste faz no
 * máximo um pedido manual que passa.
 *
 * Como o spec segura um run "em andamento": com o fake em `500`, a listagem da
 * agenda (caça a órfãos, última fase do run) falha de forma transitória e a
 * página volta para o Outbox com backoff (1 s, 5 s, 30 s...), então o run fica
 * `Running` até o spec limpar a falha.
 */

const CALENDAR_ROUTE = '/app/schedule/calendar';
const SETTINGS_ROUTE = '/app/settings/external-calendars';
const SAO_PAULO = 'America/Sao_Paulo';

function todayPlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function requestGoogleSync(api: APIRequestContext) {
  return api.post('/api/calendar/google/sync', { data: {} });
}

/** Chamadas do back ao fake para um id externo (`path` contém o id), com método e status. */
async function googleCalls(externalId: string, method: string, status?: number) {
  return (await fakeGoogleCalendar.inbox({ path: externalId })).filter(
    (e) => e.method === method && (status === undefined || e.response.status === status),
  );
}

test.describe('Fluxo 8.3 — Agenda externa: Sincronizar e reconciliação', () => {
  // E7 — plano §5.1 itens 2 a 4 (run, órfãos, contadores), §5.2 itens 1 e 2, decisão 5, §8.1 item 11.
  test('@flow E7 Sincronizar mostra o progresso e o snack, recria o apagado à mão, remove cancelado e órfão com marcador, não toca o sem marcador', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(300_000);
    await apiCompleteOnboarding(authApi);
    const connected = await apiConnectGoogleCalendar(authApi, tenant.password);
    await waitForGoogleSyncIdle(authApi, { description: 'run AfterConnect do connect' });

    // Três eventos espelhados pelos ganchos: um fica igual, um o gestor apaga
    // à mão no Google, um é cancelado no app sem o gancho conseguir tirá-lo de lá.
    const keep = await setupAcceptedEvent(authApi);
    const gone = await setupAcceptedEvent(authApi);
    const toCancel = await setupAcceptedEvent(authApi);
    const mirrored = new Map<string, string>();
    for (const [name, id] of [
      ['keep', keep.eventId],
      ['gone', gone.eventId],
      ['cancel', toCancel.eventId],
    ] as const) {
      const ev = await waitForGoogleEvent(connected.sub, id, (e) => e?.status === 'confirmed', {
        description: `evento ${name} espelhado pelo gancho`,
      });
      mirrored.set(id, ev!.id);
    }
    const goneExternalId = mirrored.get(gone.eventId)!;
    const cancelExternalId = mirrored.get(toCancel.eventId)!;

    // Na agenda dedicada: um órfão com o NOSSO marcador (evento que não existe
    // no app) e um evento criado à mão pelo gestor, sem marcador.
    const orphanDate = todayPlus(12);
    const orphan = await fakeGoogleCalendar.createEventByHand(connected.calendarId, {
      summary: 'Festa que não existe mais',
      start: { dateTime: `${orphanDate}T10:00:00`, timeZone: SAO_PAULO },
      end: { dateTime: `${orphanDate}T12:00:00`, timeZone: SAO_PAULO },
      extendedProperties: {
        private: { recreativoTenantId: tenant.tenantId, recreativoEventId: randomUUID() },
      },
    });
    const manual = await fakeGoogleCalendar.createEventByHand(connected.calendarId, {
      summary: 'Reunião do gestor (à mão)',
      start: { dateTime: `${orphanDate}T15:00:00`, timeZone: SAO_PAULO },
      end: { dateTime: `${orphanDate}T16:00:00`, timeZone: SAO_PAULO },
    });

    // O gestor apaga um evento à mão no Google (vai para a lixeira).
    await fakeGoogleCalendar.deleteEventByHand(connected.calendarId, goneExternalId);

    // A tela já aberta, para o clique sair logo depois do cancelamento.
    await authPage.goto(CALENDAR_ROUTE);
    const button = authPage.getByTestId('external-calendar-sync-button-google');
    await expect(button).toBeVisible({ timeout: 20_000 });

    // Cancelar no app com o Google fora: o gancho falha (o link fica com o id
    // externo) e o evento continua lá. Depois da 3ª falha o próximo retry do
    // Outbox é 30 s depois: é a janela em que o run, e não o gancho, o remove.
    await fakeGoogleCalendar.setFailure(connected.sub, '500');
    try {
      const cancel = await authApi.post(`/api/events/${toCancel.eventId}/cancel`, {
        data: { reason: 'E2E sincronizar' },
      });
      expect(cancel.ok(), `cancel: ${cancel.status()} ${await cancel.text()}`).toBe(true);
      await expect
        .poll(async () => (await googleCalls(cancelExternalId, 'DELETE', 500)).length, {
          timeout: 30_000,
          message: 'o gancho do cancelamento falha três vezes no Google',
        })
        .toBeGreaterThanOrEqual(3);
    } finally {
      await fakeGoogleCalendar.clearFailure(connected.sub);
    }

    // Sincronizar: o botão vira "Sincronizando Google…" com a barra de progresso.
    await button.click();
    await expect(authPage.getByTestId('external-calendar-sync-label-google')).toContainText('Sincronizando Google');
    await expect(authPage.getByTestId('external-calendar-sync-progress-google')).toBeVisible();

    // Ao terminar, o snack com os contadores.
    const finalSnack = snack(authPage, 'Google:');
    await expect(finalSnack).toBeVisible({ timeout: 120_000 });
    await expect(finalSnack).toContainText('removido');

    const run = await waitForGoogleSyncRun(authApi, (r) => !isActiveSyncRun(r), { description: 'run manual terminado' });
    expect(run!.trigger).toBe('Manual');
    expect(run!.status).toBe('Completed');
    // O "37/120" do botão: o run conta os candidatos ao começar e percorre todos.
    expect(run!.total, 'total contado no início do run').toBeGreaterThanOrEqual(3);
    expect(run!.scanned).toBeGreaterThanOrEqual(run!.total!);
    // O órfão com o nosso marcador só o run remove; o cancelado no app pode já ter saído
    // por um retry do gancho antes do run chegar nele, então ele não entra na conta.
    expect(run!.removed, 'ao menos o órfão com o nosso marcador').toBeGreaterThanOrEqual(1);
    expect(run!.created, 'o evento apagado à mão volta (plano §5.1.2, "cria o que falta")').toBeGreaterThanOrEqual(1);

    // No Google: o apagado à mão foi recriado...
    const recreated = await fakeGoogleCalendar.eventFor(connected.sub, gone.eventId);
    expect(recreated?.status, 'evento apagado à mão no Google é recriado pelo Sincronizar').toBe('confirmed');
    // ...o cancelado no app e o órfão com marcador saíram...
    const canceledThere = await fakeGoogleCalendar.eventFor(connected.sub, toCancel.eventId);
    expect(canceledThere === undefined || canceledThere.status === 'cancelled', 'cancelado no app sai do Google').toBe(true);
    const account = await fakeGoogleCalendar.account(connected.sub);
    const allEvents = account.calendars.flatMap((c) => c.events);
    const orphanNow = allEvents.find((e) => e.id === orphan.id);
    expect(orphanNow === undefined || orphanNow.status === 'cancelled', 'órfão com o nosso marcador sai do Google').toBe(true);
    // ...o sem marcador ficou intocado, e o que não mudou também.
    const manualNow = allEvents.find((e) => e.id === manual.id);
    expect(manualNow?.status, 'evento sem marcador fica intocado').toBe('confirmed');
    expect(manualNow?.sequence).toBe(manual.sequence);
    expect(await googleCalls(manual.id, 'DELETE')).toHaveLength(0);
    expect(await googleCalls(manual.id, 'PATCH')).toHaveLength(0);
    expect((await fakeGoogleCalendar.eventFor(connected.sub, keep.eventId))?.status).toBe('confirmed');

    // O run aparece em "Últimas sincronizações".
    await authPage.goto(SETTINGS_ROUTE);
    const row = authPage.getByTestId(`external-calendars-run-${run!.id}`);
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(authPage.getByTestId(`external-calendars-run-status-${run!.id}`)).toHaveText('Concluída');
    await expect(authPage.getByTestId(`external-calendars-run-result-${run!.id}`)).toContainText('removido');
  });

  // E8 — plano §5.1 item 3 (`SyncAlreadyRunning`), §5.2 item 1 ("o botão nasce sincronizando"),
  // §8.1 item 6 (cooldown de 5 min), §3.7 (`SyncRunNotFound`, cross-tenant).
  test('@flow E8 run em andamento: 409 SyncAlreadyRunning e a tela acompanha; cooldown traduzido; cancelar run de outro tenant dá 404', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(300_000);
    await apiCompleteOnboarding(authApi);
    const connected = await apiConnectGoogleCalendar(authApi, tenant.password);
    await waitForGoogleSyncIdle(authApi, { description: 'run AfterConnect do connect' });

    const other = await signupNewTenant();
    const otherApi = await createBearerApiContext(other.accessToken);

    await fakeGoogleCalendar.setFailure(connected.sub, '500');
    let failureOn = true;
    try {
      // Primeiro pedido: o run nasce e fica em andamento (Google fora na listagem).
      const first = await requestGoogleSync(authApi);
      expect(first.ok(), `POST sync: ${first.status()} ${await first.text()}`).toBe(true);
      const runId = ((await first.json()).data as { id: string }).id;

      // Segundo pedido com o run em andamento: 409 SyncAlreadyRunning.
      const second = await requestGoogleSync(authApi);
      expect(second.status()).toBe(409);
      expect(await apiErrorCodes(second)).toContain('ExternalCalendar.SyncAlreadyRunning');

      // A tela aberta com o run em curso acompanha esse run: o botão nasce "sincronizando".
      await authPage.goto(CALENDAR_ROUTE);
      const label = authPage.getByTestId('external-calendar-sync-label-google');
      await expect(label).toContainText('Sincronizando Google', { timeout: 20_000 });
      await expect(authPage.getByTestId('external-calendar-sync-button-google')).toBeDisabled();
      await expect(authPage.getByTestId('external-calendar-sync-progress-google')).toBeVisible();

      // Cancelar o run de OUTRO tenant: 404, e o run segue.
      const crossCancel = await otherApi.post(`/api/calendar/sync-runs/${runId}/cancel`);
      expect(crossCancel.status()).toBe(404);
      expect(await apiErrorCodes(crossCancel)).toContain('ExternalCalendar.SyncRunNotFound');
      const stillRunning = await apiGetLatestGoogleSyncRun(authApi);
      expect(stillRunning?.id).toBe(runId);
      expect(isActiveSyncRun(stillRunning)).toBe(true);

      // O Google volta: o run termina e a tela que acompanhava mostra o snack final.
      await fakeGoogleCalendar.clearFailure(connected.sub);
      failureOn = false;
      const finished = await waitForGoogleSyncRun(authApi, (r) => r?.id === runId && !isActiveSyncRun(r), {
        timeoutMs: 180_000,
        intervalMs: 2_000,
        description: 'run em andamento termina com o Google de volta',
      });
      expect(finished!.status).toBe('Completed');
      await expect(snack(authPage, 'Google:')).toBeVisible({ timeout: 30_000 });
      await expect(label).toHaveText('Sincronizar');

      // Novo "Sincronizar" manual antes de 5 min: 409 SyncCooldown...
      const cooldown = await requestGoogleSync(authApi);
      expect(cooldown.status()).toBe(409);
      expect(await apiErrorCodes(cooldown)).toContain('ExternalCalendar.SyncCooldown');

      // ...e, na tela, a mensagem traduzida.
      await authPage.getByTestId('external-calendar-sync-button-google').click();
      await expect(snack(authPage, 'antes de sincronizar de novo')).toBeVisible({ timeout: 10_000 });
      await expect(snack(authPage, 'antes de sincronizar de novo')).toContainText('Aguarde');
      await expect(label).toHaveText('Sincronizar');
    } finally {
      if (failureOn) await fakeGoogleCalendar.clearFailure(connected.sub);
      await otherApi.dispose();
    }
  });

  // E18 — plano §5.1 item 2 (falha transitória conta `Failed` no run), §5.2 itens 1 e 3
  // (snack âmbar "Ver falhas"; desde a Etapa 216 abre a central na aba "Com falha") e o
  // filtro `syncStatus=Failed` da lista de eventos, isolado por tenant.
  test('@flow E18 sincronização com falha: snack âmbar com "Ver falhas" abre a central; a lista filtrada mostra só as falhas do tenant', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(360_000);
    await apiCompleteOnboarding(authApi);
    const connected = await apiConnectGoogleCalendar(authApi, tenant.password);
    await waitForGoogleSyncIdle(authApi, { description: 'run AfterConnect do connect' });

    // Tenant A: dois eventos que vão falhar e um que fica em dia.
    const failing1 = await setupAcceptedEvent(authApi);
    const failing2 = await setupAcceptedEvent(authApi);
    const healthy = await setupAcceptedEvent(authApi);
    for (const id of [failing1.eventId, failing2.eventId, healthy.eventId]) {
      await waitForGoogleEvent(connected.sub, id, (e) => e?.status === 'confirmed', { description: `evento ${id}` });
    }

    // Outro tenant, com a própria conta, também com um evento em falha.
    const other = await signupNewTenant();
    const otherApi = await createBearerApiContext(other.accessToken);
    const otherConnected = await apiConnectGoogleCalendar(otherApi, other.password);
    const otherEvent = await setupAcceptedEvent(otherApi);
    await waitForGoogleEvent(otherConnected.sub, otherEvent.eventId, (e) => e?.status === 'confirmed', {
      description: 'evento do outro tenant',
    });

    await fakeGoogleCalendar.setFailure(otherConnected.sub, '500');
    await fakeGoogleCalendar.setFailure(connected.sub, '500');
    let failureOnA = true;
    try {
      // Mudanças com o Google fora: os ganchos falham e os links ficam `Failed`.
      for (const [api, id] of [
        [otherApi, otherEvent.eventId],
        [authApi, failing1.eventId],
        [authApi, failing2.eventId],
      ] as const) {
        const patch = await api.patch(`/api/events/${id}`, { data: { startTime: '15:00:00', endTime: '19:00:00' } });
        expect(patch.ok(), `PATCH ${id}: ${patch.status()} ${await patch.text()}`).toBe(true);
      }
      await expect
        .poll(async () => (await apiListEventsBySyncStatus(authApi, 'Failed')).map((e) => e.id).sort(), {
          timeout: 60_000,
          intervals: [2_000],
          message: 'os dois eventos do tenant A ficam com falha',
        })
        .toEqual([failing1.eventId, failing2.eventId].sort());
      await expect
        .poll(async () => (await apiListEventsBySyncStatus(otherApi, 'Failed')).map((e) => e.id), {
          timeout: 60_000,
          intervals: [2_000],
          message: 'o evento do outro tenant fica com falha',
        })
        .toEqual([otherEvent.eventId]);

      // A lista filtrada "Agenda externa: com falha" (deep link `?syncStatus=Failed`):
      // ⚠ na coluna "Agenda" e só os eventos com falha do próprio tenant.
      await authPage.goto('/app/events/list?syncStatus=Failed');
      await expect(authPage.getByTestId('events-list-table')).toBeVisible({ timeout: 20_000 });
      await expect(authPage.getByTestId('events-list-filter-syncStatus')).toContainText('Com falha');
      await expect(authPage.getByTestId('events-list-total')).toHaveText('2');
      for (const id of [failing1.eventId, failing2.eventId]) {
        await expect(authPage.getByTestId(`events-list-mirror-${id}-google`)).toHaveAttribute('data-status', 'Failed');
      }
      await expect(authPage.getByTestId(`events-list-title-${healthy.eventId}`)).toHaveCount(0);
      await expect(authPage.getByTestId(`events-list-title-${otherEvent.eventId}`)).toHaveCount(0);

      // Sincronizar com o Google ainda fora: os dois eventos com mudança contam como falha.
      await authPage.goto(CALENDAR_ROUTE);
      const button = authPage.getByTestId('external-calendar-sync-button-google');
      await expect(button).toBeVisible({ timeout: 20_000 });
      await button.click();
      await expect(authPage.getByTestId('external-calendar-sync-label-google')).toContainText('Sincronizando Google');
      await waitForGoogleSyncRun(
        authApi,
        (r) => r?.trigger === 'Manual' && (r.failed >= 2 || !isActiveSyncRun(r)),
        { timeoutMs: 60_000, description: 'a fase de eventos do run conta as falhas' },
      );

      // O Google volta para a última fase (órfãos) e o run termina com falhas.
      await fakeGoogleCalendar.clearFailure(connected.sub);
      failureOnA = false;
      const run = await waitForGoogleSyncRun(authApi, (r) => r?.trigger === 'Manual' && !isActiveSyncRun(r), {
        timeoutMs: 180_000,
        intervalMs: 2_000,
        description: 'run manual terminado',
      });
      expect(run!.status).toBe('CompletedWithErrors');
      expect(run!.failed).toBeGreaterThanOrEqual(2);

      // Snack âmbar com "Ver falhas"...
      const warning = snack(authPage, 'Google:');
      await expect(warning).toBeVisible({ timeout: 30_000 });
      await expect(warning).toHaveClass(/snack-warning/);
      await expect(warning).toContainText('com falha');
      await warning.getByRole('button', { name: 'Ver falhas' }).click();

      // ...que abre a central de pendências na aba "Com falha".
      await authPage.waitForURL(/\/app\/settings\/external-calendars\/pendencias\?tab=Failed/, { timeout: 15_000 });
      await expect(authPage.getByTestId('external-calendar-pending-title')).toBeVisible({ timeout: 20_000 });

      // Com o Google de volta, os reenvios unitários que o run enfileirou (§5.1.2)
      // acertam os dois eventos em segundos, e a central sem falha não mostra
      // abas. Para ver a aba que o "Ver falhas" pede selecionada, uma falha
      // nova e a mesma URL de novo.
      await fakeGoogleCalendar.setFailure(connected.sub, '500');
      failureOnA = true;
      const again = await authApi.patch(`/api/events/${failing1.eventId}`, {
        data: { startTime: '16:00:00', endTime: '20:00:00' },
      });
      expect(again.ok(), `PATCH de novo: ${again.status()} ${await again.text()}`).toBe(true);
      await expect
        .poll(async () => (await apiListEventsBySyncStatus(authApi, 'Failed')).map((e) => e.id), {
          timeout: 60_000,
          intervals: [2_000],
        })
        .toContain(failing1.eventId);
      await authPage.reload();
      await expect(authPage.getByRole('tab', { name: /^Com falha/ })).toHaveAttribute('aria-selected', 'true', {
        timeout: 20_000,
      });
    } finally {
      if (failureOnA) await fakeGoogleCalendar.clearFailure(connected.sub);
      await fakeGoogleCalendar.clearFailure(otherConnected.sub);
      await otherApi.dispose();
    }
  });

  // E19 — plano §5.1 item 6 (reconciliação diária, decisão 13), §5.2 item 2 (toggle).
  // Descartado no registro e2e do plano (sem teste aqui, de propósito): o
  // `appsettings.E2E.json` desliga o worker (`ExternalCalendar:ReconcileWorkerEnabled=false`),
  // a hora é a opção global `DailyReconcileHourLocal` lida contra o `IClock` real
  // (sem relógio controlável no E2E), o ciclo é de no mínimo 1 min depois de um
  // atraso de 180 s, e não há gatilho manual do `SweepOnceAsync`. A cobertura fica
  // no back (`ExternalCalendarReconcileServiceTests`, `ExternalCalendarReconcileWorkerTests`).

  // E20 — plano §5.1 item 3 (`events.update` dispara e cancela), §5.3 item 5 (RBAC:
  // Financial com `events.read` não dispara), §5.2 item 2 (toggle com `settings.update`).
  test('@flow E20 Financial lê as sincronizações sem Cancelar nem Sincronizar e recebe 403; Manager sincroniza e cancela; toggle só com settings.update', async ({
    authApi,
    authPage,
    tenant,
    browser,
  }) => {
    test.setTimeout(240_000);
    await apiCompleteOnboarding(authApi);
    const connected = await apiConnectGoogleCalendar(authApi, tenant.password);
    await waitForGoogleSyncIdle(authApi, { description: 'run AfterConnect do connect' });

    const manager = seedUserWithRoleDirect({ tenantId: tenant.tenantId, role: 'Manager', emailPrefix: 'manager-sync' });
    const financial = seedUserWithRoleDirect({
      tenantId: tenant.tenantId,
      role: 'Financial',
      emailPrefix: 'financial-sync',
    });
    const managerTokens = await loginViaApi(authApi, manager.email, manager.password);
    const financialTokens = await loginViaApi(authApi, financial.email, financial.password);
    const financialApi = await createBearerApiContext(financialTokens.accessToken);
    const managerPage = await openPageWithTokens(browser, managerTokens);
    const financialPage = await openPageWithTokens(browser, financialTokens);

    // Google fora na listagem: o run do Manager fica em andamento para ser cancelado.
    await fakeGoogleCalendar.setFailure(connected.sub, '500');
    try {
      // Manager sincroniza pelo botão do calendário.
      await managerPage.goto(CALENDAR_ROUTE);
      const managerButton = managerPage.getByTestId('external-calendar-sync-button-google');
      await expect(managerButton).toBeVisible({ timeout: 20_000 });
      await managerButton.click();
      await expect(managerPage.getByTestId('external-calendar-sync-label-google')).toContainText('Sincronizando Google');
      const run = await waitForGoogleSyncRun(authApi, (r) => r?.trigger === 'Manual' && isActiveSyncRun(r), {
        description: 'run manual do Manager',
      });
      expect(run!.requestedByName).toBe('Test Manager');

      // Financial (`events.read`): 403 no POST sync e no cancel.
      const financialSync = await requestGoogleSync(financialApi);
      expect(financialSync.status()).toBe(403);
      const financialCancel = await financialApi.post(`/api/calendar/sync-runs/${run!.id}/cancel`);
      expect(financialCancel.status()).toBe(403);
      expect(isActiveSyncRun(await apiGetLatestGoogleSyncRun(authApi))).toBe(true);

      // Financial na tela: vê as últimas sincronizações (com o run em andamento) sem
      // "Cancelar", não vê o toggle; no calendário vê o chip sem "Sincronizar".
      await financialPage.goto(SETTINGS_ROUTE);
      await expect(financialPage.getByTestId(`external-calendars-run-${run!.id}`)).toBeVisible({ timeout: 20_000 });
      await expect(financialPage.getByTestId(`external-calendars-run-cancel-${run!.id}`)).toHaveCount(0);
      await expect(financialPage.getByTestId('external-calendars-daily-reconcile-toggle')).toHaveCount(0);
      await financialPage.goto(CALENDAR_ROUTE);
      await expect(financialPage.getByTestId('external-calendar-chip-google')).toBeVisible({ timeout: 20_000 });
      await expect(financialPage.getByTestId('external-calendar-sync-button-google')).toHaveCount(0);

      // Manager cancela pela tabela; não vê o toggle (sem `settings.update`).
      await managerPage.goto(SETTINGS_ROUTE);
      const cancelButton = managerPage.getByTestId(`external-calendars-run-cancel-${run!.id}`);
      await expect(cancelButton).toBeVisible({ timeout: 20_000 });
      await expect(managerPage.getByTestId('external-calendars-daily-reconcile-toggle')).toHaveCount(0);
      await cancelButton.click();
      await expect(managerPage.getByTestId(`external-calendars-run-status-${run!.id}`)).toHaveText('Cancelada', {
        timeout: 15_000,
      });
      await expect(cancelButton).toHaveCount(0);
      const canceled = await apiGetLatestGoogleSyncRun(authApi);
      expect(canceled?.id).toBe(run!.id);
      expect(canceled?.status).toBe('Canceled');

      // O Owner (`settings.update`) vê o toggle de reconciliação.
      await authPage.goto(SETTINGS_ROUTE);
      await expect(authPage.getByTestId('external-calendars-daily-reconcile-toggle')).toBeVisible({ timeout: 20_000 });
    } finally {
      await fakeGoogleCalendar.clearFailure(connected.sub);
      await managerPage.context().close();
      await financialPage.context().close();
      await financialApi.dispose();
    }
  });
});
