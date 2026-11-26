import { assertOk, readJson } from '../../helpers/response';
import { acceptedEvents, draftContracts, noteEvents, operationalEvents } from '../lib/builders';
import { FlowSeed } from '../lib/flow';
import { Lot } from '../lib/lot';
import { noteCompany } from '../lib/notes';
import { brDate } from '../lib/random';
import { formalizeManually } from './09-contracts';

/** A agenda externa (Google) é conectada por quem testa: na stack de e2e a conexão vai para o simulador do Google. */
async function noteExternalCalendar(lot: Lot): Promise<void> {
  noteCompany(lot);
  noteEvents(lot, 'aceita', await acceptedEvents(lot));
}

/**
 * Etapa 288 (fluxo 8, CE-07) - festa com contrato assinado: arrastar para outro
 * dia é recusado pelo back e o card volta. Três festas aceitas, cada uma com o
 * contrato formalizado por aceite manual; o parâmetro "Mover só o horário de
 * festa com contrato assinado..." fica no padrão (ligado).
 */
async function noteSignedEvents(lot: Lot): Promise<void> {
  for (const [i, c] of (await draftContracts(lot)).entries()) {
    await formalizeManually(lot, c.contractId, 'massa 8');
    const res = await lot.api.get(`/api/events/${c.eventId}`);
    await assertOk(res, 'GET evento (massa 8)');
    const ev = await readJson<{ eventDate: string; startTime: string; endTime: string; location: string | null }>(res);
    lot.note(
      `Festa assinada ${i + 1} (contrato formalizado)`,
      `${brDate(ev.eventDate)} · ${ev.startTime.slice(0, 5)} às ${ev.endTime.slice(0, 5)} · ${ev.location ?? 'sem local'} · identificador da festa: ${c.eventId}`,
    );
  }
}

export const calendarSeeds: FlowSeed[] = [
  {
    flow: '8',
    summary: '3 festas aceitas e 3 compromissos operacionais espalhados pelas próximas semanas, para o calendário abrir com itens de tipos diferentes, e 3 festas com contrato formalizado, para a recusa de arrastar festa com contrato assinado.',
    run: async (lot) => {
      noteEvents(lot, 'aceita', await acceptedEvents(lot));
      (await operationalEvents(lot)).forEach((e, i) => lot.note(`Compromisso ${i + 1}`, `${e.location} · ${brDate(e.eventDate)} · 09:00 às 12:00`));
      await noteSignedEvents(lot);
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
