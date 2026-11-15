import { acceptedEvents, expenses, noteBudgets, noteEvents, paidEvents, sentBudgets } from '../lib/builders';
import { FlowSeed } from '../lib/flow';
import { Lot } from '../lib/lot';

/** Movimento de um mês típico: festas a receber, festas quitadas, orçamentos em aberto e despesas. */
async function noteMonth(lot: Lot): Promise<void> {
  const events = await acceptedEvents(lot);
  const lines = await expenses(lot, events);
  noteEvents(lot, 'aceita, a receber', events, (_, i) => lines[i]!);
  (await paidEvents(lot)).forEach((e, i) => lot.note(`Festa ${i + 1} (quitada)`, `Cliente ${e.clientName} · pago R$ ${e.total.toFixed(2).replace('.', ',')}`));
  noteBudgets(lot, 'enviado, em aberto', await sentBudgets(lot, 45));
}

export const dashboardSeeds: FlowSeed[] = [
  {
    flow: '12.1',
    summary: '3 festas aceitas a receber (cada uma com despesa), 3 festas quitadas e 3 orçamentos enviados em aberto, para o painel abrir com números.',
    run: noteMonth,
  },
  {
    flow: '12.2',
    summary: '3 festas aceitas a receber (cada uma com despesa), 3 festas quitadas, 3 orçamentos enviados em aberto e 3 despesas da empresa no mês, para os relatórios terem o que somar.',
    run: noteMonth,
  },
];
