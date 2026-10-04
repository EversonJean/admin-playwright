import { test, expect } from '@playwright/test';
import { authTest } from '../../fixtures/auth.fixture';
import { isBackendHealthy } from '../../helpers/api-client';
import { apiCreateCollaborator } from '../../helpers/api-entities';
import { apiAssignCollaborator, apiCreatePublicEvent } from '../../helpers/api-event-flow';
import {
  enableFeatureFlagDirect,
  seedOpenAirFormDataDirect,
  setEventAddressDirect,
} from '../../helpers/db-helper';
import { fakeOpenAi } from '../../helpers/fake-providers';
import { assertOk, readJson } from '../../helpers/response';
import { setupAcceptedEvent } from '../../helpers/setup-flows';

/**
 * Smoke test de infraestrutura — valida que back e front estão respondendo.
 * Não depende de tenant ou banco populado.
 *
 * Se este teste falhar, NADA depois disso vai funcionar — investigue stack
 * antes de mexer em qualquer outro teste.
 */
test.describe('Infra — back e front respondendo', () => {
  test('@smoke backend /health retorna 200', async () => {
    const ok = await isBackendHealthy();
    expect(ok).toBe(true);
  });

  test('@smoke frontend serve a página raiz', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBeLessThan(400);
    await expect(page).toHaveTitle(/.+/);
  });

  test('@smoke frontend redireciona pra /auth/login quando anônimo', async ({ page }) => {
    await page.goto('/app');
    await expect(page).toHaveURL(/\/auth\/login/);
  });
});

/**
 * E37 (PLANO-AJUSTES-DA-CONVERSAO §12 item 2, Etapa 203): a suíte roda sem rede
 * externa. O `appsettings.E2E.json` escolhe `Weather:Provider=Fake`, e com ele
 * o cliente da Open-Meteo nem é registrado no DI: ler a previsão do fake é a
 * prova de que nenhuma chamada sai para a Open-Meteo.
 *
 * A previsão do fake é fixa: seca (10% de chuva), 24 °C e vento de 8 km/h o
 * dia inteiro (`FakeWeatherForecastProvider`).
 *   - Plano do evento público: o resumo do clima entra no prompt do
 *     planejador, e o prompt é lido no inbox do fake de IA — marca positiva.
 *   - Torre de Controle: com essa previsão, festa ao ar livre não ganha sinal
 *     de clima (os limiares são 40% de chuva e 40 km/h de vento). O fake não
 *     tem valor que gere o card, e o comentário dele pede para não ajustar o
 *     número; aqui a torre lê o fake e não acusa clima.
 */
const FAKE_WEATHER_SUMMARY = 'CLIMA PREVISTO: sem chuva prevista, máxima de 24°C';

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

authTest.describe('Infra — clima pelo provider fake, sem Open-Meteo', () => {
  authTest('@flow public event plan reads the fake forecast', async ({ authApi, tenant }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_ai');
    enableFeatureFlagDirect(tenant.tenantId, 'feature_ticketing');
    await assertOk(
      await authApi.put('/api/ai/features/ai_public_event_planner', {
        data: { enabled: true, configJson: null },
      }),
      'liga o planejador na Central de IA',
    );

    const title = `Evento público clima E2E ${Date.now()}`;
    const event = await apiCreatePublicEvent(authApi, { title, eventDate: inDays(5) });
    setEventAddressDirect(event.id, 'Curitiba', 'PR');
    const collaborator = await apiCreateCollaborator(authApi);
    await apiAssignCollaborator(authApi, event.id, collaborator.id);

    const since = new Date().toISOString();
    await assertOk(
      await authApi.post(`/api/events/${event.id}/playbook/generate-public-event-plan`),
      'POST generate-public-event-plan',
    );

    const prompts = (await fakeOpenAi.inbox({ since }))
      .filter((e) => e.method === 'POST' && e.path === '/chat/completions')
      .map((e) => JSON.stringify(e.body));
    const planPrompt = prompts.find((p) => p.includes(`EVENTO: ${title}`));
    expect(planPrompt, 'o planejador chamou o fake de IA com o evento').toBeTruthy();
    expect(planPrompt).toContain(FAKE_WEATHER_SUMMARY);
  });

  authTest('@flow control tower reads the fake forecast for an open-air party', async ({
    authApi,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_ai');
    await assertOk(
      await authApi.put('/api/ai/features/ai_control_tower', { data: { enabled: true, configJson: null } }),
      'liga a Torre de Controle na Central de IA',
    );

    // Festa daqui a 3 dias, em Curitiba (endereço do aceite), ao ar livre.
    const { eventId } = await setupAcceptedEvent(authApi, {
      budget: { eventDate: inDays(3), validUntilDate: inDays(1) },
    });
    // Formulário pós-aceite "ao ar livre" pelo banco: o PATCH form-data dá 409
    // na primeira gravação (ver `seedOpenAirFormDataDirect`).
    seedOpenAirFormDataDirect(eventId);

    await assertOk(await authApi.post('/api/ai/control-tower/refresh'), 'POST control-tower/refresh');
    const res = await authApi.get('/api/ai/control-tower');
    await assertOk(res, 'GET /api/ai/control-tower');
    const tower = await readJson<{ signals: Array<{ eventId: string; kind: string }> }>(res);

    const ownSignals = tower.signals.filter((s) => s.eventId === eventId);
    // A festa entrou na janela da torre: sem equipe e sem pagamento, ela tem
    // outros sinais. Sem isto, "sem card de clima" passaria por festa ignorada.
    expect(ownSignals.length, 'a torre analisou a festa').toBeGreaterThan(0);
    expect(ownSignals.map((s) => s.kind), 'festa ao ar livre com previsão seca: sem card de clima').not.toContain(
      'WeatherOutdoor',
    );
  });
});
