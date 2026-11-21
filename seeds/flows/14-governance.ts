import { acceptedEvents, noteEvents, superAdminLogin } from '../lib/builders';
import { FlowSeed } from '../lib/flow';
import { noteClients, noteCollaborators, noteCompany, noteRoleUsers } from '../lib/notes';

export const governanceSeeds: FlowSeed[] = [
  {
    flow: '14.1',
    summary: '3 clientes cadastrados e 3 festas aceitas, criados há pouco pelo usuário dono: ações recentes (cadastro, envio e aceite de orçamento) para procurar no histórico de auditoria.',
    run: async (lot) => {
      await noteClients(lot);
      noteEvents(lot, 'aceita', await acceptedEvents(lot));
    },
  },
  {
    flow: '14.2',
    summary: '3 clientes pessoa física com nome, e-mail, celular e CPF (os titulares dos dados) e 3 colaboradores, para exportar, corrigir e eliminar dados pessoais.',
    run: async (lot) => {
      await noteClients(lot);
      await noteCollaborators(lot);
    },
  },
  {
    flow: '14.3',
    summary: 'A empresa do lote com 3 usuários internos logáveis e o acesso do Super Admin, que liga e desliga o modo manutenção.',
    run: async (lot) => {
      noteCompany(lot);
      await noteRoleUsers(lot);
      superAdminLogin(lot);
      lot.note('Super Admin', 'login na tabela "Como entrar" do lote');
    },
  },
  {
    flow: '14.4',
    summary: '3 clientes pessoa física com festa aceita (o vínculo que limita a eliminação) para pedir a eliminação dos dados e acompanhar o encerramento.',
    run: async (lot) => {
      await noteClients(lot);
      noteEvents(lot, 'aceita', await acceptedEvents(lot));
    },
  },
  {
    flow: '14.5',
    summary: '3 usuários com login, um de cada perfil (Administrador, Gestor, Financeiro), e 3 festas aceitas, para conferir que botões cada perfil enxerga.',
    run: async (lot) => {
      await noteRoleUsers(lot);
      noteEvents(lot, 'aceita', await acceptedEvents(lot));
    },
  },
];
