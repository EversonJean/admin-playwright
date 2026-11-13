import { defineConfig, devices } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '.env') });

const DEFAULT_BACK_URL = 'https://localhost:1501';
const FRONT_URL = process.env.FRONT_URL ?? 'http://localhost:4200';
// Painel Super Admin — build/origem próprios desde SEPARACAO-SUPER-ADMIN.md
// (project `super-admin` do workspace Angular, porta 4201 em dev).
const SUPER_ADMIN_URL = process.env.SUPER_ADMIN_URL ?? 'http://localhost:4201';
const BACK_URL = process.env.BACK_URL ?? DEFAULT_BACK_URL;
const SKIP_WEBSERVER = process.env.SKIP_WEBSERVER === 'true';

const BACK_CONNECTION_STRING =
  process.env.BACK_CONNECTION_STRING ??
  'Host=localhost;Port=5432;Database=adminbackend;Username=postgres;Password=postgres';

const BACK_PROJECT_PATH = process.env.BACK_PROJECT_PATH ?? '../admin-backend/src/AdminBackend.Api';
const FRONT_PROJECT_PATH = process.env.FRONT_PROJECT_PATH ?? '../admin-frontend';

// [DECISAO] Segundo clone na mesma maquina: o .env (gitignored) troca BACK_URL,
// FRONT_URL, SUPER_ADMIN_URL e o banco, e a suite sobe a stack inteira nessas
// portas, sem tocar na do outro clone (que segue em 1501/4200/4201). Sem .env,
// nada muda: os comandos abaixo saem identicos aos de sempre.
// O proxy.conf.json versionado aponta para a 1501; com outro back, o dev server
// recebe uma copia dele com o target trocado, gravada fora do repo.
function e2eProxyConfig(): string | null {
  if (BACK_URL === DEFAULT_BACK_URL) return null;
  const source = path.resolve(__dirname, FRONT_PROJECT_PATH, 'proxy.conf.json');
  const routes = JSON.parse(fs.readFileSync(source, 'utf8')) as Record<string, { target: string }>;
  for (const route of Object.values(routes)) route.target = BACK_URL;
  const file = path.join(os.tmpdir(), `admin-e2e-proxy-${new URL(BACK_URL).port}.json`);
  const content = JSON.stringify(routes, null, 2);
  // a config e avaliada de novo em cada worker: so grava se mudou
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) fs.writeFileSync(file, content);
  return file;
}
const E2E_PROXY_CONFIG = SKIP_WEBSERVER ? null : e2eProxyConfig();

// Argumentos extras do `ng serve`: porta, quando o .env troca, e o proxy acima.
function ngServeArgs(url: string, defaultPort: string): string {
  const port = new URL(url).port;
  const args = [
    ...(port !== defaultPort ? ['--port', port] : []),
    ...(E2E_PROXY_CONFIG ? ['--proxy-config', `"${E2E_PROXY_CONFIG}"`] : []),
  ];
  return args.length ? ` -- ${args.join(' ')}` : '';
}

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
          name: 'fake-clicksign',
          command: 'npm run fakes:clicksign',
          url: 'http://localhost:1511/_control/health',
          timeout: 30_000,
          reuseExistingServer: !process.env.CI,
        },
        {
          name: 'fake-whatsapp',
          command: 'npm run fakes:whatsapp',
          url: 'http://localhost:1512/_control/health',
          timeout: 30_000,
          // App da Meta de TESTE (PLANO-SEGURANCA E143, E147): o fake confere
          // `client_id`/`client_secret` e o `{AppId}` do upload contra os mesmos
          // literais de `WhatsApp:AppId`/`AppSecret` do `appsettings.E2E.json`.
          reuseExistingServer: !process.env.CI,
        },
        {
          name: 'fake-email',
          command: 'npm run fakes:email',
          url: 'http://localhost:1513/_control/health',
          timeout: 30_000,
          reuseExistingServer: !process.env.CI,
        },
        {
          name: 'fake-openai',
          command: 'npm run fakes:openai',
          url: 'http://localhost:1514/_control/health',
          timeout: 30_000,
          reuseExistingServer: !process.env.CI,
        },
        {
          name: 'fake-anthropic',
          command: 'npm run fakes:anthropic',
          url: 'http://localhost:1515/_control/health',
          timeout: 30_000,
          reuseExistingServer: !process.env.CI,
        },
        {
          name: 'fake-google-maps',
          command: 'npm run fakes:maps',
          url: 'http://localhost:1516/_control/health',
          timeout: 30_000,
          reuseExistingServer: !process.env.CI,
        },
        {
          // PLANO-AGENDAS-EXTERNAS §12: OAuth, JWKS do id_token e Calendar API.
          name: 'fake-google-calendar',
          command: 'npm run fakes:google-calendar',
          url: 'http://localhost:1517/_control/health',
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
          // Vencem o appsettings.E2E.json porque o Program.cs re-adiciona as
          // variaveis de ambiente depois dele (so no ambiente E2E).
          env: {
            ConnectionStrings__Default: BACK_CONNECTION_STRING,
            Kestrel__Endpoints__Https__Url: BACK_URL,
            Email__FrontBaseUrl: FRONT_URL,
          },
        },
        {
          name: 'admin-frontend',
          command: `npm start${ngServeArgs(FRONT_URL, '4200')}`,
          cwd: FRONT_PROJECT_PATH,
          url: FRONT_URL,
          timeout: 180_000,
          reuseExistingServer: !process.env.CI,
        },
        {
          name: 'super-admin',
          command: `npm run start:super-admin${ngServeArgs(SUPER_ADMIN_URL, '4201')}`,
          cwd: FRONT_PROJECT_PATH,
          url: SUPER_ADMIN_URL,
          timeout: 180_000,
          reuseExistingServer: !process.env.CI,
        },
      ],
});
