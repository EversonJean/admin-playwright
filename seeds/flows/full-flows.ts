import {
  acceptedEvents,
  communityEvents,
  expenses,
  multiDaySentBudgets,
  noteBudgets,
  noteEvents,
  paidEvents,
  rainParties,
  sentBudgets,
  splitInThree,
} from '../lib/builders';
import { FlowSeed } from '../lib/flow';
import { Lot } from '../lib/lot';
import { noteActivities, noteClients, noteCollaborators, noteCompany, notePackages, notePortalUsers } from '../lib/notes';
import { brDate, randomCnpj } from '../lib/random';
import { noteChecklistWithPortal } from './13-portal';
import { noteRentals } from './15-rentals';

/**
 * Fluxos completos (`tests/fluxos-completos/NN-*.spec.ts`): cada um encadeia
 * várias áreas, então a massa é o PONTO DE PARTIDA do roteiro, três vezes.
 */

const money = (value: number) => `R$ ${value.toFixed(2).replace('.', ',')}`;

async function noteSent(lot: Lot): Promise<void> {
  noteBudgets(lot, 'enviado', await sentBudgets(lot));
}

async function noteInstallments(lot: Lot): Promise<void> {
  const events = await acceptedEvents(lot);
  for (const e of events) await splitInThree(lot, e);
  noteEvents(lot, 'com 3 parcelas em aberto', events, (e) => `total ${money(e.total)} · vencimentos em 3, 7 e 10 dias`);
}

async function notePaid(lot: Lot): Promise<void> {
  (await paidEvents(lot)).forEach((e, i) => lot.note(`Festa ${i + 1} (quitada)`, `Cliente ${e.clientName} · pago ${money(e.total)} por Pix`));
}

/** Três festas aceitas, cada uma com um brinquedo reservado para o dia. */
async function noteEventRentals(lot: Lot): Promise<void> {
  const events = await acceptedEvents(lot, 20);
  noteEvents(lot, 'aceita, com brinquedo', events);
  await noteRentals(lot, events);
}

async function noteMonthExpenses(lot: Lot): Promise<void> {
  const events = await acceptedEvents(lot);
  const lines = await expenses(lot, events);
  noteEvents(lot, 'com despesa', events, (_, i) => lines[i]!);
  lot.note('Despesas da empresa', '3 lançadas hoje: Transporte R$ 100,00, Lanche R$ 150,00 e Material R$ 200,00');
}

export const fullFlowSeeds: FlowSeed[] = [
  {
    flow: 'FC-00',
    summary: 'O ponto de partida do ciclo inteiro, três vezes: 3 clientes, 3 atividades, 3 pacotes e 3 colaboradores cadastrados, e 3 orçamentos enviados com link público para aceitar e seguir até a festa paga.',
    run: async (lot) => {
      await noteClients(lot);
      await noteActivities(lot);
      await notePackages(lot);
      await noteCollaborators(lot);
      await noteSent(lot);
    },
  },
  {
    flow: 'FC-01',
    summary: '3 orçamentos enviados com link público, para o caminho em que o cliente não fecha e o gestor registra a recusa.',
    run: noteSent,
  },
  {
    flow: 'FC-02',
    summary: '3 orçamentos enviados com link público, para editar, reenviar em versão nova e aceitar a versão certa.',
    run: noteSent,
  },
  {
    flow: 'FC-03',
    summary: '3 festas aceitas com o total dividido em 3 parcelas em aberto (vencimentos em 3, 7 e 10 dias), para receber parcela por parcela até quitar.',
    run: noteInstallments,
  },
  {
    flow: 'FC-04',
    summary: '3 festas aceitas com 3 parcelas em aberto cada (a primeira vence em 3 dias); a carga não cria parcela já vencida, então o atraso é observado depois do vencimento.',
    run: noteInstallments,
  },
  {
    flow: 'FC-05',
    summary: '3 orçamentos enviados de festa de dois dias (começa num dia e termina no seguinte), com link público para aceitar.',
    run: async (lot) => noteBudgets(lot, 'enviado, dois dias', await multiDaySentBudgets(lot)),
  },
  {
    flow: 'FC-06',
    summary: '3 festas aceitas e quitadas por Pix, para tentar ajustes financeiros que quebram as regras (estorno, devolução e crédito acima do pago).',
    run: notePaid,
  },
  {
    flow: 'FC-07',
    summary: '3 festas aceitas para espelhar na agenda externa; a agenda é conectada no teste (simulador do Google na stack de e2e).',
    run: async (lot) => {
      noteCompany(lot);
      noteEvents(lot, 'aceita', await acceptedEvents(lot));
    },
  },
  {
    flow: 'FC-08',
    summary: '3 orçamentos enviados e sem resposta, para registrar a recusa com motivo e ver o efeito no raio-x comercial.',
    run: noteSent,
  },
  {
    flow: 'FC-09',
    summary: '3 festas quitadas por Pix (para gerar crédito ao cliente) e 3 orçamentos enviados dos mesmos clientes (a outra festa que o crédito vai pagar).',
    run: async (lot) => {
      await notePaid(lot);
      await noteSent(lot);
    },
  },
  {
    flow: 'FC-10',
    summary: '3 festas ao ar livre marcadas para amanhã (dia de chuva no clima de teste) e 3 colaboradores com acesso ao Portal, para percorrer o plano B do aviso até a festa.',
    run: async (lot) => {
      (await rainParties(lot)).forEach((p, i) => lot.note(`Festa ao ar livre ${i + 1}`, `Cliente ${p.clientName} · amanhã, 14:00 às 18:00 · local ao ar livre com 30 m² cobertos`));
      await notePortalUsers(lot);
    },
  },
  {
    flow: 'FC-11',
    summary: '3 ações comunitárias (evento sem cobrança) já confirmadas e 3 colaboradores, para escalar, registrar despesa e encerrar.',
    run: async (lot) => {
      (await communityEvents(lot)).forEach((e, i) => lot.note(`Ação comunitária ${i + 1} (confirmada)`, `evento em ${brDate(e.eventDate)}, sem cobrança`));
      await noteCollaborators(lot);
    },
  },
  {
    flow: 'FC-12',
    summary: '3 festas aceitas, cada uma com uma locação reservada de brinquedo para o dia, para preparar o brinquedo pelo checklist até liberar a entrega.',
    run: noteEventRentals,
  },
  {
    flow: 'FC-13',
    summary: '3 locações avulsas reservadas com entrega em 20, 25 e 30 dias; o lembrete de preparação sai quando a entrega entra na janela de aviso.',
    run: async (lot) => noteRentals(lot),
  },
  {
    flow: 'FC-14',
    summary: '3 festas aceitas com material na lista e equipe escalada, e o acesso ao Portal de cada colaborador, para preparar o material pelo Portal.',
    run: noteChecklistWithPortal,
  },
  {
    flow: 'FC-15',
    summary: '3 festas aceitas com material na lista e equipe escalada, e o acesso ao Portal de cada colaborador, para enviar aviso e registrar a ciência.',
    run: noteChecklistWithPortal,
  },
  {
    flow: 'FC-16',
    summary: '3 festas aceitas, cada uma com um brinquedo reservado para o dia, e 3 colaboradores, para montar o transporte de ida e de volta.',
    run: async (lot) => {
      await noteEventRentals(lot);
      await noteCollaborators(lot);
    },
  },
  {
    flow: 'FC-17',
    summary: '3 tipos de brinquedo com uma unidade cada e 3 locações reservadas, para testar a locação por quantidade e a falta de unidade disponível.',
    run: async (lot) => noteRentals(lot),
  },
  {
    flow: 'FC-18',
    summary: '3 locações avulsas reservadas, para entregar, receber de volta com avaria e cobrar o cliente.',
    run: async (lot) => noteRentals(lot),
  },
  {
    flow: 'FC-19',
    summary: '3 ações comunitárias confirmadas e 3 locações reservadas, para registrar avaria de brinquedo usado em evento sem cobrança.',
    run: async (lot) => {
      (await communityEvents(lot)).forEach((e, i) => lot.note(`Ação comunitária ${i + 1} (confirmada)`, `evento em ${brDate(e.eventDate)}, sem cobrança`));
      await noteRentals(lot);
    },
  },
  {
    flow: 'FC-25',
    summary: '3 festas aceitas, cada uma com uma despesa lançada, e 3 despesas da empresa no mês corrente, para o relatório de despesas do mês e os custos repassados.',
    run: noteMonthExpenses,
  },
  {
    flow: 'FC-26',
    summary: '3 festas aceitas com despesa, 3 despesas da empresa no mês e 3 locações reservadas (base para avaria), para o relatório do mês com tendência e exportação.',
    run: async (lot) => {
      await noteMonthExpenses(lot);
      await noteRentals(lot);
    },
  },
  {
    flow: 'FC-27',
    summary: '3 CNPJs válidos sorteados para digitar no cadastro de empresa e de cliente (na stack de e2e a consulta do CNPJ é respondida pelo simulador) e a empresa do lote.',
    run: async (lot) => {
      for (let i = 1; i <= 3; i++) lot.note(`Ficha ${i} para digitar (CNPJ)`, randomCnpj(lot.rng));
      noteCompany(lot);
    },
  },
];
