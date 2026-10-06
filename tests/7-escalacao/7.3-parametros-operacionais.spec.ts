import { APIRequestContext } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import {
  apiCompleteOnboarding,
  apiCreateCollaborator,
  apiSetSettingParameter,
} from '../../helpers/api-entities';
import { apiAssignCollaborator, apiGetEvent } from '../../helpers/api-event-flow';
import { setupAcceptedEvent } from '../../helpers/setup-flows';

/**
 * Fluxo: 7.3 — Parâmetros operacionais (configuráveis por empresa)
 * Diagrama: docs/fluxos/negocio-7.3-parametros-operacionais.mmd
 *
 * Inclui modalidades, níveis, prazos de pagamento — todos sob /app/settings/*.
 *
 * Etapa 198 (PLANO-AJUSTES-DA-CONVERSAO §7 item 2, D7; registro e2e E20): os
 * parâmetros da agenda da equipe valem por tenant. A antecedência de chegada
 * (`COLLABORATOR_ARRIVAL_BUFFER_MINUTES`) entra na janela de compromisso da
 * escalação; o máximo de eventos por dia (`COLLABORATOR_MAX_EVENTS_PER_DAY`)
 * vira aviso `S2` que pede justificativa, nunca bloqueio.
 */

interface ScheduleAssignment {
  eventId: string;
  commitmentStart: string;
  commitmentEnd: string;
}

/** Janela gravada na escalação do colaborador para o evento, pela agenda dele. */
async function commitmentWindow(
  api: APIRequestContext,
  collaboratorId: string,
  eventId: string,
): Promise<{ start: number; end: number }> {
  const fromUtc = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const toUtc = new Date(Date.now() + 60 * 86_400_000).toISOString();
  const res = await api.get(
    `/api/collaborators/${collaboratorId}/schedule?fromUtc=${fromUtc}&toUtc=${toUtc}`,
  );
  expect(res.ok(), await res.text()).toBe(true);
  const body = (await res.json()) as { data?: { assignments: ScheduleAssignment[] } };
  const row = body.data?.assignments.find((a) => a.eventId === eventId);
  expect(row, `escalação de ${collaboratorId} no evento ${eventId}`).toBeTruthy();
  return { start: Date.parse(row!.commitmentStart), end: Date.parse(row!.commitmentEnd) };
}

function datePlus(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

test.describe('Fluxo 7.3 — Parâmetros operacionais', () => {
  // Tenant novo cai no assistente de configuração (`onboardingGuard`, Etapa
  // 109) a cada carga de página, assim que o `/me` hidrata `isOnboarded=false`.
  // Sem concluir a configuração, o teste corria contra esse redirect: o smoke
  // às vezes conferia a URL antes dele, e o form nunca aparecia.
  test.beforeEach(async ({ authApi }) => {
    await apiCompleteOnboarding(authApi);
  });

  test('@flow modalidades carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/service-modalities');
  });

  test('@flow níveis de colaborador carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/collaborator-levels');
  });

  test('@flow termos de pagamento carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/payment-terms');
  });

  test('@flow tela geral de parâmetros carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/parameters');
  });

  test('@crud cria modalidade via UI e valida no back', async ({ authPage, authApi }) => {
    const nome = `Modalidade E2E ${Date.now()}`;

    await authPage.goto('/app/settings/service-modalities/new');
    await authPage.getByTestId('modality-form-name').fill(nome);
    await authPage.getByTestId('modality-form-value').fill('150');
    await authPage.getByTestId('modality-form-save').click();

    await authPage.waitForURL(/\/app\/settings\/service-modalities(\?|$)/, { timeout: 10_000 });

    const res = await authApi.get('/api/service-modalities');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const items = body.data?.items ?? body.items ?? body.data ?? body;
    const list = Array.isArray(items) ? items : items.items ?? [];
    expect(list.some((m: { name?: string }) => m.name === nome)).toBe(true);
  });

  test('@crud cria nível de colaborador via UI e valida no back', async ({ authPage, authApi }) => {
    const nome = `Nível E2E ${Date.now()}`;

    await authPage.goto('/app/settings/collaborator-levels/new');
    await authPage.getByTestId('level-form-name').fill(nome);
    await authPage.getByTestId('level-form-order').fill('99');
    await authPage.getByTestId('level-form-base-value').fill('200');
    await authPage.getByTestId('level-form-save').click();

    await authPage.waitForURL(/\/app\/settings\/collaborator-levels(\?|$)/, { timeout: 10_000 });

    const res = await authApi.get('/api/collaborator-levels');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const items = body.data?.items ?? body.items ?? body.data ?? body;
    const list = Array.isArray(items) ? items : items.items ?? [];
    expect(list.some((l: { name?: string }) => l.name === nome)).toBe(true);
  });

  test('@flow arrival buffer of 45 min widens the staffing commitment window', async ({
    authApi,
  }) => {
    const { eventId } = await setupAcceptedEvent(authApi);
    // Mesmo endereço (fakeAddress): o deslocamento estimado é o mesmo para os dois.
    const before = await apiCreateCollaborator(authApi);
    const after = await apiCreateCollaborator(authApi);

    // Sem valor gravado: o default de hoje (15 min).
    await apiAssignCollaborator(authApi, eventId, before.id);
    await apiSetSettingParameter(authApi, 'COLLABORATOR_ARRIVAL_BUFFER_MINUTES', 45);
    await apiAssignCollaborator(authApi, eventId, after.id);

    const w15 = await commitmentWindow(authApi, before.id, eventId);
    const w45 = await commitmentWindow(authApi, after.id, eventId);
    // A janela começa 30 min antes (45 - 15) e termina no mesmo ponto.
    expect((w15.start - w45.start) / 60_000).toBe(30);
    expect(w45.end).toBe(w15.end);
  });

  test('@crud max 2 events per day: the 3rd event of the day shows the S2 warning and staffing proceeds with justification', async ({
    authApi,
    authPage,
  }) => {
    await apiSetSettingParameter(authApi, 'COLLABORATOR_MAX_EVENTS_PER_DAY', 2);
    const day = datePlus(40);
    // Três festas no mesmo dia, longe o bastante para não haver sobreposição
    // (H1) nem intervalo curto (H2): só o limite diário entra em jogo.
    const first = await setupAcceptedEvent(authApi, {
      budget: { eventDate: day, startTime: '08:00', endTime: '10:00' },
    });
    const second = await setupAcceptedEvent(authApi, {
      budget: { eventDate: day, startTime: '12:00', endTime: '14:00' },
    });
    const third = await setupAcceptedEvent(authApi, {
      budget: { eventDate: day, startTime: '16:00', endTime: '18:00' },
    });
    const collaborator = await apiCreateCollaborator(authApi);
    await apiAssignCollaborator(authApi, first.eventId, collaborator.id);
    await apiAssignCollaborator(authApi, second.eventId, collaborator.id);

    await authPage.goto(`/app/events/${third.eventId}`);
    await authPage.getByRole('tab', { name: 'Equipe', exact: true }).click();
    await authPage.getByTestId('event-detail-team-assign').click();
    await expect(authPage.getByTestId('assign-collaborator-title')).toBeVisible();

    await authPage.getByTestId('assign-collaborator-select').click();
    await authPage.getByTestId(`assign-collaborator-option-${collaborator.id}`).click();
    await authPage.getByTestId('assign-collaborator-confirm').click();

    // Aviso S2, não bloqueio: o diálogo pede justificativa.
    const warning = authPage.locator('[data-testid="conflict-viewer-item"][data-code="S2"]');
    await expect(warning).toBeVisible({ timeout: 15_000 });
    await expect(warning).toHaveAttribute('data-severity', 'Soft');
    await expect(authPage.getByTestId('assign-collaborator-override-reason')).toBeVisible();

    await authPage
      .getByTestId('assign-collaborator-override-reason')
      .fill('Festas curtas no mesmo bairro, recreador de acordo');
    await authPage.getByTestId('assign-collaborator-confirm').click();
    await expect(authPage.getByTestId('assign-collaborator-title')).toHaveCount(0, {
      timeout: 15_000,
    });

    const ev = (await apiGetEvent(authApi, third.eventId)) as {
      collaborators?: Array<{ collaboratorId: string }>;
    };
    expect(ev.collaborators?.map((c) => c.collaboratorId)).toContain(collaborator.id);
  });
});
