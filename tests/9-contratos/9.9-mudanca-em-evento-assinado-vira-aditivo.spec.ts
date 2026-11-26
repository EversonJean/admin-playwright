import type { APIRequestContext } from '@playwright/test';

import { authTest as test, expect } from '../../fixtures/auth.fixture';
import {
  apiAddendumPdf,
  apiErrorBody,
  apiFormalizeAddendumManually,
  apiFormalizeContractManually,
  apiGetAddendumState,
  apiGetPendingContractChange,
  apiListContractAddendums,
  apiProposeContractChange,
  apiSendAddendum,
  apiTryProposeContractChange,
  setupManuallyFormalizedContract,
  waitForAddendumEffects,
} from '../../helpers/addendums';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import { apiCompleteOnboarding, apiListNotifications, apiSetSettingParameter } from '../../helpers/api-entities';
import { apiPatchEvent } from '../../helpers/api-event-flow';
import { assertOk, readJson, unwrapList } from '../../helpers/response';
import {
  apiCreateActiveContractTemplate,
  loginAsRole,
  openSessionPage,
  setupAcceptedEvent,
  setupDraftContract,
} from '../../helpers/setup-flows';
import { calendarCard, dragCalendarCard, snack } from '../../helpers/ui';

/**
 * Fluxo: 9.9 — Mudança em evento assinado vira aditivo, com aprovação
 * Diagrama: docs/fluxos/negocio-9.9-mudanca-em-evento-assinado-vira-aditivo.mmd
 * Cenário: docs/cenarios-de-teste/9-contratos/9.9-mudanca-em-evento-assinado-vira-aditivo.md
 * (CF-01 a CF-05, CE-01, CE-02, CE-04 a CE-08, CE-10)
 *
 * PLANO-ADITIVOS-COM-APROVACAO §7 (AD-E) itens 1 a 6, decisões 1 e 12, A15 a A20:
 * - mudar data, local ou item de preço de festa com contrato assinado não muda a
 *   festa: abre a proposta (motivo obrigatório) e nasce o aditivo em rascunho, com
 *   o banner "Alteração pendente" e o "→ proposto"; a segunda mudança entra no
 *   mesmo aditivo (revisão + 1); formalizado, a festa muda;
 * - quem não tem `contracts.formalize` (Gestor) propõe com "Precisa de aprovação":
 *   enviar ao cliente é recusado com `Addendums.ApprovalRequired`; enviar para
 *   aprovação avisa Dono e Administrador (sino e card do Início); devolver exige a
 *   nota (`Addendums.ReturnNoteRequired`) e avisa quem criou; aprovar grava "Aprovado
 *   por"; o Gestor não aprova, não devolve e não vê a fila (403);
 * - quatro olhos: quem propôs não aprova (`Addendums.SelfApprovalNotAllowed`); o
 *   segundo aprovador recebe `Addendums.InvalidStatus`;
 * - aditivo já enviado: `Addendums.OpenAlreadySent` com o número e o status, e
 *   "Recolher e incluir" funde no mesmo número;
 * - série com contrato-mestre: "Editar e replicar" e "Encerrar série" propõem um
 *   aditivo só, sem mudar nem cancelar nada até a formalização;
 * - outra empresa: 404 em todas as portas, sem nada mudar no dono.
 */

const ALWAYS_APPROVAL = 'ADDENDUM_INTERNAL_APPROVAL_ALWAYS';
const FOUR_EYES = 'ADDENDUM_FOUR_EYES';
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface EventFacts {
  eventDate: string;
  startTime: string;
  endTime: string;
  location: string | null;
  childrenCount: number;
  total: number;
  status: string;
  clientName: string | null;
}

async function eventFacts(api: APIRequestContext, eventId: string): Promise<EventFacts> {
  const res = await api.get(`/api/events/${eventId}`);
  await assertOk(res, 'GET /api/events/{id}');
  const ev = await readJson<EventFacts>(res);
  return {
    eventDate: ev.eventDate,
    startTime: ev.startTime,
    endTime: ev.endTime,
    location: ev.location,
    childrenCount: ev.childrenCount,
    total: ev.total,
    status: ev.status,
    clientName: ev.clientName,
  };
}

interface PricingItem {
  id: string;
  sourceType: string;
  sourceId: string | null;
  description: string;
  quantity: number;
  unit: string | null;
  unitPrice: number;
  discountAmount: number;
  additionalAmount: number;
  totalPrice: number;
  notes: string | null;
}

async function pricingItems(api: APIRequestContext, eventId: string): Promise<PricingItem[]> {
  const res = await api.get(`/api/events/${eventId}/pricing-items`);
  await assertOk(res, 'GET /api/events/{id}/pricing-items');
  return unwrapList<PricingItem>(res);
}

/** Corpo do item como o `CreateEventPricingItemRequest` (o que o front manda na proposta). */
function itemRequest(item: PricingItem, unitPrice = item.unitPrice) {
  return {
    sourceType: item.sourceType,
    sourceId: item.sourceId,
    description: item.description,
    quantity: item.quantity,
    unit: item.unit,
    unitPrice,
    discountAmount: item.discountAmount,
    additionalAmount: item.additionalAmount,
    notes: item.notes,
  };
}

/** A mudança como o front a envia: só o campo editado; o resto `null`. */
function frontChange(change: Record<string, unknown>): Record<string, unknown> {
  return {
    items: null,
    packageId: null,
    childrenCount: null,
    eventDate: null,
    endDate: null,
    startTime: null,
    endTime: null,
    location: null,
    manualAdjustment: null,
    manualAdjustmentDescription: null,
    payment: null,
    ...change,
  };
}

function isoPlus(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function brDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

function longDate(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${iso}T12:00:00Z`),
  );
}

async function hasNotice(api: APIRequestContext, title: string): Promise<boolean> {
  return (await apiListNotifications(api)).some((n) => n.title === title);
}

async function awaitingQueue(api: APIRequestContext): Promise<Array<{ id: string; createdByName: string | null }>> {
  const res = await api.get('/api/addendums?status=AwaitingApproval');
  await assertOk(res, 'GET /api/addendums?status=AwaitingApproval');
  return unwrapList<{ id: string; createdByName: string | null }>(res);
}

test.describe('Fluxo 9.9 — Mudança em evento assinado vira aditivo', () => {
  // Contrato formalizado, vários logins, avisos e a entrega do outbox (varredura a cada 5 s).
  test.describe.configure({ timeout: 240_000 });

  test('@flow arrastar festa assinada propoe aditivo em rascunho; a segunda mudanca entra nele; formalizado, a festa muda', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    const { eventId, contractId } = await setupDraftContract(authApi, tenant.tenantId);
    const day = isoPlus(3);
    const target = isoPlus(4);
    await apiPatchEvent(authApi, eventId, { eventDate: day });
    await apiFormalizeContractManually(authApi, contractId);
    const before = await eventFacts(authApi, eventId);
    const itemsBefore = await pricingItems(authApi, eventId);
    expect(itemsBefore.length).toBeGreaterThan(0);

    // CF-01 — o arrasto não muda a festa: abre a proposta com o antes e o depois.
    await apiCompleteOnboarding(authApi);
    await authPage.goto('/app/schedule/calendar');
    await dragCalendarCard(authPage, day, String(before.clientName), target);
    await expect(authPage.getByTestId('contract-change-title')).toHaveText(
      'Contrato assinado: estas mudanças viram um aditivo novo',
    );
    await expect(authPage.getByTestId('contract-change-notice')).toContainText(
      'A festa só muda depois que o cliente aceitar o aditivo.',
    );
    await expect(authPage.getByTestId('contract-change-row-date')).toContainText(brDate(day));
    await expect(authPage.getByTestId('contract-change-row-date')).toContainText(brDate(target));
    await expect(calendarCard(authPage, day, String(before.clientName)), 'o card voltou').toBeVisible();

    // CE-01 — sem motivo (ou só espaços) a proposta não sai.
    const confirm = authPage.getByTestId('contract-change-confirm');
    await expect(confirm).toBeDisabled();
    await authPage.getByTestId('contract-change-reason').fill('   ');
    await expect(confirm).toBeDisabled();
    expect(await apiListContractAddendums(authApi, contractId), 'nenhum aditivo sem motivo').toHaveLength(0);

    await authPage.getByTestId('contract-change-reason').fill('O cliente pediu outra data');
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(
      snack(authPage, 'Aditivo #1 criado, em "rascunho". A festa só muda depois que o cliente aceitar.'),
    ).toBeVisible();
    const [addendum] = await apiListContractAddendums(authApi, contractId);
    expect(addendum!.addendumNumber).toBe(1);
    expect(addendum!.status).toBe('Draft');
    expect(await eventFacts(authApi, eventId), 'a festa continua na data antiga').toEqual(before);

    // Na festa: o banner e o "→ proposto", com a data antiga no cabeçalho.
    await authPage.goto(`/app/events/${eventId}`);
    await expect(authPage.getByTestId('event-detail-pending-change-title')).toHaveText(
      'Alteração pendente — aditivo #1, Rascunho',
    );
    await expect(authPage.getByTestId('event-detail-proposed-date')).toHaveText(`→ proposto: ${brDate(target)}`);
    await expect(authPage.getByTestId('event-detail-fact-date')).toContainText(longDate(day));

    // CF-04 — mudar um item de preço: o PUT direto é recusado e nada muda...
    const first = itemsBefore[0]!;
    const newPrice = first.unitPrice + 100;
    const direct = await authApi.put(`/api/events/${eventId}/pricing-items/${first.id}`, {
      data: itemRequest(first, newPrice),
    });
    expect(direct.status()).toBe(409);
    expect((await apiErrorBody(direct)).codes).toContain('Events.ChangeRequiresAddendum');
    expect(await pricingItems(authApi, eventId)).toEqual(itemsBefore);

    // ...e a proposta (o corpo que o front manda: só os itens) entra no mesmo aditivo.
    const items = itemsBefore.map((i) => itemRequest(i, i.id === first.id ? newPrice : i.unitPrice));
    const merged = await apiProposeContractChange(authApi, eventId, 'O cliente pediu outra data e mudou o valor', frontChange({ items }));
    expect(merged.merged, 'fundiu no rascunho aberto').toBe(true);
    expect(merged.addendumId).toBe(addendum!.id);
    expect(merged.addendumNumber).toBe(1);
    expect(merged.revision).toBe(2);
    expect(await apiListContractAddendums(authApi, contractId), 'um aditivo só').toHaveLength(1);
    const pending = await apiGetPendingContractChange(authApi, eventId);
    const changeSet = pending!.changeSet as {
      schedule: { after: { date: string } } | null;
      pricing: { totalAfter: number } | null;
    };
    expect(changeSet.pricing, 'o item está no aditivo').not.toBeNull();
    expect(changeSet.schedule?.after.date, 'a data proposta antes continua no aditivo').toBe(target);
    expect(await eventFacts(authApi, eventId)).toEqual(before);
    expect(await pricingItems(authApi, eventId)).toEqual(itemsBefore);

    // Formalizado pelo caminho do 9.4, a festa muda: data e item.
    await apiSendAddendum(authApi, addendum!.id);
    await apiFormalizeAddendumManually(authApi, addendum!.id);
    expect((await waitForAddendumEffects(authApi, addendum!.id)).effectsStatus).toBe('Applied');
    const after = await eventFacts(authApi, eventId);
    expect(after.eventDate).toBe(target);
    expect(after.total).toBeGreaterThan(before.total);
    const changedItem = (await pricingItems(authApi, eventId)).find(
      (i) => i.sourceType === first.sourceType && i.sourceId === first.sourceId,
    );
    expect(changedItem?.unitPrice).toBeCloseTo(newPrice, 2);
    expect(await apiGetPendingContractChange(authApi, eventId), 'sem alteração pendente').toBeNull();
  });

  test('@flow gestor propoe com aprovacao: dono e admin sao avisados, devolver pede nota, admin aprova e envia; o gestor nao aprova', async ({
    authApi,
    authPage,
    browser,
    tenant,
  }) => {
    const { eventId } = await setupManuallyFormalizedContract(authApi, tenant.tenantId);
    const before = await eventFacts(authApi, eventId);
    const admin = await loginAsRole(tenant.tenantId, 'Admin');
    const manager = await loginAsRole(tenant.tenantId, 'Manager');
    await apiCompleteOnboarding(authApi);
    try {
      // CF-02 — o Gestor propõe: rascunho com "Precisa de aprovação".
      const proposal = await apiProposeContractChange(manager.api, eventId, 'O cliente pediu outro salao', {
        location: `Salao proposto ${Date.now()}`,
      });
      expect(proposal.status).toBe('Draft');
      expect(proposal.requiresInternalApproval).toBe(true);
      const id = proposal.addendumId;

      // CE-04 — enviar ao cliente sem a aprovação: recusado, para o Gestor e para o Dono.
      await apiAddendumPdf(manager.api, id);
      for (const api of [manager.api, authApi]) {
        const send = await api.post(`/api/addendums/${id}/send`);
        expect(send.status()).toBe(409);
        expect((await apiErrorBody(send)).codes).toContain('Addendums.ApprovalRequired');
      }
      await authPage.goto(`/app/events/${eventId}`);
      await authPage.getByRole('tab', { name: 'Contrato', exact: true }).click();
      await expect(authPage.getByTestId(`addendum-requires-approval-${id}`)).toBeVisible();
      await expect(authPage.getByTestId(`addendum-send-${id}`), '"Marcar como enviado" desabilitado').toBeDisabled();
      await expect(authPage.getByTestId(`addendum-formalize-manual-${id}`), 'sem formalizar').toHaveCount(0);

      // CF-02 — enviar para aprovação: Dono e Administrador avisados; o Gestor não.
      await assertOk(await manager.api.post(`/api/addendums/${id}/submit`), 'POST submit (Gestor)');
      expect((await apiGetAddendumState(authApi, id)).status).toBe('AwaitingApproval');
      const awaitingTitle = 'Aditivo #1 aguardando aprovação';
      for (const [who, api] of [
        ['Dono', authApi],
        ['Administrador', admin.api],
      ] as const) {
        await expect
          .poll(() => hasNotice(api, awaitingTitle), { message: `"${awaitingTitle}" no sino do ${who}`, timeout: 30_000 })
          .toBe(true);
      }
      expect(await hasNotice(manager.api, awaitingTitle), 'o Gestor não recebe').toBe(false);

      // O card do Início e a fila, para quem formaliza.
      const home = await readJson<{ addendumsAwaitingApproval: { count: number; route: string } | null }>(
        await authApi.get('/api/home'),
      );
      expect(home.addendumsAwaitingApproval?.count ?? 0).toBeGreaterThanOrEqual(1);
      expect(home.addendumsAwaitingApproval?.route).toBe('/app/contracts/addendums/awaiting-approval');
      const queue = await awaitingQueue(authApi);
      expect(queue.find((q) => q.id === id)?.createdByName, '"Proposto por" o Gestor').toBeTruthy();

      // CE-07 — o Gestor não aprova, não devolve, não vê a fila nem o card.
      expect((await manager.api.post(`/api/addendums/${id}/approve`)).status(), 'approve do Gestor').toBe(403);
      expect(
        (await manager.api.post(`/api/addendums/${id}/return`, { data: { note: 'Tentativa' } })).status(),
        'return do Gestor',
      ).toBe(403);
      expect((await manager.api.get('/api/addendums?status=AwaitingApproval')).status(), 'fila do Gestor').toBe(403);
      const managerHome = await readJson<{ addendumsAwaitingApproval: unknown }>(await manager.api.get('/api/home'));
      expect(managerHome.addendumsAwaitingApproval ?? null, 'sem o card no Início do Gestor').toBeNull();
      const managerPage = await openSessionPage(browser, manager.tokens);
      try {
        await managerPage.page.goto(`/app/events/${eventId}`);
        await managerPage.page.getByRole('tab', { name: 'Contrato', exact: true }).click();
        await expect(managerPage.page.getByTestId(`addendum-status-${id}`)).toBeVisible();
        await expect(managerPage.page.getByTestId(`addendum-approve-${id}`)).toHaveCount(0);
        await expect(managerPage.page.getByTestId(`addendum-return-${id}`)).toHaveCount(0);
      } finally {
        await managerPage.context.close();
      }
      expect((await apiGetAddendumState(authApi, id)).status).toBe('AwaitingApproval');

      // CE-05 — devolver sem nota é recusado; com a nota volta a rascunho e avisa quem criou.
      const noNote = await admin.api.post(`/api/addendums/${id}/return`, { data: { note: '   ' } });
      expect(noNote.status()).toBe(400);
      expect((await apiErrorBody(noNote)).codes).toContain('Addendums.ReturnNoteRequired');
      expect((await apiGetAddendumState(authApi, id)).status).toBe('AwaitingApproval');
      const note = 'Confirme o endereco do salao com o cliente';
      await assertOk(await admin.api.post(`/api/addendums/${id}/return`, { data: { note } }), 'POST return');
      const returned = await apiGetAddendumState(authApi, id);
      expect(returned.status).toBe('Draft');
      expect(returned.returnNote).toBe(note);
      await expect
        .poll(() => hasNotice(manager.api, 'Aditivo #1 devolvido'), { message: 'aviso ao Gestor', timeout: 30_000 })
        .toBe(true);

      // O Gestor corrige (a proposta funde no rascunho) e reenvia para aprovação.
      const corrected = await apiProposeContractChange(manager.api, eventId, 'O cliente confirmou o salao', {
        location: `Salao confirmado ${Date.now()}`,
      });
      expect(corrected.merged).toBe(true);
      expect(corrected.addendumNumber).toBe(1);
      expect(corrected.requiresInternalApproval).toBe(true);
      await assertOk(await manager.api.post(`/api/addendums/${id}/submit`), 'POST submit (de novo)');

      // CF-03 — o Administrador aprova ("Aprovado por") e envia ao cliente.
      await assertOk(await admin.api.post(`/api/addendums/${id}/approve`), 'POST approve (Admin)');
      const approved = await apiGetAddendumState(authApi, id);
      expect(approved.status).toBe('Approved');
      expect(approved.approvedAt).not.toBeNull();
      expect(approved.approvedByName, '"Aprovado por"').toBeTruthy();
      await apiSendAddendum(admin.api, id);
      expect((await apiGetAddendumState(authApi, id)).status).toBe('Sent');
      expect((await awaitingQueue(authApi)).some((q) => q.id === id), 'sai da fila').toBe(false);
    } finally {
      await admin.api.dispose();
      await manager.api.dispose();
    }
    expect(await eventFacts(authApi, eventId), 'a festa não muda antes da formalização').toEqual(before);
  });

  test('@flow serie com contrato-mestre: editar e replicar e encerrar a serie propoem um aditivo so; formalizado, muda e cancela', async ({
    authApi,
  }) => {
    const anchor = isoPlus(45);
    const series = await setupAcceptedEvent(authApi, {
      budget: {
        eventDate: anchor,
        recurrence: { daysOfWeek: [DAY_NAMES[new Date(`${anchor}T12:00:00Z`).getUTCDay()]!], occurrenceCount: 4 },
      },
    });
    const anchorEvent = await readJson<{ seriesId: string | null }>(await authApi.get(`/api/events/${series.eventId}`));
    const seriesId = anchorEvent.seriesId!;
    expect(seriesId, 'o aceite recorrente criou a série').toBeTruthy();
    const templateId = await apiCreateActiveContractTemplate(authApi);
    const masterRes = await authApi.post('/api/contracts', { data: { seriesId, templateId } });
    await assertOk(masterRes, 'POST /api/contracts (contrato-mestre)');
    const master = await readJson<{ id: string }>(masterRes);
    await apiFormalizeContractManually(authApi, master.id);

    const seriesRes = await authApi.get(`/api/event-series/${seriesId}`);
    await assertOk(seriesRes, 'GET /api/event-series/{id}');
    const occurrences = (await readJson<{ occurrences: Array<{ eventId: string; eventDate: string }> }>(seriesRes)).occurrences
      .slice()
      .sort((a, b) => a.eventDate.localeCompare(b.eventDate));
    expect(occurrences.length, 'ocorrências da série').toBeGreaterThanOrEqual(3);
    const factsBefore = await Promise.all(occurrences.map((o) => eventFacts(authApi, o.eventId)));
    const newLocation = `Salao da serie ${Date.now()}`;

    // "Editar e replicar" com local novo e motivo: nada muda, nasce UM aditivo.
    const propagate = await authApi.post(`/api/events/${occurrences[0]!.eventId}/propagate`, {
      data: { scope: 'ThisAndFuture', location: newLocation, reason: 'O cliente trocou o salao da serie' },
    });
    await assertOk(propagate, 'POST /api/events/{id}/propagate');
    const result = await readJson<{
      updated: unknown[];
      addendumsCreated: Array<{ addendumId: string; addendumNumber: number }>;
      pendingFormalization: Array<{ addendumId: string; addendumNumber: number }>;
    }>(propagate);
    expect(result.updated, 'nenhuma ocorrência mudou agora').toHaveLength(0);
    const proposed = [...result.addendumsCreated, ...result.pendingFormalization];
    expect(new Set(proposed.map((a) => a.addendumId)).size, 'um aditivo só').toBe(1);
    const addendumId = proposed[0]!.addendumId;
    expect(await Promise.all(occurrences.map((o) => eventFacts(authApi, o.eventId)))).toEqual(factsBefore);
    const pending = await apiGetPendingContractChange(authApi, occurrences[0]!.eventId);
    expect(pending?.addendumId).toBe(addendumId);
    const targets = (pending!.changeSet as { targetEventIds: string[] }).targetEventIds;
    for (const o of occurrences) expect(targets, 'as ocorrências-alvo no aditivo').toContain(o.eventId);

    // "Encerrar série" responde que o encerramento foi proposto; nada é cancelado.
    const lastKept = occurrences[1]!.eventDate;
    const endRes = await authApi.post(`/api/event-series/${seriesId}/end`, {
      data: { lastOccurrenceDate: lastKept, reason: 'O cliente encerrou a serie' },
    });
    await assertOk(endRes, 'POST /api/event-series/{id}/end');
    const ended = await readJson<{ canceledEventIds: string[]; addendumId: string | null; proposedAsAddendum: boolean }>(
      endRes,
    );
    expect(ended.proposedAsAddendum).toBe(true);
    expect(ended.canceledEventIds).toHaveLength(0);
    expect(ended.addendumId, 'o encerramento entra no mesmo aditivo').toBe(addendumId);
    expect(await Promise.all(occurrences.map((o) => eventFacts(authApi, o.eventId)))).toEqual(factsBefore);
    expect(await apiListContractAddendums(authApi, master.id)).toHaveLength(1);

    // Formalizado: o local muda nas que ficam e as datas depois da última são canceladas.
    await apiSendAddendum(authApi, addendumId);
    await apiFormalizeAddendumManually(authApi, addendumId);
    expect((await waitForAddendumEffects(authApi, addendumId)).effectsStatus).toBe('Applied');
    for (const o of occurrences) {
      const facts = await eventFacts(authApi, o.eventId);
      if (o.eventDate <= lastKept) {
        expect(facts.location, `local novo em ${o.eventDate}`).toBe(newLocation);
        expect(facts.status).not.toBe('Canceled');
      } else {
        expect(facts.status, `${o.eventDate} cancelada pelo encerramento`).toBe('Canceled');
      }
    }
  });

  test('@flow quatro olhos: quem propos nao aprova; o dono aprova; o segundo aprovador recebe InvalidStatus', async ({
    authApi,
    tenant,
  }) => {
    const { eventId } = await setupManuallyFormalizedContract(authApi, tenant.tenantId);
    await apiSetSettingParameter(authApi, ALWAYS_APPROVAL, 'true');
    await apiSetSettingParameter(authApi, FOUR_EYES, 'true');
    const admin = await loginAsRole(tenant.tenantId, 'Admin');
    try {
      // Com "Exigir aprovação interna em todo aditivo", até o Administrador passa pela aprovação.
      const proposal = await apiProposeContractChange(admin.api, eventId, 'O cliente pediu outro salao', {
        location: `Salao quatro olhos ${Date.now()}`,
      });
      expect(proposal.requiresInternalApproval).toBe(true);
      await assertOk(await admin.api.post(`/api/addendums/${proposal.addendumId}/submit`), 'POST submit (Admin)');

      // CE-06 — quem propôs não aprova.
      const self = await admin.api.post(`/api/addendums/${proposal.addendumId}/approve`);
      expect(self.status()).toBe(409);
      expect((await apiErrorBody(self)).codes).toContain('Addendums.SelfApprovalNotAllowed');
      expect((await apiGetAddendumState(authApi, proposal.addendumId)).status).toBe('AwaitingApproval');

      // O Dono aprova.
      await assertOk(await authApi.post(`/api/addendums/${proposal.addendumId}/approve`), 'POST approve (Dono)');
      expect((await apiGetAddendumState(authApi, proposal.addendumId)).status).toBe('Approved');

      // CE-08 — o segundo aprovador (a outra aba, sem recarregar) recebe InvalidStatus.
      const owner2 = await loginAsRole(tenant.tenantId, 'Owner');
      try {
        const second = await owner2.api.post(`/api/addendums/${proposal.addendumId}/approve`);
        expect(second.status()).toBe(409);
        expect((await apiErrorBody(second)).codes).toContain('Addendums.InvalidStatus');
        const lateReturn = await owner2.api.post(`/api/addendums/${proposal.addendumId}/return`, {
          data: { note: 'Devolver depois de aprovado' },
        });
        expect(lateReturn.status()).toBe(409);
        expect((await apiErrorBody(lateReturn)).codes).toContain('Addendums.InvalidStatus');
      } finally {
        await owner2.api.dispose();
      }
      expect((await apiGetAddendumState(authApi, proposal.addendumId)).status).toBe('Approved');
    } finally {
      await admin.api.dispose();
    }
  });

  test('@flow aditivo ja enviado: propor outra mudanca da OpenAlreadySent; recolher e incluir funde no mesmo numero', async ({
    authApi,
    tenant,
  }) => {
    const { eventId, contractId } = await setupManuallyFormalizedContract(authApi, tenant.tenantId);
    const before = await eventFacts(authApi, eventId);
    const sent = await apiProposeContractChange(authApi, eventId, 'O cliente pediu outra data', {
      eventDate: isoPlus(130),
    });
    await apiSendAddendum(authApi, sent.addendumId);
    expect((await apiGetAddendumState(authApi, sent.addendumId)).status).toBe('Sent');

    // CE-02 — a proposta nova é recusada com o número e o status do aberto.
    const change = { location: `Salao novo ${Date.now()}` };
    const refused = await apiTryProposeContractChange(authApi, eventId, 'Tambem mudou o salao', change);
    expect(refused.status()).toBe(409);
    const err = await apiErrorBody(refused);
    expect(err.codes).toContain('Addendums.OpenAlreadySent');
    expect(err.data?.openAddendumNumber).toBe(1);
    expect(err.data?.openAddendumStatus).toBe('Sent');
    expect(await apiListContractAddendums(authApi, contractId)).toHaveLength(1);

    // "Recolher e incluir": volta a rascunho e funde (mesmo número, revisão + 1).
    const recall = await authApi.post(`/api/addendums/${sent.addendumId}/recall-and-merge`, {
      data: { eventId, reason: 'Tambem mudou o salao', change, expectedRevision: sent.revision },
    });
    await assertOk(recall, 'POST /api/addendums/{id}/recall-and-merge');
    const merged = await readJson<{ addendumId: string; addendumNumber: number; status: string; revision: number; merged: boolean }>(
      recall,
    );
    expect(merged.addendumId).toBe(sent.addendumId);
    expect(merged.addendumNumber).toBe(1);
    expect(merged.status).toBe('Draft');
    expect(merged.revision).toBe(sent.revision + 1);
    expect(merged.merged).toBe(true);
    const list = await apiListContractAddendums(authApi, contractId);
    expect(list, 'sem segundo aditivo aberto').toHaveLength(1);
    const pending = await apiGetPendingContractChange(authApi, eventId);
    expect((pending!.changeSet as { location: { after: string | null } | null }).location?.after).toBe(change.location);
    expect(await eventFacts(authApi, eventId)).toEqual(before);
  });

  test('@flow outra empresa: pending-contract-changes e as portas do aditivo dao 404; a fila nao mostra; nada muda', async ({
    authApi,
    tenant,
  }) => {
    const { eventId, contractId } = await setupManuallyFormalizedContract(authApi, tenant.tenantId);
    // O aditivo do tenant A aguardando aprovação: as portas da aprovação valem para ele.
    const manager = await loginAsRole(tenant.tenantId, 'Manager');
    const proposal = await apiProposeContractChange(manager.api, eventId, 'O cliente pediu outro salao', {
      location: `Salao isolado ${Date.now()}`,
    });
    const addendumId = proposal.addendumId;
    await assertOk(await manager.api.post(`/api/addendums/${addendumId}/submit`), 'POST submit');
    await manager.api.dispose();
    const before = await eventFacts(authApi, eventId);
    const stateBefore = await apiGetAddendumState(authApi, addendumId);

    const other = await signupNewTenant();
    const apiB = await createBearerApiContext(other.accessToken);
    try {
      expect((await apiB.get(`/api/events/${eventId}/pending-contract-changes`)).status(), 'pending').toBe(404);
      expect((await apiB.post(`/api/addendums/${addendumId}/submit`)).status(), 'submit').toBe(404);
      expect((await apiB.post(`/api/addendums/${addendumId}/approve`)).status(), 'approve').toBe(404);
      expect(
        (await apiB.post(`/api/addendums/${addendumId}/return`, { data: { note: 'Invasao' } })).status(),
        'return',
      ).toBe(404);
      expect(
        (
          await apiB.post(`/api/addendums/${addendumId}/recall-and-merge`, {
            data: { eventId, reason: 'Invasao', change: { location: 'Invasao' } },
          })
        ).status(),
        'recall-and-merge',
      ).toBe(404);
      expect((await awaitingQueue(apiB)).some((q) => q.id === addendumId), 'a fila do B não mostra').toBe(false);
    } finally {
      await apiB.dispose();
    }
    const stateAfter = await apiGetAddendumState(authApi, addendumId);
    expect(stateAfter.status).toBe(stateBefore.status);
    expect(stateAfter.revision).toBe(stateBefore.revision);
    expect(await apiListContractAddendums(authApi, contractId)).toHaveLength(1);
    expect(await eventFacts(authApi, eventId)).toEqual(before);
  });
});
