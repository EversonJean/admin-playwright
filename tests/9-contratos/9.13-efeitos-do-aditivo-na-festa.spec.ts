import type { APIRequestContext } from '@playwright/test';

import { authTest as test, expect } from '../../fixtures/auth.fixture';
import {
  apiErrorBody,
  apiProposeContractChange,
  apiSendAddendum,
  setupFormalizedContractWithPlan,
  waitForAddendumEffects,
} from '../../helpers/addendums';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import { apiCompleteOnboarding, apiListNotifications } from '../../helpers/api-entities';
import { apiGetPaymentPlan } from '../../helpers/api-event-flow';
import {
  addendumFormalizedOutboxDirect,
  redeliverOutboxMessageDirect,
  setEventLocationDirect,
} from '../../helpers/db-helper';
import { assertOk, readJson, unwrapList } from '../../helpers/response';
import { loginAsRole, openSessionPage } from '../../helpers/setup-flows';
import { snack } from '../../helpers/ui';

/**
 * Fluxo: 9.13 — Efeitos do aditivo na festa
 * Diagrama: docs/fluxos/negocio-9.13-efeitos-do-aditivo-na-festa.mmd
 * Cenário: docs/cenarios-de-teste/9-contratos/9.13-efeitos-do-aditivo-na-festa.md (CF-01, CE-01, CE-03, CE-04)
 *
 * PLANO-ADITIVOS-COM-APROVACAO §6 (AD-D) itens 1 a 5, A3, A4, A7, A8, A11:
 * - formalizar enfileira a aplicação no outbox; o handler do Events aplica data,
 *   crianças, itens e o pagamento (parcela extra com a trilha "Aditivo #N") e o
 *   selo da lista passa a "Efeitos aplicados" sem recarregar; a mesma mensagem
 *   entregue de novo não aplica outra vez;
 * - a festa que mudou depois da proposta deixa o aditivo "Falhou" com a frase do
 *   campo, sem aplicar nada, e avisa Dono e Administrador ("Aditivo #N não
 *   aplicado", que abre a aba Contrato); "Aplicar de novo" (`contracts.formalize`)
 *   reenfileira e falha de novo; o Gestor não vê o botão e recebe 403; outra
 *   empresa, 404.
 */

interface EventFacts {
  eventDate: string;
  location: string | null;
  childrenCount: number;
  total: number;
}

async function eventFacts(api: APIRequestContext, eventId: string): Promise<EventFacts> {
  const res = await api.get(`/api/events/${eventId}`);
  await assertOk(res, 'GET /api/events/{id}');
  const ev = await readJson<EventFacts>(res);
  return { eventDate: ev.eventDate, location: ev.location, childrenCount: ev.childrenCount, total: ev.total };
}

async function pricingItems(api: APIRequestContext, eventId: string) {
  const res = await api.get(`/api/events/${eventId}/pricing-items`);
  await assertOk(res, 'GET /api/events/{id}/pricing-items');
  return (await unwrapList<{ id: string; sourceType: string; description?: string; totalPrice: number }>(res))
    .map((i) => ({ id: i.id, sourceType: i.sourceType, totalPrice: i.totalPrice }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function installments(api: APIRequestContext, eventId: string) {
  return ((await apiGetPaymentPlan(api, eventId))?.installments ?? [])
    .map((i) => ({ id: i.id, expectedAmount: i.expectedAmount, paidAmount: i.paidAmount }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function adjustments(api: APIRequestContext, eventId: string) {
  const res = await api.get(`/api/events/${eventId}/financial-adjustments`);
  await assertOk(res, 'GET /api/events/{id}/financial-adjustments');
  return unwrapList<{ id: string; type: string; amount: number; reason: string }>(res);
}

/** Dia por extenso como o detalhe mostra ("3 de dezembro de 2026"), sem o dia da semana. */
function longDate(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${iso}T12:00:00Z`),
  );
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test.describe('Fluxo 9.13 — Efeitos do aditivo na festa', () => {
  // Contrato formalizado, plano, proposta e as entregas do outbox (varredura a cada 5 s).
  test.describe.configure({ timeout: 240_000 });

  test('@flow formalizar aplica data, criancas, itens e parcela extra uma vez so; o selo vira "Efeitos aplicados" sem recarregar', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    const { eventId } = await setupFormalizedContractWithPlan(authApi, tenant.tenantId);
    const before = await eventFacts(authApi, eventId);
    const installmentsBefore = await installments(authApi, eventId);
    const newDate = addDays(before.eventDate, 7);
    const newChildren = before.childrenCount + 3;

    const proposal = await apiProposeContractChange(authApi, eventId, 'Cliente pediu outra data e mais criancas', {
      eventDate: newDate,
      childrenCount: newChildren,
      manualAdjustment: 150,
      manualAdjustmentDescription: 'Hora extra combinada',
      payment: { mode: 'ExtraInstallments', installmentCount: 1 },
    });
    expect(proposal.status).toBe('Draft');
    expect(proposal.financialImpact ?? 0, 'acréscimo: a parcela extra tem valor').toBeGreaterThan(0);
    // A20 — propor não muda a festa.
    expect(await eventFacts(authApi, eventId)).toEqual(before);
    await apiSendAddendum(authApi, proposal.addendumId);

    // Formaliza pela tela e fica nela: o selo muda sem recarregar.
    await apiCompleteOnboarding(authApi);
    await authPage.goto(`/app/events/${eventId}`);
    await authPage.getByRole('tab', { name: 'Contrato', exact: true }).click();
    await authPage.getByTestId(`addendum-formalize-manual-${proposal.addendumId}`).click();
    await authPage.getByTestId('addendum-formalize-manual-reason').fill('Cliente aceitou por mensagem (e2e)');
    // O aceite manual exige quem aceitou e o meio (PLANEJAMENTO §12, "Dados do
    // aceite"; o aditivo segue o fluxo do contrato).
    await authPage.getByTestId('addendum-formalize-manual-channel').click();
    await authPage.getByRole('option', { name: 'Verbal', exact: true }).click();
    await authPage.getByTestId('addendum-formalize-manual-signer').fill('Maria Cliente');
    await authPage.getByTestId('addendum-formalize-manual-submit').click();
    await expect(snack(authPage, `Aditivo #${proposal.addendumNumber} formalizado`)).toBeVisible();
    const badge = authPage.getByTestId(`addendum-effects-${proposal.addendumId}`);
    // "Aplicando…" dura até o publicador do outbox varrer (5 s); a tela pode já
    // abrir no aplicado. O front tem o caso do "Aplicando…" (addendums-section.spec).
    await expect(badge).toContainText(/Aplicando…|Efeitos aplicados/);
    await expect(badge, 'o selo muda sozinho, sem recarregar').toContainText('Efeitos aplicados', { timeout: 30_000 });
    await expect(authPage.getByTestId('event-detail-fact-date'), 'o cabeçalho da festa já tem a data nova').toContainText(
      longDate(newDate),
      { timeout: 15_000 },
    );

    // A festa mudou uma vez: data, crianças, o ajuste nos itens e a parcela extra.
    const applied = await waitForAddendumEffects(authApi, proposal.addendumId);
    expect(applied.effectsStatus).toBe('Applied');
    expect(applied.effectsAppliedAt).not.toBeNull();
    const after = await eventFacts(authApi, eventId);
    expect(after.eventDate).toBe(newDate);
    expect(after.childrenCount).toBe(newChildren);
    expect(after.total).toBeGreaterThan(before.total);
    const itemsAfter = await pricingItems(authApi, eventId);
    const installmentsAfter = await installments(authApi, eventId);
    expect(installmentsAfter, 'uma parcela extra').toHaveLength(installmentsBefore.length + 1);
    const extra = installmentsAfter.find((i) => !installmentsBefore.some((b) => b.id === i.id))!;
    expect(extra.expectedAmount).toBeCloseTo(proposal.financialImpact!, 2);
    const trail = await adjustments(authApi, eventId);
    expect(
      trail.some((a) => a.reason === `Aditivo #${proposal.addendumNumber}`),
      'a trilha do financeiro com a origem "Aditivo #N"',
    ).toBe(true);

    // Calendário: a festa no dia novo, e não mais no antigo.
    const onNewDay = await authApi.get(`/api/events/calendar?from=${newDate}&to=${newDate}`);
    await assertOk(onNewDay, 'GET /api/events/calendar (dia novo)');
    expect((await unwrapList<{ id: string }>(onNewDay)).some((e) => e.id === eventId)).toBe(true);
    const onOldDay = await authApi.get(`/api/events/calendar?from=${before.eventDate}&to=${before.eventDate}`);
    await assertOk(onOldDay, 'GET /api/events/calendar (dia antigo)');
    expect((await unwrapList<{ id: string }>(onOldDay)).some((e) => e.id === eventId)).toBe(false);

    // Reentregar a mesma mensagem: o consumidor deduplica e nada se aplica de novo.
    const messages = addendumFormalizedOutboxDirect(tenant.tenantId, proposal.addendumId);
    expect(messages, 'uma mensagem de formalização no outbox').toHaveLength(1);
    expect(messages[0]!.status).toBe('Published');
    redeliverOutboxMessageDirect(messages[0]!.id);
    await expect
      .poll(() => addendumFormalizedOutboxDirect(tenant.tenantId, proposal.addendumId)[0]!.status, {
        message: 'o publicador entrega a mensagem de novo',
        timeout: 60_000,
        intervals: [1_000],
      })
      .toBe('Published');
    expect(await eventFacts(authApi, eventId)).toEqual(after);
    expect(await pricingItems(authApi, eventId)).toEqual(itemsAfter);
    expect(await installments(authApi, eventId), 'nenhuma parcela extra a mais').toEqual(installmentsAfter);
    expect((await adjustments(authApi, eventId)).length).toBe(trail.length);
    expect((await waitForAddendumEffects(authApi, proposal.addendumId)).effectsStatus).toBe('Applied');
  });

  test('@flow festa que mudou depois da proposta: "Falhou" sem aplicar nada, aviso no sino e "Aplicar de novo" falha de novo', async ({
    authApi,
    authPage,
    browser,
    tenant,
  }) => {
    const { eventId } = await setupFormalizedContractWithPlan(authApi, tenant.tenantId);
    const proposedLocation = `Salao do aditivo ${Date.now()}`;
    const movedLocation = `Chacara Boa Vista ${Date.now()}`;
    const proposal = await apiProposeContractChange(authApi, eventId, 'Cliente pediu outro local', {
      location: proposedLocation,
    });
    // A festa muda de local depois da proposta (a tela não deixa; a massa também vai pelo banco).
    setEventLocationDirect(eventId, movedLocation);
    const before = await eventFacts(authApi, eventId);
    const itemsBefore = await pricingItems(authApi, eventId);
    const installmentsBefore = await installments(authApi, eventId);

    const admin = await loginAsRole(tenant.tenantId, 'Admin');
    const manager = await loginAsRole(tenant.tenantId, 'Manager');
    try {
      await apiSendAddendum(authApi, proposal.addendumId);
      await assertOk(
        await authApi.post(`/api/addendums/${proposal.addendumId}/formalize-manual`, {
          data: { signerName: 'Cliente E2E', channel: 'presencial', reason: 'Aceite (e2e)', evidenceText: null, signerPhone: null, signerEmail: null },
        }),
        'POST formalize-manual',
      );

      // CE-01 — "Falhou" com a frase do campo; nada aplicado pela metade.
      const failed = await waitForAddendumEffects(authApi, proposal.addendumId);
      expect(failed.status).toBe('Formalized');
      expect(failed.effectsStatus).toBe('Failed');
      expect(failed.effectsErrorCode).toBe('Addendums.EffectsConflict');
      expect(failed.effectsError ?? '').toContain('O local da festa mudou depois da proposta');
      expect(failed.effectsError ?? '').toContain(movedLocation);
      expect(await eventFacts(authApi, eventId)).toEqual(before);
      expect(await pricingItems(authApi, eventId)).toEqual(itemsBefore);
      expect(await installments(authApi, eventId)).toEqual(installmentsBefore);

      // Aviso no sino do Dono e do Administrador; o Gestor não recebe.
      const title = `Aditivo #${proposal.addendumNumber} não aplicado`;
      for (const [who, api] of [
        ['Dono', authApi],
        ['Administrador', admin.api],
      ] as const) {
        await expect
          .poll(async () => (await apiListNotifications(api)).some((n) => n.title === title), {
            message: `aviso "${title}" no sino do ${who}`,
            timeout: 30_000,
          })
          .toBe(true);
      }
      expect((await apiListNotifications(manager.api)).some((n) => n.title === title), 'o Gestor não recebe').toBe(false);

      // O aviso abre a festa na aba Contrato, com o selo "Falhou: <motivo>".
      const ownerNotice = (await apiListNotifications(authApi)).find((n) => n.title === title)!;
      expect(ownerNotice.message).toContain(`Aditivo #${proposal.addendumNumber} formalizado, mas não aplicado na festa`);
      await apiCompleteOnboarding(authApi);
      await authPage.goto('/app');
      await authPage.getByTestId('notification-bell').click();
      await authPage.getByTestId(`notification-open-${ownerNotice.id}`).click();
      await authPage.waitForURL(new RegExp(`/app/events/${eventId}`));
      const badge = authPage.getByTestId(`addendum-effects-${proposal.addendumId}`);
      await expect(badge, 'o aviso abre a aba Contrato').toBeVisible();
      await expect(badge).toContainText('Falhou: O local da festa mudou depois da proposta');

      // "Aplicar de novo" do Dono reenfileira e falha de novo (a festa continua diferente).
      await authPage.getByTestId(`addendum-apply-effects-${proposal.addendumId}`).click();
      await expect(snack(authPage, `Aplicando de novo os efeitos do aditivo #${proposal.addendumNumber}`)).toBeVisible();
      await expect
        .poll(() => addendumFormalizedOutboxDirect(tenant.tenantId, proposal.addendumId).length, {
          message: 'o reenvio entra no outbox com mensagem nova',
          timeout: 15_000,
        })
        .toBe(2);
      const failedAgain = await waitForAddendumEffects(authApi, proposal.addendumId);
      expect(failedAgain.effectsStatus).toBe('Failed');
      expect(failedAgain.effectsErrorCode).toBe('Addendums.EffectsConflict');
      expect(await eventFacts(authApi, eventId)).toEqual(before);
      expect(await installments(authApi, eventId)).toEqual(installmentsBefore);

      // CE-03 — o Gestor vê "Falhou", sem o botão, e a API recusa com 403.
      const managerPage = await openSessionPage(browser, manager.tokens);
      try {
        await managerPage.page.goto(`/app/events/${eventId}`);
        await managerPage.page.getByRole('tab', { name: 'Contrato', exact: true }).click();
        await expect(managerPage.page.getByTestId(`addendum-effects-${proposal.addendumId}`)).toContainText('Falhou');
        await expect(managerPage.page.getByTestId(`addendum-apply-effects-${proposal.addendumId}`)).toHaveCount(0);
      } finally {
        await managerPage.context.close();
      }
      const managerRetry = await manager.api.post(`/api/addendums/${proposal.addendumId}/apply-effects`);
      expect(managerRetry.status(), 'apply-effects do Gestor').toBe(403);
    } finally {
      await admin.api.dispose();
      await manager.api.dispose();
    }

    // CE-04 — outra empresa: 404 e nada reenfileirado.
    const outboxCount = addendumFormalizedOutboxDirect(tenant.tenantId, proposal.addendumId).length;
    const other = await signupNewTenant();
    const apiB = await createBearerApiContext(other.accessToken);
    try {
      const res = await apiB.post(`/api/addendums/${proposal.addendumId}/apply-effects`);
      expect(res.status(), 'apply-effects de outra empresa').toBe(404);
      expect((await apiErrorBody(res)).codes).toContain('Addendums.NotFound');
      expect((await apiB.get(`/api/addendums/${proposal.addendumId}`)).status()).toBe(404);
    } finally {
      await apiB.dispose();
    }
    expect(addendumFormalizedOutboxDirect(tenant.tenantId, proposal.addendumId)).toHaveLength(outboxCount);
    expect(await eventFacts(authApi, eventId)).toEqual(before);
  });
});
