import { acceptedEvents, extraCompanies, feature, formLinks, noteBudgets, noteEvents, publicEvents, sentBudgets, whatsappChannel } from '../lib/builders';
import { FlowSeed } from '../lib/flow';
import { Lot } from '../lib/lot';
import { noteClients, noteCompany, notePeopleSheets, noteRoleUsers } from '../lib/notes';
import { brDate } from '../lib/random';

/** O dono e três usuários internos, todos com login e senha conhecidos e sem verificação em duas etapas. */
async function noteLogins(lot: Lot): Promise<void> {
  noteCompany(lot);
  await noteRoleUsers(lot);
}

async function noteWhatsapp(lot: Lot): Promise<void> {
  lot.note('Canal de WhatsApp da empresa', `conectado · identificador do número: ${await whatsappChannel(lot)}`);
  await noteClients(lot);
}

export const securitySeeds: FlowSeed[] = [
  {
    flow: '17.1',
    summary: 'O dono e 3 usuários internos com login e senha conhecidos, todos ainda sem verificação em duas etapas, para ativar, usar e desativar.',
    run: noteLogins,
  },
  {
    flow: '17.2',
    summary: 'O dono e 3 usuários internos com login e senha conhecidos, para entrar por navegadores diferentes e marcar ou revogar dispositivo confiável.',
    run: noteLogins,
  },
  {
    flow: '17.3',
    summary: 'O dono e 3 usuários internos com senha conhecida, para as ações que pedem a senha de novo (confirmação extra).',
    run: noteLogins,
  },
  {
    flow: '17.4',
    summary: 'O dono e 3 usuários internos com login e senha conhecidos, para provocar tentativas de acesso suspeitas (senha errada repetida, outro navegador).',
    run: noteLogins,
  },
  {
    flow: '17.5',
    summary: 'O dono e 3 usuários internos com login e senha conhecidos, para abrir, expirar e encerrar sessões.',
    run: noteLogins,
  },
  {
    flow: '17.6',
    summary: '3 links públicos de orçamento, 3 links de formulário pós-aceite e 3 links de venda de ingresso, todos válidos, para abrir sem login e alterar o endereço.',
    run: async (lot) => {
      noteBudgets(lot, 'enviado', await sentBudgets(lot));
      const events = await acceptedEvents(lot, 50);
      const links = await formLinks(lot, events);
      noteEvents(lot, 'aceita', events, (_, i) => `link do formulário: ${links[i]}`);
      (await publicEvents(lot)).forEach((e, i) => lot.note(`Evento público ${i + 1}: ${e.title}`, `${brDate(e.eventDate)} · link de venda: ${e.saleUrl}`));
    },
  },
  {
    flow: '17.7',
    summary: '3 clientes pessoa física com CPF, e-mail e celular gravados, para conferir que o dado aparece certo na tela e protegido fora dela.',
    run: noteClients,
  },
  {
    flow: '17.8',
    summary: '3 clientes cadastrados e 3 fichas de cliente para digitar, usadas para testar textos longos demais e campos acima do limite.',
    run: async (lot) => {
      await noteClients(lot);
      notePeopleSheets(lot, 'cliente novo', 'limite');
    },
  },
  {
    flow: '17.9',
    summary: '3 clientes cadastrados e 3 fichas de cliente para digitar com caracteres especiais no nome, para conferir que a tela mostra o texto sem executá-lo.',
    run: async (lot) => {
      await noteClients(lot);
      notePeopleSheets(lot, 'cliente novo', 'especial', () => 'acrescente ao nome: <b>teste</b> & "aspas"');
    },
  },
  {
    flow: '17.10',
    summary: '3 clientes com celular e o canal de WhatsApp da empresa conectado (número de teste), para conferir a posse do número e o limite diário de envios.',
    run: noteWhatsapp,
  },
  {
    flow: '17.11',
    summary: '3 clientes com celular, o canal de WhatsApp da empresa do lote conectado e 2 outras empresas sem canal, para conferir que cada empresa só usa o próprio número.',
    run: async (lot) => {
      await noteWhatsapp(lot);
      (await extraCompanies(lot)).forEach((c, i) => lot.note(`Outra empresa ${i + 1}: ${c.name}`, `Login do dono: ${c.email} · Senha: ${c.password}`));
    },
  },
  {
    flow: '17.12',
    summary: 'A empresa do lote com o add-on de IA ligado e 3 clientes cadastrados, para usar as funções de IA e conferir provedor e custo (na stack de e2e a resposta vem do simulador de IA).',
    run: async (lot) => {
      await feature(lot, 'feature_ai');
      noteCompany(lot);
      await noteClients(lot);
    },
  },
  {
    flow: '17.13',
    summary: '3 clientes pessoa física com CPF, e-mail e celular (os titulares) e 3 festas aceitas em nome deles, para atender pedidos de dados pessoais por titular.',
    run: async (lot) => {
      await noteClients(lot);
      noteEvents(lot, 'aceita', await acceptedEvents(lot));
    },
  },
];
