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

export const fakeCollaborator = () => {
  const id = shortId();
  return {
    name: `Recreador ${id}`,
    email: `recreador-${id}@e2e.test`,
    phone: '41988888888',
    document: '98765432100',
  };
};

export const fakeAddress = () => ({
  zipCode: '80010100',
  street: 'Rua das Flores',
  number: '123',
  complement: 'Apto 45',
  neighborhood: 'Centro',
  city: 'Curitiba',
  state: 'PR',
});
