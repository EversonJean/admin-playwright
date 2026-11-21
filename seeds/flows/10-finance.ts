import { acceptedEvents, expenses, noteEvents, paidEvents, splitInThree, staffEvents } from '../lib/builders';
import { FlowSeed } from '../lib/flow';
import { Lot } from '../lib/lot';

const money = (value: number) => `R$ ${value.toFixed(2).replace('.', ',')}`;

/** Três festas aceitas com o total dividido em 3 parcelas em aberto (vencem em 3, 7 e 10 dias). */
async function noteInstallmentEvents(lot: Lot): Promise<void> {
  const events = await acceptedEvents(lot);
  for (const e of events) await splitInThree(lot, e);
  noteEvents(lot, 'com 3 parcelas em aberto', events, (e) => `total ${money(e.total)} · vencimentos em 3, 7 e 10 dias`);
}

export const financeSeeds: FlowSeed[] = [
  {
    flow: '10.1',
    summary: '3 festas aceitas sem nenhum pagamento registrado, cada uma com o valor total em aberto.',
    run: async (lot) => noteEvents(lot, 'sem pagamento', await acceptedEvents(lot), (e) => `total ${money(e.total)}`),
  },
  {
    flow: '10.2',
    summary: '3 festas aceitas com o total dividido em 3 parcelas em aberto (vencimentos em 3, 7 e 10 dias), para receber parcela por parcela.',
    run: noteInstallmentEvents,
  },
  {
    flow: '10.3',
    summary: '3 festas aceitas e quitadas por Pix numa parcela única, prontas para estorno, devolução e crédito ao cliente.',
    run: async (lot) => (await paidEvents(lot)).forEach((e, i) => lot.note(`Festa ${i + 1} (quitada)`, `Cliente ${e.clientName} · pago ${money(e.total)} por Pix`)),
  },
  {
    flow: '10.4',
    summary: '3 festas aceitas, cada uma com uma despesa lançada, e 3 despesas da empresa no mês corrente.',
    run: async (lot) => {
      const events = await acceptedEvents(lot);
      const lines = await expenses(lot, events);
      noteEvents(lot, 'com despesa', events, (_, i) => lines[i]!);
      lot.note('Despesas da empresa', '3 lançadas hoje: Transporte R$ 100,00, Lanche R$ 150,00 e Material R$ 200,00');
    },
  },
  {
    flow: '10.5',
    summary: '3 festas aceitas com líder e apoio escalados, para calcular e pagar a comissão da equipe.',
    run: async (lot) => {
      const events = await acceptedEvents(lot);
      const staff = await staffEvents(lot, events);
      noteEvents(lot, 'com equipe', events, (_, i) => staff[i]!);
    },
  },
  {
    flow: '10.6',
    summary: '3 festas aceitas com 3 parcelas em aberto cada (vencimentos em 3, 7 e 10 dias), para aparecerem nas pendências financeiras.',
    run: noteInstallmentEvents,
  },
];
