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

/**
 * Cria `count` entidades em lotes paralelos de `batchSize`, na ordem do
 * índice (1-based) — para pré-condição de "catálogo maior que uma página"
 * sem 150 requests em série nem 150 de uma vez contra o rate limit.
 */
export async function createInBatches<T>(
  count: number,
  create: (index: number) => Promise<T>,
  batchSize = 10,
): Promise<T[]> {
  const created: T[] = [];
  for (let start = 1; start <= count; start += batchSize) {
    const end = Math.min(count, start + batchSize - 1);
    const batch = await Promise.all(
      Array.from({ length: end - start + 1 }, (_, k) => create(start + k)),
    );
    created.push(...batch);
  }
  return created;
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

/** Insumo vinculado à atividade (`ActivityProductInputDto`). */
export interface ActivityProductInput {
  productId: string;
  qtyPerChild: number;
  isChecklistOnly: boolean;
}

/**
 * POST /api/activities. `activityProducts` vincula insumos: com
 * `feature_stock`, o aceite do orçamento reserva os consumíveis para o evento.
 */
export async function apiCreateActivity(
  api: APIRequestContext,
  overrides: Partial<ReturnType<typeof fakeActivity>> & { activityProducts?: ActivityProductInput[] } = {},
): Promise<CreatedEntity> {
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
      activityProducts: overrides.activityProducts ?? [],
    },
  });
  await expectOk(res, 'apiCreateActivity');
  const body = await res.json();
  return body.data ?? body;
}

/**
 * POST /api/products — produto consumível ativo, sem vínculo com atividade.
 * Nome único por `Date.now()` quando o teste não passa um.
 */
export async function apiCreateProduct(
  api: APIRequestContext,
  overrides: { name?: string; unitCost?: number; isReusable?: boolean } = {},
): Promise<CreatedEntity & { name: string }> {
  const res = await api.post('/api/products', {
    data: {
      name: overrides.name ?? `Produto E2E ${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      category: 'Materiais',
      unit: 'un',
      unitCost: overrides.unitCost ?? 1.5,
      isReusable: overrides.isReusable ?? false,
      activityProducts: [],
    },
  });
  await expectOk(res, 'apiCreateProduct');
  const body = await res.json();
  return body.data ?? body;
}

/**
 * POST /api/collaborators. `address` troca o endereço padrão (sem
 * coordenada) — por exemplo, por um com `latitude`/`longitude` para o
 * deslocamento medido pelo fake do Google.
 */
export async function apiCreateCollaborator(
  api: APIRequestContext,
  overrides: Partial<ReturnType<typeof fakeCollaborator>> & { address?: Record<string, unknown> } = {},
): Promise<CreatedEntity> {
  const fake = { ...fakeCollaborator(), ...overrides };
  const res = await api.post('/api/collaborators', {
    data: {
      name: fake.name,
      role: 'Recreador',
      email: fake.email,
      phone: fake.phone,
      address: overrides.address ?? fakeAddress(),
    },
  });
  await expectOk(res, 'apiCreateCollaborator');
  const body = await res.json();
  return body.data ?? body;
}

/**
 * POST /api/packages — pacote ATIVO com as atividades dadas (estratégia
 * `Calculated` sem desconto, 1 a 50 crianças), para o orçamento referenciar pelo `packageId`.
 * Nome único por `Date.now()`.
 */
export async function apiCreatePackage(
  api: APIRequestContext,
  input: { activityIds: string[]; name?: string },
): Promise<CreatedEntity & { name: string }> {
  const res = await api.post('/api/packages', {
    data: {
      name: input.name ?? `Pacote E2E ${Date.now()}`,
      minChildren: 1,
      maxChildren: 50,
      includedCollaborators: 2,
      pricingStrategy: 'Calculated',
      // `Calculated` exige o desconto (0 = soma das atividades sem abatimento).
      discountPercentage: 0,
      activities: input.activityIds.map((activityId) => ({ activityId, quantity: 1 })),
      status: 'Active',
    },
  });
  await expectOk(res, 'apiCreatePackage');
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
 * PUT /api/settings/parameters/{key} — grava o parâmetro do tenant (tela
 * Configurações → Parâmetros). O valor vai como texto, igual à tela; o back
 * converte pelo tipo do catálogo (`SettingDefinitions`).
 */
export async function apiSetSettingParameter(
  api: APIRequestContext,
  key: string,
  value: string | number,
): Promise<void> {
  const res = await api.put(`/api/settings/parameters/${key}`, { data: { value: String(value) } });
  await expectOk(res, `apiSetSettingParameter(${key})`);
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

/**
 * A habilidade do catálogo do tenant com este nome; cria se não existe. O
 * catálogo do tenant novo já nasce com as habilidades padrão (ex.: "Pintura
 * facial"), e o POST de uma delas é 409 `Skill.AlreadyExists`.
 */
export async function apiFindOrCreateSkill(
  api: APIRequestContext,
  name: string,
): Promise<CreatedEntity & { name: string }> {
  const res = await api.get('/api/skills');
  await expectOk(res, 'GET /api/skills');
  const body = await res.json();
  const data = body.data ?? body;
  const items = (Array.isArray(data) ? data : (data.items ?? [])) as Array<CreatedEntity & { name: string }>;
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '').toLowerCase();
  const found = items.find((s) => norm(s.name) === norm(name));
  return found ?? (await apiCreateSkill(api, { name }));
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

/**
 * PUT /api/ai/features/{code} — liga/desliga um card de IA do tenant (Central
 * de IA). Exige `feature_ai` no tenant (`enableFeatureFlagDirect`).
 */
export async function apiSetAiFeature(
  api: APIRequestContext,
  code: string,
  enabled: boolean,
  configJson: string | null = null,
): Promise<void> {
  const res = await api.put(`/api/ai/features/${code}`, { data: { enabled, configJson } });
  await expectOk(res, `apiSetAiFeature(${code})`);
}

/**
 * PUT /api/stock/locations/{id} trocando só o que o teste passa (endereço,
 * nome): lê o detalhe e regrava os demais campos como estão. Exige
 * `feature_stock`. O Local Principal ignora tipo e responsável na mutação.
 */
export async function apiUpdateStockLocation(
  api: APIRequestContext,
  locationId: string,
  changes: { name?: string; address?: Record<string, unknown> | null },
): Promise<void> {
  const getRes = await api.get(`/api/stock/locations/${locationId}`);
  await expectOk(getRes, 'GET /api/stock/locations/{id}');
  const body = await getRes.json();
  const current = (body.data ?? body) as {
    name: string;
    type: string;
    collaboratorId: string | null;
    address: Record<string, unknown> | null;
    notes: string | null;
    status: string;
  };
  const res = await api.put(`/api/stock/locations/${locationId}`, {
    data: {
      name: changes.name ?? current.name,
      type: current.type,
      collaboratorId: current.collaboratorId,
      address: changes.address !== undefined ? changes.address : current.address,
      notes: current.notes,
      status: current.status,
    },
  });
  await expectOk(res, 'apiUpdateStockLocation');
}

/**
 * PUT /api/events/{eventId}/departure-location — de onde sai o material da
 * festa (Etapa 219); `null` volta ao local da reserva. Exige `feature_stock`.
 */
export async function apiSetEventDepartureLocation(
  api: APIRequestContext,
  eventId: string,
  stockLocationId: string | null,
): Promise<void> {
  const res = await api.put(`/api/events/${eventId}/departure-location`, { data: { stockLocationId } });
  await expectOk(res, 'apiSetEventDepartureLocation');
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

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  message: string;
  contextEntityType: string | null;
  contextEntityId: string | null;
  createdAt: string;
}

/** GET /api/notifications — as do usuário do contexto (o sino), as 50 mais recentes. */
export async function apiListNotifications(api: APIRequestContext): Promise<NotificationItem[]> {
  const res = await api.get('/api/notifications?pageSize=50');
  await expectOk(res, 'apiListNotifications');
  const body = await res.json();
  const data = body.data ?? body;
  return (Array.isArray(data) ? data : data.items) as NotificationItem[];
}
