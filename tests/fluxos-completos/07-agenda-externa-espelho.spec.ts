import { APIRequestContext } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { twoTenantsTest } from '../../fixtures/two-tenants.fixture';
import { apiCompleteOnboarding, apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import {
  apiAcceptPublicBudget,
  apiCreateBudget,
  apiGetEvent,
  apiSendBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
  publicAcceptBody,
} from '../../helpers/api-event-flow';
import { setupAcceptedEvent } from '../../helpers/setup-flows';
import { fakeGoogleCalendar, FakeGoogleCalendarEvent } from '../../helpers/fake-providers';
import { apiConnectGoogleCalendar, waitForGoogleEvent } from '../../helpers/external-calendar';

/**
 * Fluxo completo: aceite do orçamento -> evento -> espelho na agenda externa (Google)
 * Plano: docs/implementar/fase2/PLANO-AGENDAS-EXTERNAS.md §3.3 (ganchos e enfileirador com o
 * tenant do `Event`), §3.4 (payload), §6a.1 item 1 e §8.1 itens 1 e 8 (lista fechada);
 * registro e2e §12 (E2, E3)
 * Diagrama: docs/fluxos/negocio-8.2-agenda-externa-google.mmd
 *
 * Integração pelo fake `fake-providers/google-calendar` (porta 1517); cada
 * teste usa contas Google próprias no fake.
 */

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Data UTC `YYYY-MM-DD` daqui a `days` dias (aritmética toda em UTC, sem virar o dia). */
function utcDatePlus(days: number): string {
  const d = new Date();
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayOfWeekName(date: string): string {
  return DAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()]!;
}

/** Eventos vivos da conta que carregam o marcador do tenant. */
async function liveEventsOfTenant(sub: string, tenantId: string): Promise<FakeGoogleCalendarEvent[]> {
  return (await fakeGoogleCalendar.liveEvents(sub)).filter(
    (e) => e.extendedProperties?.private?.recreativoTenantId === tenantId,
  );
}

/** Aceite público (anônimo) de um orçamento já enviado. */
async function acceptPublicly(
  token: string,
  body: Record<string, unknown> = publicAcceptBody(),
): Promise<{ eventId: string }> {
  const publicApi = await createPublicApiContext();
  try {
    const accepted = await apiAcceptPublicBudget(publicApi, token, body);
    expect(accepted.eventId, 'o aceite devolve o evento âncora').toBeTruthy();
    return { eventId: accepted.eventId };
  } finally {
    await publicApi.dispose();
  }
}

/** Detalhe do evento: as linhas de agenda externa (`EventDetailDto.externalCalendars`). */
async function externalCalendarsOf(api: APIRequestContext, eventId: string): Promise<unknown[]> {
  const ev = (await apiGetEvent(api, eventId)) as { externalCalendars?: unknown[] | null };
  return ev.externalCalendars ?? [];
}

test.describe('Fluxo completo — agenda externa: o aceite espelha no Google', () => {
  // E2 — plano §3.3 (gancho no materializador: uma mensagem por ocorrência), §3.4 (`Summary`
  // "{cliente} — {crianças} crianças"), §6a.1 item 1 e §8.1 item 8 (lista fechada da
  // descrição; contato do cliente só com EXTERNAL_CALENDAR_INCLUDE_CLIENT_CONTACT, default
  // false), §4.2 item 4 (detalhe "espelhado ✓").
  test('@flow E2 aceitar orçamento em série de 2 espelha as 2 ocorrências, com o título do plano e sem dado sensível', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(180_000);
    await apiCompleteOnboarding(authApi);

    // A agenda já está conectada quando o cliente aceita.
    const connected = await apiConnectGoogleCalendar(authApi, tenant.password);

    // Orçamento recorrente: 2 ocorrências semanais, âncora daqui a ~5 semanas.
    const unique = Date.now().toString(36);
    const clientName = `Mariana E2E ${unique}`;
    const clientPhone = '41999999999';
    const clientCpf = '12345678909';
    const client = await apiCreateClient(authApi, {
      name: clientName,
      phone: clientPhone,
      document: clientCpf,
    });
    const clientEmail = String((client as { email?: string }).email ?? '');
    // O cliente nasce com e-mail (`fakeClient`): sem ele, a asserção da lista fechada passaria à toa.
    expect(clientEmail, 'cliente com e-mail para provar que ele fica fora do Google').toBeTruthy();
    const activity = await apiCreateActivity(authApi);
    const anchorDate = utcDatePlus(35);
    const secondDate = addDays(anchorDate, 7);
    const childrenCount = 20;
    const budget = await apiCreateBudget(authApi, {
      clientId: client.id,
      activityIds: [activity.id],
      eventDate: anchorDate,
      startTime: '15:00',
      endTime: '19:00',
      childrenCount,
      recurrence: { daysOfWeek: [dayOfWeekName(anchorDate)], occurrenceCount: 2 },
    });
    const sent = await apiSendBudget(authApi, budget.id);

    // O cliente aceita preenchendo o formulário com tudo o que a lista fechada barra.
    const birthdayChildName = `Aniversariante Zuleica ${unique}`;
    const restrictions = `Alergia grave a amendoim ${unique}`;
    const formPhone = '(41) 98765-4321';
    const dayContactPhone = '(41) 91234-5678';
    const formCpf = '123.456.789-09';
    const { eventId: anchorId } = await acceptPublicly(extractTokenFromPublicUrl(sent.publicUrl), {
      ...publicAcceptBody(),
      formData: {
        clientCpf: formCpf,
        clientPhone: formPhone,
        birthdayChildName,
        childrenAgeRange: '4 a 8 anos',
        eventTheme: 'Circo',
        dayContactName: 'Tia Rosa',
        dayContactPhone,
        restrictions,
        isConfirmed: true,
      },
    });

    // As 2 ocorrências chegam ao Google, cada uma com o marcador do tenant.
    let mirrored: FakeGoogleCalendarEvent[] = [];
    await expect
      .poll(
        async () => {
          mirrored = await liveEventsOfTenant(connected.sub, tenant.tenantId);
          return mirrored.length;
        },
        { timeout: 60_000, intervals: [1_000], message: 'as 2 ocorrências da série no Google' },
      )
      .toBe(2);
    expect(mirrored.every((e) => e.calendarId === connected.calendarId)).toBe(true);

    const byDate = new Map(mirrored.map((e) => [e.start?.dateTime?.slice(0, 10), e]));
    const first = byDate.get(anchorDate);
    const second = byDate.get(secondDate);
    expect(first, `ocorrência de ${anchorDate} no Google`).toBeTruthy();
    expect(second, `ocorrência de ${secondDate} no Google`).toBeTruthy();
    expect(first!.extendedProperties?.private?.recreativoEventId).toBe(anchorId);
    expect(first!.start?.dateTime).toBe(`${anchorDate}T15:00:00`);
    expect(second!.start?.dateTime).toBe(`${secondDate}T15:00:00`);

    // A segunda ocorrência é um evento do próprio tenant, distinto da âncora.
    const secondId = second!.extendedProperties?.private?.recreativoEventId;
    expect(secondId).toBeTruthy();
    expect(secondId).not.toBe(anchorId);
    await apiGetEvent(authApi, secondId!);

    const forbiddenText = [birthdayChildName, restrictions, formPhone, dayContactPhone, formCpf];
    const forbiddenDigits = ['41999999999', '12345678909', '41987654321', '41912345678'];
    for (const ev of mirrored) {
      // Título do plano: "cliente — N crianças".
      expect(ev.summary).toBe(`${clientName} — ${childrenCount} crianças`);

      // Nada da lista fechada no que vai ao Google (título, descrição, local).
      const visible = [ev.summary ?? '', ev.description ?? '', ev.location ?? ''].join('\n');
      for (const text of forbiddenText) {
        expect(visible, `"${text}" não pode ir ao Google`).not.toContain(text);
      }
      const digitsOnly = visible.replace(/\D/g, '');
      for (const digits of forbiddenDigits) {
        expect(digitsOnly, `telefone/CPF ${digits} não pode ir ao Google`).not.toContain(digits);
      }
      // Contato do cliente fica de fora por default (EXTERNAL_CALENDAR_INCLUDE_CLIENT_CONTACT = false).
      expect(visible, 'e-mail do cliente fora por default').not.toContain(clientEmail);
    }

    // Detalhe de cada ocorrência: "Google Agenda: espelhado ✓".
    for (const eventId of [anchorId, secondId!]) {
      await authPage.goto(`/app/events/${eventId}`);
      const row = authPage.getByTestId('event-external-calendar-google');
      await expect(row).toBeVisible({ timeout: 20_000 });
      await expect(row).toHaveAttribute('data-status', 'Synced');
      await expect(row).toContainText('espelhado');
    }
  });
});

twoTenantsTest.describe('Fluxo completo — agenda externa: aceite público e isolamento entre tenants', () => {
  // E3 — plano §3.3 (o tenant vem do `Event` carregado, nunca do `ICurrentUser`; o aceite
  // público roda sem usuário; filtro `Where(TenantId == tenantId)` explícito) e §8.1 item 1
  // (`AceitePublicoAnonimo_ConexaoEmOutroTenant_NaoEnfileira` ·
  // `AceitePublicoAnonimo_NoTenantDoOrcamento_EnfileiraComEsseTenant`).
  twoTenantsTest(
    '@flow E3 aceite público anônimo de um tenant não vai à agenda conectada de outro e não quebra o aceite',
    async ({ apiA, apiB, tenantA, tenantB }) => {
      twoTenantsTest.setTimeout(240_000);

      // Tenant A tem o Google conectado; B ainda não.
      const googleA = await apiConnectGoogleCalendar(apiA, tenantA.password);

      // B: aceite público anônimo. O aceite responde e cria o evento normalmente.
      const { eventId: eventB1 } = await setupAcceptedEvent(apiB);
      expect(eventB1).toBeTruthy();
      const evB1 = await apiGetEvent(apiB, eventB1);
      expect(evB1.id).toBe(eventB1);
      // Sem conexão em B, o detalhe não tem linha de agenda externa (§4.2 item 4).
      expect(await externalCalendarsOf(apiB, eventB1)).toHaveLength(0);

      // Sentinela: um aceite em A, depois do de B, chega à agenda de A. Quando ele estiver
      // lá, o Outbox já teria entregue qualquer mensagem do aceite de B.
      const { eventId: eventA } = await setupAcceptedEvent(apiA);
      await waitForGoogleEvent(googleA.sub, eventA, (e) => e?.status === 'confirmed', {
        description: 'sentinela do tenant A',
        timeoutMs: 60_000,
      });

      // Nada de B na agenda de A: nem o evento, nem o marcador do tenant B.
      const accountA = await fakeGoogleCalendar.account(googleA.sub);
      const allA = accountA.calendars.flatMap((c) => c.events);
      expect(allA.filter((e) => e.extendedProperties?.private?.recreativoEventId === eventB1)).toHaveLength(0);
      expect(allA.filter((e) => e.extendedProperties?.private?.recreativoTenantId === tenantB.tenantId)).toHaveLength(0);
      expect(allA.every((e) => e.extendedProperties?.private?.recreativoTenantId === tenantA.tenantId)).toBe(true);

      // E nenhuma chamada ao Google carregou o evento ou o tenant de B.
      const leaked = (await fakeGoogleCalendar.inbox()).filter((entry) => {
        const raw = JSON.stringify(entry.body ?? '') + entry.path;
        return raw.includes(eventB1) || raw.includes(tenantB.tenantId);
      });
      expect(leaked, 'nenhuma chamada ao Google com dado do tenant B').toHaveLength(0);

      // B conecta a própria conta e aceita outro orçamento anônimo: vai para a agenda de B,
      // com o tenant B no marcador, e continua fora da de A.
      const googleB = await apiConnectGoogleCalendar(apiB, tenantB.password);
      expect(googleB.sub).not.toBe(googleA.sub);
      const { eventId: eventB2 } = await setupAcceptedEvent(apiB);
      const mirroredB2 = await waitForGoogleEvent(googleB.sub, eventB2, (e) => e?.status === 'confirmed', {
        description: 'aceite anônimo de B na agenda de B',
        timeoutMs: 60_000,
      });
      expect(mirroredB2!.calendarId).toBe(googleB.calendarId);
      expect(mirroredB2!.extendedProperties?.private?.recreativoTenantId).toBe(tenantB.tenantId);

      expect(await fakeGoogleCalendar.eventFor(googleA.sub, eventB2)).toBeUndefined();
      const liveA = await fakeGoogleCalendar.liveEvents(googleA.sub);
      expect(liveA.some((e) => e.extendedProperties?.private?.recreativoTenantId === tenantB.tenantId)).toBe(false);
    },
  );
});
