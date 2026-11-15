import { acceptedEvents, communityEvents, draftBudgets, noteBudgets, noteEvents, sentBudgets, whatsappChannel } from '../lib/builders';
import { FlowSeed } from '../lib/flow';
import { noteActivities, noteClients, notePackages } from '../lib/notes';
import { brDate } from '../lib/random';

export const budgetSeeds: FlowSeed[] = [
  {
    flow: '5.1',
    summary: '3 clientes, 3 atividades e 3 pacotes para montar orçamento novo, e 3 orçamentos em rascunho para continuar editando.',
    run: async (lot) => {
      await noteClients(lot);
      await noteActivities(lot);
      await notePackages(lot);
      noteBudgets(lot, 'rascunho', await draftBudgets(lot));
    },
  },
  {
    flow: '5.2',
    summary: '3 orçamentos em rascunho, completos e prontos para enviar ao cliente.',
    run: async (lot) => noteBudgets(lot, 'rascunho', await draftBudgets(lot)),
  },
  {
    flow: '5.3',
    summary: '3 orçamentos enviados, cada um com o link público do cliente: um para aceitar, um para pedir alteração e um para deixar sem resposta.',
    run: async (lot) => noteBudgets(lot, 'enviado', await sentBudgets(lot)),
  },
  {
    flow: '5.4',
    summary: '3 orçamentos enviados, para editar e reenviar (cada edição gera versão nova e link novo).',
    run: async (lot) => noteBudgets(lot, 'enviado', await sentBudgets(lot)),
  },
  {
    flow: '5.5',
    summary: '9 orçamentos nos três estados principais: 3 em rascunho, 3 enviados e 3 aceitos (com a festa criada).',
    run: async (lot) => {
      noteBudgets(lot, 'rascunho', await draftBudgets(lot));
      noteBudgets(lot, 'enviado', await sentBudgets(lot, 45));
      noteEvents(lot, 'orçamento aceito', await acceptedEvents(lot, 60));
    },
  },
  {
    flow: '5.6',
    summary: '3 orçamentos enviados e sem resposta, para o gestor marcar como recusado com motivo.',
    run: async (lot) => noteBudgets(lot, 'enviado', await sentBudgets(lot)),
  },
  {
    flow: '5.7',
    summary: '3 orçamentos em rascunho de clientes com celular e o canal de WhatsApp da empresa conectado (número de teste; o envio sai pelo simulador de WhatsApp da stack de e2e).',
    run: async (lot) => {
      const phoneNumberId = await whatsappChannel(lot);
      lot.note('Canal de WhatsApp da empresa', `conectado · identificador do número: ${phoneNumberId}`);
      noteBudgets(lot, 'rascunho', await draftBudgets(lot));
    },
  },
  {
    flow: '5.8',
    summary: '3 ações comunitárias (orçamento sem cobrança) já confirmadas, cada uma com o evento criado, e 3 atividades para montar outra.',
    run: async (lot) => {
      (await communityEvents(lot)).forEach((e, i) => lot.note(`Ação comunitária ${i + 1} (confirmada)`, `evento em ${brDate(e.eventDate)}, sem cobrança`));
      await noteActivities(lot);
    },
  },
];
