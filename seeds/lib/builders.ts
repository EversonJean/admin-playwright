import {
  apiAddCollaboratorSkill,
  apiCreateActivity,
  apiCreateClient,
  apiCreateCollaborator,
  apiCreateCollaboratorLevel,
  apiCreateEventCategory,
  apiCreatePackage,
  apiCreateProduct,
  apiFindOrCreateSkill,
} from '../../helpers/api-entities';
import {
  apiAssignCollaborator,
  apiCreateBudget,
  apiCreatePaymentPlan,
  apiCreatePublicEvent,
  apiCreateTicketSaleLink,
  apiCreateTicketType,
  apiGetPaymentSummary,
  apiIssueEventFormLink,
  apiSendBudget,
  setupCommunityEvent,
} from '../../helpers/api-event-flow';
import { createApiContext, signupAndConfirm } from '../../helpers/api-client';
import {
  enableFeatureFlagDirect,
  seedCollaboratorPortalUserDirect,
  seedConnectedWhatsappTenantDirect,
  seedUserWithRoleDirect,
} from '../../helpers/db-helper';
import { addCompanyExpense, addEventExpense } from '../../helpers/monthly-expenses';
import { setupRainParty } from '../../helpers/rain-plan';
import {
  apiCreateEquipmentType,
  apiCreateEquipmentUnit,
  apiCreateRental,
  apiTransitionRental,
  inspectRentalBatch,
  setupReservedRental,
} from '../../helpers/rental-preparation';
import { assertOk, readJson } from '../../helpers/response';
import { setupAcceptedEvent, setupDraftContract, setupPaidEvent } from '../../helpers/setup-flows';
import { SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD, SUPER_ADMIN_TOTP_SECRET } from '../../helpers/super-admin-session';
import { Lot, LOT_PASSWORD } from './lot';
import {
  ACTIVITY_NAMES,
  brDate,
  dayPlus,
  EVENT_CATEGORY_NAMES,
  PACKAGE_NAMES,
  PARTNER_NAMES,
  Person,
  PRODUCT_NAMES,
  randomAddress,
  randomCnpj,
  randomCompanyName,
  randomMobile,
  randomPeople,
  SKILL_NAMES,
  VENUES,
} from './random';

/**
 * Construtores da massa. Dois tipos:
 *
 * - CADASTRO (clientes, atividades, equipe...): `lot.once`, um conjunto por
 *   lote, dividido entre os fluxos. Quem testa não gasta cadastro.
 * - MOVIMENTO (orçamento, festa, locação, contrato...): um conjunto NOVO a cada
 *   chamada, porque o teste manual consome o registro (aceitar, pagar,
 *   cancelar). Cada fluxo recebe os seus três e não disputa com o vizinho.
 *
 * Tudo passa pelos helpers do e2e (`helpers/`): a carga usa a mesma API que os
 * specs exercitam, e quebra junto com eles quando o contrato muda.
 */

export const RECORDS_PER_FLOW = 3;

export interface Named {
  id: string;
  name: string;
}

export type SeededClient = Person & { id: string };

/** Liga um add-on da empresa do lote, uma vez. */
export function feature(lot: Lot, key: string): Promise<void> {
  return lot.once(`feature:${key}`, async () => enableFeatureFlagDirect(lot.company.tenantId, key));
}

// ───────────────────────────── cadastro (um por lote) ─────────────────────────────

export function clients(lot: Lot): Promise<SeededClient[]> {
  return lot.once('clients', async () => {
    const out: SeededClient[] = [];
    for (const p of randomPeople(lot.rng, lot.id, RECORDS_PER_FLOW, 'cliente')) {
      const created = await apiCreateClient(lot.api, { name: p.name, email: p.email, phone: p.phone, document: p.cpf });
      out.push({ ...p, id: created.id });
    }
    return out;
  });
}

export function activities(lot: Lot): Promise<Array<Named & { pricePerChild: number }>> {
  return lot.once('activities', async () => {
    const out: Array<Named & { pricePerChild: number }> = [];
    for (const name of lot.rng.take(ACTIVITY_NAMES, RECORDS_PER_FLOW)) {
      const pricePerChild = lot.rng.int(3, 9) * 10;
      const created = await apiCreateActivity(lot.api, { name, pricePerChild, description: `${name} para festas infantis` });
      out.push({ id: created.id, name, pricePerChild });
    }
    return out;
  });
}

export function products(lot: Lot): Promise<Named[]> {
  return lot.once('products', async () => {
    const out: Named[] = [];
    for (const name of lot.rng.take(PRODUCT_NAMES, RECORDS_PER_FLOW)) {
      const created = await apiCreateProduct(lot.api, { name, unitCost: lot.rng.int(2, 30) });
      out.push({ id: created.id, name });
    }
    return out;
  });
}

export function packages(lot: Lot): Promise<Named[]> {
  return lot.once('packages', async () => {
    const acts = await activities(lot);
    const out: Named[] = [];
    const names = lot.rng.take(PACKAGE_NAMES, RECORDS_PER_FLOW);
    for (let i = 0; i < names.length; i++) {
      const activityIds = [acts[i % acts.length]!.id, acts[(i + 1) % acts.length]!.id];
      const created = await apiCreatePackage(lot.api, { name: names[i]!, activityIds });
      out.push({ id: created.id, name: names[i]! });
    }
    return out;
  });
}

export function eventCategories(lot: Lot): Promise<Named[]> {
  return lot.once('eventCategories', async () => {
    const out: Named[] = [];
    for (const base of lot.rng.take(EVENT_CATEGORY_NAMES, RECORDS_PER_FLOW)) {
      // o catálogo da empresa nova já traz categorias padrão: o id do lote evita o nome repetido
      const name = `${base} ${lot.id}`;
      const created = await apiCreateEventCategory(lot.api, { group: 'Festa', name });
      out.push({ id: created.id, name });
    }
    return out;
  });
}

/** Parceiros: clientes PJ marcados como parceiro (salão, escola, buffet). */
export function partners(lot: Lot): Promise<Array<Named & { cnpj: string }>> {
  return lot.once('partners', async () => {
    const out: Array<Named & { cnpj: string }> = [];
    for (const name of lot.rng.take(PARTNER_NAMES, RECORDS_PER_FLOW)) {
      const cnpj = randomCnpj(lot.rng);
      const res = await lot.api.post('/api/clients', {
        data: { type: 'PJ', name, document: cnpj, phone: randomMobile(lot.rng), isPartner: true, partnerCategory: 'Buffet' },
      });
      await assertOk(res, 'criar parceiro');
      out.push({ id: (await readJson<{ id: string }>(res)).id, name, cnpj });
    }
    return out;
  });
}

export function collaborators(lot: Lot): Promise<Array<Person & { id: string }>> {
  return lot.once('collaborators', async () => {
    // o nível dá custo de equipe ao orçamento (sem ele a estimativa sai incompleta)
    await apiCreateCollaboratorLevel(lot.api, { baseValue: 120, name: `Recreador ${lot.id}` });
    const out: Array<Person & { id: string }> = [];
    for (const p of randomPeople(lot.rng, lot.id, RECORDS_PER_FLOW, 'equipe')) {
      const created = await apiCreateCollaborator(lot.api, { name: p.name, email: p.email, phone: p.phone });
      out.push({ ...p, id: created.id });
    }
    return out;
  });
}

/** Três habilidades do catálogo, uma em cada colaborador. */
export function skills(lot: Lot): Promise<Array<Named & { collaboratorName: string }>> {
  return lot.once('skills', async () => {
    const team = await collaborators(lot);
    const out: Array<Named & { collaboratorName: string }> = [];
    const names = lot.rng.take(SKILL_NAMES, RECORDS_PER_FLOW);
    for (let i = 0; i < names.length; i++) {
      const skill = await apiFindOrCreateSkill(lot.api, names[i]!);
      await apiAddCollaboratorSkill(lot.api, team[i]!.id, skill.id);
      out.push({ id: skill.id, name: names[i]!, collaboratorName: team[i]!.name });
    }
    return out;
  });
}

export interface SeededLogin {
  role: string;
  email: string;
  password: string;
}

const ROLE_LABEL: Record<string, string> = {
  Admin: 'Administrador',
  Manager: 'Gestor',
  Financial: 'Financeiro',
};

/** Um usuário de cada perfil interno (Administrador, Gestor, Financeiro), com login. */
export function roleUsers(lot: Lot): Promise<SeededLogin[]> {
  return lot.once('roleUsers', async () => {
    const out: SeededLogin[] = [];
    for (const role of ['Admin', 'Manager', 'Financial'] as const) {
      const user = seedUserWithRoleDirect({ tenantId: lot.company.tenantId, role, emailPrefix: `${role.toLowerCase()}.${lot.id}` });
      const login = { role: ROLE_LABEL[role]!, email: user.email, password: user.password };
      lot.addLogin({ role: `Perfil ${login.role}`, url: `${lot.frontUrl}/auth/login`, email: login.email, password: login.password });
      out.push(login);
    }
    return out;
  });
}

/** Acesso ao Portal para cada colaborador do lote. */
export function portalUsers(lot: Lot): Promise<Array<SeededLogin & { collaboratorId: string; name: string }>> {
  return lot.once('portalUsers', async () => {
    const team = await collaborators(lot);
    const out: Array<SeededLogin & { collaboratorId: string; name: string }> = [];
    for (const c of team) {
      const user = seedCollaboratorPortalUserDirect({
        tenantId: lot.company.tenantId,
        collaboratorId: c.id,
        emailPrefix: `portal.${lot.id}`,
      });
      lot.addLogin({
        role: `Portal do colaborador: ${c.name}`,
        url: `${lot.frontUrl}/auth/login`,
        email: user.email,
        password: user.password,
        note: 'cai direto no Portal',
      });
      out.push({ role: 'Portal', email: user.email, password: user.password, collaboratorId: c.id, name: c.name });
    }
    return out;
  });
}

/** O Super Admin de desenvolvimento (um só no banco; o código de 6 dígitos sai do segredo). */
export function superAdminLogin(lot: Lot): void {
  lot.addLogin({
    role: 'Super Admin (painel da plataforma)',
    url: lot.superAdminUrl,
    email: SUPER_ADMIN_EMAIL,
    password: SUPER_ADMIN_PASSWORD,
    note: `código de 6 dígitos: cadastre o segredo ${SUPER_ADMIN_TOTP_SECRET} num app autenticador`,
  });
}

// ───────────────────────────── fichas (dados para digitar) ─────────────────────────────

/** Três pessoas sorteadas para digitar num formulário de cadastro (nada é gravado no banco). */
export function inputPeople(lot: Lot, tag: string): Person[] {
  return randomPeople(lot.rng, lot.id, RECORDS_PER_FLOW, tag);
}

export function personSheet(p: Person): string {
  return `Nome: ${p.name} · E-mail: ${p.email} · Celular: ${p.phone} · CPF: ${p.cpf}`;
}

export function companySheet(lot: Lot, index: number): string {
  const [owner] = randomPeople(lot.rng, lot.id, 1, `nova${index}`);
  const address = randomAddress(lot.rng);
  return (
    `Empresa: ${randomCompanyName(lot.rng, `${lot.id}-${index}`)} · CNPJ: ${randomCnpj(lot.rng)} · ` +
    `Responsável: ${owner!.name} · E-mail: ${owner!.email} · Celular: ${owner!.phone} · Senha: Massa@12345 · ` +
    `Endereço: ${address.street}, ${address.number}, ${address.neighborhood}, Curitiba/PR, CEP 80010-100`
  );
}

// ───────────────────────────── movimento (novo a cada chamada) ─────────────────────────────

export interface SeededBudget {
  id: string;
  clientName: string;
  eventDate: string;
  venue: string;
  activityName: string;
}

function describeBudget(b: SeededBudget): string {
  return `Cliente ${b.clientName} · festa em ${brDate(b.eventDate)} · ${b.venue} · atividade ${b.activityName}`;
}

/** Três orçamentos em rascunho, um por cliente do lote, em datas e locais diferentes. */
export async function draftBudgets(lot: Lot, firstDay = 30): Promise<SeededBudget[]> {
  const [cs, acts] = [await clients(lot), await activities(lot)];
  const venues = lot.rng.take(VENUES, RECORDS_PER_FLOW);
  const out: SeededBudget[] = [];
  for (let i = 0; i < RECORDS_PER_FLOW; i++) {
    const eventDate = dayPlus(firstDay + i * 7 + lot.rng.int(0, 3));
    const created = await apiCreateBudget(lot.api, {
      clientId: cs[i]!.id,
      activityIds: [acts[i]!.id],
      eventDate,
      childrenCount: 10 + i * 5,
      eventLocation: venues[i]!,
    });
    out.push({ id: created.id, clientName: cs[i]!.name, eventDate, venue: venues[i]!, activityName: acts[i]!.name });
  }
  return out;
}

export type SentBudget = SeededBudget & { publicUrl: string };

/** Três orçamentos já ENVIADOS ao cliente, cada um com o link público da proposta. */
export async function sentBudgets(lot: Lot, firstDay = 30): Promise<SentBudget[]> {
  const out: SentBudget[] = [];
  for (const b of await draftBudgets(lot, firstDay)) {
    const sent = await apiSendBudget(lot.api, b.id);
    out.push({ ...b, publicUrl: sent.publicUrl });
  }
  return out;
}

export function noteBudgets(lot: Lot, state: string, list: SeededBudget[]): void {
  list.forEach((b, i) => {
    const link = 'publicUrl' in b ? ` · link do cliente: ${(b as SentBudget).publicUrl}` : '';
    lot.note(`Orçamento ${i + 1} (${state})`, `${describeBudget(b)}${link}`);
  });
}

export interface SeededEvent {
  id: string;
  budgetId: string;
  clientId: string;
  clientName: string;
  eventDate: string;
  venue: string;
  activityName: string;
  total: number;
}

function describeEvent(e: SeededEvent): string {
  return `Cliente ${e.clientName} · ${brDate(e.eventDate)} · ${e.venue} · atividade ${e.activityName}`;
}

export interface EventSlot {
  date: string;
  startTime?: string;
  endTime?: string;
  /** Atividade da festa; omitida = a do cadastro do lote, na ordem. */
  activity?: Named;
  /** Mantém a data pedida mesmo que outra festa do lote já a use (fim de semana da escalação). */
  fixedDate?: boolean;
}

/** Uma festa já ACEITA pelo cliente (orçamento enviado e aceito) em cada horário dado. */
export async function acceptedEventsAt(lot: Lot, slots: EventSlot[]): Promise<SeededEvent[]> {
  const [cs, acts] = [await clients(lot), await activities(lot)];
  const venues = lot.rng.take(VENUES, slots.length);
  const out: SeededEvent[] = [];
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    const date = slot.fixedDate ? slot.date : lot.freeDay(slot.date);
    const client = cs[i % cs.length]!;
    const activity = slot.activity ?? acts[i % acts.length]!;
    const accepted = await setupAcceptedEvent(lot.api, {
      clientId: client.id,
      activityIds: [activity.id],
      budget: {
        eventDate: date,
        childrenCount: 10 + i * 5,
        eventLocation: venues[i]!,
        ...(slot.startTime ? { startTime: slot.startTime, endTime: slot.endTime } : {}),
      },
    });
    const summary = await apiGetPaymentSummary(lot.api, accepted.eventId);
    out.push({
      id: accepted.eventId,
      budgetId: accepted.orcamentoId,
      clientId: client.id,
      clientName: client.name,
      eventDate: date,
      venue: venues[i]!,
      activityName: activity.name,
      total: summary.eventTotal,
    });
  }
  return out;
}

/** Três festas aceitas, uma por semana a partir de `firstDay` dias à frente. */
export function acceptedEvents(lot: Lot, firstDay = 15): Promise<SeededEvent[]> {
  const slots = Array.from({ length: RECORDS_PER_FLOW }, (_, i) => ({ date: dayPlus(firstDay + i * 7 + lot.rng.int(0, 3)) }));
  return acceptedEventsAt(lot, slots);
}

/** Três festas aceitas no MESMO fim de semana: duas no sábado (manhã e tarde) e uma no domingo. */
export function weekendEvents(lot: Lot): Promise<SeededEvent[]> {
  // sábado com pelo menos 2 dias de folga: a validade do orçamento vai até a véspera da festa
  let toSaturday = (6 - new Date().getDay() + 7) % 7;
  if (toSaturday < 2) toSaturday += 7;
  return acceptedEventsAt(lot, [
    { date: dayPlus(toSaturday), startTime: '09:00', endTime: '12:00', fixedDate: true },
    { date: dayPlus(toSaturday), startTime: '15:00', endTime: '18:00', fixedDate: true },
    { date: dayPlus(toSaturday + 1), startTime: '14:00', endTime: '18:00', fixedDate: true },
  ]);
}

/** Três festas aceitas cuja atividade usa material: a lista de materiais da festa nasce preenchida. */
export async function checklistEvents(lot: Lot): Promise<Array<SeededEvent & { productName: string }>> {
  const prods = await products(lot);
  const names = lot.rng.take(ACTIVITY_NAMES, RECORDS_PER_FLOW);
  const slots: EventSlot[] = [];
  for (let i = 0; i < RECORDS_PER_FLOW; i++) {
    const name = `${names[i]!} com material ${lot.id}`;
    const created = await apiCreateActivity(lot.api, {
      name,
      activityProducts: [{ productId: prods[i]!.id, qtyPerChild: 1, isChecklistOnly: true }],
    });
    slots.push({ date: dayPlus(16 + i * 7), activity: { id: created.id, name } });
  }
  const events = await acceptedEventsAt(lot, slots);
  return events.map((e, i) => ({ ...e, productName: prods[i]!.name }));
}

export function noteEvents(lot: Lot, state: string, list: SeededEvent[], extra: (e: SeededEvent, i: number) => string = () => ''): void {
  list.forEach((e, i) => {
    const more = extra(e, i);
    lot.note(`Festa ${i + 1} (${state})`, `${describeEvent(e)}${more ? ` · ${more}` : ''}`);
  });
}

/** Parcela o total em três vencimentos (o último leva o resto dos centavos). */
export async function splitInThree(lot: Lot, event: SeededEvent): Promise<string[]> {
  const part = Math.floor((event.total / 3) * 100) / 100;
  const last = Math.round((event.total - part * 2) * 100) / 100;
  const plan = await apiCreatePaymentPlan(lot.api, event.id, [
    { order: 1, label: 'Sinal', expectedAmount: part, dueDate: dayPlus(3) },
    { order: 2, label: 'Segunda parcela', expectedAmount: part, dueDate: dayPlus(7) },
    { order: 3, label: 'Quitação', expectedAmount: last, dueDate: dayPlus(10) },
  ]);
  return plan.installments.map((i) => i.id);
}

/** Três festas aceitas e QUITADAS (parcela única paga por Pix). */
export async function paidEvents(lot: Lot): Promise<Array<{ id: string; clientName: string; total: number }>> {
  const [cs, acts] = [await clients(lot), await activities(lot)];
  const out: Array<{ id: string; clientName: string; total: number }> = [];
  for (let i = 0; i < RECORDS_PER_FLOW; i++) {
    const paid = await setupPaidEvent(lot.api, {
      clientId: cs[i]!.id,
      activityIds: [acts[i]!.id],
      budget: { eventDate: dayPlus(40 + i * 7), eventLocation: lot.rng.pick(VENUES) },
    });
    out.push({ id: paid.eventId, clientName: cs[i]!.name, total: paid.total });
  }
  return out;
}

/** Escala os colaboradores do lote nas festas dadas: o primeiro como líder; ninguém confirmou ainda. */
export async function staffEvents(lot: Lot, events: SeededEvent[]): Promise<string[]> {
  const team = await collaborators(lot);
  const lines: string[] = [];
  for (let i = 0; i < events.length; i++) {
    const leader = team[i % team.length]!;
    const helper = team[(i + 1) % team.length]!;
    await apiAssignCollaborator(lot.api, events[i]!.id, leader.id, { isLeader: true });
    await apiAssignCollaborator(lot.api, events[i]!.id, helper.id);
    lines.push(`líder ${leader.name}, apoio ${helper.name} (aguardando confirmação)`);
  }
  return lines;
}

/** Três contratos em rascunho, cada um numa festa aceita própria, com modelo e cláusula ativos. */
export async function draftContracts(lot: Lot): Promise<Array<{ contractId: string; eventId: string }>> {
  const out: Array<{ contractId: string; eventId: string }> = [];
  for (let i = 0; i < RECORDS_PER_FLOW; i++) {
    const c = await setupDraftContract(lot.api, lot.company.tenantId);
    out.push({ contractId: c.contractId, eventId: c.eventId });
  }
  return out;
}

/** Três locações RESERVADAS, cada uma de um brinquedo com checklist de preparação. */
export async function reservedRentals(lot: Lot, events: SeededEvent[] = []): Promise<Array<{ id: string; typeName: string; assetCode: string; clientName: string; deliveryDate: string }>> {
  await feature(lot, 'feature_equipment_rental');
  const cs = await clients(lot);
  const toys = lot.rng.take(['Pula-pula', 'Tobogã inflável', 'Piscina de bolinhas', 'Cama elástica', 'Castelo inflável'], RECORDS_PER_FLOW);
  const out: Array<{ id: string; typeName: string; assetCode: string; clientName: string; deliveryDate: string }> = [];
  for (let i = 0; i < RECORDS_PER_FLOW; i++) {
    // com festa: o brinquedo vai para ela, no dia dela
    const deliveryDate = events[i]?.eventDate ?? dayPlus(20 + i * 5);
    const typeName = `${toys[i]!} ${lot.id}`;
    const r = await setupReservedRental(lot.api, lot.company.tenantId, {
      clientId: events[i]?.clientId ?? cs[i]!.id,
      eventId: events[i]?.id ?? null,
      typeName,
      deliveryDate,
      enableAddOn: false,
    });
    out.push({ id: r.rental.id, typeName, assetCode: r.unit.assetCode, clientName: events[i]?.clientName ?? cs[i]!.name, deliveryDate });
  }
  return out;
}

export interface EquipmentBudget extends SentBudget {
  equipment: string;
}

/**
 * Orçamento com brinquedo (FC-20, Etapas 325 e 326): dois tipos com unidades
 * (3 camas elásticas com caução e 1 piscina de bolinhas, os dois sem passo de
 * preparação) e três orçamentos ENVIADOS com equipamento e endereço da festa,
 * em semanas diferentes. O terceiro pede 2 piscinas, uma a mais do que existe:
 * no aceite, a locação nasce em rascunho e os gestores recebem o aviso de falta.
 */
export async function equipmentBudgets(lot: Lot): Promise<{ types: string[]; budgets: EquipmentBudget[] }> {
  await feature(lot, 'feature_equipment_rental');
  const [cs, acts] = [await clients(lot), await activities(lot)];
  const bedName = `Cama elástica ${lot.id}`;
  const poolName = `Piscina de bolinhas ${lot.id}`;
  const bed = await apiCreateEquipmentType(lot.api, { name: bedName, depositAmount: 300 });
  const pool = await apiCreateEquipmentType(lot.api, { name: poolName });
  const bedCodes: string[] = [];
  for (let i = 0; i < RECORDS_PER_FLOW; i++) bedCodes.push((await apiCreateEquipmentUnit(lot.api, bed.id)).assetCode);
  const poolCode = (await apiCreateEquipmentUnit(lot.api, pool.id)).assetCode;
  const plans = [
    { lines: [{ equipmentTypeId: bed.id, quantity: 2 }], label: `2x ${bedName}` },
    { lines: [{ equipmentTypeId: bed.id, quantity: 2 }], label: `2x ${bedName}` },
    {
      lines: [{ equipmentTypeId: bed.id, quantity: 1 }, { equipmentTypeId: pool.id, quantity: 2 }],
      label: `1x ${bedName} e 2x ${poolName} (só 1 piscina cadastrada: falta 1 no aceite)`,
    },
  ];
  const venues = lot.rng.take(VENUES, RECORDS_PER_FLOW);
  const budgets: EquipmentBudget[] = [];
  for (let i = 0; i < RECORDS_PER_FLOW; i++) {
    const eventDate = lot.freeDay(dayPlus(30 + i * 7 + lot.rng.int(0, 3)));
    const created = await apiCreateBudget(lot.api, {
      clientId: cs[i]!.id,
      activityIds: [acts[i]!.id],
      eventDate,
      childrenCount: 10 + i * 5,
      eventLocation: venues[i]!,
      address: randomAddress(lot.rng),
      equipmentLines: plans[i]!.lines,
    });
    const sent = await apiSendBudget(lot.api, created.id);
    budgets.push({
      id: created.id,
      clientName: cs[i]!.name,
      eventDate,
      venue: venues[i]!,
      activityName: acts[i]!.name,
      publicUrl: sent.publicUrl,
      equipment: plans[i]!.label,
    });
  }
  return {
    types: [
      `${bedName}: ${bedCodes.length} unidades (${bedCodes.join(', ')}), caução de R$ 300,00 por unidade`,
      `${poolName}: 1 unidade (${poolCode}), sem caução`,
    ],
    budgets,
  };
}

/**
 * Giro e limpeza da volta (FC-21, Etapas 324 e 327): um tipo com giro de 24 h
 * e "Higienizar na volta", sem passo de preparação, com 3 unidades. Para cada
 * unidade, uma locação EM USO (já saiu, com a inspeção de saída) e a próxima
 * locação da mesma unidade RESERVADA 3 dias depois: a volta da primeira abre a
 * limpeza, e a saída da segunda fica travada até alguém concluir.
 */
export async function rentalsWithReturnCleaning(lot: Lot): Promise<{
  typeName: string;
  pairs: Array<{ assetCode: string; clientName: string; inUseNumber: string; inUseDate: string; nextNumber: string; nextDate: string }>;
}> {
  await feature(lot, 'feature_equipment_rental');
  const cs = await clients(lot);
  const typeName = `Castelo inflável ${lot.id}`;
  const type = await apiCreateEquipmentType(lot.api, { name: typeName, turnaroundHours: 24, requiresReturnCleaning: true });
  const pairs: Array<{ assetCode: string; clientName: string; inUseNumber: string; inUseDate: string; nextNumber: string; nextDate: string }> = [];
  for (let i = 0; i < RECORDS_PER_FLOW; i++) {
    const unit = await apiCreateEquipmentUnit(lot.api, type.id);
    const inUseDate = dayPlus(2 + i * 7);
    const inUse = await apiCreateRental(lot.api, { clientId: cs[i]!.id, deliveryDate: inUseDate, unitIds: [unit.id] });
    await apiTransitionRental(lot.api, inUse.id, 'Reserved', 'Confirmed', 'Preparing');
    await assertOk(await inspectRentalBatch(lot.api, inUse.id, { type: 'Outbound' }), 'inspeção de saída');
    await apiTransitionRental(lot.api, inUse.id, 'Dispatched', 'Delivered', 'InUse');
    const nextDate = dayPlus(5 + i * 7);
    const next = await apiCreateRental(lot.api, { clientId: cs[(i + 1) % cs.length]!.id, deliveryDate: nextDate, unitIds: [unit.id] });
    await apiTransitionRental(lot.api, next.id, 'Reserved');
    pairs.push({
      assetCode: unit.assetCode,
      clientName: cs[i]!.name,
      inUseNumber: inUse.rentalNumber,
      inUseDate,
      nextNumber: next.rentalNumber,
      nextDate,
    });
  }
  return { typeName, pairs };
}

/** Três ações comunitárias (evento sem cobrança) já confirmadas. */
export async function communityEvents(lot: Lot): Promise<Array<{ eventId: string; eventDate: string }>> {
  const out: Array<{ eventId: string; eventDate: string }> = [];
  for (let i = 0; i < RECORDS_PER_FLOW; i++) {
    const eventDate = dayPlus(18 + i * 7);
    const acts = await activities(lot);
    const c = await setupCommunityEvent(lot.api, { eventDate, activityIds: [acts[i]!.id] });
    out.push({ eventId: c.eventId, eventDate });
  }
  return out;
}

/** Três eventos abertos ao público, cada um com um lote de ingresso e o link de venda. */
export async function publicEvents(lot: Lot): Promise<Array<{ id: string; title: string; eventDate: string; saleUrl: string }>> {
  await feature(lot, 'feature_ticketing');
  const titles = lot.rng.take(['Colônia de férias', 'Tarde de brincadeiras', 'Festival de bolhas', 'Manhã de gincana', 'Oficina de circo'], RECORDS_PER_FLOW);
  const out: Array<{ id: string; title: string; eventDate: string; saleUrl: string }> = [];
  for (let i = 0; i < RECORDS_PER_FLOW; i++) {
    const eventDate = dayPlus(12 + i * 7);
    const title = `${titles[i]!} ${lot.id}`;
    const event = await apiCreatePublicEvent(lot.api, { title, eventDate });
    await apiCreateTicketType(lot.api, event.id, { name: 'Pulseira criança', price: 30 + i * 10 });
    const link = await apiCreateTicketSaleLink(lot.api, event.id);
    out.push({ id: event.id, title, eventDate, saleUrl: link.url });
  }
  return out;
}

/** Três festas ao ar livre marcadas para AMANHÃ (o dia em que o clima de teste prevê chuva). */
export async function rainParties(lot: Lot): Promise<Array<{ eventId: string; clientName: string }>> {
  const cs = await clients(lot);
  const out: Array<{ eventId: string; clientName: string }> = [];
  for (let i = 0; i < RECORDS_PER_FLOW; i++) {
    const party = await setupRainParty(lot.api, { clientId: cs[i]!.id });
    out.push({ eventId: party.eventId, clientName: cs[i]!.name });
  }
  return out;
}

/** Três registros operacionais (compromisso externo) na agenda, sem orçamento. */
export async function operationalEvents(lot: Lot): Promise<Array<{ id: string; eventDate: string; location: string }>> {
  const places = lot.rng.take(['Reunião com fornecedor', 'Manutenção dos brinquedos', 'Treinamento da equipe', 'Visita técnica ao salão'], RECORDS_PER_FLOW);
  const out: Array<{ id: string; eventDate: string; location: string }> = [];
  for (let i = 0; i < RECORDS_PER_FLOW; i++) {
    const eventDate = dayPlus(60 + i * 3);
    const res = await lot.api.post('/api/events/operational', {
      data: { kind: 'ExternalCommitment', eventDate, startTime: '09:00', endTime: '12:00', location: places[i]!, childrenCount: 10 },
    });
    await assertOk(res, 'criar registro operacional');
    out.push({ id: (await readJson<{ id: string }>(res)).id, eventDate, location: places[i]! });
  }
  return out;
}

/** Três leads novos no funil. */
export async function leads(lot: Lot): Promise<Array<Named & { phone: string }>> {
  await feature(lot, 'feature_leads');
  const out: Array<Named & { phone: string }> = [];
  for (const p of randomPeople(lot.rng, lot.id, RECORDS_PER_FLOW, 'lead')) {
    const res = await lot.api.post('/api/leads', {
      data: { name: p.name, whatsAppPhone: p.phone, email: p.email, source: 'WhatsApp', isRecurring: false },
    });
    await assertOk(res, 'criar lead');
    out.push({ id: (await readJson<{ id: string }>(res)).id, name: p.name, phone: p.phone });
  }
  return out;
}

/** Uma despesa em cada festa dada e três despesas da empresa, no mês corrente. */
export async function expenses(lot: Lot, events: SeededEvent[]): Promise<string[]> {
  const today = dayPlus(0);
  const lines: string[] = [];
  const categories = ['Transporte', 'Lanche', 'Material'];
  for (let i = 0; i < events.length; i++) {
    const amount = 40 + i * 25;
    await addEventExpense(lot.api, events[i]!.id, amount, categories[i % categories.length]!, today);
    lines.push(`despesa da festa: ${categories[i % categories.length]} R$ ${amount},00`);
  }
  for (let i = 0; i < RECORDS_PER_FLOW; i++) {
    await addCompanyExpense(lot.api, 100 + i * 50, categories[i]!, today);
  }
  return lines;
}

export async function formLinks(lot: Lot, events: SeededEvent[]): Promise<string[]> {
  const out: string[] = [];
  for (const e of events) out.push((await apiIssueEventFormLink(lot.api, e.id)).url);
  return out;
}

/** Três orçamentos ENVIADOS de festa de dois dias (começa num dia e termina no seguinte). */
export async function multiDaySentBudgets(lot: Lot): Promise<SentBudget[]> {
  const [cs, acts] = [await clients(lot), await activities(lot)];
  const venues = lot.rng.take(VENUES, RECORDS_PER_FLOW);
  const out: SentBudget[] = [];
  for (let i = 0; i < RECORDS_PER_FLOW; i++) {
    const eventDate = dayPlus(30 + i * 7);
    const created = await apiCreateBudget(lot.api, {
      clientId: cs[i]!.id,
      activityIds: [acts[i]!.id],
      eventDate,
      eventEndDate: dayPlus(31 + i * 7),
      eventLocation: venues[i]!,
    });
    const sent = await apiSendBudget(lot.api, created.id);
    out.push({ id: created.id, clientName: cs[i]!.name, eventDate, venue: venues[i]!, activityName: acts[i]!.name, publicUrl: sent.publicUrl });
  }
  return out;
}

/** Três cláusulas na biblioteca, cada uma com a primeira versão ativa. */
export function clauses(lot: Lot): Promise<Named[]> {
  return lot.once('clauses', async () => {
    const titles = lot.rng.take(['Cancelamento e remarcação', 'Uso de imagem', 'Responsabilidade por danos', 'Forma de pagamento', 'Horário e duração'], RECORDS_PER_FLOW);
    const out: Named[] = [];
    for (let i = 0; i < titles.length; i++) {
      const title = `${titles[i]!} ${lot.id}`;
      const body = `Cláusula de ${titles[i]!.toLowerCase()} usada na massa de teste.`;
      const res = await lot.api.post('/api/clauses', {
        // `applicableTo` é flags e o DTO recebe o número (1 = pessoa física)
        data: { title, category: 'Geral', applicableTo: 1, isRequired: false, suggestedOrder: i + 1, bodyHtml: `<p>${body}</p>`, bodyPlain: body },
      });
      await assertOk(res, 'criar cláusula');
      const clause = await readJson<{ id: string }>(res);
      const version = await lot.api.post(`/api/clauses/${clause.id}/versions`, { data: { bodyHtml: `<p>${body}</p>`, bodyPlain: body } });
      await assertOk(version, 'emitir versão da cláusula');
      const issued = await readJson<{ id?: string; versionId?: string }>(version);
      await assertOk(await lot.api.post(`/api/clauses/${clause.id}/versions/${issued.id ?? issued.versionId}/activate`), 'ativar versão da cláusula');
      out.push({ id: clause.id, name: title });
    }
    return out;
  });
}

/** Três modelos de contrato em rascunho, cada um já com uma cláusula da biblioteca. */
export function contractTemplates(lot: Lot): Promise<Named[]> {
  return lot.once('contractTemplates', async () => {
    const library = await clauses(lot);
    const layouts = await lot.api.get('/api/contract-layouts');
    await assertOk(layouts, 'listar layouts de contrato');
    const body = (await layouts.json()) as { data?: Array<{ key: string }> | { items: Array<{ key: string }> } } | Array<{ key: string }>;
    const list = Array.isArray(body) ? body : Array.isArray(body.data) ? body.data : (body.data?.items ?? []);
    const layoutKey = list[0]?.key;
    if (!layoutKey) throw new Error('Catálogo de layouts de contrato vazio');
    const out: Named[] = [];
    for (let i = 0; i < RECORDS_PER_FLOW; i++) {
      const name = `Contrato de festa ${i + 1} ${lot.id}`;
      const res = await lot.api.post('/api/contract-templates', {
        data: { name, description: 'Modelo da massa de teste', type: 'ClientIndividual', layoutKey, header: 'Contrato de prestação de serviços', footer: lot.company.name, showLogo: true },
      });
      await assertOk(res, 'criar modelo de contrato');
      const template = await readJson<{ id: string }>(res);
      await assertOk(
        await lot.api.put(`/api/contract-templates/${template.id}/clauses`, { data: { clauses: [{ clauseId: library[i]!.id, order: 1 }] } }),
        'vincular cláusula ao modelo',
      );
      out.push({ id: template.id, name });
    }
    return out;
  });
}

/** Canal de WhatsApp da empresa conectado (número de teste), com os add-ons de WhatsApp e Conversas ligados. */
export function whatsappChannel(lot: Lot): Promise<string> {
  return lot.once('whatsappChannel', async () => {
    await feature(lot, 'feature_whatsapp');
    await feature(lot, 'feature_conversations');
    return seedConnectedWhatsappTenantDirect(lot.company.tenantId).phoneNumberId;
  });
}

/** Duas outras empresas no banco, para o painel da plataforma ter o que listar e para provar isolamento. */
export function extraCompanies(lot: Lot): Promise<Array<{ name: string; email: string; password: string }>> {
  return lot.once('extraCompanies', async () => {
    const out: Array<{ name: string; email: string; password: string }> = [];
    for (let i = 1; i <= 2; i++) {
      const [owner] = randomPeople(lot.rng, lot.id, 1, `outra${i}`);
      const name = randomCompanyName(lot.rng, `${lot.id}-${i}`);
      const anon = await createApiContext();
      try {
        await signupAndConfirm(anon, { companyName: name, adminName: owner!.name, adminEmail: owner!.email, adminPassword: LOT_PASSWORD });
      } finally {
        await anon.dispose();
      }
      lot.addLogin({ role: `Dono de OUTRA empresa: ${name}`, url: `${lot.frontUrl}/auth/login`, email: owner!.email, password: LOT_PASSWORD, note: 'não pode ver nada da empresa do lote' });
      out.push({ name, email: owner!.email, password: LOT_PASSWORD });
    }
    return out;
  });
}
