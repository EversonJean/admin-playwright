import { acceptedEvents, noteEvents, reservedRentals, SeededEvent } from '../lib/builders';
import { FlowSeed } from '../lib/flow';
import { Lot } from '../lib/lot';
import { noteClients } from '../lib/notes';
import { brDate } from '../lib/random';

/** Três locações reservadas; com `events`, cada brinquedo vai para uma festa, no dia dela. */
export async function noteRentals(lot: Lot, events: SeededEvent[] = []): Promise<void> {
  (await reservedRentals(lot, events)).forEach((r, i) =>
    lot.note(
      `Locação ${i + 1} (reservada)`,
      `${r.typeName} · patrimônio ${r.assetCode} · cliente ${r.clientName} · entrega em ${brDate(r.deliveryDate)}${events[i] ? ' · vinculada à festa do mesmo dia' : ' · avulsa'}`,
    ),
  );
}

export const rentalSeeds: FlowSeed[] = [
  {
    flow: '15.1',
    summary: '3 locações avulsas reservadas (com o add-on de locação ligado), cada uma de um brinquedo com patrimônio e checklist de preparação, para entregar, devolver e inspecionar.',
    run: async (lot) => noteRentals(lot),
  },
  {
    flow: '15.2',
    summary: '3 tipos de brinquedo com uma unidade cada, 3 locações reservadas e 3 clientes para criar locação nova.',
    run: async (lot) => {
      await noteRentals(lot);
      await noteClients(lot);
    },
  },
  {
    flow: '15.3',
    summary: '3 festas aceitas, cada uma com uma locação reservada de brinquedo para o dia da festa: a preparação do brinquedo aparece na lista de materiais da festa.',
    run: async (lot) => {
      const events = await acceptedEvents(lot, 20);
      noteEvents(lot, 'aceita, com brinquedo', events);
      await noteRentals(lot, events);
    },
  },
];
