import { randomBytes } from 'crypto';

/**
 * Factories de dados fake para testes E2E.
 * Cada chamada produz um valor único — evita colisões entre testes paralelos.
 */

function shortId(): string {
  return randomBytes(4).toString('hex'); // 8 chars
}

export const fakeTenant = () => {
  const id = shortId();
  return {
    companyName: `Festinha ${id}`,
    subdomain: `festinha-${id}`,
    adminEmail: `admin-${id}@e2e.test`,
    adminPassword: 'Test@12345',
    adminName: `Admin ${id}`,
  };
};

export const fakeClient = () => {
  const id = shortId();
  return {
    name: `Cliente ${id}`,
    email: `cliente-${id}@e2e.test`,
    phone: '41999999999',
    document: '12345678909', // CPF de teste válido
  };
};

export const fakeActivity = () => {
  const id = shortId();
  return {
    name: `Pula-pula ${id}`,
    description: 'Atividade de teste E2E',
    durationMinutes: 60,
    pricePerChild: 50,
    minChildren: 5,
    maxChildren: 30,
    minAgeYears: 3,
    maxAgeYears: 12,
  };
};

/**
 * Celular de Curitiba com 8 digitos aleatorios (`419XXXXXXXX`). Desde a Etapa
 * 239 o telefone e unico entre colaboradores ativos do tenant: um fixo fazia o
 * segundo colaborador do mesmo tenant tomar 409 `Collaborator.PhoneInUse`.
 */
export function uniqueMobilePhone(): string {
  const digits = (randomBytes(4).readUInt32BE(0) % 100_000_000).toString().padStart(8, '0');
  return `419${digits}`;
}

export const fakeCollaborator = () => {
  const id = shortId();
  return {
    name: `Recreador ${id}`,
    email: `recreador-${id}@e2e.test`,
    phone: uniqueMobilePhone(),
    document: '98765432100',
  };
};

/** Dígito verificador de CPF/CNPJ (módulo 11) sobre `digits` com os `weights`. */
function mod11Digit(digits: number[], weights: number[]): number {
  const sum = digits.reduce((acc, d, i) => acc + d * weights[i]!, 0);
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}

function randomDigits(count: number): number[] {
  const bytes = randomBytes(count);
  return Array.from(bytes, (b) => b % 10);
}

/**
 * CPF válido e aleatório, só dígitos (11). Para o teste que procura o cliente
 * PELO documento: com o `12345678909` fixo do `fakeClient`, todo cliente do
 * banco E2E teria o mesmo e a busca não distinguiria nada.
 */
export function fakeCpf(): string {
  let base = randomDigits(9);
  while (base.every((d) => d === base[0])) base = randomDigits(9);
  const d1 = mod11Digit(base, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = mod11Digit([...base, d1], [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return [...base, d1, d2].join('');
}

/** CNPJ válido e aleatório (matriz `0001`), só dígitos (14). */
export function fakeCnpj(): string {
  const base = [...randomDigits(8), 0, 0, 0, 1];
  const d1 = mod11Digit(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = mod11Digit([...base, d1], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return [...base, d1, d2].join('');
}

/** `12345678909` → `123.456.789-09`. */
export function formatCpf(cpf: string): string {
  return cpf.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
}

/** `11222333000181` → `11.222.333/0001-81`. */
export function formatCnpj(cnpj: string): string {
  return cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

export const fakeAddress = () => ({
  zipCode: '80010100',
  street: 'Rua das Flores',
  number: '123',
  complement: 'Apto 45',
  neighborhood: 'Centro',
  city: 'Curitiba',
  state: 'PR',
});
