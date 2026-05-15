#!/usr/bin/env node
/**
 * gen-stubs — gera um arquivo .spec.ts (stub com test.fixme) para cada
 * fluxo .mmd em `docs/fluxos/negocio-*.mmd`.
 *
 * Idempotente: NÃO sobrescreve arquivos existentes. Pra forçar, passe --force.
 *
 * Uso:
 *   node scripts/gen-stubs.js          # cria os que faltam
 *   node scripts/gen-stubs.js --force  # sobrescreve tudo (cuidado se já implementou alguns)
 */

const fs = require('fs');
const path = require('path');

const FLUXOS_DIR = path.resolve(__dirname, '..', '..', '..', 'docs', 'fluxos');
const TESTS_DIR = path.resolve(__dirname, '..', 'tests');
const FORCE = process.argv.includes('--force');

const SECTION_NAMES = {
  '1': '1-onboarding',
  '2': '2-cadastros',
  '3': '3-equipe',
  '4': '4-comercial',
  '5': '5-orcamento',
  '6': '6-eventos',
  '7': '7-escalacao',
  '8': '8-calendario',
  '9': '9-contratos',
  '10': '10-financeiro',
  '11': '11-comunicacao',
  '12': '12-dashboard',
  '13': '13-portal-colaborador',
  '14': '14-governanca',
  '15': '15-locacao',
  '16': '16-super-admin',
  '17': '17-seguranca',
};

function parseFluxoFile(filename) {
  const match = filename.match(/^negocio-(\d+)(?:\.(\d+))?-(.+)\.mmd$/);
  if (!match) return null;
  const [, major, minor, slug] = match;
  return {
    filename,
    code: minor ? `${major}.${minor}` : major,
    section: major,
    slug,
    title: slug.replace(/-/g, ' '),
  };
}

function readMmdTitle(filepath) {
  try {
    const content = fs.readFileSync(filepath, 'utf-8');
    const m = content.match(/^---\s*[\r\n]+title:\s*(.+?)\s*[\r\n]+---/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function makeStub(fluxo, title) {
  const displayTitle = title ?? `${fluxo.code} — ${fluxo.title}`;
  const slugSafe = fluxo.slug;
  return `import { tenantTest as test } from '../../fixtures/tenant.fixture';

/**
 * Fluxo: ${displayTitle}
 * Diagrama: docs/fluxos/${fluxo.filename}
 * Especificação: docs/FUNCIONALIDADES-NEGOCIO.md §${fluxo.code}
 *
 * Como implementar:
 *  1. Abrir o .mmd no VSCode (preview Mermaid) ou em https://mermaid.live
 *  2. Cada caixa numerada (N01, N02, ...) vira 1+ ação/assert no teste
 *  3. Decisões (losangos) viram \`test()\` separados (golden + alternativas)
 *  4. Trocar \`test.fixme\` por \`test\` quando rodar verde
 */
test.describe('Fluxo ${fluxo.code} — ${slugSafe}', () => {
  test.fixme('TODO: implementar fluxo ${fluxo.code}', async ({ page, tenant }) => {
    // tenant.accessToken, tenant.email, tenant.companyName disponíveis aqui
    // page já tem ignoreHTTPSErrors e baseURL configurados (http://localhost:4200)
  });
});
`;
}

function main() {
  if (!fs.existsSync(FLUXOS_DIR)) {
    console.error(`✘ Pasta de fluxos não encontrada: ${FLUXOS_DIR}`);
    process.exit(1);
  }

  const files = fs
    .readdirSync(FLUXOS_DIR)
    .filter((f) => f.startsWith('negocio-') && f.endsWith('.mmd'))
    .sort();

  let created = 0;
  let skipped = 0;

  for (const file of files) {
    const fluxo = parseFluxoFile(file);
    if (!fluxo) {
      console.warn(`! Ignorado (nome fora do padrão): ${file}`);
      continue;
    }
    const sectionDir = SECTION_NAMES[fluxo.section];
    if (!sectionDir) {
      console.warn(`! Seção desconhecida (${fluxo.section}) — ${file}`);
      continue;
    }

    const outDir = path.join(TESTS_DIR, sectionDir);
    fs.mkdirSync(outDir, { recursive: true });

    const outFile = path.join(outDir, `${fluxo.code}-${fluxo.slug}.spec.ts`);
    if (fs.existsSync(outFile) && !FORCE) {
      skipped++;
      continue;
    }

    const title = readMmdTitle(path.join(FLUXOS_DIR, file));
    fs.writeFileSync(outFile, makeStub(fluxo, title), 'utf-8');
    created++;
  }

  console.log(`\n✔ ${created} stub(s) criado(s), ${skipped} já existiam (pulou).`);
  if (!FORCE && skipped > 0) {
    console.log('  Use --force pra sobrescrever.');
  }
}

main();
