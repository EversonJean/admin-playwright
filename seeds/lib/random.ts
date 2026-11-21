import { randomBytes } from 'crypto';

/**
 * Dados sorteados da massa de teste manual: nomes que uma pessoa reconhece
 * ("Ana Souza", "Pintura facial"), e não os `Cliente 3fa9c1` do e2e.
 *
 * O sorteio sai de um gerador com semente (o id do lote): duas cargas nunca
 * repetem os dados, e a mesma semente (`--lot <id>`) refaz a mesma carga.
 */

export interface Rng {
  /** Número em [0, 1). */
  next(): number;
  /** Inteiro em [min, max], pontas incluídas. */
  int(min: number, max: number): number;
  pick<T>(list: readonly T[]): T;
  /** `count` itens distintos, em ordem sorteada. */
  take<T>(list: readonly T[], count: number): T[];
  digits(count: number): string;
}

/** Id curto do lote (6 hex): entra no nome da empresa e nos e-mails. */
export function newLotId(): string {
  return randomBytes(3).toString('hex');
}

/** mulberry32 sobre a semente em hex. */
export function createRng(seedHex: string): Rng {
  let state = parseInt(seedHex.slice(0, 8), 16) >>> 0 || 0x9e3779b9;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const take = <T>(list: readonly T[], count: number): T[] => {
    const pool = [...list];
    const out: T[] = [];
    while (out.length < count && pool.length > 0) out.push(pool.splice(int(0, pool.length - 1), 1)[0]!);
    return out;
  };
  return {
    next,
    int,
    pick: (list) => list[int(0, list.length - 1)]!,
    take,
    digits: (count) => Array.from({ length: count }, () => int(0, 9)).join(''),
  };
}

const FIRST_NAMES = [
  'Ana', 'Bruno', 'Carla', 'Diego', 'Elisa', 'Fábio', 'Gabriela', 'Heitor', 'Isabela', 'João',
  'Karina', 'Lucas', 'Mariana', 'Nicolas', 'Olívia', 'Paulo', 'Rafaela', 'Sérgio', 'Tatiane', 'Vinícius',
  'Yasmin', 'André', 'Beatriz', 'Caio', 'Daniela', 'Eduardo', 'Fernanda', 'Gustavo', 'Helena', 'Igor',
] as const;

const LAST_NAMES = [
  'Souza', 'Oliveira', 'Santos', 'Pereira', 'Lima', 'Carvalho', 'Ferreira', 'Ribeiro', 'Almeida', 'Costa',
  'Gomes', 'Martins', 'Araújo', 'Barbosa', 'Rocha', 'Dias', 'Teixeira', 'Moreira', 'Cardoso', 'Nunes',
] as const;

const COMPANY_WORDS = [
  'Girassol', 'Arco-Íris', 'Pipoca', 'Balão Mágico', 'Algodão Doce', 'Cata-Vento', 'Estrelinha',
  'Carrossel', 'Brincar', 'Pé de Moleque', 'Bambolê', 'Peteca', 'Amarelinha', 'Ciranda',
] as const;

export const ACTIVITY_NAMES = [
  'Pintura facial', 'Escultura de balões', 'Caça ao tesouro', 'Oficina de slime', 'Gincana maluca',
  'Show de mágica', 'Contação de histórias', 'Circuito de obstáculos', 'Oficina de pipas', 'Karaokê kids',
  'Futebol de sabão', 'Bolhas gigantes', 'Dança das cadeiras', 'Teatro de fantoches', 'Oficina de cupcake',
] as const;

export const PRODUCT_NAMES = [
  'Tinta facial', 'Balão canudo', 'Glitter', 'Cola branca', 'Papel crepom', 'Fita adesiva colorida',
  'Bambolê', 'Corda de pular', 'Giz de cera', 'Massinha de modelar', 'Copo descartável', 'Bexiga nº 9',
] as const;

export const PACKAGE_NAMES = [
  'Pacote Festa Completa', 'Pacote Mini Festa', 'Pacote Aventura', 'Pacote Artes', 'Pacote Esportes',
  'Pacote Premium', 'Pacote Escola', 'Pacote Fim de Semana',
] as const;

export const SKILL_NAMES = [
  'Malabarismo', 'Violão', 'Primeiros socorros', 'Animação de palco', 'Libras', 'Maquiagem artística',
  'Recreação aquática', 'Mágica de salão',
] as const;

export const EVENT_CATEGORY_NAMES = [
  'Aniversário infantil', 'Festa de formatura', 'Confraternização', 'Dia das crianças', 'Festa junina',
  'Colônia de férias', 'Chá revelação',
] as const;

export const PARTNER_NAMES = [
  'Buffet Castelo', 'Salão Jardim Encantado', 'Espaço Trampolim', 'Colégio Pequeno Mundo',
  'Shopping Vila Verde', 'Clube Recanto', 'Buffet Doce Infância',
] as const;

export const VENUES = [
  'Salão de festas do condomínio Araucária', 'Chácara Recanto Feliz', 'Buffet Castelo, sala 2',
  'Casa do cliente, bairro Água Verde', 'Clube Recreativo Batel', 'Parque Barigui, churrasqueira 4',
  'Salão paroquial São José', 'Espaço Trampolim, Portão',
] as const;

const STREETS = [
  'Rua das Flores', 'Avenida Sete de Setembro', 'Rua XV de Novembro', 'Rua Padre Anchieta',
  'Avenida República Argentina', 'Rua Mateus Leme', 'Rua Itupava', 'Avenida Iguaçu',
] as const;

const NEIGHBORHOODS = ['Centro', 'Batel', 'Água Verde', 'Portão', 'Cabral', 'Juvevê', 'Bigorrilho', 'Santa Felicidade'] as const;

/** Sem acento e sem espaço, para e-mail. */
function slug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.|\.$/g, '');
}

function mod11Digit(digits: number[], weights: number[]): number {
  const rest = digits.reduce((acc, d, i) => acc + d * weights[i]!, 0) % 11;
  return rest < 2 ? 0 : 11 - rest;
}

/** CPF válido, só dígitos. */
export function randomCpf(rng: Rng): string {
  let base = rng.digits(9).split('').map(Number);
  while (base.every((d) => d === base[0])) base = rng.digits(9).split('').map(Number);
  const d1 = mod11Digit(base, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = mod11Digit([...base, d1], [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return [...base, d1, d2].join('');
}

/** CNPJ válido (matriz 0001), só dígitos. */
export function randomCnpj(rng: Rng): string {
  const base = [...rng.digits(8).split('').map(Number), 0, 0, 0, 1];
  const d1 = mod11Digit(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = mod11Digit([...base, d1], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return [...base, d1, d2].join('');
}

/** Celular de Curitiba, só dígitos (`419XXXXXXXX`). */
export function randomMobile(rng: Rng): string {
  return `419${rng.digits(8)}`;
}

export interface Person {
  name: string;
  email: string;
  phone: string;
  cpf: string;
}

/** `count` pessoas com nomes distintos; o e-mail leva o id do lote (único no banco). */
export function randomPeople(rng: Rng, lotId: string, count: number, emailTag = ''): Person[] {
  const firsts = rng.take(FIRST_NAMES, count);
  return firsts.map((first, i) => {
    const last = rng.pick(LAST_NAMES);
    const name = `${first} ${last}`;
    return {
      name,
      email: `${slug(name)}${emailTag ? `.${emailTag}` : ''}.${lotId}${i + 1}@massa.test`,
      phone: randomMobile(rng),
      cpf: randomCpf(rng),
    };
  });
}

export function randomCompanyName(rng: Rng, lotId: string): string {
  return `Recreação ${rng.pick(COMPANY_WORDS)} ${lotId}`;
}

export function randomAddress(rng: Rng): Record<string, string> {
  return {
    zipCode: '80010100',
    street: rng.pick(STREETS),
    number: String(rng.int(10, 2500)),
    complement: '',
    neighborhood: rng.pick(NEIGHBORHOODS),
    city: 'Curitiba',
    state: 'PR',
  };
}

/** Data (YYYY-MM-DD) de hoje + `days`. */
export function dayPlus(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** `2026-11-29` → `29/11/2026`, como a tela mostra. */
export function brDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
