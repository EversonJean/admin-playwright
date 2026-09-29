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
export async function apiCreateClient(
  api: APIRequestContext,
  overrides: Partial<ReturnType<typeof fakeClient>> & { type?: 'PF' | 'PJ' } = {},
): Promise<CreatedEntity> {
  const fake = { ...fakeClient(), ...overrides };
  const res = await api.post('/api/clients', {
    data: {
      type: overrides.type ?? 'PF',
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
      // DTO atual exige a lista (vazia = atividade sem insumos vinculados).
      activityProducts: [],
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

/**
 * POST /api/company/complete-onboarding — marca a configuração inicial como
 * concluída. Sem isto, o `onboardingGuard` do front (Etapa 109) manda o tenant
 * recém-criado para `/app/onboarding` a cada `page.goto` (o "uma vez por
 * sessão" dele reinicia a cada carga de página) e o spec de UI nunca vê a tela
 * que pediu. Tenant novo está em período de teste: não exige documento.
 */
export async function apiCompleteOnboarding(api: APIRequestContext): Promise<void> {
  const res = await api.post('/api/company/complete-onboarding');
  await expectOk(res, 'apiCompleteOnboarding');
}

/**
 * POST /api/skills — habilidade do catálogo do tenant (Etapa 192). Nome único
 * por `Date.now()`: o back recusa duplicata ignorando maiúsculas, acentos e
 * espaços, então dois testes com o mesmo prefixo fixo colidiriam.
 */
export async function apiCreateSkill(
  api: APIRequestContext,
  overrides: { name?: string; description?: string | null } = {},
): Promise<CreatedEntity & { name: string }> {
  const res = await api.post('/api/skills', {
    data: {
      name: overrides.name ?? `Habilidade E2E ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      description: overrides.description ?? null,
    },
  });
  await expectOk(res, 'apiCreateSkill');
  const body = await res.json();
  return body.data ?? body;
}

/** POST /api/collaborators/:id/skills — vincula uma habilidade do catálogo ao colaborador. */
export async function apiAddCollaboratorSkill(
  api: APIRequestContext,
  collaboratorId: string,
  skillId: string,
): Promise<CreatedEntity & { skillId: string }> {
  const res = await api.post(`/api/collaborators/${collaboratorId}/skills`, { data: { skillId } });
  await expectOk(res, 'apiAddCollaboratorSkill');
  const body = await res.json();
  return body.data ?? body;
}

/**
 * POST /api/contact-identities — identidade de contato com um ou mais
 * WhatsApps (Etapa 68). Exige `feature_leads` ou `feature_whatsapp` no tenant.
 * O primeiro telefone da lista é o primário.
 */
export async function apiCreateContactIdentity(
  api: APIRequestContext,
  input: { displayName?: string; whatsappPhones: string[] },
): Promise<CreatedEntity & { displayName: string }> {
  const res = await api.post('/api/contact-identities', {
    data: {
      displayName: input.displayName ?? `Contato E2E ${Date.now()}`,
      source: 'Manual',
      isKnown: true,
      clientId: null,
      tags: null,
      notes: null,
      points: input.whatsappPhones.map((value, i) => ({
        type: 'Whatsapp',
        value,
        isPrimary: i === 0,
        consentStatus: null,
        isVerified: null,
      })),
    },
  });
  await expectOk(res, 'apiCreateContactIdentity');
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
