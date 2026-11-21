import { acceptedEvents, noteEvents, operationalEvents } from '../lib/builders';
import { FlowSeed } from '../lib/flow';
import { Lot } from '../lib/lot';
import { noteCompany } from '../lib/notes';
import { brDate } from '../lib/random';

/** A agenda externa (Google) é conectada por quem testa: na stack de e2e a conexão vai para o simulador do Google. */
async function noteExternalCalendar(lot: Lot): Promise<void> {
  noteCompany(lot);
  noteEvents(lot, 'aceita', await acceptedEvents(lot));
}

export const calendarSeeds: FlowSeed[] = [
  {
    flow: '8',
    summary: '3 festas aceitas e 3 compromissos operacionais espalhados pelas próximas semanas, para o calendário abrir com itens de tipos diferentes.',
    run: async (lot) => {
      noteEvents(lot, 'aceita', await acceptedEvents(lot));
      (await operationalEvents(lot)).forEach((e, i) => lot.note(`Compromisso ${i + 1}`, `${e.location} · ${brDate(e.eventDate)} · 09:00 às 12:00`));
    },
  },
  {
    flow: '8.2',
    summary: '3 festas aceitas na empresa do lote, ainda sem agenda externa conectada; a conexão com o Google é feita no teste (na stack de e2e, pelo simulador do Google).',
    run: noteExternalCalendar,
  },
  {
    flow: '8.3',
    summary: '3 festas aceitas para espelhar na agenda externa e conferir o botão Sincronizar; a agenda é conectada no teste (simulador do Google na stack de e2e).',
    run: noteExternalCalendar,
  },
  {
    flow: '8.4',
    summary: '3 festas aceitas para gerar e resolver pendências do espelho na agenda externa; a agenda é conectada no teste (simulador do Google na stack de e2e).',
    run: noteExternalCalendar,
  },
  {
    flow: '8.5',
    summary: '3 festas aceitas para ver o efeito da personalização do título e da cor na agenda externa; a agenda é conectada no teste (simulador do Google na stack de e2e).',
    run: noteExternalCalendar,
  },
];
