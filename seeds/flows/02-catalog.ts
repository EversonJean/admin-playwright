import { acceptedEvents, eventCategories, noteEvents } from '../lib/builders';
import { FlowSeed } from '../lib/flow';
import { noteActivities, noteClients, noteNamed, notePackages, notePartners, notePeopleSheets, noteProducts } from '../lib/notes';
import { ACTIVITY_NAMES, randomAddress } from '../lib/random';

export const catalogSeeds: FlowSeed[] = [
  {
    flow: '2.1',
    summary: '3 atividades cadastradas e ativas, com preço por criança, e 3 nomes de atividade livres para cadastrar.',
    run: async (lot) => {
      await noteActivities(lot);
      lot.rng.take(ACTIVITY_NAMES, 3).forEach((name, i) =>
        lot.note(`Ficha ${i + 1} para digitar (atividade nova)`, `Nome: ${name} ${lot.id}-n${i + 1} · Preço por criança: R$ ${lot.rng.int(3, 9) * 10},00 · Duração: 60 min · Idade: 3 a 12 anos`),
      );
    },
  },
  {
    flow: '2.2',
    summary: '3 pacotes ativos, cada um com duas atividades, e as 3 atividades do cadastro para montar pacote novo.',
    run: async (lot) => {
      await notePackages(lot);
      await noteActivities(lot);
    },
  },
  {
    flow: '2.3',
    summary: '3 tipos de evento cadastrados no grupo Festa, além dos que a empresa nova já traz.',
    run: async (lot) => noteNamed(lot, 'Tipo de evento', await eventCategories(lot), () => 'grupo Festa'),
  },
  {
    flow: '2.4',
    summary: '3 produtos (materiais) cadastrados e as 3 atividades do cadastro, para vincular material à atividade.',
    run: async (lot) => {
      await noteProducts(lot);
      await noteActivities(lot);
    },
  },
  {
    flow: '2.5',
    summary: '3 clientes pessoa física cadastrados (nome, e-mail, celular e CPF) e 3 fichas de cliente novo para digitar.',
    run: async (lot) => {
      await noteClients(lot);
      notePeopleSheets(lot, 'cliente novo', 'novo');
    },
  },
  {
    flow: '2.6',
    summary: '3 clientes cadastrados com endereço em Curitiba e 3 endereços diferentes para digitar.',
    run: async (lot) => {
      await noteClients(lot);
      for (let i = 1; i <= 3; i++) {
        const a = randomAddress(lot.rng);
        lot.note(`Ficha ${i} para digitar (endereço)`, `${a.street}, ${a.number} · ${a.neighborhood} · Curitiba/PR · CEP 80010-100`);
      }
    },
  },
  {
    flow: '2.7',
    summary: '3 tipos de evento cadastrados e 3 festas aceitas, para configurar os campos do formulário e ver o efeito na festa.',
    run: async (lot) => {
      noteNamed(lot, 'Tipo de evento', await eventCategories(lot), () => 'grupo Festa');
      noteEvents(lot, 'aceita', await acceptedEvents(lot));
    },
  },
  {
    flow: '2.8',
    summary: '3 parceiros cadastrados (pessoa jurídica com CNPJ válido, categoria Buffet) e 3 clientes comuns, para a venda em nome do parceiro.',
    run: async (lot) => {
      await notePartners(lot);
      await noteClients(lot);
    },
  },
];
