import {
  apiCreateEquipmentType,
  apiCreateEquipmentUnit,
  apiCreateRental,
  apiCreateVehicle,
  apiTransitionRental,
  inspectRentalBatch,
  putRentalLogistics,
  scheduleRentalPreparation,
} from '../../helpers/rental-preparation';
import { PreparationStepInput } from '../../helpers/api-entities';
import { createPublicApiContext } from '../../helpers/api-event-flow';
import {
  apiAcceptRentalTermByLink,
  apiIssueRentalHandoverTerm,
  apiPutRentalTermTemplate,
  rentalTermPublicUrl,
} from '../../helpers/rental-handover-term';
import { assertOk } from '../../helpers/response';
import {
  acceptedEvents,
  acceptedEventsAt,
  clients,
  communityEvents,
  equipmentBudgets,
  expenses,
  feature,
  multiDaySentBudgets,
  noteBudgets,
  noteEvents,
  paidEvents,
  portalUsers,
  rainParties,
  RECORDS_PER_FLOW,
  rentalsWithReturnCleaning,
  sentBudgets,
  splitInThree,
} from '../lib/builders';
import { FlowSeed } from '../lib/flow';
import { Lot } from '../lib/lot';
import {
  noteActivities,
  noteClients,
  noteCollaborators,
  noteCompany,
  notePackages,
  notePortalUsers,
  noteRoleUsers,
} from '../lib/notes';
import { brDate, dayPlus, randomCnpj } from '../lib/random';
import { noteChecklistWithPortal } from './13-portal';
import { noteRentals } from './15-rentals';

/**
 * Fluxos completos (`tests/fluxos-completos/NN-*.spec.ts`): cada um encadeia
 * várias áreas, então a massa é o PONTO DE PARTIDA do roteiro, três vezes.
 */

const money = (value: number) => `R$ ${value.toFixed(2).replace('.', ',')}`;

async function noteSent(lot: Lot): Promise<void> {
  noteBudgets(lot, 'enviado', await sentBudgets(lot));
}

async function noteInstallments(lot: Lot): Promise<void> {
  const events = await acceptedEvents(lot);
  for (const e of events) await splitInThree(lot, e);
  noteEvents(lot, 'com 3 parcelas em aberto', events, (e) => `total ${money(e.total)} · vencimentos em 3, 7 e 10 dias`);
}

async function notePaid(lot: Lot): Promise<void> {
  (await paidEvents(lot)).forEach((e, i) => lot.note(`Festa ${i + 1} (quitada)`, `Cliente ${e.clientName} · pago ${money(e.total)} por Pix`));
}

/** Três festas aceitas, cada uma com um brinquedo reservado para o dia. */
async function noteEventRentals(lot: Lot): Promise<void> {
  const events = await acceptedEvents(lot, 20);
  noteEvents(lot, 'aceita, com brinquedo', events);
  await noteRentals(lot, events);
}

async function noteMonthExpenses(lot: Lot): Promise<void> {
  const events = await acceptedEvents(lot);
  const lines = await expenses(lot, events);
  noteEvents(lot, 'com despesa', events, (_, i) => lines[i]!);
  lot.note('Despesas da empresa', '3 lançadas hoje: Transporte R$ 100,00, Lanche R$ 150,00 e Material R$ 200,00');
}

/** Passos do tipo da FC-22 (Etapa 328): o primeiro exige foto. */
const PHOTO_PROOF_STEPS: PreparationStepInput[] = [
  { title: 'Fotografar a lona inteira', category: 'Safety', isMandatory: true, requiresPhoto: true },
  { title: 'Higienizar a lona', category: 'Cleaning', isMandatory: true },
];

/**
 * Fotos como prova (FC-22, Etapa 328), três vezes:
 * - uma locação RESERVADA de um tipo cujo passo "Fotografar a lona inteira"
 *   exige foto, com a data da manutenção marcada para amanhã e um colaborador
 *   com acesso ao Portal como responsável (cada locação, um colaborador);
 * - uma locação EM USO de outro tipo, sem passo de preparação, já com a
 *   inspeção de saída: a volta com dano é registrada no teste.
 */
async function notePhotoProofRentals(lot: Lot): Promise<void> {
  await feature(lot, 'feature_equipment_rental');
  const [cs, team] = [await clients(lot), await portalUsers(lot)];
  const castleName = `Castelo inflável ${lot.id}`;
  const bedName = `Cama elástica ${lot.id}`;
  const castle = await apiCreateEquipmentType(lot.api, { name: castleName, steps: PHOTO_PROOF_STEPS });
  const bed = await apiCreateEquipmentType(lot.api, { name: bedName });
  lot.note('Tipo com foto exigida', `${castleName} · passo "Fotografar a lona inteira" com "Exige foto" e "Higienizar a lona"`);
  lot.note('Tipo sem preparação', `${bedName} · para a volta com dano`);
  for (let i = 0; i < RECORDS_PER_FLOW; i++) {
    const responsible = team[i % team.length]!;
    const castleUnit = await apiCreateEquipmentUnit(lot.api, castle.id);
    const prepDate = dayPlus(10 + i * 5);
    const prep = await apiCreateRental(lot.api, { clientId: cs[i]!.id, deliveryDate: prepDate, unitIds: [castleUnit.id] });
    await apiTransitionRental(lot.api, prep.id, 'Reserved');
    await assertOk(
      await scheduleRentalPreparation(lot.api, prep.id, { date: dayPlus(1), responsibleCollaboratorId: responsible.collaboratorId }),
      'data da preparação',
    );
    lot.note(
      `Locação ${i + 1} para preparar (reservada)`,
      `${prep.rentalNumber} · ${castleName} · patrimônio ${castleUnit.assetCode} · cliente ${cs[i]!.name} · entrega em ${brDate(prepDate)} · responsável ${responsible.name} (Portal)`,
    );

    const bedUnit = await apiCreateEquipmentUnit(lot.api, bed.id);
    const useDate = dayPlus(2 + i * 7);
    const inUse = await apiCreateRental(lot.api, { clientId: cs[i]!.id, deliveryDate: useDate, unitIds: [bedUnit.id] });
    await apiTransitionRental(lot.api, inUse.id, 'Reserved', 'Confirmed', 'Preparing');
    await assertOk(await inspectRentalBatch(lot.api, inUse.id, { type: 'Outbound' }), 'inspeção de saída');
    await apiTransitionRental(lot.api, inUse.id, 'Dispatched', 'Delivered', 'InUse');
    lot.note(
      `Locação ${i + 1} para a volta com dano (em uso)`,
      `${inUse.rentalNumber} · ${bedName} · patrimônio ${bedUnit.assetCode} · cliente ${cs[i]!.name} · entrega em ${brDate(useDate)}`,
    );
  }
}

/**
 * Passos do tipo da FC-23 (Etapa 329): um "antes de sair do depósito",
 * opcional (a preparação existe e não segura a saída), e quatro "na montagem,
 * no local", o primeiro com foto exigida.
 */
const ON_SITE_SETUP_STEPS: PreparationStepInput[] = [
  { title: 'Higienizar a lona', category: 'Cleaning', isMandatory: false },
  { title: 'Ancorar com estacas ou sacos de areia', category: 'Safety', isMandatory: true, requiresPhoto: true, stage: 'OnSite' },
  { title: 'Soprador em piso seco, com extensão aterrada', category: 'Safety', isMandatory: true, stage: 'OnSite' },
  { title: 'Área livre de 2 m em volta', category: 'Safety', isMandatory: true, stage: 'OnSite' },
  { title: 'Explicar as regras e o limite de crianças ao responsável', category: 'Safety', isMandatory: false, stage: 'OnSite' },
];

/**
 * Montagem no local (FC-23, Etapa 329), três vezes: uma festa aceita para hoje
 * (o Portal só mostra a entrega de ontem a amanhã) com uma locação EM
 * PREPARAÇÃO de um castelo inflável com passos do local, já com a inspeção de
 * saída e o transporte planejado: na entrega, um colaborador com Portal como
 * motorista; na retirada, o colaborador da locação seguinte (que não é da
 * entrega desta). A saída ("Em trânsito") é o primeiro passo do roteiro.
 */
async function noteOnSiteSetupRentals(lot: Lot): Promise<void> {
  await feature(lot, 'feature_equipment_rental');
  const team = await portalUsers(lot);
  const day = dayPlus(0);
  const events = await acceptedEventsAt(
    lot,
    ['09:00', '13:00', '17:00'].map((startTime, i) => ({
      date: day,
      startTime,
      endTime: `${String(11 + i * 4).padStart(2, '0')}:00`,
      fixedDate: true,
    })),
  );
  const castleName = `Castelo inflável ${lot.id}`;
  const castle = await apiCreateEquipmentType(lot.api, { name: castleName, steps: ON_SITE_SETUP_STEPS });
  const vehicle = await apiCreateVehicle(lot.api, { name: `Fiorino ${lot.id}` });
  lot.note(
    'Tipo com montagem no local',
    `${castleName} · "Antes de sair do depósito": Higienizar a lona (opcional) · "Na montagem, no local": Ancorar com estacas ou sacos de areia (obrigatório, exige foto), Soprador em piso seco, com extensão aterrada (obrigatório), Área livre de 2 m em volta (obrigatório), Explicar as regras e o limite de crianças ao responsável (opcional)`,
  );
  lot.note('Veículo', vehicle.name);
  for (let i = 0; i < RECORDS_PER_FLOW; i++) {
    const event = events[i]!;
    const driver = team[i % team.length]!;
    const pickup = team[(i + 1) % team.length]!;
    const unit = await apiCreateEquipmentUnit(lot.api, castle.id);
    const rental = await apiCreateRental(lot.api, {
      clientId: event.clientId,
      eventId: event.id,
      deliveryDate: event.eventDate,
      unitIds: [unit.id],
    });
    await apiTransitionRental(lot.api, rental.id, 'Reserved', 'Confirmed', 'Preparing');
    await assertOk(await inspectRentalBatch(lot.api, rental.id, { type: 'Outbound' }), 'inspeção de saída');
    await assertOk(
      await putRentalLogistics(lot.api, rental.id, [
        { kind: 'Delivery', vehicleId: vehicle.id, departureDate: event.eventDate, departureTime: '07:00:00', loadingMinutes: 30, crew: [{ collaboratorId: driver.collaboratorId, isDriver: true }] },
        { kind: 'Pickup', vehicleId: vehicle.id, departureDate: event.eventDate, departureTime: '18:30:00', loadingMinutes: 15, crew: [{ collaboratorId: pickup.collaboratorId, isDriver: true }] },
      ]),
      'transporte da locação',
    );
    lot.note(
      `Locação ${i + 1} para sair (em preparação)`,
      `${rental.rentalNumber} · ${castleName} · patrimônio ${unit.assetCode} · festa de ${event.clientName} em ${brDate(event.eventDate)} · entrega às 10:00 · motorista da entrega: ${driver.name} (Portal) · retirada: ${pickup.name}`,
    );
  }
}

/** Modelo do termo de entrega da FC-24 (Etapa 330): só variáveis do catálogo do back. */
const HANDOVER_TERM_TEMPLATE = {
  title: 'Termo de entrega dos brinquedos',
  body:
    'Locação {locacao.numero} · uso em {festa.data}\n\n' +
    'Eu, {cliente.nome}, recebo da {empresa.nome} os brinquedos abaixo, no endereço {entrega.endereco}:\n{itens}\n\n' +
    'Regras de uso:\n{regras}\n\n' +
    'Caução: {caucao}\n\n' +
    'Respondo por dano que não seja desgaste natural e aviso a empresa de qualquer defeito assim que o perceber.',
};

const HANDOVER_TERM_USAGE_RULES =
  'Só com monitor presente. No máximo 8 crianças por vez, de 3 a 10 anos. Sem calçados, comida ou bebida dentro do brinquedo.';

/**
 * Termo de entrega (FC-24, Etapa 330), três vezes, com o modelo do termo da
 * empresa gravado e um castelo inflável com "Regras de uso" e caução:
 * - uma locação CONFIRMADA com o termo gerado e aguardando o aceite (o link do
 *   cliente vai no arquivo do lote);
 * - uma locação CONFIRMADA com o termo já aceito pelo link, com nome e CPF;
 * - uma locação RESERVADA, fora da janela em que o termo pode ser gerado;
 * - uma locação EM TRÂNSITO para hoje (o Portal só mostra a entrega de ontem a
 *   amanhã), com a inspeção de saída, um colaborador com Portal como motorista
 *   da entrega e o termo aguardando o aceite: o "Cliente aceitar agora". A
 *   terceira fica sem termo, para o Portal pedir o termo ao escritório.
 */
async function noteHandoverTermRentals(lot: Lot): Promise<void> {
  await feature(lot, 'feature_equipment_rental');
  const [cs, team] = [await clients(lot), await portalUsers(lot)];
  await apiPutRentalTermTemplate(lot.api, HANDOVER_TERM_TEMPLATE);
  lot.note('Modelo do termo', `"${HANDOVER_TERM_TEMPLATE.title}", gravado pela empresa (Equipamentos → painel → "Termo de entrega")`);
  const castleName = `Castelo inflável ${lot.id}`;
  const castle = await apiCreateEquipmentType(lot.api, { name: castleName, depositAmount: 300, usageRules: HANDOVER_TERM_USAGE_RULES });
  lot.note('Tipo com regras de uso', `${castleName} · caução de R$ 300,00 · "Regras de uso": ${HANDOVER_TERM_USAGE_RULES}`);
  // Nome diferente do veículo da FC-23: carregadas juntas, as duas caem na mesma
  // empresa, e o nome do veículo é único (409 Vehicle.NameAlreadyExists).
  const vehicle = await apiCreateVehicle(lot.api, { name: `Kombi ${lot.id}` });
  lot.note('Veículo', vehicle.name);
  const today = dayPlus(0);
  const publicApi = await createPublicApiContext();
  try {
    for (let i = 0; i < RECORDS_PER_FLOW; i++) {
      const client = cs[i]!;

      const linkUnit = await apiCreateEquipmentUnit(lot.api, castle.id);
      const linkDate = dayPlus(4 + i * 3);
      const linkRental = await apiCreateRental(lot.api, { clientId: client.id, deliveryDate: linkDate, unitIds: [linkUnit.id] });
      await apiTransitionRental(lot.api, linkRental.id, 'Reserved', 'Confirmed');
      const linkTerm = await apiIssueRentalHandoverTerm(lot.api, linkRental.id);
      lot.note(
        `Locação ${i + 1} com o termo aguardando o aceite (confirmada)`,
        `${linkRental.rentalNumber} · ${castleName} · patrimônio ${linkUnit.assetCode} · cliente ${client.name} · entrega em ${brDate(linkDate)} · link do cliente: ${rentalTermPublicUrl(lot.frontUrl, linkTerm.publicToken!)}`,
      );

      const acceptedUnit = await apiCreateEquipmentUnit(lot.api, castle.id);
      const acceptedDate = dayPlus(5 + i * 3);
      const acceptedRental = await apiCreateRental(lot.api, { clientId: client.id, deliveryDate: acceptedDate, unitIds: [acceptedUnit.id] });
      await apiTransitionRental(lot.api, acceptedRental.id, 'Reserved', 'Confirmed');
      const acceptedTerm = await apiIssueRentalHandoverTerm(lot.api, acceptedRental.id);
      await apiAcceptRentalTermByLink(publicApi, acceptedTerm.publicToken!, {
        name: client.name,
        document: client.cpf,
        textSha256: acceptedTerm.textSha256,
      });
      lot.note(
        `Locação ${i + 1} com o termo aceito (confirmada)`,
        `${acceptedRental.rentalNumber} · ${castleName} · patrimônio ${acceptedUnit.assetCode} · cliente ${client.name} · entrega em ${brDate(acceptedDate)} · aceito pelo link por ${client.name}, com CPF`,
      );

      const reservedUnit = await apiCreateEquipmentUnit(lot.api, castle.id);
      const reservedDate = dayPlus(6 + i * 3);
      const reservedRental = await apiCreateRental(lot.api, { clientId: client.id, deliveryDate: reservedDate, unitIds: [reservedUnit.id] });
      await apiTransitionRental(lot.api, reservedRental.id, 'Reserved');
      lot.note(
        `Locação ${i + 1} reservada (o termo ainda não pode ser gerado)`,
        `${reservedRental.rentalNumber} · ${castleName} · patrimônio ${reservedUnit.assetCode} · cliente ${client.name} · entrega em ${brDate(reservedDate)}`,
      );

      const driver = team[i % team.length]!;
      const onSiteUnit = await apiCreateEquipmentUnit(lot.api, castle.id);
      const onSiteRental = await apiCreateRental(lot.api, { clientId: client.id, deliveryDate: today, unitIds: [onSiteUnit.id] });
      await apiTransitionRental(lot.api, onSiteRental.id, 'Reserved', 'Confirmed', 'Preparing');
      await assertOk(await inspectRentalBatch(lot.api, onSiteRental.id, { type: 'Outbound' }), 'inspeção de saída');
      await assertOk(
        await putRentalLogistics(lot.api, onSiteRental.id, [
          { kind: 'Delivery', vehicleId: vehicle.id, departureDate: today, departureTime: '07:00:00', loadingMinutes: 30, crew: [{ collaboratorId: driver.collaboratorId, isDriver: true }] },
        ]),
        'transporte da locação',
      );
      await apiTransitionRental(lot.api, onSiteRental.id, 'Dispatched');
      // A última fica sem termo: o Portal pede "Peça ao escritório para gerar o termo".
      const withTerm = i < RECORDS_PER_FLOW - 1;
      if (withTerm) await apiIssueRentalHandoverTerm(lot.api, onSiteRental.id);
      lot.note(
        `Locação ${i + 1} para aceitar no local (em trânsito)`,
        `${onSiteRental.rentalNumber} · ${castleName} · patrimônio ${onSiteUnit.assetCode} · cliente ${client.name} · entrega hoje (${brDate(today)}) às 10:00 · motorista da entrega: ${driver.name} (Portal) · ${withTerm ? 'termo aguardando o aceite' : 'sem termo gerado'}`,
      );
    }
  } finally {
    await publicApi.dispose();
  }
}

export const fullFlowSeeds: FlowSeed[] = [
  {
    flow: 'FC-00',
    summary: 'O ponto de partida do ciclo inteiro, três vezes: 3 clientes, 3 atividades, 3 pacotes e 3 colaboradores cadastrados, e 3 orçamentos enviados com link público para aceitar e seguir até a festa paga.',
    run: async (lot) => {
      await noteClients(lot);
      await noteActivities(lot);
      await notePackages(lot);
      await noteCollaborators(lot);
      await noteSent(lot);
    },
  },
  {
    flow: 'FC-01',
    summary: '3 orçamentos enviados com link público, para o caminho em que o cliente não fecha e o gestor registra a recusa.',
    run: noteSent,
  },
  {
    flow: 'FC-02',
    summary: '3 orçamentos enviados com link público, para editar, reenviar em versão nova e aceitar a versão certa.',
    run: noteSent,
  },
  {
    flow: 'FC-03',
    summary: '3 festas aceitas com o total dividido em 3 parcelas em aberto (vencimentos em 3, 7 e 10 dias), para receber parcela por parcela até quitar.',
    run: noteInstallments,
  },
  {
    flow: 'FC-04',
    summary: '3 festas aceitas com 3 parcelas em aberto cada (a primeira vence em 3 dias); a carga não cria parcela já vencida, então o atraso é observado depois do vencimento.',
    run: noteInstallments,
  },
  {
    flow: 'FC-05',
    summary: '3 orçamentos enviados de festa de dois dias (começa num dia e termina no seguinte), com link público para aceitar.',
    run: async (lot) => noteBudgets(lot, 'enviado, dois dias', await multiDaySentBudgets(lot)),
  },
  {
    flow: 'FC-06',
    summary: '3 festas aceitas e quitadas por Pix, para tentar ajustes financeiros que quebram as regras (estorno, devolução e crédito acima do pago).',
    run: notePaid,
  },
  {
    flow: 'FC-07',
    summary: '3 festas aceitas para espelhar na agenda externa; a agenda é conectada no teste (simulador do Google na stack de e2e).',
    run: async (lot) => {
      noteCompany(lot);
      noteEvents(lot, 'aceita', await acceptedEvents(lot));
    },
  },
  {
    flow: 'FC-08',
    summary: '3 orçamentos enviados e sem resposta, para registrar a recusa com motivo e ver o efeito no raio-x comercial.',
    run: noteSent,
  },
  {
    flow: 'FC-09',
    summary: '3 festas quitadas por Pix (para gerar crédito ao cliente) e 3 orçamentos enviados dos mesmos clientes (a outra festa que o crédito vai pagar).',
    run: async (lot) => {
      await notePaid(lot);
      await noteSent(lot);
    },
  },
  {
    flow: 'FC-10',
    summary: '3 festas ao ar livre marcadas para amanhã (dia de chuva no clima de teste) e 3 colaboradores com acesso ao Portal, para percorrer o plano B do aviso até a festa.',
    run: async (lot) => {
      (await rainParties(lot)).forEach((p, i) => lot.note(`Festa ao ar livre ${i + 1}`, `Cliente ${p.clientName} · amanhã, 14:00 às 18:00 · local ao ar livre com 30 m² cobertos`));
      await notePortalUsers(lot);
    },
  },
  {
    flow: 'FC-11',
    summary: '3 ações comunitárias (evento sem cobrança) já confirmadas e 3 colaboradores, para escalar, registrar despesa e encerrar.',
    run: async (lot) => {
      (await communityEvents(lot)).forEach((e, i) => lot.note(`Ação comunitária ${i + 1} (confirmada)`, `evento em ${brDate(e.eventDate)}, sem cobrança`));
      await noteCollaborators(lot);
    },
  },
  {
    flow: 'FC-12',
    summary: '3 festas aceitas, cada uma com uma locação reservada de brinquedo para o dia, para preparar o brinquedo pelo checklist até liberar a entrega.',
    run: noteEventRentals,
  },
  {
    flow: 'FC-13',
    summary: '3 locações avulsas reservadas com entrega em 20, 25 e 30 dias; o lembrete de preparação sai quando a entrega entra na janela de aviso.',
    run: async (lot) => noteRentals(lot),
  },
  {
    flow: 'FC-14',
    summary: '3 festas aceitas com material na lista e equipe escalada, e o acesso ao Portal de cada colaborador, para preparar o material pelo Portal.',
    run: noteChecklistWithPortal,
  },
  {
    flow: 'FC-15',
    summary: '3 festas aceitas com material na lista e equipe escalada, e o acesso ao Portal de cada colaborador, para enviar aviso e registrar a ciência.',
    run: noteChecklistWithPortal,
  },
  {
    flow: 'FC-16',
    summary: '3 festas aceitas, cada uma com um brinquedo reservado para o dia, e 3 colaboradores, para montar o transporte de ida e de volta.',
    run: async (lot) => {
      await noteEventRentals(lot);
      await noteCollaborators(lot);
    },
  },
  {
    flow: 'FC-17',
    summary: '3 tipos de brinquedo com uma unidade cada e 3 locações reservadas, para testar a locação por quantidade e a falta de unidade disponível.',
    run: async (lot) => noteRentals(lot),
  },
  {
    flow: 'FC-18',
    summary: '3 locações avulsas reservadas, para entregar, receber de volta com avaria e cobrar o cliente.',
    run: async (lot) => noteRentals(lot),
  },
  {
    flow: 'FC-19',
    summary: '3 ações comunitárias confirmadas e 3 locações reservadas, para registrar avaria de brinquedo usado em evento sem cobrança.',
    run: async (lot) => {
      (await communityEvents(lot)).forEach((e, i) => lot.note(`Ação comunitária ${i + 1} (confirmada)`, `evento em ${brDate(e.eventDate)}, sem cobrança`));
      await noteRentals(lot);
    },
  },
  {
    flow: 'FC-20',
    summary: 'Locação de equipamentos ligada, 3 clientes, 3 atividades e 2 tipos de brinquedo (3 camas elásticas com caução e 1 piscina de bolinhas), e 3 orçamentos enviados com brinquedo e endereço da festa, com link público para aceitar; o terceiro pede 2 piscinas, uma a mais do que existe; e um login de cada perfil interno (Administrador, Gestor, Financeiro).',
    run: async (lot) => {
      await noteClients(lot);
      await noteActivities(lot);
      const { types, budgets } = await equipmentBudgets(lot);
      types.forEach((t, i) => lot.note(`Tipo de brinquedo ${i + 1}`, t));
      budgets.forEach((b, i) =>
        lot.note(
          `Orçamento ${i + 1} (enviado, com brinquedo)`,
          `Cliente ${b.clientName} · festa em ${brDate(b.eventDate)} · ${b.venue} · atividade ${b.activityName} · ${b.equipment} · link do cliente: ${b.publicUrl}`,
        ),
      );
      await noteRoleUsers(lot);
    },
  },
  {
    flow: 'FC-21',
    summary: 'Locação de equipamentos ligada, 1 tipo de brinquedo com tempo de giro de 24 h e "Higienizar na volta" com 3 unidades e, para cada unidade, uma locação em uso e a próxima locação da mesma unidade reservada 3 dias depois; e um login de cada perfil interno (Administrador, Gestor, Financeiro).',
    run: async (lot) => {
      const { typeName, pairs } = await rentalsWithReturnCleaning(lot);
      lot.note('Tipo de brinquedo', `${typeName} · tempo de giro de 24 h · "Higienizar na volta" marcado · 3 unidades`);
      pairs.forEach((p, i) =>
        lot.note(
          `Unidade ${i + 1}: ${p.assetCode}`,
          `${p.inUseNumber} em uso (cliente ${p.clientName}, entrega em ${brDate(p.inUseDate)}) · a próxima, ${p.nextNumber}, reservada com entrega em ${brDate(p.nextDate)}`,
        ),
      );
      await noteRoleUsers(lot);
    },
  },
  {
    flow: 'FC-22',
    summary: 'Locação de equipamentos ligada, 3 locações reservadas de um castelo inflável cujo passo "Fotografar a lona inteira" exige foto, cada uma com a data da manutenção marcada e um colaborador com acesso ao Portal como responsável, e 3 locações em uso de uma cama elástica (sem preparação), já com a inspeção de saída, para a volta com dano; e um login de cada perfil interno (Administrador, Gestor, Financeiro).',
    run: async (lot) => {
      await notePhotoProofRentals(lot);
      await notePortalUsers(lot);
      await noteRoleUsers(lot);
    },
  },
  {
    flow: 'FC-23',
    summary: 'Locação de equipamentos ligada, um castelo inflável com um passo "Antes de sair do depósito" (opcional) e quatro "Na montagem, no local" (o primeiro, "Ancorar com estacas ou sacos de areia", exige foto), e 3 festas aceitas para o dia da carga, cada uma com uma locação em preparação desse brinquedo, já com a inspeção de saída e o transporte planejado (na entrega, um colaborador com acesso ao Portal como motorista; na retirada, outro); e um login de cada perfil interno (Administrador, Gestor, Financeiro).',
    run: async (lot) => {
      await noteOnSiteSetupRentals(lot);
      await notePortalUsers(lot);
      await noteRoleUsers(lot);
    },
  },
  {
    flow: 'FC-24',
    summary: 'Locação de equipamentos ligada, o modelo do termo de entrega gravado pela empresa, um castelo inflável com "Regras de uso" e caução de R$ 300,00 e, três vezes: uma locação confirmada com o termo aguardando o aceite (com o link do cliente), uma confirmada com o termo já aceito pelo link, uma reservada (fora da janela do termo) e uma em trânsito para hoje, com um colaborador com acesso ao Portal como motorista da entrega e o termo aguardando o aceite (a terceira em trânsito, sem termo gerado); e um login de cada perfil interno (Administrador, Gestor, Financeiro).',
    run: async (lot) => {
      await noteHandoverTermRentals(lot);
      await notePortalUsers(lot);
      await noteRoleUsers(lot);
    },
  },
  {
    flow: 'FC-25',
    summary: '3 festas aceitas, cada uma com uma despesa lançada, e 3 despesas da empresa no mês corrente, para o relatório de despesas do mês e os custos repassados.',
    run: noteMonthExpenses,
  },
  {
    flow: 'FC-26',
    summary: '3 festas aceitas com despesa, 3 despesas da empresa no mês e 3 locações reservadas (base para avaria), para o relatório do mês com tendência e exportação.',
    run: async (lot) => {
      await noteMonthExpenses(lot);
      await noteRentals(lot);
    },
  },
  {
    flow: 'FC-27',
    summary: '3 CNPJs válidos sorteados para digitar no cadastro de empresa e de cliente (na stack de e2e a consulta do CNPJ é respondida pelo simulador) e a empresa do lote.',
    run: async (lot) => {
      for (let i = 1; i <= 3; i++) lot.note(`Ficha ${i} para digitar (CNPJ)`, randomCnpj(lot.rng));
      noteCompany(lot);
    },
  },
];
