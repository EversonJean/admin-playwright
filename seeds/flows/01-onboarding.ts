import { FlowSeed } from '../lib/flow';
import { noteActivities, noteClients, noteCollaborators, noteCompany, noteCompanySheets, notePeopleSheets, noteRoleUsers } from '../lib/notes';

const ROLES = ['Administrador', 'Gestor', 'Financeiro'];

export const onboardingSeeds: FlowSeed[] = [
  {
    flow: '1.1',
    summary: '3 fichas de empresa nova para digitar no cadastro (nome, CNPJ, responsável, e-mail, senha) e a empresa do lote, cujo e-mail já está em uso (para a exceção de e-mail repetido).',
    run: async (lot) => {
      noteCompanySheets(lot);
      noteCompany(lot);
    },
  },
  {
    flow: '1.2',
    summary: 'A empresa do lote, recém-criada e sem identidade preenchida, e 3 fichas com dados de empresa (CNPJ válido, endereço, telefone) para digitar.',
    run: async (lot) => {
      noteCompany(lot);
      noteCompanySheets(lot);
    },
  },
  {
    flow: '1.3',
    summary: '3 fichas de pessoas para convidar (uma para cada perfil) e 3 usuários que já existem na empresa (para a exceção de e-mail já usado).',
    run: async (lot) => {
      notePeopleSheets(lot, 'convite', 'convite', (i) => `Perfil: ${ROLES[i]}`);
      await noteRoleUsers(lot);
    },
  },
  {
    flow: '1.4',
    summary: '3 usuários com login, um de cada perfil (Administrador, Gestor, Financeiro), além do dono, e 3 clientes cadastrados para as telas terem o que mostrar.',
    run: async (lot) => {
      await noteRoleUsers(lot);
      await noteClients(lot);
    },
  },
  {
    flow: '1.5',
    summary: '3 usuários com login e senha conhecidos (Administrador, Gestor, Financeiro), além do dono, para entrar, errar a senha e recuperar o acesso.',
    run: async (lot) => {
      noteCompany(lot);
      await noteRoleUsers(lot);
    },
  },
  {
    flow: '1.6',
    summary: 'A empresa do lote com 3 clientes e 3 atividades cadastrados, para percorrer as telas gerais com dados.',
    run: async (lot) => {
      noteCompany(lot);
      await noteClients(lot);
      await noteActivities(lot);
    },
  },
  {
    flow: '1.7',
    summary: 'A empresa do lote, 3 usuários internos com login e 3 colaboradores cadastrados.',
    run: async (lot) => {
      noteCompany(lot);
      await noteRoleUsers(lot);
      await noteCollaborators(lot);
    },
  },
  {
    flow: '1.8',
    summary: '3 usuários ativos com login (Administrador, Gestor, Financeiro) para bloquear e desbloquear, além do dono que faz o bloqueio.',
    run: async (lot) => {
      noteCompany(lot);
      await noteRoleUsers(lot);
    },
  },
];
