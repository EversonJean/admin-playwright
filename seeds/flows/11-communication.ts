import { acceptedEvents, noteBudgets, noteEvents, sentBudgets, staffEvents, whatsappChannel } from '../lib/builders';
import { FlowSeed } from '../lib/flow';
import { noteClients } from '../lib/notes';

export const communicationSeeds: FlowSeed[] = [
  {
    flow: '11.1',
    summary: '3 orçamentos enviados (cada envio dispara um e-mail ao cliente; na stack de e2e ele fica na caixa do simulador de e-mail) e 3 clientes com e-mail.',
    run: async (lot) => {
      noteBudgets(lot, 'enviado', await sentBudgets(lot));
      await noteClients(lot);
    },
  },
  {
    flow: '11.2',
    summary: '3 clientes com celular e o canal de WhatsApp da empresa conectado (número de teste; os envios saem pelo simulador de WhatsApp da stack de e2e).',
    run: async (lot) => {
      const phoneNumberId = await whatsappChannel(lot);
      lot.note('Canal de WhatsApp da empresa', `conectado · identificador do número: ${phoneNumberId}`);
      await noteClients(lot);
    },
  },
  {
    flow: '11.3',
    summary: '3 festas aceitas pelo cliente com equipe escalada e aguardando confirmação, para acompanhar os avisos do sino de notificações a cada ação.',
    run: async (lot) => {
      const events = await acceptedEvents(lot);
      const staff = await staffEvents(lot, events);
      noteEvents(lot, 'aceita', events, (_, i) => staff[i]!);
    },
  },
];
