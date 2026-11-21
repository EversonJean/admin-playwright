import { test } from '@playwright/test';
import { ALL_SEEDS, resolveSeeds } from './flows';
import { openLot, writeLotReport } from './lib/lot';

/**
 * Carga de massa para teste manual. Não é teste: roda pelo Playwright só para
 * reaproveitar os helpers do e2e (TypeScript, contexto HTTP, cifra, SQL).
 * Quem chama é o `scripts/seed.js` (`npm run seed -- <fluxos>`), que passa:
 *
 *   SEED_FLOWS  fluxos pedidos, separados por vírgula (`5.3,10.1`, `5`, `fc`, `all`)
 *   SEED_LOT    id do lote, para refazer a MESMA carga (só com uma repetição)
 *
 * Cada repetição (`--runs N` vira `--repeat-each N`) é um lote: uma empresa
 * nova com a mesma estrutura e dados sorteados de novo.
 */

const requested = (process.env.SEED_FLOWS ?? '').split(',').filter(Boolean);

test('massa de teste', async ({}, testInfo) => {
  // um lote com todos os fluxos faz centenas de chamadas, em série
  test.setTimeout(30 * 60_000);

  const { seeds, unknown } = resolveSeeds(requested);
  if (unknown.length > 0 || seeds.length === 0) {
    const known = ALL_SEEDS.map((s) => s.flow).join(' ');
    throw new Error(`Fluxo sem massa: ${unknown.join(', ') || '(nenhum pedido)'}. Fluxos com massa: ${known}`);
  }

  const lot = await openLot(testInfo.repeatEachIndex === 0 ? process.env.SEED_LOT || undefined : undefined);
  const failures: string[] = [];
  try {
    for (const seed of seeds) {
      lot.currentFlow = seed.flow;
      try {
        await seed.run(lot);
      } catch (error) {
        // um fluxo que falha não derruba os outros: fica anotado no lote e a carga sai com erro
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${seed.flow}: ${message}`);
        lot.note('[FALHOU] carga deste fluxo', message.slice(0, 400));
      }
    }
  } finally {
    const file = writeLotReport(lot, seeds);
    console.log(`\n=== LOTE ${lot.id} — ${lot.company.name} ===`);
    for (const login of lot.logins) console.log(`  ${login.role}: ${login.url}  login ${login.email}  senha ${login.password}`);
    console.log(`  fluxos: ${seeds.map((s) => s.flow).join(', ')}`);
    console.log(`  registros anotados: ${lot.records.length}`);
    console.log(`  roteiro do lote: ${file}\n`);
    await lot.dispose();
  }

  if (failures.length > 0) throw new Error(`Carga incompleta no lote ${lot.id}:\n- ${failures.join('\n- ')}`);
});
