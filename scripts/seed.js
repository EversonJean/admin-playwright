#!/usr/bin/env node
/**
 * seed — carga de MASSA DE TESTE MANUAL na aplicação que já está no ar.
 *
 * Cada execução cria um LOTE: uma empresa nova, com login próprio, e os
 * registros dos fluxos pedidos (pelo menos 3 por fluxo). Rodar de novo cria
 * outro lote com a mesma estrutura e dados sorteados de novo; os lotes não se
 * misturam, porque cada empresa só vê o que é dela.
 *
 *   npm run seed -- 5.3                 massa do fluxo 5.3
 *   npm run seed -- 5                   todos os fluxos da área 5
 *   npm run seed -- 5.3 10.1 FC-03      vários fluxos na MESMA empresa
 *   npm run seed -- fc                  todos os fluxos completos
 *   npm run seed -- all                 tudo (demora alguns minutos)
 *   npm run seed -- 5.3 --runs 3        3 lotes: mesma estrutura, dados diferentes
 *   npm run seed -- 5.3 --lot a1b2c3    refaz a carga com os MESMOS dados sorteados daquele lote
 *   npm run seed -- 5.3 --up            sobe o back e os simuladores do e2e só para carregar (aplicação parada)
 *   npm run seed -- 5.3 --up --db massa sobe o back num banco à parte (criado e migrado na hora), sem tocar no do e2e
 *   npm run seed -- --list              os fluxos que têm massa e o que cada um cria
 *
 * Alvo: por padrão o back, o front e o banco do `.env` (os mesmos do e2e).
 * Para a aplicação de desenvolvimento, diga onde ela está:
 *   npm run seed -- 5.3 --back https://localhost:1501 --front http://localhost:4200 --db admin-dev
 *
 * O roteiro de cada lote (endereço, logins, senhas e registros por fluxo) sai
 * no terminal e em `seeds/output/lote-<id>.md`. O que testar com ele:
 * `docs/cenarios-de-teste/` na raiz do workspace.
 *
 * [ALERTA] Só grava em `localhost`: a carga cria empresas e confirma e-mail
 * direto no banco, e isso nunca pode acontecer num ambiente de verdade.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

function usage() {
  const header = fs.readFileSync(__filename, 'utf8').split('*/')[0];
  console.log(header.split('\n').slice(1).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
}

function parseArgs(argv) {
  const out = { flows: [], runs: 1, lot: null, list: false, help: false, up: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--list') out.list = true;
    else if (arg === '--up') out.up = true;
    else if (arg === '--runs') out.runs = Number(argv[++i]);
    else if (arg === '--lot') out.lot = argv[++i];
    else if (arg === '--back') process.env.BACK_URL = argv[++i];
    else if (arg === '--front') process.env.FRONT_URL = argv[++i];
    else if (arg === '--db') useDatabase(argv[++i]);
    else if (arg.startsWith('--')) fail(`opção desconhecida: ${arg} (veja npm run seed -- --help)`);
    else out.flows.push(...arg.split(',').filter(Boolean));
  }
  return out;
}

/** O banco da carga e, com --up, o do back que ela sobe: os dois têm de ser o mesmo. */
function useDatabase(name) {
  if (!name || !/^[A-Za-z0-9_-]+$/.test(name)) fail('--db espera o nome do banco (letras, números, - e _)');
  process.env.PG_DATABASE = name;
  const current =
    process.env.BACK_CONNECTION_STRING ?? 'Host=localhost;Port=5432;Database=adminbackend;Username=postgres;Password=postgres';
  process.env.BACK_CONNECTION_STRING = current.replace(/Database=[^;]*/, 'Database=' + name);
}

function fail(message) {
  console.error(`seed: ${message}`);
  process.exit(2);
}

/** Pares `flow` + `summary` de `seeds/flows/*.ts` (a mesma leitura do check-scenarios.js). */
function catalog() {
  const dir = path.join(ROOT, 'seeds', 'flows');
  const pair = /flow:\s*'([^']+)',\s*summary:\s*'((?:[^'\\]|\\.)*)'/g;
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    if (!name.endsWith('.ts')) continue;
    for (const m of fs.readFileSync(path.join(dir, name), 'utf8').matchAll(pair)) out.push({ flow: m[1], summary: m[2] });
  }
  return out;
}

function health(url) {
  return new Promise((resolve) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(`${url}/health`, { rejectUnauthorized: false, timeout: 5000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  if (args.list) {
    for (const item of catalog()) console.log(`${item.flow.padEnd(6)} ${item.summary}`);
    return;
  }
  if (args.flows.length === 0) fail('diga o fluxo: npm run seed -- 5.3   (ou --list para ver os que têm massa)');
  if (!Number.isInteger(args.runs) || args.runs < 1 || args.runs > 20) fail('--runs espera um número de 1 a 20');
  if (args.lot && args.runs > 1) fail('--lot refaz UMA carga; não combina com --runs');
  if (args.lot && !/^[0-9a-f]{6}$/.test(args.lot)) fail('--lot espera o id de 6 caracteres do lote (ex.: a1b2c3)');

  const backUrl = process.env.BACK_URL ?? 'https://localhost:1501';
  const host = new URL(backUrl).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) fail(`a carga só grava em localhost; o alvo é ${backUrl}`);

  if (!args.up && !(await health(backUrl))) {
    fail(
      `o back não respondeu em ${backUrl}/health. Suba a aplicação antes (skill start-app, ou a stack do e2e) ` +
        'aponte para a que está no ar com --back, --front e --db, ou use --up para a carga subir o back do e2e sozinha.',
    );
  }

  console.log(
    `seed: ${args.runs} lote(s) de [${args.flows.join(', ')}] em ${backUrl} (banco ${process.env.PG_DATABASE ?? 'adminbackend'})`,
  );
  const cli = ['playwright', 'test', '-c', 'playwright.seed.config.ts'];
  if (args.runs > 1) cli.push('--repeat-each', String(args.runs));
  const result = spawnSync('npx', cli, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, BACK_URL: backUrl, SEED_FLOWS: args.flows.join(','), SEED_LOT: args.lot ?? '', SEED_UP: args.up ? 'true' : '' },
  });
  process.exit(result.status ?? 1);
}

main();
