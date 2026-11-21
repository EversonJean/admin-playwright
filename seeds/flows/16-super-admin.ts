import { extraCompanies, superAdminLogin, whatsappChannel } from '../lib/builders';
import { FlowSeed } from '../lib/flow';
import { Lot } from '../lib/lot';
import { noteCompany, noteRoleUsers } from '../lib/notes';

/** O acesso do Super Admin e três empresas no banco: a do lote e mais duas. */
async function notePlatform(lot: Lot): Promise<void> {
  superAdminLogin(lot);
  lot.note('Super Admin', 'login na tabela "Como entrar" do lote');
  noteCompany(lot);
  (await extraCompanies(lot)).forEach((c, i) => lot.note(`Outra empresa ${i + 1}: ${c.name}`, `Login do dono: ${c.email} · Senha: ${c.password}`));
}

export const superAdminSeeds: FlowSeed[] = [
  {
    flow: '16.1',
    summary: 'O acesso do Super Admin e 3 empresas em período de teste (a do lote e mais duas), para listar, abrir, suspender e reativar.',
    run: notePlatform,
  },
  {
    flow: '16.2',
    summary: 'O acesso do Super Admin e 3 empresas em período de teste (a do lote e mais duas), para trocar de plano e ligar add-ons.',
    run: notePlatform,
  },
  {
    flow: '16.3',
    summary: 'O acesso do Super Admin e 3 empresas em período de teste, para gerar e acompanhar a cobrança (na stack de e2e a cobrança vai para o simulador do Asaas).',
    run: notePlatform,
  },
  {
    flow: '16.4',
    summary: 'O acesso do Super Admin e 3 empresas com dono logável, para abrir chamado de suporte ou relato de erro numa empresa e tratar no painel.',
    run: notePlatform,
  },
  {
    flow: '16.5',
    summary: 'O acesso do Super Admin e 3 empresas (a do lote e mais duas), para personalizar uma e conferir que as outras não mudam.',
    run: notePlatform,
  },
  {
    flow: '16.6',
    summary: 'O acesso do Super Admin e a empresa do lote com o canal de WhatsApp conectado (número de teste), para cadastrar e aprovar modelos de mensagem.',
    run: async (lot) => {
      await notePlatform(lot);
      lot.note('Canal de WhatsApp da empresa do lote', `conectado · identificador do número: ${await whatsappChannel(lot)}`);
    },
  },
  {
    flow: '16.7',
    summary: 'O acesso do Super Admin e 3 empresas com movimento recente da carga, para as telas de observabilidade terem o que mostrar.',
    run: notePlatform,
  },
  {
    flow: '16.8',
    summary: 'O acesso do Super Admin, 3 empresas (a do lote e mais duas) e 3 usuários internos na do lote, para consultar o histórico de e-mails e encerrar uma empresa.',
    run: async (lot) => {
      await notePlatform(lot);
      await noteRoleUsers(lot);
    },
  },
];
