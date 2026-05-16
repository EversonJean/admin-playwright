import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '.env') });

const FRONT_URL = process.env.FRONT_URL ?? 'http://localhost:4200';
const BACK_URL = process.env.BACK_URL ?? 'https://localhost:1501';
const SKIP_WEBSERVER = process.env.SKIP_WEBSERVER === 'true';

const BACK_CONNECTION_STRING =
  process.env.BACK_CONNECTION_STRING ??
  'Host=localhost;Port=5432;Database=adminbackend;Username=postgres;Password=postgres';

const BACK_PROJECT_PATH = process.env.BACK_PROJECT_PATH ?? '../admin-backend/src/AdminBackend.Api';
const FRONT_PROJECT_PATH = process.env.FRONT_PROJECT_PATH ?? '../admin-frontend';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // Angular dev server (ng serve) local nao aguenta 4 workers simultaneos
  // em testes UI pesados (form fill + submit + waitForURL). 2 workers eh o
  // sweet spot: paralelismo razoavel sem timeouts intermitentes.
  workers: 2,
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
  ],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: FRONT_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ignoreHTTPSErrors: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: SKIP_WEBSERVER
    ? undefined
    : [
        // Fake providers — sobem ANTES do back porque o back resolve BaseUrl
        // deles no startup (HttpClient factory). reuseExistingServer permite
        // rodar specs sucessivos sem reinicializar tudo em dev.
        {
          name: 'fake-asaas',
          command: 'npm run fakes:asaas',
          url: 'http://localhost:1510/_control/health',
          timeout: 30_000,
          reuseExistingServer: !process.env.CI,
        },
        {
          name: 'admin-backend',
          // Profile `e2e` no launchSettings.json fixa ASPNETCORE_ENVIRONMENT=E2E
          // (que carrega appsettings.E2E.json: Outbox in-memory + endpoints
          // `/api/_e2e/*`). Definir ASPNETCORE_ENVIRONMENT no `env` abaixo NÃO
          // funciona — launchSettings.json sobrescreve.
          command: `dotnet run --project "${BACK_PROJECT_PATH}" --launch-profile e2e`,
          url: `${BACK_URL}/health`,
          timeout: 180_000,
          reuseExistingServer: !process.env.CI,
          ignoreHTTPSErrors: true,
          env: {
            ConnectionStrings__Default: BACK_CONNECTION_STRING,
          },
        },
        {
          name: 'admin-frontend',
          command: 'npm start',
          cwd: FRONT_PROJECT_PATH,
          url: FRONT_URL,
          timeout: 180_000,
          reuseExistingServer: !process.env.CI,
        },
      ],
});
