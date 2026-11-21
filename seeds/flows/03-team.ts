import { FlowSeed } from '../lib/flow';
import { noteCollaborators, notePeopleSheets, notePortalUsers, noteSkills } from '../lib/notes';
import { randomCpf, randomMobile } from '../lib/random';

export const teamSeeds: FlowSeed[] = [
  {
    flow: '3.1',
    summary: '3 colaboradores cadastrados e ativos (com um nível de remuneração) e 3 fichas de colaborador novo para digitar.',
    run: async (lot) => {
      await noteCollaborators(lot);
      notePeopleSheets(lot, 'colaborador novo', 'novo.colab');
    },
  },
  {
    flow: '3.2',
    summary: '3 colaboradores cadastrados, cada um com acesso ao Portal (login e senha), para o gestor bloquear datas e o colaborador declarar disponibilidade.',
    run: async (lot) => {
      await noteCollaborators(lot);
      await notePortalUsers(lot);
    },
  },
  {
    flow: '3.3',
    summary: '3 colaboradores cadastrados sem dados bancários e 3 chaves Pix fictícias (CPF, celular e e-mail) para digitar.',
    run: async (lot) => {
      await noteCollaborators(lot);
      lot.note('Ficha 1 para digitar (chave Pix CPF)', randomCpf(lot.rng));
      lot.note('Ficha 2 para digitar (chave Pix celular)', randomMobile(lot.rng));
      lot.note('Ficha 3 para digitar (chave Pix e-mail)', `pix.${lot.id}@massa.test`);
    },
  },
  {
    flow: '3.4',
    summary: '3 habilidades no catálogo, cada uma já vinculada a um dos 3 colaboradores do lote.',
    run: async (lot) => {
      await noteSkills(lot);
      await noteCollaborators(lot);
    },
  },
];
