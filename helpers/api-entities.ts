import { APIRequestContext } from '@playwright/test';
import {
  fakeActivity,
  fakeClient,
  fakeCollaborator,
  fakeAddress,
} from './test-data';

/**
 * Helpers pra criar entidades via API autenticada — usados em testes de fluxos
 * que precisam dados precondicionais (ex: orçamento exige cliente + atividades).
 *
 * Lançam erro descritivo se a request falhar — ajuda a diagnosticar quando a
 * rota muda ou validators ficam mais estritos.
 */

async function expectOk(res: { ok: () => boolean; status: () => number; text: () => Promise<string> }, op: string) {
  if (!res.ok()) {
    throw new Error(`${op} falhou (${res.status()}): ${await res.text()}`);
  }
}

export interface CreatedEntity {
  id: string;
  [key: string]: unknown;
}

/** POST /api/clients */
export async function apiCreateClient(api: APIRequestContext, overrides: Partial<ReturnType<typeof fakeClient>> = {}): Promise<CreatedEntity> {
  const fake = { ...fakeClient(), ...overrides };
  const res = await api.post('/api/clients', {
    data: {
      name: fake.name,
      email: fake.email,
      phone: fake.phone,
      document: fake.document,
      address: fakeAddress(),
    },
  });
  await expectOk(res, 'apiCreateClient');
  const body = await res.json();
  return body.data ?? body;
}

/** POST /api/activities */
export async function apiCreateActivity(api: APIRequestContext, overrides: Partial<ReturnType<typeof fakeActivity>> = {}): Promise<CreatedEntity> {
  const fake = { ...fakeActivity(), ...overrides };
  const res = await api.post('/api/activities', {
    data: {
      name: fake.name,
      category: 'Recreação',
      description: fake.description,
      durationMinutes: fake.durationMinutes,
      pricePerChild: fake.pricePerChild,
      minChildren: fake.minChildren,
      maxChildren: fake.maxChildren,
      minAge: fake.minAgeYears,
      maxAge: fake.maxAgeYears,
    },
  });
  await expectOk(res, 'apiCreateActivity');
  const body = await res.json();
  return body.data ?? body;
}

/** POST /api/collaborators */
export async function apiCreateCollaborator(api: APIRequestContext, overrides: Partial<ReturnType<typeof fakeCollaborator>> = {}): Promise<CreatedEntity> {
  const fake = { ...fakeCollaborator(), ...overrides };
  const res = await api.post('/api/collaborators', {
    data: {
      name: fake.name,
      role: 'Recreador',
      email: fake.email,
      phone: fake.phone,
      address: fakeAddress(),
    },
  });
  await expectOk(res, 'apiCreateCollaborator');
  const body = await res.json();
  return body.data ?? body;
}

/** GET /api/clients — útil pra validar listagem após criar */
export async function apiListClients(api: APIRequestContext): Promise<{ items: CreatedEntity[] }> {
  const res = await api.get('/api/clients');
  await expectOk(res, 'apiListClients');
  const body = await res.json();
  return body.data ?? body;
}

/** GET /api/activities */
export async function apiListActivities(api: APIRequestContext): Promise<{ items: CreatedEntity[] }> {
  const res = await api.get('/api/activities');
  await expectOk(res, 'apiListActivities');
  const body = await res.json();
  return body.data ?? body;
}

/** GET /api/collaborators */
export async function apiListCollaborators(api: APIRequestContext): Promise<{ items: CreatedEntity[] }> {
  const res = await api.get('/api/collaborators');
  await expectOk(res, 'apiListCollaborators');
  const body = await res.json();
  return body.data ?? body;
}
