import {
  acceptedEvents,
  checklistEvents,
  formLinks,
  noteBudgets,
  noteEvents,
  operationalEvents,
  publicEvents,
  rainParties,
  sentBudgets,
  splitInThree,
  staffEvents,
} from '../lib/builders';
import { FlowSeed } from '../lib/flow';
import { noteCollaborators } from '../lib/notes';
import { brDate } from '../lib/random';

export const eventSeeds: FlowSeed[] = [
  {
    flow: '6.1',
    summary: '3 orçamentos enviados com link público (aceitar cada um cria a festa sozinho) e 3 festas que já nasceram de um aceite, para comparar.',
    run: async (lot) => {
      noteBudgets(lot, 'enviado', await sentBudgets(lot));
      noteEvents(lot, 'criada pelo aceite', await acceptedEvents(lot, 50));
    },
  },
  {
    flow: '6.2',
    summary: '3 festas aceitas, em datas e locais diferentes, para abrir o detalhe e percorrer as abas.',
    run: async (lot) => noteEvents(lot, 'aceita', await acceptedEvents(lot)),
  },
  {
    flow: '6.3',
    summary: '3 festas aceitas com equipe escalada (aguardando confirmação) e o valor dividido em 3 parcelas, para mover os três eixos de situação: operação, equipe e financeiro.',
    run: async (lot) => {
      const events = await acceptedEvents(lot);
      const staff = await staffEvents(lot, events);
      for (const e of events) await splitInThree(lot, e);
      noteEvents(lot, 'aceita', events, (_, i) => `${staff[i]} · 3 parcelas em aberto`);
    },
  },
  {
    flow: '6.4',
    summary: '3 registros operacionais na agenda (compromisso externo, sem orçamento nem cliente), em dias diferentes.',
    run: async (lot) =>
      (await operationalEvents(lot)).forEach((e, i) => lot.note(`Registro operacional ${i + 1}`, `${e.location} · ${brDate(e.eventDate)} · 09:00 às 12:00`)),
  },
  {
    flow: '6.5',
    summary: '3 festas aceitas, cada uma com o link público do formulário pós-aceite ainda não preenchido.',
    run: async (lot) => {
      const events = await acceptedEvents(lot);
      const links = await formLinks(lot, events);
      noteEvents(lot, 'aceita', events, (_, i) => `link do formulário: ${links[i]}`);
    },
  },
  {
    flow: '6.6',
    summary: '3 eventos abertos ao público (com o add-on de ingressos ligado), cada um com um lote de ingresso e o link de venda.',
    run: async (lot) =>
      (await publicEvents(lot)).forEach((e, i) => lot.note(`Evento público ${i + 1}: ${e.title}`, `${brDate(e.eventDate)} · link de venda: ${e.saleUrl}`)),
  },
  {
    flow: '6.7',
    summary: '3 festas aceitas cuja atividade usa um material do cadastro: a lista de materiais de cada festa já nasce com o item.',
    run: async (lot) => {
      const events = await checklistEvents(lot);
      noteEvents(lot, 'aceita', events, (_, i) => `material na lista: ${events[i]!.productName}`);
    },
  },
  {
    flow: '6.8',
    summary: '3 festas ao ar livre marcadas para amanhã, o dia em que o clima de teste prevê chuva, com atividade que só funciona a céu aberto, e 3 colaboradores para avisar.',
    run: async (lot) => {
      (await rainParties(lot)).forEach((p, i) => lot.note(`Festa ao ar livre ${i + 1}`, `Cliente ${p.clientName} · amanhã, 14:00 às 18:00 · local ao ar livre com 30 m² cobertos`));
      await noteCollaborators(lot);
    },
  },
];
