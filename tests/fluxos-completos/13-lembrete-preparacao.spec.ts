import type { APIRequestContext } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import { NotificationItem, apiCreateCollaborator, apiListNotifications } from '../../helpers/api-entities';
import { enableFeatureFlagDirect, seedWhatsappChannelDirect } from '../../helpers/db-helper';
import { fakeWhatsApp } from '../../helpers/fake-providers';
import { TRIGGER_TIMEOUT, apiTriggerDailyJob, tenantDayPlus } from '../../helpers/rain-plan';
import {
  apiGetRentalPreparation,
  apiListPendingAcknowledgement,
  preparationChecks,
  scheduleRentalPreparation,
  setupReservedRental,
} from '../../helpers/rental-preparation';
import { apiErrorCodes, assertOk, readJson } from '../../helpers/response';
import {
  loginAsRole,
  loginPortalCollaborator,
  openSessionPage,
  RoleSession,
} from '../../helpers/setup-flows';

/**
 * Fluxo: 13 — Lembrete D-7, data da manutenção e acompanhamento da preparação
 * Diagrama: — (o plano é a fonte: PLANO-PREPARACAO-DE-EQUIPAMENTOS §6, PE-D;
 * §5 para a ciência; decisões 13, 15 e 16)
 *
 * E3: locação com entrega em 7 dias gera o aviso D-7 que não sai da fila sem
 * ciência; o gestor marca a data e o responsável; no dia, o acompanhamento
 * pergunta e "adiada para…" grava o histórico; véspera com pendência vira
 * lembrete.
 *
 * E19: o gestor marca a data com o responsável e o aviso chega a ele pelo
 * Portal e pelo WhatsApp (fake); o recreador responsável abre "Preparação dos
 * brinquedos" pelo card do Início, marca os itens e responde "Foi executada?";
 * outro colaborador do mesmo tenant recebe 404 e a preparação de outro tenant
 * não aparece; o Financeiro leva 403 ao marcar a data; tenant sem o add-on não
 * vê o atalho nem a página.
 */

/** Os avisos do usuário de um tipo, sobre uma locação. */
async function noticesOf(api: APIRequestContext, type: string, rentalId: string): Promise<NotificationItem[]> {
  return (await apiListNotifications(api)).filter((n) => n.type === type && n.contextEntityId === rentalId);
}

/** GET /api/portal/rental-preparations — a lista do responsável (array ou página). */
async function portalPreparationIds(api: APIRequestContext): Promise<string[]> {
  const res = await api.get('/api/portal/rental-preparations');
  await assertOk(res, 'GET /api/portal/rental-preparations');
  const data = await readJson<Array<{ rentalId: string }> | { items: Array<{ rentalId: string }> }>(res);
  return (Array.isArray(data) ? data : data.items).map((i) => i.rentalId);
}

const LEVAR_REQUIREMENTS = [
  { name: 'carregador', category: 'Equipment' as const, isMandatory: true },
  { name: 'extensão', category: 'Power' as const, isMandatory: true },
  { name: 'microfone', category: 'Accessory' as const, isMandatory: true },
];

test.describe('Fluxo 13 — Lembrete da preparação dos brinquedos', () => {
  test('@flow E3: the D-7 notice stays until acknowledged; scheduling the date with a responsible acknowledges it; on the day the follow-up asks "Foi executada?" and "adiada para…" records the history; the eve of delivery with pending items becomes a reminder', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(TRIGGER_TIMEOUT + 240_000);
    const today = tenantDayPlus(0);

    // A: entrega em 7 dias, com brinquedo a limpar e revisar (§6 itens 2 e 3).
    const a = await setupReservedRental(authApi, tenant.tenantId, { deliveryDate: tenantDayPlus(7) });
    // B: entrega amanhã, manutenção pendente; C: entrega amanhã, só "Levar".
    const b = await setupReservedRental(authApi, tenant.tenantId, {
      deliveryDate: tenantDayPlus(1),
      enableAddOn: false,
    });
    const c = await setupReservedRental(authApi, tenant.tenantId, {
      deliveryDate: tenantDayPlus(1),
      steps: [],
      requirements: LEVAR_REQUIREMENTS,
      enableAddOn: false,
    });

    // §6 item 3: reservada dentro da janela, o aviso 35 nasce na transição, com ciência.
    const [due] = await noticesOf(authApi, 'RentalPreparationDue', a.rental.id);
    expect(due, 'aviso D-7 ao gestor na reserva').toBeTruthy();
    expect(due!.requiresAcknowledgement).toBe(true);
    expect(due!.acknowledgedAt ?? null).toBeNull();
    expect(due!.message).toContain(a.rental.rentalNumber);
    expect(due!.message).toContain('Marque a data da manutenção');

    // Decisão 16: só "Levar" não tem D-7.
    expect(await noticesOf(authApi, 'RentalPreparationDue', c.rental.id), 'só "Levar": sem D-7').toHaveLength(0);

    // §5 itens 2 e 3: não sai da fila sem ciência.
    expect((await apiListPendingAcknowledgement(authApi)).map((n) => n.id)).toContain(due!.id);
    await assertOk(await authApi.post('/api/notifications/mark-all-read'), 'mark-all-read');
    const stillPending = (await noticesOf(authApi, 'RentalPreparationDue', a.rental.id))[0]!;
    expect(stillPending.acknowledgedAt ?? null, 'marcar todos como lidos não dá ciência').toBeNull();
    expect((await apiListPendingAcknowledgement(authApi)).map((n) => n.id)).toContain(due!.id);
    const dismiss = await authApi.post(`/api/notifications/${due!.id}/dismiss`);
    expect(dismiss.status(), 'dispensar antes da ciência').toBe(409);
    expect(await apiErrorCodes(dismiss)).toContain('Notification.AcknowledgementPending');

    // §6 item 4: o gestor marca a data (hoje) e o responsável; marcar dá ciência ao 35.
    const responsible = await apiCreateCollaborator(authApi);
    const portal = await loginPortalCollaborator(tenant.tenantId, responsible.id);
    try {
      const outOfRange = await scheduleRentalPreparation(authApi, a.rental.id, { date: tenantDayPlus(8) });
      expect(outOfRange.status(), 'data depois da entrega').toBe(400);
      expect(await apiErrorCodes(outOfRange)).toContain('RentalPreparation.ScheduleOutOfRange');

      await assertOk(
        await scheduleRentalPreparation(authApi, a.rental.id, {
          date: today,
          responsibleCollaboratorId: responsible.id,
          notifyChannels: ['Portal'],
        }),
        'schedule',
      );
      const scheduled = await apiGetRentalPreparation(authApi, a.rental.id);
      expect(scheduled.status).toBe('Scheduled');
      expect(scheduled.scheduledFor).toBe(today);
      expect(scheduled.responsibleCollaboratorId).toBe(responsible.id);
      expect(scheduled.entries.map((e) => e.kind)).toContain('Scheduled');

      const acknowledged = (await noticesOf(authApi, 'RentalPreparationDue', a.rental.id))[0]!;
      expect(acknowledged.acknowledgedAt, 'marcar a data dá ciência ao 35').toBeTruthy();
      expect((await apiListPendingAcknowledgement(authApi)).map((n) => n.id)).not.toContain(due!.id);

      // O ciclo diário (§6 itens 2, 5 e 7).
      await apiTriggerDailyJob(authApi);

      // D-7 uma vez só: o ciclo não repete o 35 já enviado na reserva.
      expect(await noticesOf(authApi, 'RentalPreparationDue', a.rental.id), '35 uma vez por preparação').toHaveLength(1);

      // §6 item 5: no dia marcado, o acompanhamento pergunta aos gestores e ao responsável.
      const [followUp] = await noticesOf(authApi, 'RentalPreparationFollowUp', a.rental.id);
      expect(followUp, 'acompanhamento ao gestor no dia marcado').toBeTruthy();
      expect(followUp!.message).toContain(a.rental.rentalNumber);
      expect(followUp!.message).toContain('Foi executada?');
      await expect
        .poll(async () => (await noticesOf(portal.api, 'RentalPreparationFollowUp', a.rental.id)).length)
        .toBeGreaterThan(0);

      // §6 item 7: véspera com manutenção pendente.
      const [eveB] = await noticesOf(authApi, 'RentalDispatchEve', b.rental.id);
      expect(eveB, 'véspera da entrega com a preparação aberta').toBeTruthy();
      expect(eveB!.message).toContain(
        `Entrega amanhã e a preparação dos brinquedos da ${b.rental.rentalNumber} não terminou.`,
      );
      expect(eveB!.requiresAcknowledgement ?? false, 'o 37 é sem ciência').toBe(false);

      // Decisão 16: só "Levar" recebe só a véspera, com a lista do que separar.
      const [eveC] = await noticesOf(authApi, 'RentalDispatchEve', c.rental.id);
      expect(eveC, 'véspera da locação só de "Levar"').toBeTruthy();
      expect(eveC!.message).toContain(`Amanhã sai a locação ${c.rental.rentalNumber}: separe`);
      for (const r of LEVAR_REQUIREMENTS) expect(eveC!.message).toContain(r.name);
      expect(await noticesOf(authApi, 'RentalPreparationFollowUp', c.rental.id)).toHaveLength(0);

      // §6 item 6: "adiada para…" grava o histórico com a data anterior e a nova.
      const newDate = tenantDayPlus(3);
      await assertOk(
        await authApi.post(`/api/rentals/${a.rental.id}/preparation/follow-up`, {
          data: { outcome: 'Postponed', newDate, reason: 'Chuva no dia', markAllChecksDone: false },
        }),
        'follow-up Postponed',
      );
      const postponed = await apiGetRentalPreparation(authApi, a.rental.id);
      expect(postponed.status).toBe('Scheduled');
      expect(postponed.scheduledFor).toBe(newDate);
      expect(postponed.postponeCount).toBe(1);
      const entry = postponed.entries.find((e) => e.kind === 'Postponed');
      expect(entry, 'linha "Adiada" no histórico').toBeTruthy();
      expect(entry!.previousDate).toBe(today);
      expect(entry!.date).toBe(newDate);
    } finally {
      await portal.api.dispose();
    }
  });

  test('@flow E19: the responsible gets the scheduled preparation by Portal and WhatsApp, opens it from the Home card, marks items and answers "Foi executada?"; another collaborator gets 404, another tenant does not see it, Financial gets 403 scheduling, a tenant without the add-on sees neither the shortcut nor the page', async ({
    authApi,
    browser,
    tenant,
  }) => {
    test.setTimeout(300_000);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_whatsapp');
    const phoneNumberId = seedWhatsappChannelDirect(tenant.tenantId);
    const today = tenantDayPlus(0);

    const { rental } = await setupReservedRental(authApi, tenant.tenantId, { deliveryDate: tenantDayPlus(7) });

    // O responsável tem Portal e WhatsApp; ele já falou com o número da empresa,
    // então a janela de 24 h está aberta e o texto livre sai.
    const phone = `+55419${String(Date.now()).slice(-7)}5`;
    const responsible = await apiCreateCollaborator(authApi, { phone });
    const portal = await loginPortalCollaborator(tenant.tenantId, responsible.id);
    const hook = await fakeWhatsApp.triggerWebhook({ kind: 'inbound', phoneNumberId, phone, text: 'Oi, sou da equipe' });
    expect(hook.backStatus, `webhook inbound: ${hook.backBody}`).toBe(200);

    const sessions: RoleSession[] = [portal];
    try {
      // Financeiro de verdade não marca a data (§6, testes de permissão).
      const financial = await loginAsRole(tenant.tenantId, 'Financial');
      sessions.push(financial);
      const forbidden = await scheduleRentalPreparation(financial.api, rental.id, {
        date: today,
        responsibleCollaboratorId: responsible.id,
      });
      expect(forbidden.status(), 'Financial não marca a data').toBe(403);

      // §6 item 4: marcar com responsável e canais encaminha o aviso.
      await assertOk(
        await scheduleRentalPreparation(authApi, rental.id, {
          date: today,
          responsibleCollaboratorId: responsible.id,
          notifyChannels: ['Portal', 'WhatsApp'],
        }),
        'schedule com encaminhamento',
      );

      // Portal: o aviso encaminhado (33) sobre a locação, com ciência.
      await expect
        .poll(async () =>
          (await apiListNotifications(portal.api)).filter(
            (n) => n.type === 'NoticeForwarded' && n.forwardedType === 'RentalPreparationDue',
          ).length,
        )
        .toBeGreaterThan(0);
      const forwarded = (await apiListNotifications(portal.api)).find(
        (n) => n.type === 'NoticeForwarded' && n.forwardedType === 'RentalPreparationDue',
      )!;
      expect(forwarded.requiresAcknowledgement).toBe(true);
      expect(`${forwarded.title} ${forwarded.message}`).toContain(rental.rentalNumber);

      // WhatsApp (fake): o texto do aviso chega ao telefone do responsável.
      const digits = phone.replace(/\D/g, '');
      await expect
        .poll(async () =>
          (await fakeWhatsApp.inbox({ path: '/messages' }))
            .map((e) => JSON.stringify(e.body))
            .filter((body) => body.includes(digits) && body.includes(rental.rentalNumber)).length,
        )
        .toBeGreaterThan(0);

      // §6 item 12: o card "Preparação dos brinquedos" do Início abre a página.
      const prep = await apiGetRentalPreparation(authApi, rental.id);
      const mandatory = preparationChecks(prep).filter((c) => c.isMandatory);
      const view = await openSessionPage(browser, portal.tokens);
      try {
        await view.page.goto('/portal');
        const homeCard = view.page.getByTestId('home-card-rental-preparations');
        await expect(homeCard).toBeVisible({ timeout: 20_000 });
        // O card do Portal é denso: sem recolher, a lista está sempre à vista.
        const entry = view.page.getByTestId(`portal-home-rental-preparation-${rental.id}`);
        await expect(entry).toContainText(rental.rentalNumber);
        await entry.getByRole('link').click();
        await view.page.waitForURL(new RegExp(`/portal/rental-preparations/${rental.id}`));
        await expect(view.page.getByTestId('portal-rental-preparation-summary')).toBeVisible({ timeout: 20_000 });

        // Marca o primeiro obrigatório pela tela.
        await view.page.getByTestId(`portal-rental-preparation-done-${mandatory[0]!.id}`).click();
        await expect(view.page.getByTestId(`portal-rental-preparation-check-status-${mandatory[0]!.id}`)).toHaveText(
          'Feito',
        );

        // "Foi executada?" com item por fazer: a tela pede a confirmação (409
        // ChecksPending do back) e o "fiz todos" fecha a preparação.
        await view.page.getByTestId('portal-rental-preparation-outcome-Executed').click();
        await view.page.getByTestId('portal-rental-preparation-follow-up-send').click();
        await expect(view.page.getByTestId('portal-rental-preparation-pending-checks')).toContainText(
          mandatory[1]!.title,
        );
        await view.page.getByTestId('portal-rental-preparation-confirm-all').click();
        await expect(view.page.getByTestId('portal-rental-preparation-follow-up-done')).toBeVisible({ timeout: 20_000 });
      } finally {
        await view.context.close();
      }

      const executed = await apiGetRentalPreparation(authApi, rental.id);
      expect(executed.status).toBe('Done');
      expect(executed.entries.map((e) => e.kind)).toContain('Executed');
      expect(preparationChecks(executed).filter((c) => c.isMandatory).every((c) => c.status === 'Done')).toBe(true);

      // Outro colaborador do mesmo tenant: o mesmo 404 da preparação alheia.
      const other = await apiCreateCollaborator(authApi);
      const otherPortal = await loginPortalCollaborator(tenant.tenantId, other.id);
      sessions.push(otherPortal);
      const alien = await otherPortal.api.get(`/api/portal/rental-preparations/${rental.id}`);
      expect(alien.status(), 'preparação alheia').toBe(404);
      expect(await apiErrorCodes(alien)).toContain('RentalPreparation.NotFound');
      const alienWrite = await otherPortal.api.post(
        `/api/portal/rental-preparations/${rental.id}/checks/${mandatory[0]!.id}/complete`,
        { data: { status: 'Done', notes: null } },
      );
      expect(alienWrite.status(), 'marcar na preparação alheia').toBe(404);
      expect(await portalPreparationIds(otherPortal.api)).not.toContain(rental.id);

      // Outro tenant (com o add-on): a preparação não aparece.
      const otherTenant = await signupNewTenant();
      enableFeatureFlagDirect(otherTenant.tenantId, 'feature_equipment_rental');
      const otherAdmin = await createBearerApiContext(otherTenant.accessToken);
      try {
        const outsiderCollaborator = await apiCreateCollaborator(otherAdmin);
        const outsider = await loginPortalCollaborator(otherTenant.tenantId, outsiderCollaborator.id);
        sessions.push(outsider);
        expect(await portalPreparationIds(outsider.api)).not.toContain(rental.id);
        expect((await outsider.api.get(`/api/portal/rental-preparations/${rental.id}`)).status()).toBe(404);
      } finally {
        await otherAdmin.dispose();
      }

      // Tenant sem o add-on: nem o atalho do Perfil nem a página.
      const noAddOn = await signupNewTenant();
      const noAddOnAdmin = await createBearerApiContext(noAddOn.accessToken);
      try {
        const collaborator = await apiCreateCollaborator(noAddOnAdmin);
        const withoutAddOn = await loginPortalCollaborator(noAddOn.tenantId, collaborator.id);
        sessions.push(withoutAddOn);
        const gated = await withoutAddOn.api.get('/api/portal/rental-preparations');
        expect(gated.status(), 'sem o add-on').toBe(403);

        const page = await openSessionPage(browser, withoutAddOn.tokens);
        try {
          // O atalho do Perfil depende da resposta da lista: espera o 403 antes de afirmar.
          const listAnswered = page.page.waitForResponse((r) => r.url().includes('/api/portal/rental-preparations'));
          await page.page.goto('/portal/profile');
          expect((await listAnswered).status()).toBe(403);
          await expect(page.page.getByTestId('portal-profile-rental-preparations-link')).toHaveCount(0);
          await page.page.goto('/portal');
          await expect(page.page.getByTestId('home-card-rental-preparations')).toHaveCount(0);
          await page.page.goto('/portal/rental-preparations');
          await page.page.waitForURL((url) => url.pathname === '/portal' || url.pathname === '/portal/', {
            timeout: 20_000,
          });
          await expect(page.page.getByTestId('portal-rental-preparations')).toHaveCount(0);
        } finally {
          await page.context.close();
        }
      } finally {
        await noAddOnAdmin.dispose();
      }
    } finally {
      for (const s of sessions) await s.api.dispose();
    }
  });
});
