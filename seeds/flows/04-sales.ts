import { leads, whatsappChannel } from '../lib/builders';
import { FlowSeed } from '../lib/flow';
import { Lot } from '../lib/lot';
import { noteActivities, noteClients, notePeopleSheets } from '../lib/notes';

async function noteLeads(lot: Lot): Promise<void> {
  (await leads(lot)).forEach((l, i) => lot.note(`Lead ${i + 1}: ${l.name}`, `situação Novo · WhatsApp ${l.phone}`));
}

export const salesSeeds: FlowSeed[] = [
  {
    flow: '4.1',
    summary: '3 leads novos no funil (com o add-on de leads ligado) e 3 fichas de lead para digitar.',
    run: async (lot) => {
      await noteLeads(lot);
      notePeopleSheets(lot, 'lead novo', 'lead.novo');
    },
  },
  {
    flow: '4.2',
    summary: '3 leads na coluna Novo do funil, um para cada caminho: avançar, perder e tentar pular etapa.',
    run: noteLeads,
  },
  {
    flow: '4.3',
    summary: '3 leads com WhatsApp e o canal de WhatsApp da empresa conectado (número de teste); as mensagens de entrada chegam pelo simulador de WhatsApp da stack de e2e.',
    run: async (lot) => {
      const phoneNumberId = await whatsappChannel(lot);
      lot.note('Canal de WhatsApp da empresa', `conectado · identificador do número: ${phoneNumberId}`);
      await noteLeads(lot);
    },
  },
  {
    flow: '4.4',
    summary: '3 leads novos prontos para converter em cliente e orçamento, mais 3 clientes e 3 atividades já cadastrados.',
    run: async (lot) => {
      await noteLeads(lot);
      await noteClients(lot);
      await noteActivities(lot);
    },
  },
];
