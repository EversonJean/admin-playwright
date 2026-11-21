import { acceptedEvents, clauses, contractTemplates, draftContracts, feature, noteEvents } from '../lib/builders';
import { FlowSeed } from '../lib/flow';
import { Lot } from '../lib/lot';
import { noteCollaborators, noteNamed, notePartners } from '../lib/notes';

async function noteDraftContracts(lot: Lot): Promise<void> {
  (await draftContracts(lot)).forEach((c, i) =>
    lot.note(`Contrato ${i + 1} (rascunho)`, `gerado para uma festa aceita própria; abra pela aba Contrato da festa · identificador da festa: ${c.eventId}`),
  );
}

export const contractSeeds: FlowSeed[] = [
  {
    flow: '9.1',
    summary: '3 cláusulas na biblioteca, cada uma com a primeira versão ativa, para editar, versionar e inativar.',
    run: async (lot) => noteNamed(lot, 'Cláusula', await clauses(lot), () => 'categoria Geral · versão 1 ativa'),
  },
  {
    flow: '9.2',
    summary: '3 modelos de contrato em rascunho, cada um já com uma cláusula, e 3 cláusulas ativas na biblioteca para montar modelo novo.',
    run: async (lot) => {
      noteNamed(lot, 'Modelo de contrato', await contractTemplates(lot), () => 'rascunho, com uma cláusula; falta ativar');
      noteNamed(lot, 'Cláusula', await clauses(lot), () => 'ativa');
    },
  },
  {
    flow: '9.3',
    summary: '3 contratos em rascunho, cada um numa festa aceita própria, com modelo e cláusula ativos e o add-on de assinatura digital ligado, e 3 festas aceitas ainda sem contrato.',
    run: async (lot) => {
      await noteDraftContracts(lot);
      noteEvents(lot, 'aceita, sem contrato', await acceptedEvents(lot, 50));
    },
  },
  {
    flow: '9.4',
    summary: '3 contratos em rascunho, cada um numa festa aceita própria; formalize o contrato (roteiro 9.3) e então teste o aditivo.',
    run: noteDraftContracts,
  },
  {
    flow: '9.5',
    summary: '3 parceiros, 3 colaboradores e 3 modelos de contrato em rascunho, para gerar contrato com parceiro e com colaborador.',
    run: async (lot) => {
      await notePartners(lot);
      await noteCollaborators(lot);
      noteNamed(lot, 'Modelo de contrato', await contractTemplates(lot), () => 'rascunho, com uma cláusula');
    },
  },
  {
    flow: '9.6',
    summary: '3 cláusulas ativas na biblioteca e o add-on de IA ligado na empresa, para pedir sugestão e revisão de cláusula (na stack de e2e a resposta vem do simulador de IA).',
    run: async (lot) => {
      await feature(lot, 'feature_ai');
      noteNamed(lot, 'Cláusula', await clauses(lot), () => 'ativa');
    },
  },
];
