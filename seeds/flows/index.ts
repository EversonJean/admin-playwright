import { FlowSeed } from '../lib/flow';
import { onboardingSeeds } from './01-onboarding';
import { catalogSeeds } from './02-catalog';
import { teamSeeds } from './03-team';
import { salesSeeds } from './04-sales';
import { budgetSeeds } from './05-budgets';
import { eventSeeds } from './06-events';
import { staffingSeeds } from './07-staffing';
import { calendarSeeds } from './08-calendar';
import { contractSeeds } from './09-contracts';
import { financeSeeds } from './10-finance';
import { communicationSeeds } from './11-communication';
import { dashboardSeeds } from './12-dashboard';
import { portalSeeds } from './13-portal';
import { governanceSeeds } from './14-governance';
import { rentalSeeds } from './15-rentals';
import { superAdminSeeds } from './16-super-admin';
import { securitySeeds } from './17-security';
import { fullFlowSeeds } from './full-flows';

/** Todas as massas, na ordem das áreas. Área nova entra aqui. */
export const ALL_SEEDS: FlowSeed[] = [
  ...onboardingSeeds,
  ...catalogSeeds,
  ...teamSeeds,
  ...salesSeeds,
  ...budgetSeeds,
  ...eventSeeds,
  ...staffingSeeds,
  ...calendarSeeds,
  ...contractSeeds,
  ...financeSeeds,
  ...communicationSeeds,
  ...dashboardSeeds,
  ...portalSeeds,
  ...governanceSeeds,
  ...rentalSeeds,
  ...superAdminSeeds,
  ...securitySeeds,
  ...fullFlowSeeds,
];

/**
 * Resolve o que foi pedido na linha de comando: `5.3` (um fluxo), `5` (a área
 * inteira; também é o fluxo `8` e o `13`, que não têm segundo nível), `FC-07`,
 * `fc` (todos os fluxos completos) ou `all`. Devolve os desconhecidos à parte.
 */
export function resolveSeeds(requested: string[]): { seeds: FlowSeed[]; unknown: string[] } {
  const picked = new Set<FlowSeed>();
  const unknown: string[] = [];
  for (const raw of requested) {
    const item = raw.trim();
    const upper = item.toUpperCase();
    let found: FlowSeed[];
    if (upper === 'ALL') found = ALL_SEEDS;
    else if (upper === 'FC') found = ALL_SEEDS.filter((s) => s.flow.startsWith('FC-'));
    else if (upper.startsWith('FC-')) found = ALL_SEEDS.filter((s) => s.flow === upper);
    else found = ALL_SEEDS.filter((s) => s.flow === item || s.flow.startsWith(`${item}.`));
    if (found.length === 0) unknown.push(item);
    for (const seed of found) picked.add(seed);
  }
  return { seeds: ALL_SEEDS.filter((s) => picked.has(s)), unknown };
}
