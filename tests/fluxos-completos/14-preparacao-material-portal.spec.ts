import type { APIRequestContext } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import {
  PreparationStepInput,
  apiCompleteOnboarding,
  apiCreateCollaborator,
  apiCreateProduct,
  apiSetSettingParameter,
} from '../../helpers/api-entities';
import { apiAssignCollaborator, apiPatchEvent } from '../../helpers/api-event-flow';
import { enableFeatureFlagDirect, seedWhatsappChannelDirect } from '../../helpers/db-helper';
import { fakeWhatsApp } from '../../helpers/fake-providers';
import {
  TRIGGER_TIMEOUT,
  apiTriggerDailyJob,
  setupConfirmedPortalCollaborator,
  tenantDayPlus,
  uniqueSuffix,
} from '../../helpers/rain-plan';
import { apiErrorCodes, assertOk, readJson } from '../../helpers/response';
import {
  loginAsRole,
  loginPortalCollaborator,
  openSessionPage,
  portalDeclineEvent,
  setupAcceptedEvent,
} from '../../helpers/setup-flows';

/**
 * Fluxo: 14 — Preparação dos produtos reutilizáveis no checklist de material
 * Diagrama: — (o plano é a fonte: PLANO-PREPARACAO-DE-EQUIPAMENTOS §9, PE-G;
 * decisão 14)
 *
 * E8: o colaborador escalado marca os passos de preparação do reutilizável no
 * Portal e só então o item; escala recusada ou cancelada leva 403.
 *
 * E25: o reutilizável com passos, vinculado a uma atividade contratada, leva os
 * passos ao item de material da festa na próxima mudança do evento; o gestor
 * não marca o item com passo obrigatório pendente e libera com "Não se aplica"
 * e motivo; reabrir o passo obrigatório devolve o item conferido a pendente; o
 * lembrete D-2 (WhatsApp fake) cita a preparação pendente; o Financeiro vê os
 * passos sem poder marcar e leva 403 no `complete`/`reopen` pela API; o passo
 * de festa de outro tenant dá 404.
 */

interface PreparationCheck {
  id: string;
  title: string;
  isMandatory: boolean;
  status: 'Pending' | 'Done' | 'NotApplicable';
}

interface MaterialItem {
  id: string;
  title: string;
  productId: string | null;
  status: 'Pending' | 'Checked' | 'Skipped';
  preparation: PreparationCheck[];
  preparationPending: number;
}

const BALL_PIT_STEPS: PreparationStepInput[] = [
  { title: 'Lavar as bolinhas', category: 'Cleaning', isMandatory: true },
  { title: 'Conferir a rede de proteção', category: 'Safety', isMandatory: true },
  { title: 'Secar ao sol', category: 'Cleaning', isMandatory: false },
];

async function materialItemOf(api: APIRequestContext, eventId: string, productId: string): Promise<MaterialItem> {
  const res = await api.get(`/api/events/${eventId}/material-checklist`);
  await assertOk(res, 'GET material-checklist');
  const checklist = await readJson<{ groups: Array<{ items: MaterialItem[] }> }>(res);
  const item = checklist.groups.flatMap((g) => g.items).find((i) => i.productId === productId);
  if (!item) throw new Error(`o produto ${productId} não está no checklist de material da festa`);
  return item;
}

function adminStep(
  api: APIRequestContext,
  eventId: string,
  itemId: string,
  checkId: string,
  action: 'complete' | 'reopen',
  body?: { status: 'Done' | 'NotApplicable'; notes?: string | null },
) {
  return api.post(`/api/events/${eventId}/material-checklist/items/${itemId}/preparation/${checkId}/${action}`, {
    data: body ?? {},
  });
}

function portalStep(
  api: APIRequestContext,
  eventId: string,
  itemId: string,
  checkId: string,
  action: 'complete' | 'reopen',
  body?: { status: 'Done' | 'NotApplicable'; notes?: string | null },
) {
  return api.post(
    `/api/portal/my-events/${eventId}/material-checklist/items/${itemId}/preparation/${checkId}/${action}`,
    { data: body ?? {} },
  );
}

/**
 * Festa aceita com uma atividade sem material; DEPOIS o reutilizável com os
 * passos é vinculado a ela e a festa muda (crianças), que é quando o item de
 * material recebe os passos (§9 item 2).
 */
async function partyWithBallPit(
  api: APIRequestContext,
  eventDate: string,
): Promise<{ eventId: string; product: { id: string; name: string }; item: MaterialItem }> {
  const { eventId, atividadeId } = await setupAcceptedEvent(api, {
    budget: { eventDate, childrenCount: 15, startTime: '14:00', endTime: '18:00' },
  });
  const product = await apiCreateProduct(api, {
    name: `Piscina de bolinhas ${uniqueSuffix()}`,
    isReusable: true,
    unitCost: 300,
    activityProducts: [{ activityId: atividadeId, qtyPerChild: 0, isChecklistOnly: true }],
    preparationSteps: BALL_PIT_STEPS,
  });
  await apiPatchEvent(api, eventId, { childrenCount: 18 });
  return { eventId, product: { id: product.id, name: product.name }, item: await materialItemOf(api, eventId, product.id) };
}

test.describe('Fluxo 14 — Preparação do material reutilizável', () => {
  test('@flow E8: the assigned collaborator marks the reusable preparation steps in the Portal and only then the item; declined or canceled assignment gets 403', async ({
    authApi,
    browser,
    tenant,
  }) => {
    test.setTimeout(240_000);
    const { eventId, product, item } = await partyWithBallPit(authApi, tenantDayPlus(10));
    const mandatory = item.preparation.filter((c) => c.isMandatory);
    const optional = item.preparation.find((c) => !c.isMandatory)!;

    const team = await setupConfirmedPortalCollaborator(authApi, tenant.tenantId, eventId);
    // O Portal só recusa a escala ainda `Pending`: este é escalado sem confirmar.
    const declinedCollaborator = await apiCreateCollaborator(authApi);
    await apiAssignCollaborator(authApi, eventId, declinedCollaborator.id, { isLeader: false });
    const declined = {
      collaboratorId: declinedCollaborator.id,
      portal: await loginPortalCollaborator(tenant.tenantId, declinedCollaborator.id),
    };
    const canceled = await setupConfirmedPortalCollaborator(authApi, tenant.tenantId, eventId, { isLeader: false });
    try {
      // §9 item 4: com passo obrigatório pendente o item não se marca.
      const early = await team.portal.api.post(
        `/api/portal/my-events/${eventId}/material-checklist/items/${item.id}/check`,
        { data: {} },
      );
      expect(early.status()).toBe(409);
      expect(await apiErrorCodes(early)).toContain('MaterialChecklist.PreparationPending');
      expect(JSON.stringify(await early.json())).toContain(`Faltam 2 passos de preparação de ${product.name}`);

      // Pela tela do Portal: os passos sob o item, depois o item.
      const view = await openSessionPage(browser, team.portal.tokens);
      try {
        await view.page.goto(`/portal/events/${eventId}/material-checklist`);
        await expect(view.page.getByTestId(`portal-material-item-${item.id}`)).toBeVisible({ timeout: 20_000 });
        await expect(view.page.getByTestId(`portal-material-item-prep-blocked-${item.id}`)).toBeVisible();
        const list = view.page.getByTestId(`portal-material-prep-list-${item.id}`);
        if (!(await list.isVisible())) await view.page.getByTestId(`portal-material-item-prep-toggle-${item.id}`).click();
        for (const step of mandatory) {
          await view.page.getByTestId(`portal-material-prep-done-${step.id}`).click();
          await expect(view.page.getByTestId(`portal-material-prep-reopen-${step.id}`)).toBeVisible({ timeout: 20_000 });
        }
        await expect(view.page.getByTestId(`portal-material-item-prep-blocked-${item.id}`)).toHaveCount(0);
        await view.page.getByTestId(`portal-material-item-checkbox-${item.id}`).click();
        await expect.poll(async () => (await materialItemOf(authApi, eventId, product.id)).status).toBe('Checked');
      } finally {
        await view.context.close();
      }
      const marked = await materialItemOf(authApi, eventId, product.id);
      expect(marked.preparation.filter((c) => c.isMandatory).every((c) => c.status === 'Done')).toBe(true);

      // §9 item 3: escala recusada e escala cancelada não escrevem (regra de hoje, 403).
      await portalDeclineEvent(declined.portal.api, eventId);
      const byDeclined = await portalStep(declined.portal.api, eventId, item.id, optional.id, 'complete', {
        status: 'Done',
      });
      expect(byDeclined.status(), 'escala recusada').toBe(403);
      expect(await apiErrorCodes(byDeclined)).toContain('Portal.NotAssigned');
      const reopenByDeclined = await portalStep(declined.portal.api, eventId, item.id, mandatory[0]!.id, 'reopen');
      expect(reopenByDeclined.status(), 'reabrir com a escala recusada').toBe(403);

      const after = await materialItemOf(authApi, eventId, product.id);
      expect(after.preparation.find((c) => c.id === optional.id)!.status, 'nada gravado').toBe('Pending');
      expect(after.status).toBe('Checked');

      // Escala `Canceled`: o produto a produz no cancelamento da festa
      // (`Event.Cancel` cancela a equipe ativa); a remoção da escala apaga a
      // linha e vira "não escalado" (404), outro caso. Por último, porque a
      // festa sai do ar.
      await assertOk(
        await authApi.post(`/api/events/${eventId}/cancel`, { data: { reason: 'Cliente desistiu (E2E)' } }),
        'cancelar a festa',
      );
      const byCanceled = await portalStep(canceled.portal.api, eventId, item.id, optional.id, 'complete', {
        status: 'Done',
      });
      expect(byCanceled.status(), 'escala cancelada').toBe(403);
      expect(await apiErrorCodes(byCanceled)).toContain('Portal.NotAssigned');
    } finally {
      for (const t of [team, declined, canceled]) await t.portal.api.dispose();
    }
  });

  test('@flow E25: product steps reach the party item on the next event change; manager cannot check with a mandatory step pending, "Não se aplica" with a reason releases it, reopening sends it back to pending; the D-2 reminder cites the pending preparation; Financial sees the steps read-only and gets 403; another tenant gets 404', async ({
    authApi,
    authPage,
    browser,
    tenant,
  }) => {
    test.setTimeout(TRIGGER_TIMEOUT + 300_000);
    await apiCompleteOnboarding(authApi);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_whatsapp');
    const phoneNumberId = seedWhatsappChannelDirect(tenant.tenantId);
    await apiSetSettingParameter(authApi, 'EVENT_MATERIAL_CHECKLIST_REMINDER_DAYS', 2);

    // §9 item 2: os passos chegam ao item na próxima mudança da festa.
    const { eventId, product, item } = await partyWithBallPit(authApi, tenantDayPlus(2));
    expect(item.preparation.map((c) => [c.title, c.isMandatory, c.status])).toEqual([
      ['Lavar as bolinhas', true, 'Pending'],
      ['Conferir a rede de proteção', true, 'Pending'],
      ['Secar ao sol', false, 'Pending'],
    ]);
    expect(item.preparationPending).toBe(2);
    const [wash, net] = item.preparation.filter((c) => c.isMandatory) as [PreparationCheck, PreparationCheck];

    // §9 item 4 (decisão 14): o gestor não marca o item com obrigatório pendente.
    const blocked = await authApi.post(`/api/events/${eventId}/material-checklist/items/${item.id}/check`, {
      data: {},
    });
    expect(blocked.status()).toBe(409);
    expect(await apiErrorCodes(blocked)).toContain('MaterialChecklist.PreparationPending');
    expect(JSON.stringify(await blocked.json())).toContain(`Faltam 2 passos de preparação de ${product.name}`);

    // §9 item 5: o lembrete D-2 cita a preparação pendente (WhatsApp fake, janela aberta).
    const phone = `+55419${String(Date.now()).slice(-7)}6`;
    const team = await setupConfirmedPortalCollaborator(authApi, tenant.tenantId, eventId, { phone });
    const hook = await fakeWhatsApp.triggerWebhook({ kind: 'inbound', phoneNumberId, phone, text: 'Oi, sou da equipe' });
    expect(hook.backStatus, `webhook inbound: ${hook.backBody}`).toBe(200);
    const financial = await loginAsRole(tenant.tenantId, 'Financial');
    const other = await signupNewTenant();
    const otherApi = await createBearerApiContext(other.accessToken);
    try {
      await apiTriggerDailyJob(authApi);
      const digits = phone.replace(/\D/g, '');
      await expect
        .poll(async () =>
          (await fakeWhatsApp.inbox({ path: '/messages' }))
            .map((e) => JSON.stringify(e.body))
            .filter((body) => body.includes(digits) && body.includes('Preparação pendente') && body.includes(product.name))
            .length,
        )
        .toBeGreaterThan(0);

      // Financeiro de verdade: lê os passos, não marca nem reabre (403).
      const finComplete = await adminStep(financial.api, eventId, item.id, wash.id, 'complete', { status: 'Done' });
      expect(finComplete.status(), 'Financial complete').toBe(403);
      const finReopen = await adminStep(financial.api, eventId, item.id, wash.id, 'reopen');
      expect(finReopen.status(), 'Financial reopen').toBe(403);
      const session = await openSessionPage(browser, financial.tokens);
      try {
        await session.page.goto(`/app/events/${eventId}`);
        await session.page.getByRole('tab', { name: 'Checklist', exact: true }).click();
        await expect(session.page.getByTestId(`material-checklist-item-${item.id}`)).toBeVisible({ timeout: 20_000 });
        const finList = session.page.getByTestId(`material-checklist-prep-list-${item.id}`);
        if (!(await finList.isVisible())) {
          await session.page.getByTestId(`material-checklist-item-prep-toggle-${item.id}`).click();
        }
        await expect(session.page.getByTestId(`material-checklist-prep-${wash.id}`)).toBeVisible();
        await expect(session.page.getByTestId(`material-checklist-prep-${wash.id}`)).toContainText('Lavar as bolinhas');
        await expect(session.page.getByTestId(`material-checklist-prep-done-${wash.id}`)).toHaveCount(0);
        await expect(session.page.getByTestId(`material-checklist-prep-na-${wash.id}`)).toHaveCount(0);
      } finally {
        await session.context.close();
      }

      // Cross-tenant: o passo da festa de outro tenant dá 404 e nada muda.
      const alien = await adminStep(otherApi, eventId, item.id, wash.id, 'complete', { status: 'Done' });
      expect(alien.status(), 'passo de festa de outro tenant').toBe(404);
      expect((await materialItemOf(authApi, eventId, product.id)).preparation.every((c) => c.status === 'Pending')).toBe(
        true,
      );

      // O gestor pela tela: "Feito" no primeiro obrigatório.
      await authPage.goto(`/app/events/${eventId}`);
      await authPage.getByRole('tab', { name: 'Checklist', exact: true }).click();
      await expect(authPage.getByTestId(`material-checklist-item-${item.id}`)).toBeVisible({ timeout: 20_000 });
      await expect(authPage.getByTestId(`material-checklist-item-prep-blocked-${item.id}`)).toBeVisible();
      const adminList = authPage.getByTestId(`material-checklist-prep-list-${item.id}`);
      if (!(await adminList.isVisible())) {
        await authPage.getByTestId(`material-checklist-item-prep-toggle-${item.id}`).click();
      }
      await authPage.getByTestId(`material-checklist-prep-done-${wash.id}`).click();
      await expect(authPage.getByTestId(`material-checklist-prep-reopen-${wash.id}`)).toBeVisible({ timeout: 20_000 });

      // "Não se aplica" no obrigatório exige o motivo; com ele, libera o item.
      const withoutNote = await adminStep(authApi, eventId, item.id, net.id, 'complete', { status: 'NotApplicable' });
      expect(withoutNote.status(), '"Não se aplica" sem motivo').toBe(400);
      await assertOk(
        await adminStep(authApi, eventId, item.id, net.id, 'complete', {
          status: 'NotApplicable',
          notes: 'Rede trocada ontem',
        }),
        'NotApplicable com motivo',
      );
      await assertOk(
        await authApi.post(`/api/events/${eventId}/material-checklist/items/${item.id}/check`, { data: {} }),
        'check depois dos passos (o opcional não segura)',
      );
      expect((await materialItemOf(authApi, eventId, product.id)).status).toBe('Checked');

      // Reabrir um obrigatório devolve o item conferido a pendente.
      await assertOk(await adminStep(authApi, eventId, item.id, wash.id, 'reopen'), 'reopen');
      const reopened = await materialItemOf(authApi, eventId, product.id);
      expect(reopened.preparation.find((c) => c.id === wash.id)!.status).toBe('Pending');
      expect(reopened.status, 'o item volta a pendente').toBe('Pending');
    } finally {
      await team.portal.api.dispose();
      await financial.api.dispose();
      await otherApi.dispose();
    }
  });
});
