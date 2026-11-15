import * as fs from 'fs';
import * as path from 'path';
import { APIRequestContext } from '@playwright/test';
import { createApiContext, createBearerApiContext, signupAndConfirm } from '../../helpers/api-client';
import { apiCompleteOnboarding } from '../../helpers/api-entities';
import { createRng, newLotId, randomCompanyName, randomPeople, Rng } from './random';

/**
 * Lote = uma carga de massa: uma empresa NOVA (tenant) com login próprio e os
 * registros dos fluxos pedidos. Cada carga cria outra empresa, então cargas
 * repetidas nunca se misturam nem dependem de limpeza do banco.
 */

const BACK_URL = process.env.BACK_URL ?? 'https://localhost:1501';
const FRONT_URL = process.env.FRONT_URL ?? 'http://localhost:4200';
const SUPER_ADMIN_URL = process.env.SUPER_ADMIN_URL ?? 'http://localhost:4201';
const OUTPUT_DIR = path.resolve(__dirname, '..', 'output');

export const LOT_PASSWORD = 'Massa@12345';

/** Fakes do e2e (`fake-providers/`), com a porta de cada um no `playwright.config.ts`. */
const SIMULATORS: Array<[string, number]> = [
  ['Asaas (cobrança da assinatura)', 1510],
  ['Clicksign (assinatura digital)', 1511],
  ['WhatsApp', 1512],
  ['E-mail', 1513],
  ['IA (OpenAI)', 1514],
  ['IA (Anthropic)', 1515],
  ['Google Maps', 1516],
  ['Google Agenda', 1517],
];

export interface LotRecord {
  flow: string;
  label: string;
  detail: string;
}

export interface LotLogin {
  role: string;
  url: string;
  email: string;
  password: string;
  note?: string;
}

export interface Lot {
  id: string;
  rng: Rng;
  /** API autenticada como o dono da empresa do lote. */
  api: APIRequestContext;
  company: { name: string; adminName: string; email: string; password: string; tenantId: string; userId: string };
  frontUrl: string;
  superAdminUrl: string;
  records: LotRecord[];
  logins: LotLogin[];
  /** Fluxo em carga: o `note` grava o registro nele. */
  currentFlow: string;
  /** Anota um registro do fluxo em carga; é o que a pessoa lê para saber qual usar. */
  note(label: string, detail: string): void;
  addLogin(login: LotLogin): void;
  /** Construtor compartilhado: roda uma vez por lote, mesmo pedido por vários fluxos. */
  once<T>(key: string, build: () => Promise<T>): Promise<T>;
  /**
   * O primeiro dia livre do lote a partir de `iso` (e o reserva). Cada festa da
   * massa cai num dia só dela: com vários fluxos na mesma empresa, a mesma
   * equipe é escalada em todas, e duas festas no mesmo dia e horário são
   * recusadas pela regra de agenda (`Schedule.H1`).
   */
  freeDay(iso: string): string;
  dispose(): Promise<void>;
}

export async function openLot(forcedId?: string): Promise<Lot> {
  const id = forcedId ?? newLotId();
  const rng = createRng(id.padEnd(8, '0'));
  const [admin] = randomPeople(rng, id, 1, 'dono');
  const companyName = randomCompanyName(rng, id);

  const anon = await createApiContext();
  let signup;
  try {
    signup = await signupAndConfirm(anon, {
      companyName,
      adminName: admin!.name,
      adminEmail: admin!.email,
      adminPassword: LOT_PASSWORD,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const hint = /EmailNotVerified/.test(message)
      ? `\n[ALERTA] O back em ${BACK_URL} não usa o banco "${process.env.PG_DATABASE ?? 'adminbackend'}" em que a carga confirmou o e-mail. ` +
        'Passe o banco do back que está no ar: npm run seed -- <fluxo> --db <nome-do-banco>.'
      : '';
    throw new Error(`Não consegui criar a empresa do lote: ${message}${hint}`);
  } finally {
    await anon.dispose();
  }

  const api = await createBearerApiContext(signup.accessToken);
  // Sem isto o front manda a empresa nova para o assistente de configuração a cada tela.
  await apiCompleteOnboarding(api);

  const cache = new Map<string, Promise<unknown>>();
  const usedDays = new Set<string>();
  const lot: Lot = {
    id,
    rng,
    api,
    company: {
      name: companyName,
      adminName: admin!.name,
      email: signup.email,
      password: signup.password,
      tenantId: signup.tenantId,
      userId: signup.userId,
    },
    frontUrl: FRONT_URL,
    superAdminUrl: SUPER_ADMIN_URL,
    records: [],
    logins: [],
    currentFlow: '',
    note(label, detail) {
      lot.records.push({ flow: lot.currentFlow, label, detail });
    },
    addLogin(login) {
      if (!lot.logins.some((l) => l.email === login.email)) lot.logins.push(login);
    },
    once<T>(key: string, build: () => Promise<T>): Promise<T> {
      if (!cache.has(key)) cache.set(key, build());
      return cache.get(key) as Promise<T>;
    },
    freeDay(iso) {
      let day = iso;
      while (usedDays.has(day)) {
        day = new Date(Date.parse(day + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
      }
      usedDays.add(day);
      return day;
    },
    dispose: () => api.dispose(),
  };
  lot.addLogin({ role: 'Dono da empresa (acesso total)', url: `${FRONT_URL}/auth/login`, email: signup.email, password: signup.password });
  return lot;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** Grava `seeds/output/lote-<id>.md` e devolve o caminho. */
export function writeLotReport(lot: Lot, flows: Array<{ flow: string; summary: string }>): string {
  const lines: string[] = [
    `# Lote ${lot.id} — ${lot.company.name}`,
    '',
    `> Gerado em ${new Date().toLocaleString('pt-BR')} · back ${BACK_URL} · banco ${process.env.PG_DATABASE ?? 'adminbackend'}`,
    `> Fluxos carregados: ${flows.map((f) => f.flow).join(', ')}`,
    '',
    '## Como entrar',
    '',
    '| Perfil | Endereço | Login | Senha | Observação |',
    '|---|---|---|---|---|',
    ...lot.logins.map((l) => `| ${cell(l.role)} | ${l.url} | \`${l.email}\` | \`${l.password}\` | ${cell(l.note ?? '')} |`),
    '',
    '## Registros por fluxo',
    '',
    'Roteiro de cada fluxo: `docs/cenarios-de-teste/<área>/<fluxo>-*.md`.',
  ];
  for (const f of flows) {
    lines.push('', `### ${f.flow}`, '', f.summary, '');
    const records = lot.records.filter((r) => r.flow === f.flow);
    if (records.length === 0) lines.push('_Nenhum registro anotado._');
    else lines.push('| Registro | Detalhe |', '|---|---|', ...records.map((r) => `| ${cell(r.label)} | ${cell(r.detail)} |`));
  }
  lines.push(
    '',
    '## Simuladores (só na stack de e2e)',
    '',
    'Na stack de e2e nada sai para fora: e-mail, WhatsApp, Google, Asaas, assinatura digital e IA respondem por simuladores locais. O que cada um recebeu fica em `/_control/inbox`:',
    '',
    '| Simulador | Caixa de entrada |',
    '|---|---|',
    ...SIMULATORS.map(([name, port]) => `| ${name} | http://localhost:${port}/_control/inbox |`),
    '',
    'Na aplicação de desenvolvimento (fora da stack de e2e) esses endereços não existem, e o que depende de serviço externo segue a configuração de lá.',
  );
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const file = path.join(OUTPUT_DIR, `lote-${lot.id}.md`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}
