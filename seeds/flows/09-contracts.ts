import { apiCreatePaymentPlan, apiGetPaymentPlan, apiGetPaymentSummary, apiRegisterPayment } from '../../helpers/api-event-flow';
import { disableFeatureFlagDirect, execSql, setEventLocationDirect } from '../../helpers/db-helper';
import { assertOk, readJson } from '../../helpers/response';
import { apiCreateActiveContractTemplate, loginAsRole, setupAcceptedEvent, setupDraftContract } from '../../helpers/setup-flows';
import { acceptedEvents, clauses, contractTemplates, draftContracts, feature, noteEvents, packages, roleUsers } from '../lib/builders';
import { FlowSeed } from '../lib/flow';
import { Lot, openLot } from '../lib/lot';
import { noteCollaborators, noteNamed, notePartners } from '../lib/notes';
import { brDate, dayPlus } from '../lib/random';

async function noteDraftContracts(lot: Lot): Promise<void> {
  (await draftContracts(lot)).forEach((c, i) =>
    lot.note(`Contrato ${i + 1} (rascunho)`, `gerado para uma festa aceita própria; abra pela aba Contrato da festa · identificador da festa: ${c.eventId}`),
  );
}

const LEGACY_LOCATIONS = ['Salão Arco-Íris', 'Chácara Boa Vista', 'Espaço Pé de Moleque'];

/** Contrato formalizado por aceite manual (massas do 8, 9.7, 9.8, 9.9, 9.12 e 9.13). */
export async function formalizeManually(lot: Lot, contractId: string, label: string): Promise<void> {
  await assertOk(
    await lot.api.post(`/api/contracts/${contractId}/formalize-manual`, {
      data: {
        signerName: 'Cliente da massa',
        channel: 'presencial',
        reason: 'Aceite registrado pela massa de teste',
        evidenceText: null,
        signerPhone: null,
        signerEmail: null,
      },
    }),
    `POST formalize-manual (${label})`,
  );
}

/**
 * Etapa 285 (fluxo 9.12) - aditivo antigo aberto com o evento já alterado. Na
 * vida real ele nasce da propagação de série sobre um contrato-mestre
 * formalizado; a massa encurta o caminho: contrato formalizado por aceite
 * manual, aditivo de local em rascunho pela API e a marca do legado por SQL
 * (`EffectsStatus = AppliedBeforeFormalization`, `ChangeSet` nulo), o mesmo
 * estado que a migration `Etapa285_AddendumChangeSet` deu aos antigos. O local
 * da festa NÃO muda (a propagação teria mudado): o roteiro só confere a lista, o
 * selo e o cancelamento.
 */
async function noteLegacyPendingAddendums(lot: Lot): Promise<void> {
  const contracts = await draftContracts(lot);
  for (const [i, c] of contracts.entries()) {
    await formalizeManually(lot, c.contractId, 'massa 9.12');
    const location = LEGACY_LOCATIONS[i % LEGACY_LOCATIONS.length]!;
    // Etapa 287 - o local se propõe pela festa (`contract-changes`); o caminho do
    // contrato recusa com `Addendums.ScopeViaEvent`.
    const created = await lot.api.post(`/api/events/${c.eventId}/contract-changes`, {
      data: { reason: `Propagação da série: festa mudou para ${location}`, change: { location } },
    });
    await assertOk(created, 'POST contract-changes (massa 9.12)');
    const addendum = await readJson<{ addendumId: string; addendumNumber: number }>(created);
    execSql(
      `UPDATE "ContractAddendums" SET "EffectsStatus" = 'AppliedBeforeFormalization', "ChangeSet" = NULL WHERE "Id" = '${addendum.addendumId}'`,
    );
    lot.note(
      `Aditivo antigo ${i + 1} (rascunho, evento já alterado)`,
      `aditivo #${addendum.addendumNumber} do contrato formalizado de uma festa aceita própria; já mudou no evento: "Local do evento" (${location}) · identificador da festa: ${c.eventId}`,
    );
  }
}

/**
 * Etapa 286 (fluxo 9.7) - aditivo de cláusulas. Três contratos formalizados,
 * cada um com a cláusula do modelo vigente; três cláusulas ativas na biblioteca
 * para incluir ou substituir; e uma cláusula sem versão ativa, para a recusa da
 * escolha na biblioteca.
 */
async function noteClauseAddendumContracts(lot: Lot): Promise<void> {
  const contracts = await draftContracts(lot);
  for (const [i, c] of contracts.entries()) {
    await formalizeManually(lot, c.contractId, 'massa 9.7');
    lot.note(
      `Contrato ${i + 1} (formalizado)`,
      `uma cláusula vigente, a do modelo; abra pela aba Contrato da festa, "Cláusulas vigentes" e "Criar aditivo" · identificador da festa: ${c.eventId}`,
    );
  }
  noteNamed(lot, 'Cláusula da biblioteca', await clauses(lot), () => 'com versão ativa; para incluir ou substituir');
  const inactiveTitle = `Cláusula sem versão ativa ${lot.id}`;
  const inactiveBody = 'Cláusula da massa de teste ainda sem versão ativa.';
  await assertOk(
    await lot.api.post('/api/clauses', {
      // `applicableTo` é flags e o DTO recebe o número (1 = pessoa física)
      data: { title: inactiveTitle, category: 'Geral', applicableTo: 1, isRequired: false, suggestedOrder: 99, bodyHtml: `<p>${inactiveBody}</p>`, bodyPlain: inactiveBody },
    }),
    'criar cláusula sem versão ativa (massa 9.7)',
  );
  lot.note('Cláusula da biblioteca sem versão ativa', `"${inactiveTitle}": aparece na busca com "sem versão ativa" e é recusada na escolha`);
}

const money = (value: number) => `R$ ${value.toFixed(2).replace('.', ',')}`;

const PLAN_STATES = {
  depositPaid: 'sinal pago, 2 parcelas em aberto',
  allOpen: 'as 3 parcelas em aberto',
  allPaid: 'as 3 parcelas pagas',
} as const;

/**
 * Plano de pagamento em 3 parcelas (vencem em 3, 7 e 10 dias) com as pagas por
 * Pix conforme o estado; devolve a descrição para o arquivo do lote (massas do
 * 9.4, 9.8 e 9.13).
 */
async function planInThree(lot: Lot, eventId: string, state: keyof typeof PLAN_STATES): Promise<string> {
  const total = (await apiGetPaymentSummary(lot.api, eventId)).eventTotal;
  const part = Math.floor((total / 3) * 100) / 100;
  const last = Math.round((total - part * 2) * 100) / 100;
  const plan = await apiCreatePaymentPlan(lot.api, eventId, [
    { order: 1, label: 'Sinal', expectedAmount: part, dueDate: dayPlus(3) },
    { order: 2, label: 'Segunda parcela', expectedAmount: part, dueDate: dayPlus(7) },
    { order: 3, label: 'Quitação', expectedAmount: last, dueDate: dayPlus(10) },
  ]);
  const toPay = state === 'depositPaid' ? plan.installments.slice(0, 1) : state === 'allPaid' ? plan.installments : [];
  for (const inst of toPay) {
    await apiRegisterPayment(lot.api, eventId, { amount: inst.expectedAmount, method: 'Pix', installmentId: inst.id });
  }
  return `total ${money(total)} em 3 parcelas (vencem em 3, 7 e 10 dias), ${PLAN_STATES[state]}`;
}

/**
 * Etapa 288 (fluxo 9.4) - com os efeitos do aditivo, o CF-02 vê as parcelas
 * mudarem: os 3 contratos em rascunho ganham o plano em 3 parcelas com o sinal
 * pago (antes da formalização, que fica com quem testa, pelo roteiro 9.3).
 */
async function noteDraftContractsWithPlan(lot: Lot): Promise<void> {
  for (const [i, c] of (await draftContracts(lot)).entries()) {
    const detail = await planInThree(lot, c.eventId, 'depositPaid');
    lot.note(`Contrato ${i + 1} (rascunho)`, `gerado para uma festa aceita própria, ${detail}; abra pela aba Contrato da festa · identificador da festa: ${c.eventId}`);
  }
}

/**
 * Etapa 287 (fluxo 9.8) - aditivo de escopo, preço e pagamento, proposto pela
 * festa. Quatro contratos formalizados por aceite manual: três com plano de
 * pagamento em 3 parcelas (a 1 com o sinal pago, a 2 toda em aberto, a 3 toda
 * paga) e um sem plano; três pacotes no catálogo para a troca. O teto de crédito
 * por cliente fica no padrão (sem limite): o CE-04 o liga em Parâmetros.
 */
async function noteScopeAddendumContracts(lot: Lot): Promise<void> {
  const contracts = [...(await draftContracts(lot)), await setupDraftContract(lot.api, lot.company.tenantId)];
  const states: Array<keyof typeof PLAN_STATES> = ['depositPaid', 'allOpen', 'allPaid'];
  for (const [i, c] of contracts.entries()) {
    const state = states[i];
    const detail = state ? await planInThree(lot, c.eventId, state) : 'sem plano de pagamento';
    await formalizeManually(lot, c.contractId, 'massa 9.8');
    lot.note(
      `Festa ${i + 1} (contrato formalizado)`,
      `${detail}; abra pela aba Contrato da festa e "Criar aditivo" · identificador da festa: ${c.eventId}`,
    );
  }
  noteNamed(lot, 'Pacote', await packages(lot), () => 'ativo no catálogo; para a troca de pacote em "Pacote da festa"');
}

const MOVED_LOCATIONS = ['Salão Arco-Íris', 'Chácara Boa Vista'];

/**
 * Etapa 288 (fluxo 9.13) - efeitos do aditivo formalizado na festa. Três festas
 * com contrato formalizado por aceite manual e plano em 3 parcelas (sinal pago),
 * cada uma com um aditivo em rascunho proposto pela festa e pronto para
 * formalizar (a formalização é o passo que o roteiro testa): 1, data nova; 2,
 * acréscimo de R$ 200 distribuído nas parcelas em aberto; 3, local novo, e
 * depois o local da festa trocado por SQL, para o "antes" do aditivo não bater
 * mais (CE-01). Com o contrato assinado a tela não muda o local da festa; a
 * massa encurta o caminho, como a do 9.12.
 */
async function noteAddendumEffects(lot: Lot): Promise<void> {
  const contracts = await draftContracts(lot);
  for (const [i, c] of contracts.entries()) {
    const plan = await planInThree(lot, c.eventId, 'depositPaid');
    await formalizeManually(lot, c.contractId, 'massa 9.13');
    const newDate = dayPlus(120 + i);
    const change =
      i === 0
        ? { eventDate: newDate }
        : i === 1
          ? { manualAdjustment: 200, manualAdjustmentDescription: 'Hora extra combinada', payment: { mode: 'DistributeOverOpen' } }
          : { location: MOVED_LOCATIONS[0] };
    const created = await lot.api.post(`/api/events/${c.eventId}/contract-changes`, {
      data: { reason: 'Pedido do cliente (massa 9.13)', change },
    });
    await assertOk(created, 'POST contract-changes (massa 9.13)');
    const addendum = await readJson<{ addendumNumber: number }>(created);
    let what =
      i === 0
        ? `data nova ${brDate(newDate)}`
        : i === 1
          ? 'acréscimo de R$ 200,00 ("Hora extra combinada") distribuído nas parcelas em aberto'
          : `local novo "${MOVED_LOCATIONS[0]}"`;
    if (i === 2) {
      setEventLocationDirect(c.eventId, MOVED_LOCATIONS[1]);
      what += `; a festa já está em "${MOVED_LOCATIONS[1]}" (mudou depois da proposta): formalizar dá "Falhou"`;
    }
    lot.note(
      `Festa ${i + 1} (contrato formalizado, aditivo #${addendum.addendumNumber} em rascunho)`,
      `${plan}; aditivo com ${what}; abra pela aba Contrato da festa · identificador da festa: ${c.eventId}`,
    );
  }
}

/**
 * Etapa 290 (fluxo 9.10) - aceite do aditivo pelo link. Três festas com
 * contrato formalizado e plano em 3 parcelas (sinal pago), cada uma com um
 * aditivo proposto pelo Dono pela festa (não precisa de aprovação), com o PDF
 * gerado e o link de aceite já gerado: 1, data nova (para aceitar, CF-01); 2,
 * acréscimo de R$ 150 nas parcelas em aberto (para recusar, CF-02); 3, local
 * novo (para corrigir e ver o link antigo deixar de abrir, CE-03, e para a
 * página aberta durante a correção, CE-05). O token em claro só existe na URL
 * que o `POST public-link` devolve: a massa a grava no arquivo do lote, como o
 * link do orçamento. Mais uma festa com aditivo proposto por um Gestor, em
 * rascunho e precisando de aprovação, sem link (CE-01).
 */
async function noteAddendumPublicLinks(lot: Lot): Promise<void> {
  const contracts = await draftContracts(lot);
  for (const [i, c] of contracts.entries()) {
    const plan = await planInThree(lot, c.eventId, 'depositPaid');
    await formalizeManually(lot, c.contractId, 'massa 9.10');
    const newDate = dayPlus(140 + i);
    const change =
      i === 0
        ? { eventDate: newDate }
        : i === 1
          ? { manualAdjustment: 150, manualAdjustmentDescription: 'Monitor extra', payment: { mode: 'DistributeOverOpen' } }
          : { location: MOVED_LOCATIONS[1] };
    const created = await lot.api.post(`/api/events/${c.eventId}/contract-changes`, {
      data: { reason: 'Pedido do cliente (massa 9.10)', change },
    });
    await assertOk(created, 'POST contract-changes (massa 9.10)');
    const addendum = await readJson<{ addendumId: string; addendumNumber: number }>(created);
    // O hash do PDF da revisão atual é pré-requisito do link (`Addendums.PdfRequired`).
    await assertOk(await lot.api.get(`/api/addendums/${addendum.addendumId}/pdf`), 'GET pdf do aditivo (massa 9.10)');
    const linkRes = await lot.api.post(`/api/addendums/${addendum.addendumId}/public-link`);
    await assertOk(linkRes, 'POST public-link (massa 9.10)');
    const link = await readJson<{ url: string; expiresAt: string }>(linkRes);
    const what =
      i === 0
        ? `data nova ${brDate(newDate)}; para aceitar`
        : i === 1
          ? 'acréscimo de R$ 150,00 ("Monitor extra") nas parcelas em aberto; para recusar'
          : `local novo "${MOVED_LOCATIONS[1]}"; para corrigir e ver o link antigo deixar de abrir`;
    lot.note(
      `Festa ${i + 1} (aditivo #${addendum.addendumNumber} enviado pelo link)`,
      `${plan}; aditivo com ${what} · link do cliente: ${link.url} · identificador da festa: ${c.eventId}`,
    );
  }

  // Aditivo proposto por um Gestor: nasce em rascunho e precisa da aprovação interna antes do link.
  const pending = await setupDraftContract(lot.api, lot.company.tenantId);
  await formalizeManually(lot, pending.contractId, 'massa 9.10');
  const manager = await loginAsRole(lot.company.tenantId, 'Manager');
  try {
    const proposed = await manager.api.post(`/api/events/${pending.eventId}/contract-changes`, {
      data: { reason: 'O cliente pediu outro local (massa 9.10)', change: { location: MOVED_LOCATIONS[0] } },
    });
    await assertOk(proposed, 'POST contract-changes do Gestor (massa 9.10)');
    const addendum = await readJson<{ addendumNumber: number }>(proposed);
    lot.note(
      'Festa com aditivo que precisa de aprovação',
      `aditivo #${addendum.addendumNumber} (local novo "${MOVED_LOCATIONS[0]}") proposto por um Gestor da massa (${manager.email}, fora dos logins do lote), em rascunho, sem link: "Gerar link de aceite" fica indisponível até a aprovação · identificador da festa: ${pending.eventId}`,
    );
  } finally {
    await manager.api.dispose();
  }
}

/** Aditivo de data nova proposto pela festa, com o PDF da revisão atual gerado (massa 9.14). */
async function proposeDateAddendumWithPdf(
  api: Lot['api'],
  eventId: string,
  newDate: string,
): Promise<{ addendumId: string; addendumNumber: number }> {
  const created = await api.post(`/api/events/${eventId}/contract-changes`, {
    data: { reason: 'Pedido do cliente (massa 9.14)', change: { eventDate: newDate } },
  });
  await assertOk(created, 'POST contract-changes (massa 9.14)');
  const addendum = await readJson<{ addendumId: string; addendumNumber: number }>(created);
  await assertOk(await api.get(`/api/addendums/${addendum.addendumId}/pdf`), 'GET pdf do aditivo (massa 9.14)');
  return addendum;
}

/**
 * Etapa 291 (fluxo 9.14) - aditivo formalizado por PDF assinado externo ou por
 * assinatura digital. Na empresa do lote, com o add-on de assinatura digital
 * ligado (`setupDraftContract` o liga): três festas com contrato formalizado e
 * um aditivo de data nova em rascunho do Dono (sem aprovação), com o PDF gerado
 * (para subir o PDF assinado, para enviar, cancelar e reenviar, e para enviar e
 * recolher); uma festa com aditivo proposto por um Gestor, enviado para aprovação
 * e aprovado pelo Dono (`Approved`); uma com aditivo de Gestor em rascunho que
 * precisa da aprovação (o botão fica indisponível com a dica). O add-on vale para a empresa inteira (armadilha do `CLAUDE.md` da
 * pasta), então a "empresa sem o add-on" é uma segunda empresa, aberta aqui com
 * o `openLot` e o add-on desligado depois do contrato; o login dela entra no
 * arquivo do lote.
 */
async function noteAddendumSignatures(lot: Lot): Promise<void> {
  const uses = [
    'para "Formalizar (PDF assinado)": baixe o PDF pelo "Pré-visualizar PDF" e suba-o como o assinado',
    'para "Enviar para assinatura digital", "Cancelar envio" e enviar de novo',
    'para enviar para assinatura digital e depois "Recolher" e "Corrigir"',
  ];
  for (const [i, c] of (await draftContracts(lot)).entries()) {
    await formalizeManually(lot, c.contractId, 'massa 9.14');
    const newDate = dayPlus(160 + i);
    const addendum = await proposeDateAddendumWithPdf(lot.api, c.eventId, newDate);
    lot.note(
      `Festa ${i + 1} (aditivo #${addendum.addendumNumber} em rascunho, com o PDF)`,
      `data nova ${brDate(newDate)}; ${uses[i]} · identificador da festa: ${c.eventId}`,
    );
  }

  // Dois aditivos de um Gestor: um aprovado pelo Dono, outro em rascunho que precisa da aprovação.
  const manager = await loginAsRole(lot.company.tenantId, 'Manager');
  try {
    for (const [i, approve] of [true, false].entries()) {
      const c = await setupDraftContract(lot.api, lot.company.tenantId);
      await formalizeManually(lot, c.contractId, 'massa 9.14');
      const newDate = dayPlus(170 + i);
      const addendum = await proposeDateAddendumWithPdf(manager.api, c.eventId, newDate);
      if (approve) {
        await assertOk(await manager.api.post(`/api/addendums/${addendum.addendumId}/submit`), 'POST submit (massa 9.14)');
        await assertOk(await lot.api.post(`/api/addendums/${addendum.addendumId}/approve`), 'POST approve (massa 9.14)');
      }
      lot.note(
        approve ? 'Festa com aditivo aprovado' : 'Festa com aditivo que precisa de aprovação',
        approve
          ? `aditivo #${addendum.addendumNumber} (data nova ${brDate(newDate)}) proposto por um Gestor da massa (${manager.email}, fora dos logins do lote) e aprovado pelo Dono, com o PDF; formaliza pelo PDF assinado ou vai para assinatura digital · identificador da festa: ${c.eventId}`
          : `aditivo #${addendum.addendumNumber} (data nova ${brDate(newDate)}) proposto por um Gestor da massa, em rascunho e precisando da aprovação interna: "Formalizar (PDF assinado)" não aparece e "Enviar para assinatura digital" fica indisponível · identificador da festa: ${c.eventId}`,
      );
    }
  } finally {
    await manager.api.dispose();
  }

  // Segunda empresa, sem o add-on: o mesmo aditivo, sem o botão da assinatura digital.
  const other = await openLot();
  try {
    const c = await setupDraftContract(other.api, other.company.tenantId);
    await formalizeManually(other, c.contractId, 'massa 9.14, empresa sem o add-on');
    disableFeatureFlagDirect(other.company.tenantId, 'feature_digital_signature');
    const newDate = dayPlus(175);
    const addendum = await proposeDateAddendumWithPdf(other.api, c.eventId, newDate);
    lot.addLogin({
      role: 'Dono de uma segunda empresa, sem o add-on de assinatura digital',
      url: `${other.frontUrl}/auth/login`,
      email: other.company.email,
      password: other.company.password,
      note: `empresa "${other.company.name}"`,
    });
    lot.note(
      'Festa da empresa sem o add-on',
      `na segunda empresa ("${other.company.name}", login no topo do arquivo): aditivo #${addendum.addendumNumber} (data nova ${brDate(newDate)}) em rascunho, com o PDF; "Enviar para assinatura digital" não aparece · identificador da festa: ${c.eventId}`,
    );
  } finally {
    await other.dispose();
  }
}

/** Aditivo formalizado por aceite manual (massa 9.11). */
async function formalizeAddendumManually(lot: Lot, addendumId: string): Promise<void> {
  await assertOk(
    await lot.api.post(`/api/addendums/${addendumId}/formalize-manual`, {
      data: {
        signerName: 'Cliente da massa',
        channel: 'presencial',
        reason: 'Aceite do aditivo registrado pela massa de teste',
        evidenceText: null,
        signerPhone: null,
        signerEmail: null,
      },
    }),
    'POST formalize-manual do aditivo (massa 9.11)',
  );
}

/**
 * Espera os efeitos do aditivo formalizado saírem de `Pending` (o outbox do back
 * os aplica em segundos) e devolve a situação final. Não falha a carga: a
 * situação vai no arquivo do lote, e quem testa vê o que encontrou.
 */
async function waitForAddendumEffects(lot: Lot, addendumId: string): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const res = await lot.api.get(`/api/addendums/${addendumId}`);
    await assertOk(res, 'GET aditivo (massa 9.11)');
    const { effectsStatus } = await readJson<{ effectsStatus: string }>(res);
    if (effectsStatus !== 'Pending') return effectsStatus;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return 'Pending';
}

const EFFECTS_NOTE: Record<string, string> = {
  Applied: '"Efeitos aplicados"',
  Failed: '"Falhou"',
  NotApplicable: 'só de cláusula, sem efeitos na festa',
  Pending: 'ainda "Aplicando…": espere "Efeitos aplicados" antes de desfazer',
};

/** Proposta pela festa (dono, sem aprovação interna); devolve o aditivo em rascunho. */
async function proposeFromEvent(
  lot: Lot,
  eventId: string,
  change: Record<string, unknown>,
  reason: string,
): Promise<{ addendumId: string; addendumNumber: number }> {
  const created = await lot.api.post(`/api/events/${eventId}/contract-changes`, { data: { reason, change } });
  await assertOk(created, 'POST contract-changes (massa 9.11)');
  return readJson<{ addendumId: string; addendumNumber: number }>(created);
}

/** Proposta pela festa, formalizada à mão e com os efeitos esperados. */
async function proposeAndFormalize(
  lot: Lot,
  eventId: string,
  change: Record<string, unknown>,
  reason: string,
): Promise<{ addendumId: string; addendumNumber: number; effects: string }> {
  const addendum = await proposeFromEvent(lot, eventId, change, reason);
  await formalizeAddendumManually(lot, addendum.addendumId);
  return { ...addendum, effects: await waitForAddendumEffects(lot, addendum.addendumId) };
}

/**
 * Etapa 292 (fluxo 9.11) - estorno de aditivo. Sete festas com contrato
 * formalizado por aceite manual, cada uma num estado de partida do roteiro:
 * 1, aditivo de data nova formalizado e aplicado (CF-01); 2, plano todo pago e
 * aditivo de acréscimo de R$ 300 em parcela extra, formalizado, aplicado e com a
 * parcela extra paga (CF-02, CE-06); 3, aditivo só de cláusula (a do modelo
 * substituída por texto livre) formalizado (CF-03); 4, aditivo de local
 * formalizado com os efeitos "Falhou", porque o local da festa mudou por SQL
 * antes da formalização, como na massa do 9.13 (CE-03); 5, aditivo de data
 * nova enviado ao cliente e não assinado (CE-07); 6, aditivo de data
 * formalizado e aplicado e, depois dele, outro aditivo de data formalizado e
 * aplicado (o conflito do CE-05); 7, aditivo de data formalizado e aplicado com
 * outro aditivo (local) em rascunho (CE-04). A formalização espera o outbox do
 * back aplicar os efeitos; a situação de cada um vai no arquivo do lote.
 */
async function noteAddendumReversals(lot: Lot): Promise<void> {
  const [c1, c2, c3] = await draftContracts(lot);
  const rest: Array<Awaited<ReturnType<typeof setupDraftContract>>> = [];
  for (let i = 0; i < 4; i++) rest.push(await setupDraftContract(lot.api, lot.company.tenantId));
  const [c4, c5, c6, c7] = rest;
  for (const c of [c1!, c2!, c3!, c4!, c5!, c6!, c7!]) await formalizeManually(lot, c.contractId, 'massa 9.11');

  // 1 - data nova, formalizado e aplicado.
  const plan1 = await planInThree(lot, c1!.eventId, 'depositPaid');
  const date1 = dayPlus(190);
  const a1 = await proposeAndFormalize(lot, c1!.eventId, { eventDate: date1 }, 'O cliente mudou a data (massa 9.11)');
  lot.note(
    `Festa 1 (aditivo #${a1.addendumNumber} de data formalizado)`,
    `${plan1}; o aditivo mudou a data para ${brDate(date1)}, ${EFFECTS_NOTE[a1.effects] ?? a1.effects}; para "Desfazer" e ver a festa voltar à data de antes · identificador da festa: ${c1!.eventId}`,
  );

  // 2 - acréscimo em parcela extra, com a parcela extra paga.
  const plan2 = await planInThree(lot, c2!.eventId, 'allPaid');
  const a2 = await proposeAndFormalize(
    lot,
    c2!.eventId,
    { manualAdjustment: 300, manualAdjustmentDescription: 'Personagem extra', payment: { mode: 'ExtraInstallments', installmentCount: 1 } },
    'O cliente pediu um personagem extra (massa 9.11)',
  );
  const extra = (await apiGetPaymentPlan(lot.api, c2!.eventId))?.installments.find((inst) => inst.balance > 0);
  if (extra) {
    await apiRegisterPayment(lot.api, c2!.eventId, { amount: extra.balance, method: 'Pix', installmentId: extra.id });
  }
  lot.note(
    `Festa 2 (aditivo #${a2.addendumNumber} de valor formalizado e pago)`,
    `${plan2}; o aditivo acrescentou R$ 300,00 ("Personagem extra") numa parcela extra, ${EFFECTS_NOTE[a2.effects] ?? a2.effects}; ${extra ? 'a parcela extra já foi paga' : 'a parcela extra não apareceu no plano (confira os efeitos)'}; para desfazer e ver o pago virar crédito do cliente · identificador da festa: ${c2!.eventId}`,
  );

  // 3 - só de cláusula: a cláusula do modelo substituída por um texto livre.
  const effective = await lot.api.get(`/api/contracts/${c3!.contractId}/effective-clauses`);
  await assertOk(effective, 'GET effective-clauses (massa 9.11)');
  const [clause] = await readJson<Array<{ clauseId: string; title: string }>>(effective);
  const freeTitle = `${clause!.title} (redação do aditivo)`;
  const created3 = await lot.api.post(`/api/contracts/${c3!.contractId}/addendums`, {
    data: {
      reason: 'Nova redação combinada com o cliente (massa 9.11)',
      clauses: [
        {
          operation: 'Replace',
          targetClauseId: clause!.clauseId,
          clauseVersionId: null,
          freeTitle,
          freeBodyHtml: '<p>Redação nova combinada com o cliente pela massa de teste.</p>',
        },
      ],
    },
  });
  await assertOk(created3, 'POST addendums só de cláusula (massa 9.11)');
  const a3 = await readJson<{ id: string; addendumNumber: number }>(created3);
  await formalizeAddendumManually(lot, a3.id);
  lot.note(
    `Festa 3 (aditivo #${a3.addendumNumber} só de cláusula formalizado)`,
    `a cláusula "${clause!.title}" foi substituída por "${freeTitle}"; em "Cláusulas vigentes" aparece a redação do aditivo; para desfazer e ver a redação de antes voltar · identificador da festa: ${c3!.eventId}`,
  );

  // 4 - efeitos "Falhou": o local da festa mudou depois da proposta.
  const a4 = await proposeFromEvent(lot, c4!.eventId, { location: MOVED_LOCATIONS[0] }, 'O cliente pediu outro local (massa 9.11)');
  setEventLocationDirect(c4!.eventId, MOVED_LOCATIONS[1]);
  await formalizeAddendumManually(lot, a4.addendumId);
  const effects4 = await waitForAddendumEffects(lot, a4.addendumId);
  lot.note(
    `Festa 4 (aditivo #${a4.addendumNumber} formalizado com os efeitos falhos)`,
    `o aditivo pedia o local "${MOVED_LOCATIONS[0]}", mas a festa já estava em "${MOVED_LOCATIONS[1]}": ${EFFECTS_NOTE[effects4] ?? effects4}; "Desfazer" não aparece · identificador da festa: ${c4!.eventId}`,
  );

  // 5 - enviado ao cliente e ainda não assinado.
  const date5 = dayPlus(195);
  const a5 = await proposeFromEvent(lot, c5!.eventId, { eventDate: date5 }, 'O cliente mudou a data (massa 9.11)');
  await assertOk(await lot.api.post(`/api/addendums/${a5.addendumId}/send`), 'POST send do aditivo (massa 9.11)');
  lot.note(
    `Festa 5 (aditivo #${a5.addendumNumber} enviado, não assinado)`,
    `data nova ${brDate(date5)}, "Enviado"; só tem "Cancelar aditivo", nunca "Desfazer" · identificador da festa: ${c5!.eventId}`,
  );

  // 6 - conflito: a data mudou de novo por outro aditivo depois do primeiro.
  const date6a = dayPlus(200);
  const date6b = dayPlus(207);
  const a6 = await proposeAndFormalize(lot, c6!.eventId, { eventDate: date6a }, 'O cliente mudou a data (massa 9.11)');
  const b6 = await proposeAndFormalize(lot, c6!.eventId, { eventDate: date6b }, 'O cliente mudou a data de novo (massa 9.11)');
  lot.note(
    `Festa 6 (aditivo #${a6.addendumNumber} e, depois dele, #${b6.addendumNumber}, os dois de data)`,
    `o #${a6.addendumNumber} mudou a data para ${brDate(date6a)} (${EFFECTS_NOTE[a6.effects] ?? a6.effects}) e o #${b6.addendumNumber} para ${brDate(date6b)} (${EFFECTS_NOTE[b6.effects] ?? b6.effects}); "Desfazer" no #${a6.addendumNumber} mostra a festa mudada depois dele · identificador da festa: ${c6!.eventId}`,
  );

  // 7 - outro aditivo aberto no contrato.
  const date7 = dayPlus(210);
  const a7 = await proposeAndFormalize(lot, c7!.eventId, { eventDate: date7 }, 'O cliente mudou a data (massa 9.11)');
  const open7 = await proposeFromEvent(lot, c7!.eventId, { location: MOVED_LOCATIONS[0] }, 'O cliente pediu outro local (massa 9.11)');
  lot.note(
    `Festa 7 (aditivo #${a7.addendumNumber} de data formalizado e #${open7.addendumNumber} em rascunho)`,
    `o #${a7.addendumNumber} mudou a data para ${brDate(date7)} (${EFFECTS_NOTE[a7.effects] ?? a7.effects}); o #${open7.addendumNumber} (local "${MOVED_LOCATIONS[0]}") está em rascunho: desfazer o #${a7.addendumNumber} é recusado até cancelar o #${open7.addendumNumber} · identificador da festa: ${c7!.eventId}`,
  );
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Nome do `DayOfWeek` de uma data local (`yyyy-MM-dd`), para a regra de recorrência do orçamento. */
function dayOfWeekName(date: string): string {
  return DAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()]!;
}

/**
 * Etapa 289 (fluxo 9.9) - mudança em festa com contrato assinado vira aditivo,
 * com aprovação interna. Três festas avulsas com contrato formalizado e sem
 * aditivo (o ponto de partida do CF-01, CF-04, CF-06 e das recusas); uma com o
 * aditivo #1 proposto por um Gestor e enviado para aprovação ("Aguardando
 * aprovação", CF-03, CE-06, CE-08); uma com o aditivo #1 proposto pelo Dono e
 * já enviado ao cliente ("Enviado", CE-02); e uma série de 4 ocorrências com o
 * contrato-mestre formalizado (CF-05), a massa que faltava desde a Etapa 288.
 */
async function noteSignedEventChanges(lot: Lot): Promise<void> {
  const signed = await draftContracts(lot);
  for (const [i, c] of signed.entries()) {
    await formalizeManually(lot, c.contractId, 'massa 9.9');
    lot.note(
      `Festa assinada ${i + 1} (contrato formalizado, sem aditivo)`,
      `festa aceita própria; mude a data, os itens ou a série por ela · identificador da festa: ${c.eventId}`,
    );
  }

  // Aditivo aguardando aprovação: proposto e enviado para aprovação por um Gestor.
  const awaiting = await setupDraftContract(lot.api, lot.company.tenantId);
  await formalizeManually(lot, awaiting.contractId, 'massa 9.9');
  const manager = await loginAsRole(lot.company.tenantId, 'Manager');
  try {
    const location = LEGACY_LOCATIONS[0]!;
    const proposed = await manager.api.post(`/api/events/${awaiting.eventId}/contract-changes`, {
      data: { reason: `O cliente pediu para mudar a festa para ${location} (massa 9.9)`, change: { location } },
    });
    await assertOk(proposed, 'POST contract-changes do Gestor (massa 9.9)');
    const addendum = await readJson<{ addendumId: string; addendumNumber: number }>(proposed);
    await assertOk(await manager.api.post(`/api/addendums/${addendum.addendumId}/submit`), 'POST submit (massa 9.9)');
    lot.note(
      'Festa com aditivo aguardando aprovação',
      `aditivo #${addendum.addendumNumber} (local novo "${location}"), proposto por um Gestor da massa (${manager.email}, fora dos logins do lote) e enviado para aprovação; aparece em "Aditivos aguardando aprovação" · identificador da festa: ${awaiting.eventId}`,
    );
  } finally {
    await manager.api.dispose();
  }

  // Aditivo já enviado ao cliente: proposto e enviado pelo Dono (não precisa de aprovação).
  const sent = await setupDraftContract(lot.api, lot.company.tenantId);
  await formalizeManually(lot, sent.contractId, 'massa 9.9');
  const sentDate = dayPlus(130);
  const sentProposal = await lot.api.post(`/api/events/${sent.eventId}/contract-changes`, {
    data: { reason: 'O cliente pediu outra data (massa 9.9)', change: { eventDate: sentDate } },
  });
  await assertOk(sentProposal, 'POST contract-changes do Dono (massa 9.9)');
  const sentAddendum = await readJson<{ addendumId: string; addendumNumber: number }>(sentProposal);
  await assertOk(await lot.api.post(`/api/addendums/${sentAddendum.addendumId}/send`), 'POST send (massa 9.9)');
  lot.note(
    'Festa com aditivo enviado ao cliente',
    `aditivo #${sentAddendum.addendumNumber} (data nova ${brDate(sentDate)}) em "Enviado"; propor outra mudança nela dá "já saiu do rascunho" e "Recolher e incluir" · identificador da festa: ${sent.eventId}`,
  );

  // Série de 4 ocorrências semanais com o contrato-mestre formalizado.
  const anchor = dayPlus(45);
  const series = await setupAcceptedEvent(lot.api, {
    budget: { eventDate: anchor, recurrence: { daysOfWeek: [dayOfWeekName(anchor)], occurrenceCount: 4 } },
  });
  const anchorRes = await lot.api.get(`/api/events/${series.eventId}`);
  await assertOk(anchorRes, 'GET âncora da série (massa 9.9)');
  const { seriesId } = await readJson<{ seriesId: string | null }>(anchorRes);
  if (!seriesId) throw new Error('massa 9.9: o aceite recorrente não devolveu a série');
  const templateId = await apiCreateActiveContractTemplate(lot.api);
  const masterRes = await lot.api.post('/api/contracts', { data: { seriesId, templateId } });
  await assertOk(masterRes, 'POST contrato-mestre da série (massa 9.9)');
  const master = await readJson<{ id: string }>(masterRes);
  await formalizeManually(lot, master.id, 'massa 9.9');
  lot.note(
    'Série com contrato-mestre formalizado',
    `4 ocorrências semanais a partir de ${brDate(anchor)}; use "Editar e replicar na série", "Encerrar série" ou "Cancelar ocorrências" · identificador da primeira festa: ${series.eventId}`,
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
    summary: '3 contratos em rascunho, cada um numa festa aceita própria com plano de pagamento em 3 parcelas (sinal pago); formalize o contrato (roteiro 9.3) e então teste o aditivo.',
    run: noteDraftContractsWithPlan,
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
  {
    flow: '9.7',
    summary: '3 contratos formalizados, cada um numa festa aceita própria e com a cláusula do modelo vigente, 3 cláusulas ativas na biblioteca para incluir ou substituir, 1 cláusula sem versão ativa e os logins de Administrador, Gestor e Financeiro.',
    run: async (lot) => {
      await noteClauseAddendumContracts(lot);
      await roleUsers(lot);
    },
  },
  {
    flow: '9.8',
    summary: '4 contratos formalizados, cada um numa festa aceita própria: 3 com plano de pagamento em 3 parcelas (uma com o sinal pago, uma toda em aberto, uma toda paga) e 1 sem plano; 3 pacotes no catálogo para a troca e os logins de Administrador, Gestor e Financeiro.',
    run: async (lot) => {
      await noteScopeAddendumContracts(lot);
      await roleUsers(lot);
    },
  },
  {
    flow: '9.9',
    summary: '3 festas com contrato formalizado e sem aditivo, 1 festa com aditivo proposto por um Gestor e aguardando aprovação, 1 festa com aditivo já enviado ao cliente, 1 série de 4 ocorrências semanais com contrato-mestre formalizado, e os logins de Administrador, Gestor (sem formalizar contratos) e Financeiro.',
    run: async (lot) => {
      await noteSignedEventChanges(lot);
      await roleUsers(lot);
    },
  },
  {
    flow: '9.10',
    summary: '3 festas com contrato formalizado e plano em 3 parcelas (sinal pago), cada uma com um aditivo enviado pelo link de aceite (o link do cliente vai no arquivo do lote): data nova para aceitar, acréscimo de R$ 150 nas parcelas para recusar e local novo para corrigir; 1 festa com aditivo de um Gestor que precisa de aprovação, sem link; e os logins de Administrador, Gestor e Financeiro.',
    run: async (lot) => {
      await noteAddendumPublicLinks(lot);
      await roleUsers(lot);
    },
  },
  {
    flow: '9.11',
    summary: '7 festas com contrato formalizado, cada uma num ponto de partida do estorno: aditivo de data nova formalizado e aplicado; plano todo pago e aditivo de acréscimo de R$ 300 em parcela extra, aplicado e com a parcela extra paga; aditivo só de cláusula formalizado; aditivo formalizado com os efeitos falhos (a festa mudou de local antes); aditivo enviado ao cliente e não assinado; aditivo de data seguido de outro aditivo de data, os dois aplicados (o conflito); aditivo de data aplicado com outro aditivo em rascunho; e os logins de Administrador, Gestor e Financeiro.',
    run: async (lot) => {
      await noteAddendumReversals(lot);
      await roleUsers(lot);
    },
  },
  {
    flow: '9.12',
    summary: '3 contratos formalizados, cada um numa festa aceita própria, com um aditivo antigo em rascunho marcado como "evento já alterado" (mudança de local), e os logins de Administrador, Gestor e Financeiro; o aviso do sino sai quando o sistema sobe depois da carga.',
    run: async (lot) => {
      await noteLegacyPendingAddendums(lot);
      await roleUsers(lot);
    },
  },
  {
    flow: '9.13',
    summary: '3 festas com contrato formalizado e plano em 3 parcelas (sinal pago), cada uma com um aditivo em rascunho pronto para formalizar: data nova, acréscimo de R$ 200 nas parcelas em aberto e local novo numa festa que já mudou de local depois da proposta; e os logins de Administrador, Gestor e Financeiro.',
    run: async (lot) => {
      await noteAddendumEffects(lot);
      await roleUsers(lot);
    },
  },
  {
    flow: '9.14',
    summary: '3 festas com contrato formalizado e um aditivo de data nova em rascunho com o PDF gerado (para subir o PDF assinado, para enviar à assinatura digital, cancelar e reenviar, e para enviar e recolher), 1 festa com aditivo de um Gestor aprovado pelo Dono e 1 com aditivo de um Gestor que ainda precisa de aprovação, com o add-on de assinatura digital ligado; uma segunda empresa sem o add-on, com um aditivo em rascunho (o login dela vai no arquivo do lote); e os logins de Administrador, Gestor e Financeiro.',
    run: async (lot) => {
      await noteAddendumSignatures(lot);
      await roleUsers(lot);
    },
  },
];
