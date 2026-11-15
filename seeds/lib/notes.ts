import {
  activities,
  clients,
  collaborators,
  companySheet,
  inputPeople,
  Named,
  packages,
  partners,
  personSheet,
  portalUsers,
  products,
  RECORDS_PER_FLOW,
  roleUsers,
  skills,
} from './builders';
import { Lot } from './lot';

/**
 * Anotações do relatório do lote: o que cada fluxo recebeu, no nome que a
 * pessoa vê na tela. Cada função garante o cadastro (cria se ainda não existe
 * no lote) e anota no fluxo em carga.
 */

export function noteNamed(lot: Lot, kind: string, list: Named[], detail: (item: Named, i: number) => string = () => 'já cadastrado'): void {
  list.forEach((item, i) => lot.note(`${kind} ${i + 1}: ${item.name}`, detail(item, i)));
}

export async function noteClients(lot: Lot): Promise<void> {
  (await clients(lot)).forEach((c, i) => lot.note(`Cliente ${i + 1}: ${c.name}`, personSheet(c)));
}

export async function noteActivities(lot: Lot): Promise<void> {
  (await activities(lot)).forEach((a, i) => lot.note(`Atividade ${i + 1}: ${a.name}`, `R$ ${a.pricePerChild},00 por criança`));
}

export async function noteProducts(lot: Lot): Promise<void> {
  noteNamed(lot, 'Produto', await products(lot));
}

export async function notePackages(lot: Lot): Promise<void> {
  noteNamed(lot, 'Pacote', await packages(lot), () => 'ativo, com duas atividades');
}

export async function notePartners(lot: Lot): Promise<void> {
  (await partners(lot)).forEach((p, i) => lot.note(`Parceiro ${i + 1}: ${p.name}`, `CNPJ ${p.cnpj} · categoria Buffet`));
}

export async function noteCollaborators(lot: Lot): Promise<void> {
  (await collaborators(lot)).forEach((c, i) => lot.note(`Colaborador ${i + 1}: ${c.name}`, `E-mail: ${c.email} · Celular: ${c.phone}`));
}

export async function noteSkills(lot: Lot): Promise<void> {
  (await skills(lot)).forEach((s, i) => lot.note(`Habilidade ${i + 1}: ${s.name}`, `já vinculada a ${s.collaboratorName}`));
}

/** Um usuário de cada perfil interno; o login também vai para "Como entrar". */
export async function noteRoleUsers(lot: Lot): Promise<void> {
  (await roleUsers(lot)).forEach((u) => lot.note(`Usuário com perfil ${u.role}`, `Login: ${u.email} · Senha: ${u.password}`));
}

export async function notePortalUsers(lot: Lot): Promise<void> {
  (await portalUsers(lot)).forEach((u) => lot.note(`Acesso ao Portal de ${u.name}`, `Login: ${u.email} · Senha: ${u.password}`));
}

/** Três pessoas sorteadas para DIGITAR no formulário (nada vai para o banco). */
export function notePeopleSheets(lot: Lot, kind: string, tag: string, extra: (i: number) => string = () => ''): void {
  inputPeople(lot, tag).forEach((p, i) => {
    const more = extra(i);
    lot.note(`Ficha ${i + 1} para digitar (${kind})`, `${personSheet(p)}${more ? ` · ${more}` : ''}`);
  });
}

/** Três empresas sorteadas para DIGITAR num cadastro de empresa. */
export function noteCompanySheets(lot: Lot): void {
  for (let i = 1; i <= RECORDS_PER_FLOW; i++) lot.note(`Ficha ${i} para digitar (empresa nova)`, companySheet(lot, i));
}

/** A própria empresa do lote, para os fluxos que só precisam estar logados. */
export function noteCompany(lot: Lot): void {
  lot.note(`Empresa do lote: ${lot.company.name}`, `Dono: ${lot.company.adminName} · Login: ${lot.company.email} · Senha: ${lot.company.password}`);
}
