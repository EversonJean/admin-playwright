import { acceptedEvents, checklistEvents, noteEvents, rainParties, staffEvents } from '../lib/builders';
import { FlowSeed } from '../lib/flow';
import { Lot } from '../lib/lot';
import { noteCollaborators, notePortalUsers, noteSkills } from '../lib/notes';

/** Três festas com líder e apoio escalados (aguardando confirmação) e o acesso ao Portal de cada colaborador. */
async function noteStaffedWithPortal(lot: Lot): Promise<void> {
  const events = await acceptedEvents(lot);
  const staff = await staffEvents(lot, events);
  noteEvents(lot, 'equipe aguardando confirmação', events, (_, i) => staff[i]!);
  await notePortalUsers(lot);
}

export const portalSeeds: FlowSeed[] = [
  {
    flow: '13',
    summary: '3 colaboradores com acesso ao Portal (login e senha) e 3 festas em que eles estão escalados, aguardando confirmação.',
    run: noteStaffedWithPortal,
  },
  {
    flow: '13.2',
    summary: '3 colaboradores com acesso ao Portal, cada um escalado em festas diferentes, para conferir que um não vê a festa nem os dados do outro.',
    run: noteStaffedWithPortal,
  },
  {
    flow: '13.3',
    summary: '3 colaboradores com acesso ao Portal e 3 festas aguardando a resposta deles, para confirmar, recusar e declarar indisponibilidade.',
    run: noteStaffedWithPortal,
  },
  {
    flow: '13.4',
    summary: '3 colaboradores com acesso ao Portal, cada um já com uma habilidade do catálogo, para ver e pedir habilidades.',
    run: async (lot) => {
      await noteSkills(lot);
      await notePortalUsers(lot);
    },
  },
  {
    flow: '13.5',
    summary: '3 festas ao ar livre marcadas para amanhã (dia de chuva no clima de teste) e 3 colaboradores com acesso ao Portal, para acompanhar o plano B pelo Portal.',
    run: async (lot) => {
      (await rainParties(lot)).forEach((p, i) => lot.note(`Festa ao ar livre ${i + 1}`, `Cliente ${p.clientName} · amanhã, 14:00 às 18:00`));
      await notePortalUsers(lot);
    },
  },
  {
    flow: '13.6',
    summary: '3 colaboradores ativos com acesso ao Portal e 3 festas em que estão escalados, para desligar um colaborador e conferir o que acontece com o acesso e com a escala.',
    run: async (lot) => {
      await noteStaffedWithPortal(lot);
      await noteCollaborators(lot);
    },
  },
];

/** Usado pelos fluxos completos de preparação de material pelo Portal. */
export async function noteChecklistWithPortal(lot: Lot): Promise<void> {
  const events = await checklistEvents(lot);
  const staff = await staffEvents(lot, events);
  noteEvents(lot, 'com material e equipe', events, (_, i) => `material: ${events[i]!.productName} · ${staff[i]}`);
  await notePortalUsers(lot);
}
