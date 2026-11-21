import { acceptedEvents, noteEvents, staffEvents, weekendEvents } from '../lib/builders';
import { FlowSeed } from '../lib/flow';
import { Lot } from '../lib/lot';
import { noteCollaborators, notePortalUsers, noteSkills } from '../lib/notes';

/** Três festas no mesmo fim de semana (duas no sábado, uma no domingo), ainda sem equipe. */
async function noteWeekend(lot: Lot): Promise<void> {
  const labels = ['sábado de manhã, 09:00 às 12:00', 'sábado à tarde, 15:00 às 18:00', 'domingo, 14:00 às 18:00'];
  noteEvents(lot, 'sem equipe', await weekendEvents(lot), (_, i) => labels[i]!);
  await noteCollaborators(lot);
}

export const staffingSeeds: FlowSeed[] = [
  {
    flow: '7.1',
    summary: '3 festas aceitas ainda sem equipe e 3 colaboradores ativos, cada um com uma habilidade, para escalar.',
    run: async (lot) => {
      noteEvents(lot, 'sem equipe', await acceptedEvents(lot));
      await noteSkills(lot);
    },
  },
  {
    flow: '7.2',
    summary: '3 festas aceitas com líder e apoio escalados e aguardando confirmação, e o acesso ao Portal de cada colaborador para confirmar ou recusar.',
    run: async (lot) => {
      const events = await acceptedEvents(lot);
      const staff = await staffEvents(lot, events);
      noteEvents(lot, 'equipe aguardando confirmação', events, (_, i) => staff[i]!);
      await notePortalUsers(lot);
    },
  },
  {
    flow: '7.3',
    summary: '3 festas aceitas e 3 colaboradores, para mudar os parâmetros operacionais da agenda e ver o efeito na escalação.',
    run: async (lot) => {
      noteEvents(lot, 'sem equipe', await acceptedEvents(lot));
      await noteCollaborators(lot);
    },
  },
  {
    flow: '7.4',
    summary: '3 festas aceitas no mesmo fim de semana (duas no sábado, uma no domingo), sem equipe, e 3 colaboradores para montar a escalação da semana.',
    run: noteWeekend,
  },
  {
    flow: '7.5',
    summary: '3 festas aceitas no mesmo fim de semana, duas delas no mesmo sábado (manhã e tarde), para o mesmo colaborador emendar uma festa na outra, e 3 colaboradores.',
    run: noteWeekend,
  },
  {
    flow: '7.6',
    summary: '3 festas aceitas no mesmo fim de semana, sem equipe, e 3 colaboradores, para pedir a proposta de escalação da semana.',
    run: noteWeekend,
  },
];
