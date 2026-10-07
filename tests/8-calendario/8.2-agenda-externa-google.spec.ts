import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCompleteOnboarding, apiListNotifications, NotificationItem } from '../../helpers/api-entities';
import { apiStepUp, createBearerApiContext, loginViaApi, openPageWithTokens } from '../../helpers/api-client';
import { seedUserWithRoleDirect } from '../../helpers/db-helper';
import { setupAcceptedEvent } from '../../helpers/setup-flows';
import { fakeEmail, fakeGoogleCalendar } from '../../helpers/fake-providers';
import {
  apiConnectGoogleCalendar,
  apiGetExternalCalendarStatus,
  apiGetGoogleConnection,
  STEP_UP_HEADER,
  waitForGoogleEvent,
  waitForGoogleSyncIdle,
} from '../../helpers/external-calendar';
import { apiErrorCodes } from '../../helpers/response';

/**
 * Fluxo: 8.2 — Agenda externa: conectar o Google e espelhar em background
 * Plano: docs/implementar/fase2/PLANO-AGENDAS-EXTERNAS.md §4 (GC-A), §3.3, §3.7, §8.1; registro e2e §12 (E1, E4, E5, E6)
 * Diagrama: docs/fluxos/negocio-8.2-agenda-externa-google.mmd
 *
 * Integração pelo fake `fake-providers/google-calendar` (porta 1517). O popup
 * do GIS não roda no E2E (plano §12): a conexão é `connect-intent` + código do
 * fake + step-up + `connect`. Cada teste usa uma conta Google própria no fake.
 */

const CALENDAR_ROUTE = '/app/schedule/calendar';

function todayPlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

test.describe('Fluxo 8.2 — Agenda externa: Google', () => {
  // E1 — plano §4.1 itens 6 e 10, §3.5 (fluxo OAuth), §4.2 item 1, §8.1 itens 4 e 9.
  test('@flow E1 conectar o Google cria a agenda dedicada, espelha os eventos futuros, chip verde e e-mail ao Owner', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(120_000);
    await apiCompleteOnboarding(authApi);

    // Evento futuro que já existe antes da conexão: o run `AfterConnect` o espelha.
    const { eventId } = await setupAcceptedEvent(authApi);

    // Pedido de conexão + confirmação de senha (step-up) + connect.
    const connected = await apiConnectGoogleCalendar(authApi, tenant.password);

    const google = connected.status.connections.find((c) => c.provider === 'google');
    expect(google, 'o connect devolve o status com a conexão do Google').toBeTruthy();
    expect(google!.status).toBe('Connected');
    expect(google!.accountEmail).toBe(connected.email);
    expect(google!.calendarName).toBe('Recreativo — Eventos');

    // A agenda dedicada nasceu na conta, com o nome do plano.
    const account = await fakeGoogleCalendar.account(connected.sub);
    const calendars = account.calendars.filter((c) => !c.deleted);
    expect(calendars).toHaveLength(1);
    expect(calendars[0]!.summary).toBe('Recreativo — Eventos');

    // O evento futuro aparece nela, com o nosso marcador e na data do evento.
    const mirrored = await waitForGoogleEvent(connected.sub, eventId, (e) => e?.status === 'confirmed', {
      description: 'evento futuro espelhado pelo AfterConnect',
    });
    expect(mirrored!.calendarId).toBe(connected.calendarId);
    expect(mirrored!.extendedProperties?.private?.recreativoTenantId).toBe(tenant.tenantId);
    expect(mirrored!.start?.dateTime).toBe(`${todayPlus(30)}T14:00:00`);

    // Chip verde no header do calendário.
    await expect
      .poll(async () => (await apiGetGoogleConnection(authApi))?.pendingCount, { timeout: 30_000 })
      .toBe(0);
    await authPage.goto(CALENDAR_ROUTE);
    const chip = authPage.getByTestId('external-calendar-chip-google');
    await expect(chip).toBeVisible({ timeout: 20_000 });
    await expect(chip).toHaveAttribute('data-tone', 'ok');
    await expect(chip).toContainText(connected.email);

    // E-mail de conexão ao Owner (plano §8.1 item 4).
    await expect
      .poll(
        async () =>
          (await fakeEmail.emails({ to: tenant.email })).filter((m) => m.subject.includes('Agenda externa conectada'))
            .length,
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
  });

  // E4 — plano §3.3 (ganchos e resultado por `Kind`), §4.3 itens 4 e 5.
  test('@flow E4 reagendar, cancelar e reativar refletem no Google; com o Google fora o save responde e na 3ª falha o sino avisa', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(240_000);
    await apiCompleteOnboarding(authApi);
    const connected = await apiConnectGoogleCalendar(authApi, tenant.password);

    // Aceite com a agenda já conectada: o gancho do aceite enfileira e o evento chega ao Google.
    const { eventId } = await setupAcceptedEvent(authApi);
    const created = await waitForGoogleEvent(connected.sub, eventId, (e) => e?.status === 'confirmed', {
      description: 'evento do aceite',
    });
    const externalId = created!.id;

    // Reagendar.
    const newDate = todayPlus(37);
    const patch = await authApi.patch(`/api/events/${eventId}`, {
      data: { eventDate: newDate, startTime: '15:00:00', endTime: '19:00:00' },
    });
    expect(patch.ok(), `PATCH evento: ${patch.status()} ${await patch.text()}`).toBe(true);
    await waitForGoogleEvent(
      connected.sub,
      eventId,
      (e) => e?.status === 'confirmed' && e.start?.dateTime === `${newDate}T15:00:00`,
      { description: 'reagendamento no Google' },
    );

    // Cancelar: sai do Google (decisão 6).
    const cancel = await authApi.post(`/api/events/${eventId}/cancel`, { data: { reason: 'E2E agenda externa' } });
    expect(cancel.ok(), `cancel: ${cancel.status()} ${await cancel.text()}`).toBe(true);
    await waitForGoogleEvent(connected.sub, eventId, (e) => e === undefined || e.status === 'cancelled', {
      description: 'cancelamento remove do Google',
    });

    // Reativar: volta ao Google, no mesmo id determinístico.
    const reactivate = await authApi.post(`/api/events/${eventId}/reactivate`, {
      data: { reason: 'E2E agenda externa' },
    });
    expect(reactivate.ok(), `reactivate: ${reactivate.status()} ${await reactivate.text()}`).toBe(true);
    const back = await waitForGoogleEvent(connected.sub, eventId, (e) => e?.status === 'confirmed', {
      description: 'reativação volta ao Google',
    });
    expect(back!.id).toBe(externalId);
    expect(back!.start?.dateTime).toBe(`${newDate}T15:00:00`);

    // Google fora: o save responde normal, a falha fica com o Outbox.
    await fakeGoogleCalendar.setFailure(connected.sub, '500');
    try {
      const started = Date.now();
      const down = await authApi.patch(`/api/events/${eventId}`, { data: { startTime: '16:00:00', endTime: '20:00:00' } });
      expect(down.ok(), `PATCH com o Google fora: ${down.status()} ${await down.text()}`).toBe(true);
      expect(Date.now() - started, 'o save não espera o Google').toBeLessThan(10_000);

      // Na 3ª falha o sino avisa (FailureNotifyAfterAttempts = 3), com o nome do provedor no texto.
      let failure: NotificationItem | undefined;
      await expect
        .poll(
          async () => {
            failure = (await apiListNotifications(authApi)).find(
              (n) => n.type === 'ExternalCalendarSyncFailed' && n.contextEntityId === eventId,
            );
            return failure !== undefined;
          },
          { timeout: 90_000, intervals: [2_000] },
        )
        .toBe(true);
      expect(failure!.message).toContain('Google Agenda');

      // Não avisou antes da 3ª: o aviso é posterior à 2ª chamada que falhou no Google.
      const failedCalls = (await fakeGoogleCalendar.inbox({ path: externalId }))
        .filter((e) => e.method === 'PATCH' && e.response.status === 500)
        .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
      expect(failedCalls.length, 'chamadas que falharam no Google').toBeGreaterThanOrEqual(3);
      expect(Date.parse(failure!.createdAt)).toBeGreaterThan(Date.parse(failedCalls[1]!.capturedAt));
    } finally {
      await fakeGoogleCalendar.clearFailure(connected.sub);
    }
  });

  // E5 — plano §3.3 ("invalid_grant / 401 no refresh"), §4.1 item 8, §4.2 itens 3 e 4, decisões 10 e 12.
  test('@flow E5 token revogado: chip vermelho com Desconectar só para quem gerencia, notificação e e-mail a Owner e Admin, detalhe sem "Tentar de novo"', async ({
    authApi,
    authPage,
    tenant,
    browser,
  }) => {
    test.setTimeout(180_000);
    await apiCompleteOnboarding(authApi);
    const admin = seedUserWithRoleDirect({ tenantId: tenant.tenantId, role: 'Admin', emailPrefix: 'admin-agenda' });
    const manager = seedUserWithRoleDirect({ tenantId: tenant.tenantId, role: 'Manager', emailPrefix: 'manager-revogado' });
    const connected = await apiConnectGoogleCalendar(authApi, tenant.password);

    const { eventId } = await setupAcceptedEvent(authApi);
    await waitForGoogleEvent(connected.sub, eventId, (e) => e?.status === 'confirmed', {
      description: 'evento espelhado antes da revogação',
    });
    // Sem run ativo: quem descobre a revogação tem de ser o gancho do PATCH abaixo, que
    // marca o LINK `Failed` (plano §3.3 item 4). Se a listagem do run `AfterConnect` chegar
    // antes, ela marca só a conexão e o gancho, já sem conta `Connected`, nem tenta.
    await waitForGoogleSyncIdle(authApi, { description: 'run AfterConnect do connect' });

    // O dono da conta revoga o acesso no Google; a próxima mudança descobre.
    await fakeGoogleCalendar.revokeAccount(connected.sub);
    const patch = await authApi.patch(`/api/events/${eventId}`, { data: { startTime: '15:00:00', endTime: '19:00:00' } });
    expect(patch.ok(), `PATCH evento: ${patch.status()} ${await patch.text()}`).toBe(true);

    await expect
      .poll(async () => (await apiGetGoogleConnection(authApi))?.status, { timeout: 60_000, intervals: [2_000] })
      .toBe('TokenRevoked');

    // Notificação "agenda desconectada" ao Owner e ao Admin.
    const isDisconnected = (n: NotificationItem) => n.type === 'ExternalCalendarDisconnected';
    await expect
      .poll(async () => (await apiListNotifications(authApi)).some(isDisconnected), { timeout: 30_000 })
      .toBe(true);
    const adminTokens = await loginViaApi(authApi, admin.email, admin.password);
    const adminApi = await createBearerApiContext(adminTokens.accessToken);
    try {
      await expect
        .poll(async () => (await apiListNotifications(adminApi)).some(isDisconnected), { timeout: 30_000 })
        .toBe(true);
    } finally {
      await adminApi.dispose();
    }

    // E-mail aos dois.
    for (const to of [tenant.email, admin.email]) {
      await expect
        .poll(
          async () => (await fakeEmail.emails({ to })).filter((m) => m.subject.includes('desconectado')).length,
          { timeout: 30_000, message: `e-mail de desconexão para ${to}` },
        )
        .toBeGreaterThan(0);
    }

    // Chip vermelho no calendário; o Owner (`settings.update`) tem "Desconectar" no menu dele.
    // "Reconectar" não se afirma no E2E, para ninguém: o item exige o GIS no front
    // (`googleClientId` do environment), vazio no E2E (plano §12, o popup não roda);
    // Owner com e Manager sem ficam no spec do `external-calendar-header`.
    await authPage.goto(CALENDAR_ROUTE);
    const chip = authPage.getByTestId('external-calendar-chip-google');
    await expect(chip).toBeVisible({ timeout: 20_000 });
    await expect(chip).toHaveAttribute('data-tone', 'error');
    await chip.click();
    await expect(authPage.getByTestId('external-calendar-disconnect-google')).toBeVisible();
    await authPage.keyboard.press('Escape');

    // O Manager, no mesmo estado, vê o chip vermelho e o menu sem "Desconectar".
    const managerTokens = await loginViaApi(authApi, manager.email, manager.password);
    const managerPage = await openPageWithTokens(browser, managerTokens);
    try {
      await managerPage.goto(CALENDAR_ROUTE);
      const managerChip = managerPage.getByTestId('external-calendar-chip-google');
      await expect(managerChip).toBeVisible({ timeout: 20_000 });
      await expect(managerChip).toHaveAttribute('data-tone', 'error');
      await managerChip.click();
      await expect(managerPage.getByTestId('external-calendar-settings-google')).toBeVisible();
      await expect(managerPage.getByTestId('external-calendar-disconnect-google')).toHaveCount(0);
    } finally {
      await managerPage.context().close();
    }

    // Detalhe do evento: a linha do Google em falha, com o aviso de reconectar e sem
    // "Tentar de novo" (reconectar resolve, não reenviar).
    await authPage.goto(`/app/events/${eventId}`);
    const row = authPage.getByTestId('event-external-calendar-google');
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toHaveAttribute('data-status', 'Failed');
    await expect(authPage.getByTestId('event-external-calendar-reconnect-google')).toBeVisible();
    await expect(authPage.getByTestId('event-external-calendar-resync-google')).toHaveCount(0);
  });

  // E6 — plano §4.1 item 10, §4.2 itens 1 e 3, §4.3 item 8, decisão 12.
  test('@flow E6 Manager vê o chip sem Vincular/Desconectar e recebe 403 no connect-intent e no connect; Financial lê o status', async ({
    authApi,
    authPage,
    tenant,
    browser,
  }) => {
    test.setTimeout(120_000);
    await apiCompleteOnboarding(authApi);

    const manager = seedUserWithRoleDirect({ tenantId: tenant.tenantId, role: 'Manager', emailPrefix: 'manager-agenda' });
    const financial = seedUserWithRoleDirect({
      tenantId: tenant.tenantId,
      role: 'Financial',
      emailPrefix: 'financial-agenda',
    });

    const managerTokens = await loginViaApi(authApi, manager.email, manager.password);
    const managerApi = await createBearerApiContext(managerTokens.accessToken);
    const financialTokens = await loginViaApi(authApi, financial.email, financial.password);
    const financialApi = await createBearerApiContext(financialTokens.accessToken);
    const page = await openPageWithTokens(browser, managerTokens);

    try {
      // Sem conexão (o único estado em que "Vincular agenda" existe): o Owner vê o botão...
      await authPage.goto(CALENDAR_ROUTE);
      await expect(authPage.getByTestId('external-calendar-link')).toBeVisible({ timeout: 20_000 });
      // ...e o Manager, no mesmo estado, vê só o aviso "não conectada", sem o botão.
      await page.goto(CALENDAR_ROUTE);
      await expect(page.getByTestId('external-calendar-not-connected')).toBeVisible({ timeout: 20_000 });
      await expect(page.getByTestId('external-calendar-link')).toHaveCount(0);

      const connected = await apiConnectGoogleCalendar(authApi, tenant.password);

      // Manager: sem `settings.update`, 403 no pedido de conexão...
      const intent = await managerApi.post('/api/calendar/google/connect-intent');
      expect(intent.status()).toBe(403);

      // ...e no connect, mesmo com o step-up dele em mãos (a recusa é da permission, não do step-up).
      const managerStepUp = await apiStepUp(managerApi, manager.password);
      const code = await fakeGoogleCalendar.authorize();
      const connect = await managerApi.post('/api/calendar/google/connect', {
        data: { code: code.code, nonce: 'nonce-qualquer' },
        headers: { [STEP_UP_HEADER]: managerStepUp },
      });
      expect(connect.status()).toBe(403);
      expect(await apiErrorCodes(connect)).not.toContain('Auth.StepUpRequired');

      // Nada mudou na conexão do tenant.
      const afterManager = await apiGetGoogleConnection(authApi);
      expect(afterManager?.accountEmail).toBe(connected.email);

      // Financial (`events.read`) lê o status.
      const financialStatus = await financialApi.get('/api/calendar/status');
      expect(financialStatus.status()).toBe(200);
      const financialBody = await financialStatus.json();
      const financialData = financialBody.data ?? financialBody;
      const google = (financialData.connections as Array<{ provider: string; status: string; accountEmail: string }>).find(
        (c) => c.provider === 'google',
      );
      expect(google?.status).toBe('Connected');
      expect(google?.accountEmail).toBe(connected.email);

      // Conectado: o Owner tem "Desconectar" no menu do chip...
      await authPage.goto(CALENDAR_ROUTE);
      const ownerChip = authPage.getByTestId('external-calendar-chip-google');
      await expect(ownerChip).toBeVisible({ timeout: 20_000 });
      await ownerChip.click();
      await expect(authPage.getByTestId('external-calendar-disconnect-google')).toBeVisible();

      // ...e o Manager, no mesmo estado, vê o chip com a conta e o menu sem "Desconectar".
      await page.goto(CALENDAR_ROUTE);
      const chip = page.getByTestId('external-calendar-chip-google');
      await expect(chip).toBeVisible({ timeout: 20_000 });
      await expect(chip).toContainText(connected.email);
      await chip.click();
      await expect(page.getByTestId('external-calendar-settings-google')).toBeVisible();
      await expect(page.getByTestId('external-calendar-disconnect-google')).toHaveCount(0);
    } finally {
      await page.context().close();
      await managerApi.dispose();
      await financialApi.dispose();
    }
  });

  test('@flow status do tenant sem conexão mostra o Google configurado no E2E', async ({ authApi }) => {
    // Pré-requisito de todo o plano: o `appsettings.E2E.json` aponta o fake e o provedor sai configurado.
    const status = await apiGetExternalCalendarStatus(authApi);
    expect(status.providers.find((p) => p.provider === 'google')?.configured).toBe(true);
    expect(status.connections).toHaveLength(0);
  });
});
