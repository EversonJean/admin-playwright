import { defineConfig } from '@playwright/test';
import * as dotenv from 'dotenv';
import * as path from 'path';
import e2eConfig from './playwright.config';

dotenv.config({ path: path.resolve(__dirname, '.env') });

/**
 * Config da CARGA DE MASSA (`npm run seed`), separada da suíte: os arquivos
 * `seeds/*.seed.ts` nunca entram no `npm test`. Um worker só: os lotes saem um
 * depois do outro.
 *
 * Por padrão a carga não sobe servidor nenhum: grava na aplicação que JÁ está
 * no ar (o `scripts/seed.js` confere o `/health` antes). Com `--up`
 * (`SEED_UP=true`) ela sobe o back e os simuladores do e2e só enquanto carrega,
 * reaproveitando os que já estiverem de pé, e os derruba no fim; o front não é
 * necessário para carregar. A massa fica no banco para quando a aplicação subir.
 */
const FRONT_SERVERS = ['admin-frontend', 'super-admin'];
const e2eServers = Array.isArray(e2eConfig.webServer) ? e2eConfig.webServer : [];

export default defineConfig({
  testDir: './seeds',
  testMatch: '**/*.seed.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  timeout: 30 * 60_000,
  use: { ignoreHTTPSErrors: true },
  webServer:
    process.env.SEED_UP === 'true' ? e2eServers.filter((s) => !FRONT_SERVERS.includes(s.name ?? '')) : undefined,
});
