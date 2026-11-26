import type { APIRequestContext, Page } from '@playwright/test';

import { authTest as test, expect } from '../../fixtures/auth.fixture';
import {
  apiAcceptAddendumByLink,
  apiErrorBody,
  apiFormalizeAddendumManually,
  apiGetAddendumState,
  apiGetPendingContractChange,
  apiGetReversalDraft,
  apiListContractAddendums,
  apiProposeContractChange,
  apiSendAddendum,
  apiTryGetReversalDraft,
  apiTryProposeContractChange,
  setupFormalizedContractWithPlan,
  setupManuallyFormalizedContract,
  waitForAddendumEffects,
} from '../../helpers/addendums';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import { apiCompleteOnboarding, apiListNotifications, apiSetSettingParameter } from '../../helpers/api-entities';
import {
  apiGetPaymentPlan,
  apiGetPaymentSummary,
  apiListClientCredits,
  apiRegisterPayment,
} from '../../helpers/api-event-flow';
import { setEventLocationDirect } from '../../helpers/db-helper';
import { apiConnectGoogleCalendar, waitForGoogleEvent } from '../../helpers/external-calendar';
import { assertOk, readJson, unwrapList } from '../../helpers/response';
import { loginAsRole, openSessionPage } from '../../helpers/setup-flows';
import { snack } from '../../helpers/ui';

/**
 * Fluxo: 9.11 — Estorno de aditivo
 * Diagrama: docs/fluxos/negocio-9.11-estorno-de-aditivo.mmd
 * Cenário: docs/cenarios-de-teste/9-contratos/9.11-estorno-de-aditivo.md
 * (CF-01, CF-02, CE-01 a CE-09)
 *
 * PLANO-ADITIVOS-COM-APROVACAO §10 (AD-H) itens 1, 2 e 4, A9, A11 a A13 (registro
 * e2e E7, E33 a E36):
 * - "Desfazer" o aditivo formalizado e aplicado abre "Estorno do aditivo #N" já com
 *   o valor anterior; "Criar estorno" cria o #M ("estorna o #N" / "estornado pelo
 *   #M") sem mudar a festa; o cliente aceita pelo link, o outbox aplica e a festa
 *   volta, no detalhe, no calendário e na agenda externa;
 * - estorno de acréscimo já pago: sugere "Distribuir nas parcelas em aberto", o
 *   pago vira crédito, a trilha tem Desconto e Crédito "Estorno do aditivo #N",
 *   sem Estorno nem Reembolso; acima do teto de crédito, recusado na proposta e
 *   "Falhou" na aplicação;
 * - conflito por mudança posterior: "Deixar fora do estorno" e "Usar o valor
 *   atual como base";
 * - recusas: AlreadyReverted (também em corrida), CannotRevertReversal,
 *   NotRevertible, AnotherOpen e o aditivo não assinado só com "Cancelar aditivo";
 * - permissões e outra empresa.
 */

const CREDIT_MAX_BALANCE = 'CREDIT_MAX_BALANCE_PER_CLIENT';

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

async function adjustments(api: APIRequestContext, eventId: string) {
  const res = await api.get(`/api/events/${eventId}/financial-adjustments`);
  await assertOk(res, 'GET /api/events/{id}/financial-adjustments');
  return unwrapList<{ id: string; type: string; amount: number; reason: string }>(res);
}

/** O que falta pagar nas parcelas do plano. */
async function openInstallments(api: APIRequestContext, eventId: string): Promise<number> {
  const plan = await apiGetPaymentPlan(api, eventId);
  return Math.round((plan?.installments ?? []).reduce((sum, i) => sum + i.balance, 0) * 100) / 100;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Dia por extenso como o detalhe mostra ("3 de dezembro de 2026"). */
function longDate(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${iso}T12:00:00Z`),
  );
}

async function onCalendarDay(api: APIRequestContext, eventId: string, iso: string): Promise<boolean> {
  const res = await api.get(`/api/events/calendar?from=${iso}&to=${iso}`);
  await assertOk(res, 'GET /api/events/calendar');
  return (await unwrapList<{ id: string }>(res)).some((e) => e.id === eventId);
}

async function openContractTab(page: Page, eventId: string): Promise<void> {
  await page.goto(`/app/events/${eventId}`);
  await page.getByRole('tab', { name: 'Contrato', exact: true }).click({ timeout: 45_000 });
  await expect(page.getByTestId('addendums-section')).toBeVisible({ timeout: 30_000 });
}

/** Aditivo pela festa formalizado à mão (pré-condição: canal e nome preenchidos) e com os efeitos aplicados. */
async function appliedAddendum(
  api: APIRequestContext,
  eventId: string,
  reason: string,
  change: Record<string, unknown>,
): Promise<{ id: string; number: number }> {
  const proposal = await apiProposeContractChange(api, eventId, reason, change);
  await apiFormalizeAddendumManually(api, proposal.addendumId);
  const applied = await waitForAddendumEffects(api, proposal.addendumId);
  expect(applied.effectsStatus, `efeitos do aditivo #${proposal.addendumNumber}`).toBe('Applied');
  return { id: proposal.addendumId, number: proposal.addendumNumber };
}

/** Os estornos (vivos ou não) de um aditivo, pela lista do contrato. */
async function reversalsOf(api: APIRequestContext, contractId: string, originalId: string) {
  return (await apiListContractAddendums(api, contractId)).filter(
    (a) => a.kind === 'Reversal' && (a as unknown as { revertsAddendumId: string | null }).revertsAddendumId === originalId,
  );
}

test.describe('Fluxo 9.11 — Estorno de aditivo', () => {
  // Contrato formalizado, aditivos com o outbox dos efeitos, link de aceite e o fake do Google.
  test.describe.configure({ timeout: 300_000 });

  test('@flow E7 "Desfazer" o aditivo de data: "Estorno do aditivo #N" com a data anterior, o par se referencia e, aceito pelo link, a festa volta no detalhe, no calendario e na agenda externa', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    await apiCompleteOnboarding(authApi);
    const connected = await apiConnectGoogleCalendar(authApi, tenant.password);
    const { eventId, contractId } = await setupManuallyFormalizedContract(authApi, tenant.tenantId);
    const original = await eventFacts(authApi, eventId);
    const mirrored = await waitForGoogleEvent(connected.sub, eventId, (e) => e?.status === 'confirmed', {
      description: 'festa espelhada no Google',
    });
    const startTime = mirrored!.start!.dateTime!.slice(10);
    const newDate = addDays(original.eventDate, 7);
    const first = await appliedAddendum(authApi, eventId, 'Cliente pediu outra data', { eventDate: newDate });
    expect((await eventFacts(authApi, eventId)).eventDate).toBe(newDate);
    await waitForGoogleEvent(connected.sub, eventId, (e) => e?.start?.dateTime === `${newDate}${startTime}`, {
      description: 'a data do aditivo no Google',
    });

    // CF-01 passos 1 a 3 — "Desfazer" abre o estorno pré-preenchido com a data anterior.
    await openContractTab(authPage, eventId);
    await authPage.getByTestId(`addendum-revert-${first.id}`).click();
    await expect(authPage.getByTestId('addendum-editor-title')).toHaveText(`Estorno do aditivo #${first.number}`, {
      timeout: 30_000,
    });
    await expect(authPage.getByTestId('addendum-editor-reversal-info')).toContainText(
      `Este aditivo desfaz o aditivo #${first.number}`,
    );
    await expect(authPage.getByTestId('addendum-scope-event-date'), 'a data de antes do aditivo').toHaveValue(
      original.eventDate,
      { timeout: 30_000 },
    );
    await expect(authPage.getByTestId('addendum-editor-reason'), 'o motivo vem em branco').toHaveValue('');
    await authPage.getByTestId('addendum-editor-reason').fill('Cliente desistiu da troca de data');
    await authPage.getByTestId('addendum-editor-submit').click();
    await expect(snack(authPage, `criado: estorno do aditivo #${first.number}`)).toBeVisible({ timeout: 30_000 });

    const [reversal] = await reversalsOf(authApi, contractId, first.id);
    expect(reversal, 'o estorno nasce na lista do contrato').toBeTruthy();
    await expect(authPage.getByTestId(`addendum-kind-${reversal!.id}`)).toContainText('Estorno');
    await expect(authPage.getByTestId(`addendum-reverts-${reversal!.id}`)).toContainText(`estorna o #${first.number}`);
    await expect(authPage.getByTestId(`addendum-reverted-by-${first.id}`)).toContainText(
      `estornado pelo #${reversal!.addendumNumber}`,
    );
    expect((await eventFacts(authApi, eventId)).eventDate, 'a festa não muda até o estorno ser formalizado').toBe(newDate);

    // O cliente aceita o estorno pelo link; o outbox aplica e a festa volta.
    await apiAcceptAddendumByLink(authApi, reversal!.id);
    expect((await apiGetAddendumState(authApi, reversal!.id)).status).toBe('Formalized');
    expect((await waitForAddendumEffects(authApi, reversal!.id)).effectsStatus).toBe('Applied');
    expect((await eventFacts(authApi, eventId)).eventDate).toBe(original.eventDate);
    expect(await onCalendarDay(authApi, eventId, original.eventDate), 'no calendário, no dia anterior').toBe(true);
    expect(await onCalendarDay(authApi, eventId, newDate)).toBe(false);
    await waitForGoogleEvent(
      connected.sub,
      eventId,
      (e) => e?.status === 'confirmed' && e.start?.dateTime === `${original.eventDate}${startTime}`,
      { description: 'a agenda externa remarcada para a data anterior' },
    );
    await openContractTab(authPage, eventId);
    await expect(authPage.getByTestId('event-detail-fact-date')).toContainText(longDate(original.eventDate));
  });

  test('@flow E33 desfazer o acrescimo ja pago: sugere distribuir nas parcelas em aberto, o pago vira credito e a trilha tem Desconto e Credito; acima do teto, recusa e "Falhou"', async ({
    authApi,
    tenant,
  }) => {
    const { eventId, contractId, clienteId, installments } = await setupFormalizedContractWithPlan(authApi, tenant.tenantId);
    // A segunda parcela paga e a quitação com R$ 100 em aberto.
    const second = installments.find((i) => i.order === 2)!;
    const last = installments.find((i) => i.order === 3)!;
    await apiRegisterPayment(authApi, eventId, { amount: second.expectedAmount, method: 'Pix', installmentId: second.id });
    await apiRegisterPayment(authApi, eventId, {
      amount: Math.round((last.expectedAmount - 100) * 100) / 100,
      method: 'Pix',
      installmentId: last.id,
    });

    // O aditivo de acréscimo de R$ 300 em parcela extra, aplicado, com a extra paga.
    const before = (await apiGetPaymentPlan(authApi, eventId))!.installments.map((i) => i.id);
    const original = await appliedAddendum(authApi, eventId, 'Personagem extra', {
      manualAdjustment: 300,
      manualAdjustmentDescription: 'Personagem extra',
      payment: { mode: 'ExtraInstallments', installmentCount: 1 },
    });
    const extra = (await apiGetPaymentPlan(authApi, eventId))!.installments.find((i) => !before.includes(i.id))!;
    expect(extra.expectedAmount).toBeCloseTo(300, 2);
    await apiRegisterPayment(authApi, eventId, { amount: extra.expectedAmount, method: 'Pix', installmentId: extra.id });
    const summaryBefore = await apiGetPaymentSummary(authApi, eventId);
    const openBefore = await openInstallments(authApi, eventId);
    expect(openBefore, `R$ 100 em aberto nas parcelas antes do estorno (resumo: ${JSON.stringify({ total: summaryBefore.eventTotal, paid: summaryBefore.totalPaid, balance: summaryBefore.balance })})`).toBeCloseTo(100, 2);
    const trailBefore = await adjustments(authApi, eventId);

    // A prévia do estorno sugere "Distribuir nas parcelas em aberto" e mostra o crédito.
    const draft = await apiGetReversalDraft(authApi, original.id);
    expect(draft.suggestedPayment?.mode).toBe('DistributeOverOpen');
    const previewRes = await authApi.post(`/api/events/${eventId}/contract-changes/preview`, { data: draft.change });
    await assertOk(previewRes, 'POST contract-changes/preview (estorno)');
    const preview = await readJson<{ payment: { mode: string; creditAmount: number } | null }>(previewRes);
    expect(preview.payment?.mode).toBe('DistributeOverOpen');
    expect(preview.payment?.creditAmount, 'o que já foi pago além do aberto vira crédito').toBeCloseTo(200, 2);

    // CE-06 — com o teto abaixo do crédito, a proposta é recusada e nada nasce.
    await apiSetSettingParameter(authApi, CREDIT_MAX_BALANCE, 1);
    const refused = await apiTryProposeContractChange(authApi, eventId, 'Cliente desistiu do personagem', draft.change!);
    // O plano dá só o código (A11); o status segue o do 9.8 (recusa 4xx).
    expect(refused.status()).toBeGreaterThanOrEqual(400);
    expect(refused.status()).toBeLessThan(500);
    expect((await apiErrorBody(refused)).codes).toContain('CreditBalance.MaxBalanceExceeded');
    expect(await reversalsOf(authApi, contractId, original.id)).toHaveLength(0);

    // Sem teto, o estorno nasce; baixado o teto depois, a aplicação falha com o aviso no sino.
    await apiSetSettingParameter(authApi, CREDIT_MAX_BALANCE, 0);
    const proposal = await apiProposeContractChange(authApi, eventId, 'Cliente desistiu do personagem', draft.change!);
    await apiSetSettingParameter(authApi, CREDIT_MAX_BALANCE, 1);
    await apiFormalizeAddendumManually(authApi, proposal.addendumId);
    const failed = await waitForAddendumEffects(authApi, proposal.addendumId);
    expect(failed.effectsStatus).toBe('Failed');
    expect(failed.effectsErrorCode).toBe('CreditBalance.MaxBalanceExceeded');
    const failTitle = `Aditivo #${proposal.addendumNumber} não aplicado`;
    await expect
      .poll(async () => (await apiListNotifications(authApi)).some((n) => n.title === failTitle), {
        message: `aviso "${failTitle}" no sino`,
        timeout: 30_000,
      })
      .toBe(true);
    expect(await openInstallments(authApi, eventId), 'nada aplicado').toBeCloseTo(openBefore, 2);
    expect(await apiListClientCredits(authApi, clienteId)).toHaveLength(0);

    // Resolvido o teto, "Aplicar de novo": o aberto cai, o pago vira crédito e a trilha sem Estorno nem Reembolso.
    await apiSetSettingParameter(authApi, CREDIT_MAX_BALANCE, 0);
    await assertOk(await authApi.post(`/api/addendums/${proposal.addendumId}/apply-effects`), 'POST apply-effects');
    await expect
      .poll(async () => (await apiGetAddendumState(authApi, proposal.addendumId)).effectsStatus, {
        message: 'o estorno aplicado depois do teto',
        timeout: 60_000,
        intervals: [1_000],
      })
      .toBe('Applied');
    const summaryAfter = await apiGetPaymentSummary(authApi, eventId);
    expect(await openInstallments(authApi, eventId), 'o saldo em aberto cai').toBeLessThan(openBefore);
    expect(summaryAfter.balance, 'o saldo da festa cai').toBeLessThan(summaryBefore.balance);
    expect(summaryAfter.totalPaid, 'o caixa não muda').toBeCloseTo(summaryBefore.totalPaid, 2);
    expect(summaryAfter.entries).toHaveLength(summaryBefore.entries.length);
    const credits = await apiListClientCredits(authApi, clienteId, true);
    expect(credits.reduce((sum, c) => sum + c.balance, 0), 'o crédito do cliente').toBeCloseTo(200, 2);

    const trail = (await adjustments(authApi, eventId)).filter((a) => !trailBefore.some((b) => b.id === a.id));
    const origin = `Estorno do aditivo #${original.number}`;
    expect(trail.some((a) => a.type === 'Discount' && a.reason.includes(origin)), 'Desconto "Estorno do aditivo #N"').toBe(true);
    expect(trail.some((a) => a.type === 'Credit' && a.reason.includes(origin)), 'Crédito "Estorno do aditivo #N"').toBe(true);
    expect(trail.filter((a) => a.type === 'Reversal' || a.type === 'Refund'), 'sem Estorno nem Reembolso').toHaveLength(0);
  });

  test('@flow E34 conflito por mudanca posterior: "A festa mudou depois do aditivo #N", "Deixar fora do estorno" tira a secao e "Usar o valor atual" parte de hoje; a proposta grava so o que ficou', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    await apiCompleteOnboarding(authApi);
    const { eventId } = await setupManuallyFormalizedContract(authApi, tenant.tenantId);
    const original = await eventFacts(authApi, eventId);
    const firstDate = addDays(original.eventDate, 7);
    const secondDate = addDays(original.eventDate, 14);
    const firstLocation = `Salao do primeiro ${Date.now()}`;
    const secondLocation = `Chacara do segundo ${Date.now()}`;
    const first = await appliedAddendum(authApi, eventId, 'Outra data e outro local', {
      eventDate: firstDate,
      location: firstLocation,
    });
    await appliedAddendum(authApi, eventId, 'Mudou de novo', { eventDate: secondDate, location: secondLocation });
    const today = await eventFacts(authApi, eventId);
    expect(today.eventDate).toBe(secondDate);

    await openContractTab(authPage, eventId);
    const isPreview = (r: { url(): string; request(): { method(): string } }) =>
      r.url().includes(`/api/events/${eventId}/contract-changes/preview`) && r.request().method() === 'POST';
    const firstPreview = authPage.waitForResponse(isPreview);
    await authPage.getByTestId(`addendum-revert-${first.id}`).click();
    await firstPreview;

    // O aviso do conflito, com o que o #1 deixou e o valor de hoje.
    const conflicts = authPage.getByTestId('addendum-editor-conflicts');
    await expect(conflicts).toContainText(`A festa mudou depois do aditivo #${first.number}`, { timeout: 30_000 });
    const scheduleValues = authPage.getByTestId('addendum-editor-conflict-values-schedule');
    await expect(scheduleValues).toContainText(`Deixado pelo aditivo #${first.number}:`);
    await expect(scheduleValues).toContainText('Hoje:');

    // "Deixar fora do estorno": a data sai da prévia.
    const excluded = authPage.waitForResponse(isPreview);
    await authPage.getByTestId('addendum-editor-conflict-exclude-schedule').click();
    const excludedRes = await excluded;
    expect((excludedRes.request().postDataJSON() as { excludedSections?: string[] }).excludedSections).toContain('schedule');
    const excludedPreview = ((await excludedRes.json()) as { data: { changeSet: { schedule: unknown } } }).data;
    expect(excludedPreview.changeSet.schedule, 'a data fora da prévia').toBeNull();
    await expect(conflicts, 'a seção continua no aviso').toContainText(`A festa mudou depois do aditivo #${first.number}`);

    // "Usar o valor atual como base": a data volta, partindo da data de hoje.
    const restored = authPage.waitForResponse(isPreview);
    await authPage.getByTestId('addendum-editor-conflict-use-current-schedule').click();
    const restoredRes = await restored;
    expect((restoredRes.request().postDataJSON() as { excludedSections?: string[] }).excludedSections ?? []).not.toContain(
      'schedule',
    );
    const restoredPreview = (
      (await restoredRes.json()) as {
        data: { changeSet: { schedule: { before: { date: string }; after: { date: string } } | null } };
      }
    ).data;
    expect(restoredPreview.changeSet.schedule?.before.date, 'parte da data de hoje').toBe(secondDate);
    expect(restoredPreview.changeSet.schedule?.after.date).toBe(original.eventDate);

    // De volta a "Deixar fora" e criar: a proposta grava só o local.
    const excludedAgain = authPage.waitForResponse(isPreview);
    await authPage.getByTestId('addendum-editor-conflict-exclude-schedule').click();
    await excludedAgain;
    await authPage.getByTestId('addendum-editor-reason').fill('Desfaz só o local do primeiro aditivo');
    await authPage.getByTestId('addendum-editor-submit').click();
    await expect(snack(authPage, `criado: estorno do aditivo #${first.number}`)).toBeVisible({ timeout: 30_000 });

    const pending = await apiGetPendingContractChange(authApi, eventId);
    expect(pending, 'o estorno aberto').not.toBeNull();
    const changeSet = pending!.changeSet as {
      schedule: unknown;
      location: { before: string | null; after: string | null } | null;
    };
    expect(changeSet.schedule, 'a data ficou fora').toBeNull();
    expect(changeSet.location?.before, 'o local parte do valor de hoje').toBe(secondLocation);
    expect(changeSet.location?.after).toBe(original.location);
    expect(await eventFacts(authApi, eventId)).toEqual(today);
  });

  test('@flow E35 estornar duas vezes (tambem em corrida) da AlreadyReverted e o estorno nao se desfaz (CannotRevertReversal)', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    const { eventId, contractId } = await setupManuallyFormalizedContract(authApi, tenant.tenantId);
    const original = await eventFacts(authApi, eventId);
    const first = await appliedAddendum(authApi, eventId, 'Cliente pediu outra data', {
      eventDate: addDays(original.eventDate, 7),
    });
    const draft = await apiGetReversalDraft(authApi, first.id);

    // CE-01 — dois cliques ao mesmo tempo: só um estorno nasce.
    const [a, b] = await Promise.all([
      apiTryProposeContractChange(authApi, eventId, 'Desfaz a data (aba 1)', draft.change!),
      apiTryProposeContractChange(authApi, eventId, 'Desfaz a data (aba 2)', draft.change!),
    ]);
    const statuses = [a.status(), b.status()].map((st) => (st >= 200 && st < 300 ? 'ok' : st)).sort();
    expect(statuses, 'um aceito e um recusado').toEqual([409, 'ok']);
    const loser = a.status() === 409 ? a : b;
    expect((await apiErrorBody(loser)).codes).toContain('Addendums.AlreadyReverted');
    const reversals = await reversalsOf(authApi, contractId, first.id);
    expect(reversals, 'um estorno só').toHaveLength(1);
    const reversal = reversals[0]!;

    // Com o estorno aberto: sem "Desfazer" no original, e a API recusa outro.
    await apiCompleteOnboarding(authApi);
    await openContractTab(authPage, eventId);
    await expect(authPage.getByTestId(`addendum-reverted-by-${first.id}`)).toBeVisible();
    await expect(authPage.getByTestId(`addendum-revert-${first.id}`)).toHaveCount(0);
    const again = await apiTryProposeContractChange(authApi, eventId, 'Desfaz de novo', draft.change!);
    expect(again.status()).toBe(409);
    expect((await apiErrorBody(again)).codes).toContain('Addendums.AlreadyReverted');

    // CE-02 — formalizado e aplicado, o estorno não tem "Desfazer" e a API responde CannotRevertReversal.
    await apiFormalizeAddendumManually(authApi, reversal.id);
    expect((await waitForAddendumEffects(authApi, reversal.id)).effectsStatus).toBe('Applied');
    const ofReversal = await apiTryGetReversalDraft(authApi, reversal.id);
    expect(ofReversal.status()).toBe(409);
    expect((await apiErrorBody(ofReversal)).codes).toContain('Addendums.CannotRevertReversal');
    const ofOriginal = await apiTryGetReversalDraft(authApi, first.id);
    expect(ofOriginal.status(), 'o original com o estorno formalizado').toBe(409);
    expect((await apiErrorBody(ofOriginal)).codes).toContain('Addendums.AlreadyReverted');
    await openContractTab(authPage, eventId);
    await expect(authPage.getByTestId(`addendum-status-${reversal.id}`)).toContainText('Formalizado');
    await expect(authPage.getByTestId(`addendum-revert-${reversal.id}`)).toHaveCount(0);
    await expect(authPage.getByTestId(`addendum-revert-${first.id}`)).toHaveCount(0);
    expect(await reversalsOf(authApi, contractId, first.id)).toHaveLength(1);
  });

  test('@flow E35 efeitos "Falhou" dao NotRevertible; com outro aditivo aberto, AnotherOpen destaca o aberto; o nao assinado so mostra "Cancelar aditivo"', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    // CE-03 — o aditivo formalizado com os efeitos "Falhou".
    const failedSetup = await setupManuallyFormalizedContract(authApi, tenant.tenantId);
    const failedProposal = await apiProposeContractChange(authApi, failedSetup.eventId, 'Cliente pediu outro local', {
      location: `Salao proposto ${Date.now()}`,
    });
    setEventLocationDirect(failedSetup.eventId, `Chacara mudada antes ${Date.now()}`);
    await apiFormalizeAddendumManually(authApi, failedProposal.addendumId);
    expect((await waitForAddendumEffects(authApi, failedProposal.addendumId)).effectsStatus).toBe('Failed');
    const notRevertible = await apiTryGetReversalDraft(authApi, failedProposal.addendumId);
    expect(notRevertible.status()).toBe(409);
    expect((await apiErrorBody(notRevertible)).codes).toContain('Addendums.NotRevertible');
    await apiCompleteOnboarding(authApi);
    await openContractTab(authPage, failedSetup.eventId);
    await expect(authPage.getByTestId(`addendum-apply-effects-${failedProposal.addendumId}`)).toBeVisible();
    await expect(authPage.getByTestId(`addendum-revert-${failedProposal.addendumId}`)).toHaveCount(0);

    // CE-04 — o #1 aplicado e o #2 aberto: "Desfazer" no #1 destaca o #2 e não abre a janela.
    const { eventId } = await setupManuallyFormalizedContract(authApi, tenant.tenantId);
    const original = await eventFacts(authApi, eventId);
    const first = await appliedAddendum(authApi, eventId, 'Cliente pediu outra data', {
      eventDate: addDays(original.eventDate, 7),
    });
    const open = await apiProposeContractChange(authApi, eventId, 'Cliente pediu outro local', {
      location: `Salao aberto ${Date.now()}`,
    });
    const anotherOpen = await apiTryGetReversalDraft(authApi, first.id);
    expect(anotherOpen.status()).toBe(409);
    const anotherOpenBody = await apiErrorBody(anotherOpen);
    expect(anotherOpenBody.codes).toContain('Addendums.AnotherOpen');
    expect(JSON.stringify(anotherOpenBody.data), 'o aberto no data do 409').toContain(open.addendumId);

    await openContractTab(authPage, eventId);
    await authPage.getByTestId(`addendum-revert-${first.id}`).click();
    await expect(
      snack(authPage, `O aditivo #${open.addendumNumber} ainda está aberto neste contrato. Corrija-o ou cancele-o antes de criar outro.`),
    ).toBeVisible({ timeout: 30_000 });
    await expect(authPage.getByTestId(`addendum-item-${open.addendumId}`)).toHaveClass(/highlighted/);
    await expect(authPage.getByTestId('addendum-editor-title')).toHaveCount(0);

    // CE-07 — o aberto, já enviado ao cliente: só "Cancelar aditivo", e a API recusa o estorno.
    await apiSendAddendum(authApi, open.addendumId);
    await openContractTab(authPage, eventId);
    await expect(authPage.getByTestId(`addendum-status-${open.addendumId}`)).toContainText('Enviado');
    await expect(authPage.getByTestId(`addendum-cancel-${open.addendumId}`)).toContainText('Cancelar aditivo');
    await expect(authPage.getByTestId(`addendum-revert-${open.addendumId}`)).toHaveCount(0);
    const notSigned = await apiTryGetReversalDraft(authApi, open.addendumId);
    expect(notSigned.status()).toBe(409);
    expect((await apiErrorBody(notSigned)).codes).toContain('Addendums.NotRevertible');

    // CE-04 passo 2 — cancelado o #2, "Desfazer" no #1 abre a janela.
    await assertOk(
      await authApi.post(`/api/addendums/${open.addendumId}/cancel`, { data: { reason: 'Cliente desistiu do local' } }),
      'POST cancel',
    );
    await openContractTab(authPage, eventId);
    await authPage.getByTestId(`addendum-revert-${first.id}`).click();
    await expect(authPage.getByTestId('addendum-editor-title')).toHaveText(`Estorno do aditivo #${first.number}`, {
      timeout: 30_000,
    });
  });

  test('@flow E36 sem events.update e sem contracts.read nao ve "Desfazer" e recebe 403 nas duas portas; outra empresa da 404 em todas, sem nada criado', async ({
    authApi,
    browser,
    tenant,
  }) => {
    const { eventId, contractId } = await setupManuallyFormalizedContract(authApi, tenant.tenantId);
    const original = await eventFacts(authApi, eventId);
    const first = await appliedAddendum(authApi, eventId, 'Cliente pediu outra data', {
      eventDate: addDays(original.eventDate, 7),
    });
    const draft = await apiGetReversalDraft(authApi, first.id);
    const countBefore = (await apiListContractAddendums(authApi, contractId)).length;

    // CE-08 — o Financeiro (sem `events.update` e sem `contracts.read`).
    const financial = await loginAsRole(tenant.tenantId, 'Financial');
    try {
      const byEvent = await apiTryProposeContractChange(financial.api, eventId, 'Sem permissao', draft.change!);
      expect(byEvent.status(), 'estorno pela festa sem events.update').toBe(403);
      const byContract = await financial.api.post(`/api/contracts/${contractId}/addendums`, {
        data: { reason: 'Sem permissao', revertsAddendumId: first.id },
      });
      expect(byContract.status(), 'estorno pelo contrato sem contracts.manage').toBe(403);
      expect((await apiTryGetReversalDraft(financial.api, first.id)).status(), 'reversal-draft sem contracts.read').toBe(403);
      const page = await openSessionPage(browser, financial.tokens);
      try {
        await page.page.goto(`/app/events/${eventId}`);
        await expect(page.page.getByTestId('event-detail-fact-date')).toBeVisible({ timeout: 30_000 });
        await expect(page.page.getByTestId(`addendum-revert-${first.id}`)).toHaveCount(0);
      } finally {
        await page.context.close();
      }
    } finally {
      await financial.api.dispose();
    }

    // CE-09 — outra empresa: 404 no reversal-draft e nas duas portas.
    const other = await signupNewTenant();
    const apiB = await createBearerApiContext(other.accessToken);
    try {
      expect((await apiTryGetReversalDraft(apiB, first.id)).status(), 'reversal-draft').toBe(404);
      expect(
        (await apiTryProposeContractChange(apiB, eventId, 'Invasao', draft.change!)).status(),
        'estorno pela festa de outra empresa',
      ).toBe(404);
      const byContract = await apiB.post(`/api/contracts/${contractId}/addendums`, {
        data: { reason: 'Invasao', revertsAddendumId: first.id },
      });
      expect(byContract.status(), 'estorno pelo contrato de outra empresa').toBe(404);
    } finally {
      await apiB.dispose();
    }
    expect(await apiListContractAddendums(authApi, contractId), 'nada criado no tenant dono').toHaveLength(countBefore);
    expect(await reversalsOf(authApi, contractId, first.id)).toHaveLength(0);
  });
});
