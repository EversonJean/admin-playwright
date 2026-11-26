import { apiSetSettingParameter } from '../../helpers/api-entities';
import { apiTriggerDailyJob } from '../../helpers/rain-plan';
import {
  acceptedEvents,
  noteBudgets,
  noteEvents,
  roleUsers,
  sentBudgets,
  splitInThree,
  staffEvents,
  whatsappChannel,
} from '../lib/builders';
import { FlowSeed } from '../lib/flow';
import { Lot } from '../lib/lot';
import { noteClients } from '../lib/notes';

// Etapa 266: o lembrete ao cliente só é preparado com o parâmetro ligado; a
// régua padrão (7, 3 e 1 dias) pega as parcelas de 3 e de 7 dias. Usado pelo
// 11.4 (a fila) e pelo 11.5 (o aviso no sino e o contador do menu, Etapa 268,
// que nascem da mesma submissão).
async function pendingClientMessages(lot: Lot): Promise<void> {
  await apiSetSettingParameter(lot.api, 'FINANCIAL_INSTALLMENT_REMINDER_NOTIFY_CLIENT', 'true');
  const events = await acceptedEvents(lot);
  for (const e of events) await splitInThree(lot, e);
  noteEvents(lot, 'com 3 parcelas em aberto', events, () => 'vencimentos em 3, 7 e 10 dias');
  // O gatilho manual roda o mesmo ciclo do worker das 7h; a submissão sai
  // pelo Outbox e a mensagem aparece na fila segundos depois.
  await apiTriggerDailyJob(lot.api);
  lot.note(
    'Mensagens ao cliente',
    '6 aguardando o ok (parcelas de 3 e de 7 dias), só por e-mail: o WhatsApp entra quando a empresa tem o modelo de lembrete de pagamento aprovado',
  );
  await roleUsers(lot);
}

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
  {
    flow: '11.4',
    summary: '3 festas aceitas com 3 parcelas em aberto (vencimentos em 3, 7 e 10 dias), o lembrete de parcela ao cliente ligado e a varredura diária rodada: as parcelas de 3 e de 7 dias viram 6 mensagens por e-mail aguardando o ok em Mensagens ao cliente; também os logins de Administrador, Gestor e Financeiro.',
    run: pendingClientMessages,
  },
  {
    flow: '11.5',
    summary: '3 festas aceitas com 3 parcelas em aberto (vencimentos em 3, 7 e 10 dias), o lembrete de parcela ao cliente ligado e a varredura diária rodada: 6 mensagens por e-mail aguardando o ok, o aviso "aguardando seu ok" no sino do Dono e o número 6 no item "Mensagens ao cliente" do menu; também os logins de Administrador, Gestor e Financeiro.',
    run: pendingClientMessages,
  },
];
