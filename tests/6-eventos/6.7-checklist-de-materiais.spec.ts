import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { setupAcceptedEvent } from '../../helpers/setup-flows';
import { apiCreateClient } from '../../helpers/api-entities';
import {
  apiAcceptPublicBudget,
  apiCreateBudget,
  apiSendBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';
import type { APIRequestContext } from '@playwright/test';

/**
 * Fluxo: 6.7 — Checklist de materiais da festa (Etapas 178-180)
 * Diagrama: docs/fluxos/negocio-6.7-checklist-de-materiais.mmd
 *
 * Roteiro do §12 do `PLANO-CHECKLIST-DE-MATERIAIS-DO-EVENTO.md`, na parte que
 * roda sem UI: o que o gestor vê ao abrir a aba nasce do CADASTRO, e o que a
 * equipe acrescenta à mão ensina a atividade.
 *
 * 🔑 A asserção que dá sentido à etapa é a primeira: um produto vinculado a
 * DUAS atividades da mesma festa vira DOIS itens, um por oficina. A aba
 * Materiais soma por produto (é a pergunta de quem compra); aqui a pergunta é
 * "o que a Oficina de Slime precisa?", que é a de quem separa na véspera.
 */

interface ChecklistItem {
  id: string;
  title: string;
  quantity: number | null;
  source: 'System' | 'Manager' | 'Collaborator';
  status: 'Pending' | 'Checked' | 'Skipped';
  productId: string | null;
  suggestionId: string | null;
}

interface ChecklistGroup {
  activityId: string;
  activityName: string;
  isInEvent: boolean;
  total: number;
  checked: number;
  items: ChecklistItem[];
}

interface Checklist {
  total: number;
  checked: number;
  pending: number;
  completionPercent: number;
  hasActivities: boolean;
  groups: ChecklistGroup[];
}

async function unwrap<T>(res: { ok(): boolean; status(): number; json(): Promise<unknown>; text(): Promise<string> }, what: string): Promise<T> {
  if (!res.ok()) {
    throw new Error(`${what} → ${res.status()}: ${await res.text()}`);
  }
  const body = (await res.json()) as { data?: T };
  return (body.data ?? (body as unknown)) as T;
}

/** Produto do catálogo já vinculado às atividades informadas. */
async function createLinkedProduct(
  api: APIRequestContext,
  name: string,
  links: { activityId: string; qtyPerChild: number; isChecklistOnly: boolean }[],
): Promise<{ id: string }> {
  const res = await api.post('/api/products', {
    data: {
      name: `${name} ${Date.now()}`,
      category: 'Papelaria',
      unit: 'L',
      unitCost: 10,
      isReusable: false,
      activityProducts: links,
    },
  });
  return unwrap<{ id: string }>(res, 'POST /api/products');
}

/**
 * Segunda festa com a MESMA atividade.
 *
 * 🔑 `setupAcceptedEvent` cria uma atividade nova a cada chamada — usá-lo duas
 * vezes daria duas oficinas diferentes, e o item extra da segunda seria
 * recusado por `MaterialChecklist.ActivityNotInEvent`. A recorrência que a
 * Etapa 180 conta é por ATIVIDADE: sem reusar a mesma, não há o que aprender.
 */
async function secondEventWithSameActivity(
  api: APIRequestContext,
  activityId: string,
): Promise<string> {
  const cliente = await apiCreateClient(api);
  const orcamento = await apiCreateBudget(api, {
    clientId: cliente.id,
    activityIds: [activityId],
  });
  const sent = await apiSendBudget(api, orcamento.id);
  const publicApi = await createPublicApiContext();
  try {
    const aceito = await apiAcceptPublicBudget(
      publicApi,
      extractTokenFromPublicUrl(sent.publicUrl),
    );
    return aceito.eventId;
  } finally {
    await publicApi.dispose();
  }
}

function getChecklist(api: APIRequestContext, eventId: string): Promise<Checklist> {
  return api
    .get(`/api/events/${eventId}/material-checklist`)
    .then((r) => unwrap<Checklist>(r, 'GET material-checklist'));
}

test.describe('Fluxo 6.7 — Checklist de materiais da festa', () => {
  test('@flow aba do evento carrega autenticada', async ({ authPage, authApi }) => {
    const { eventId } = await setupAcceptedEvent(authApi);
    await smokeRoute(authPage, `/app/events/${eventId}`);
  });

  // 🔑 O teste que separa esta etapa da previsão de material da aba Materiais.
  test('@crud lista nasce do cadastro, um item por atividade e produto', async ({ authApi }) => {
    const { eventId, atividadeId } = await setupAcceptedEvent(authApi);

    await createLinkedProduct(authApi, 'Cola branca E2E', [
      { activityId: atividadeId, qtyPerChild: 0.1, isChecklistOnly: false },
    ]);
    await createLinkedProduct(authApi, 'Bacia E2E', [
      { activityId: atividadeId, qtyPerChild: 0, isChecklistOnly: true },
    ]);

    const checklist = await getChecklist(authApi, eventId);

    expect(checklist.hasActivities).toBe(true);
    expect(checklist.groups.length).toBe(1);

    const grupo = checklist.groups[0];
    expect(grupo.activityId).toBe(atividadeId);
    expect(grupo.items.length).toBe(2);
    expect(grupo.items.every((i) => i.source === 'System')).toBe(true);

    // Consumível ganha quantidade calculada; só-checklist nasce sem.
    const cola = grupo.items.find((i) => i.title.startsWith('Cola branca'))!;
    const bacia = grupo.items.find((i) => i.title.startsWith('Bacia'))!;
    expect(cola.quantity).toBeGreaterThan(0);
    expect(bacia.quantity).toBeNull();
  });

  test('@crud o gestor marca e o progresso vem do back', async ({ authApi }) => {
    const { eventId, atividadeId } = await setupAcceptedEvent(authApi);
    await createLinkedProduct(authApi, 'Cola branca E2E', [
      { activityId: atividadeId, qtyPerChild: 0.1, isChecklistOnly: false },
    ]);

    const antes = await getChecklist(authApi, eventId);
    const item = antes.groups[0].items[0];
    expect(antes.completionPercent).toBe(0);

    const marcou = await authApi.post(
      `/api/events/${eventId}/material-checklist/items/${item.id}/check`,
      { data: {} },
    );
    expect(marcou.ok(), `check → ${marcou.status()}`).toBe(true);

    const depois = await getChecklist(authApi, eventId);
    expect(depois.completionPercent).toBe(100);
    expect(depois.groups[0].items[0].status).toBe('Checked');
  });

  // 🚨 Item de cadastro volta no próximo sync: removê-lo daria a impressão de
  // que o botão não funciona. "Não levar" é a saída, e ela sobrevive ao sync.
  test('@crud item de sistema não é removível; "não levar" é', async ({ authApi }) => {
    const { eventId, atividadeId } = await setupAcceptedEvent(authApi);
    await createLinkedProduct(authApi, 'Cola branca E2E', [
      { activityId: atividadeId, qtyPerChild: 0.1, isChecklistOnly: false },
    ]);

    const checklist = await getChecklist(authApi, eventId);
    const item = checklist.groups[0].items[0];

    const remocao = await authApi.delete(
      `/api/events/${eventId}/material-checklist/items/${item.id}`,
    );
    expect(remocao.status(), 'item de sistema recusa DELETE').toBe(409);

    const skip = await authApi.post(
      `/api/events/${eventId}/material-checklist/items/${item.id}/skip`,
      { data: { reason: 'o cliente leva o dele' } },
    );
    expect(skip.ok(), `skip → ${skip.status()}`).toBe(true);

    const depois = await getChecklist(authApi, eventId);
    expect(depois.groups[0].items[0].status).toBe('Skipped');
    // "Não levar" conta como resolvido — barra que nunca fecha é barra ignorada.
    expect(depois.completionPercent).toBe(100);
    expect(depois.pending).toBe(0);
  });

  test('@crud item extra exige atividade do evento', async ({ authApi }) => {
    const { eventId, atividadeId } = await setupAcceptedEvent(authApi);

    const fora = await authApi.post(`/api/events/${eventId}/material-checklist/items`, {
      data: { activityId: '11111111-2222-3333-4444-555555555555', title: 'Lona azul' },
    });
    expect(fora.status(), 'atividade fora do evento é recusada').toBe(400);

    const dentro = await authApi.post(`/api/events/${eventId}/material-checklist/items`, {
      data: { activityId: atividadeId, title: 'Lona azul', quantity: 1, unit: 'un' },
    });
    expect(dentro.ok(), `add → ${dentro.status()}`).toBe(true);

    const checklist = await getChecklist(authApi, eventId);
    const extra = checklist.groups[0].items.find((i) => i.title === 'Lona azul');
    expect(extra).toBeTruthy();
    expect(extra!.source).toBe('Manager');
  });

  // 🔑 O aprendizado: o mesmo item em DUAS festas da mesma atividade vira
  // sugestão recorrente; aceitar cria o vínculo e a próxima festa já nasce com
  // ele. É o "o sistema analisa e leva aos próximos eventos" do pedido.
  test('@crud item extra em duas festas vira vínculo da atividade', async ({ authApi }) => {
    const primeira = await setupAcceptedEvent(authApi);
    const atividadeId = primeira.atividadeId;

    // 🚨 As duas adições são ASSERTADAS. A primeira versão deste teste não as
    // checava e passou a medir a coisa errada: o segundo POST devolvia 400
    // (atividade de outra festa) e a contagem nunca chegava a dois.
    const add1 = await authApi.post(`/api/events/${primeira.eventId}/material-checklist/items`, {
      data: { activityId: atividadeId, title: 'Fita crepe', quantity: 20, unit: 'un' },
    });
    expect(add1.ok(), `add festa 1 → ${add1.status()}`).toBe(true);

    const segundoEventId = await secondEventWithSameActivity(authApi, atividadeId);
    const add2 = await authApi.post(`/api/events/${segundoEventId}/material-checklist/items`, {
      data: { activityId: atividadeId, title: 'Fita crepe', quantity: 20, unit: 'un' },
    });
    expect(add2.ok(), `add festa 2 → ${add2.status()}`).toBe(true);

    const sugestoes = await authApi
      .get(`/api/activities/${atividadeId}/material-suggestions?status=Pending`)
      .then((r) => unwrap<{ id: string; title: string; occurrences: number; isRecurring: boolean }[]>(
        r, 'GET material-suggestions'));

    const fita = sugestoes.find((s) => s.title === 'Fita crepe');
    expect(fita, 'a sugestão nasce da segunda ocorrência').toBeTruthy();
    expect(fita!.occurrences).toBeGreaterThanOrEqual(2);
    expect(fita!.isRecurring).toBe(true);

    // Aceitar exige um produto do catálogo — o gestor escolhe ou cria.
    const produto = await createLinkedProduct(authApi, 'Fita crepe E2E', []);
    const aceite = await authApi.post(
      `/api/activities/material-suggestions/${fita!.id}/accept`,
      { data: { productId: produto.id, qtyPerChild: 1, isChecklistOnly: false } },
    );
    expect(aceite.ok(), `accept → ${aceite.status()}: ${await aceite.text()}`).toBe(true);

    // A festa futura passa a ter o item como CADASTRO, sem duplicar o extra.
    const checklist = await getChecklist(authApi, segundoEventId);
    const fitas = checklist.groups
      .flatMap((g) => g.items)
      .filter((i) => i.title.toLowerCase().includes('fita crepe'));

    expect(fitas.length, 'promovido, não duplicado').toBe(1);
    expect(fitas[0].source).toBe('System');
    expect(fitas[0].productId).toBe(produto.id);
  });

  test('@crud prontidão ganha "Materiais separados" sem bloquear', async ({ authApi }) => {
    const { eventId, atividadeId } = await setupAcceptedEvent(authApi);
    await createLinkedProduct(authApi, 'Cola branca E2E', [
      { activityId: atividadeId, qtyPerChild: 0.1, isChecklistOnly: false },
    ]);
    await getChecklist(authApi, eventId); // o lazy sync gera a lista

    const readiness = await authApi
      .get(`/api/events/${eventId}/readiness`)
      .then((r) => unwrap<{ requirements: { key: string; level: string; isMet: boolean }[] }>(
        r, 'GET readiness'));

    const req = readiness.requirements.find((x) => x.key === 'material_checklist_done');
    expect(req, 'requisito aparece quando há lista').toBeTruthy();
    expect(req!.level).toBe('Recommended');
    expect(req!.isMet).toBe(false);
  });

  test('@crud evento de outro tenant não devolve a lista', async ({ authApi }) => {
    const randomGuid = '11111111-2222-3333-4444-555555555555';
    const r = await authApi.get(`/api/events/${randomGuid}/material-checklist`);
    expect([400, 404], `status: ${r.status()}`).toContain(r.status());
  });
});
