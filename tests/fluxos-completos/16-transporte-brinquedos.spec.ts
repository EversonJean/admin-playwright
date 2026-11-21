import type { APIRequestContext } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import {
  NotificationItem,
  apiCompleteOnboarding,
  apiCreateCollaborator,
  apiListNotifications,
} from '../../helpers/api-entities';
import {
  enableFeatureFlagDirect,
  ensureTriggerWhatsAppTemplateDirect,
  seedConnectedWhatsappTenantDirect,
} from '../../helpers/db-helper';
import { tenantDayPlus } from '../../helpers/rain-plan';
import {
  DayRoutePlan,
  RENTAL_TRANSPORT_KEY,
  apiBuildDayRoute,
  apiCreateVehicle,
  apiGetEventChecklist,
  apiGetRentalLogistics,
  apiPutRentalLogistics,
  completeLegs,
  fakeAddressWithCoordinates,
  notifyRentalCrew,
  openRentalTransportTab,
  putRentalLogistics,
  rentalTransportItem,
  setupReservedRental,
  transitionRental,
} from '../../helpers/rental-preparation';
import { apiErrorCodes, assertOk, readJson } from '../../helpers/response';
import {
  RoleSession,
  loginAsRole,
  loginPortalCollaborator,
  openSessionPage,
  setupAcceptedEvent,
} from '../../helpers/setup-flows';
import { fakeAddress } from '../../helpers/test-data';
import {
  apiConversationIdByPhone,
  apiDailyQuota,
  enableWhatsAppFeaturesDirect,
  fakeMessagesTo,
  fakeTextsTo,
  openSendTemplateDialog,
  receiveInbound,
  uid,
  uniquePhoneE164,
} from '../../helpers/whatsapp-flow';

/**
 * Fluxo: 16 — Transporte dos brinquedos (PLANO-PREPARACAO-DE-EQUIPAMENTOS, PE-H)
 * Diagrama: — (o plano é a fonte: §10 itens 1, 2, 4 a 7; decisão 11)
 *
 * E5: plano de transporte com veículo, motorista e saída marca o item
 * "Planejar o transporte"; aviso à equipe com ciência; usuário sem
 * `Rentals.Update` não edita.
 *
 * E26: o Financeiro não vê "Veículos" e leva 403 em `/api/routing/vehicles`,
 * abre a aba "Transporte" sem "Planejar" nem "Avisar equipe" e leva 403 no PUT
 * e no `notify-crew`; veículo e colaborador de outro tenant no plano dão 400 e
 * a locação de outro tenant dá 404; excluir veículo com perna de hoje em diante
 * é recusado; o colaborador avisado vê o aviso no sino do Portal, sem
 * navegação, e dá ciência, que aparece na aba.
 *
 * E27: a rota do dia montada para um veículo traz só as entregas e retiradas
 * cuja perna usa aquele veículo ou ainda não tem veículo, com o nome dele no
 * lugar da equipe, e a montagem sem veículo segue como antes; no checklist do
 * evento, o item "Planejar o transporte dos brinquedos" recusa a marcação à
 * mão com o texto que aponta a aba Transporte e some quando a última locação é
 * cancelada.
 *
 * E173 (PLANO-SEGURANCA §14 item 1 e §5 item 3, Etapa 281): o aviso de
 * transporte gravado no sino do Portal diz "ao endereço de entrega da locação",
 * sem rua nem número (anonimização do titular); o WhatsApp, que o colaborador
 * precisa para a entrega, leva o endereço; o envio pelo template (janela de
 * 24 h fechada) conta na cota diária que a tela de envio de WhatsApp mostra.
 *
 * [NOTA] Revisão integrada do plano (2026-10-25, linha 5 do plano e
 * `docs/modulos/back/Notifications.md`): o aviso de transporte nunca é gravado
 * como notificação 39. O colaborador recebe um 33 `NoticeForwarded` com
 * `forwardedType: 'RentalTransportAssigned'`, e a ciência volta a quem avisou
 * como 34 com o mesmo `forwardedType`. Onde o registro (E26) diz "aviso 39 no
 * sino do Portal", este spec afirma o 33 de transporte.
 */

const TRANSPORT = 'RentalTransportAssigned';

/** Os avisos de transporte (33/34 com `forwardedType` de transporte) do usuário. */
async function transportNotices(api: APIRequestContext, type: string): Promise<NotificationItem[]> {
  return (await apiListNotifications(api)).filter((n) => n.type === type && n.forwardedType === TRANSPORT);
}

function rentalIdsOf(plan: DayRoutePlan): string[] {
  return [...new Set(plan.stops.map((s) => s.rentalId).filter((id): id is string => !!id))];
}

test.describe('Fluxo 16 — Transporte dos brinquedos', () => {
  test('@flow E5: a transport plan with vehicle, driver and departure checks the "Planejar o transporte" event item; the crew notice requires acknowledgement; a user without Rentals.Update cannot edit', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(240_000);
    const date = tenantDayPlus(20);
    const { eventId, clienteId } = await setupAcceptedEvent(authApi, { budget: { eventDate: date } });
    const { rental } = await setupReservedRental(authApi, tenant.tenantId, {
      eventId,
      clientId: clienteId,
      deliveryDate: date,
    });
    const vehicle = await apiCreateVehicle(authApi);
    const driver = await apiCreateCollaborator(authApi);
    const portal = await loginPortalCollaborator(tenant.tenantId, driver.id);
    const sessions: RoleSession[] = [portal];

    try {
      // §10 item 5: a reserva da locação de festa cria o item, pendente.
      const pending = await rentalTransportItem(authApi, eventId);
      expect(pending, 'o item "Planejar o transporte" nasce na reserva').toBeTruthy();
      expect(pending!.title).toBe('Planejar o transporte dos brinquedos');
      expect(pending!.isDone).toBe(false);

      // Só a entrega planejada: o item segue pendente (cobra as duas pernas).
      const [delivery] = completeLegs({ date, vehicleId: vehicle.id, driverId: driver.id });
      const partial = await apiPutRentalLogistics(authApi, rental.id, [delivery!]);
      expect(partial.legs.find((l) => l.kind === 'Delivery')!.isComplete).toBe(true);
      expect(partial.legs.find((l) => l.kind === 'Pickup')!.isComplete).toBe(false);
      expect((await rentalTransportItem(authApi, eventId))!.isDone, 'falta a retirada').toBe(false);

      // §10 itens 2 e 5: as duas pernas com veículo, motorista e saída marcam o item.
      const planned = await apiPutRentalLogistics(
        authApi,
        rental.id,
        completeLegs({ date, vehicleId: vehicle.id, driverId: driver.id }),
      );
      expect(planned.legs.every((l) => l.isComplete && l.vehicleId === vehicle.id)).toBe(true);
      expect((await rentalTransportItem(authApi, eventId))!.isDone, 'transporte planejado').toBe(true);

      // §10 item 4: aviso à equipe, com ciência.
      const notified = await notifyRentalCrew(authApi, rental.id, ['Portal']);
      await assertOk(notified, 'notify-crew');
      expect((await readJson<{ sentCount: number }>(notified)).sentCount).toBe(1);

      await expect.poll(async () => (await transportNotices(portal.api, 'NoticeForwarded')).length).toBe(1);
      const notice = (await transportNotices(portal.api, 'NoticeForwarded'))[0]!;
      expect(notice.requiresAcknowledgement).toBe(true);
      expect(notice.contextEntityId).toBe(rental.id);
      expect(`${notice.title} ${notice.message}`).toContain(vehicle.name);

      const beforeAck = await apiGetRentalLogistics(authApi, rental.id);
      expect(beforeAck.crewNotifiedAt).toBeTruthy();
      const driverBefore = beforeAck.legs[0]!.crew.find((c) => c.collaboratorId === driver.id)!;
      expect(driverBefore.notifiedAt).toBeTruthy();
      expect(driverBefore.acknowledgedAt ?? null).toBeNull();

      await assertOk(await portal.api.post(`/api/notifications/${notice.id}/acknowledge`), 'acknowledge');
      const afterAck = await apiGetRentalLogistics(authApi, rental.id);
      for (const leg of afterAck.legs) {
        const member = leg.crew.find((c) => c.collaboratorId === driver.id)!;
        expect(member.acknowledgedAt, `ciência na perna ${leg.kind}`).toBeTruthy();
        expect(member.acknowledgedVia).toBe('Portal');
      }
      // Quem avisou recebe a ciência (34 de transporte).
      await expect.poll(async () => (await transportNotices(authApi, 'NoticeAcknowledged')).length).toBe(1);

      // Usuário de verdade sem `Rentals.Update` (Financeiro): lê e não edita.
      const financial = await loginAsRole(tenant.tenantId, 'Financial');
      sessions.push(financial);
      const read = await financial.api.get(`/api/rentals/${rental.id}/logistics`);
      expect(read.status(), 'Financial lê o transporte').toBe(200);
      const put = await putRentalLogistics(financial.api, rental.id, []);
      expect(put.status(), 'Financial não planeja').toBe(403);
      const notify = await notifyRentalCrew(financial.api, rental.id, ['Portal']);
      expect(notify.status(), 'Financial não avisa a equipe').toBe(403);
      expect((await apiGetRentalLogistics(authApi, rental.id)).legs.every((l) => l.isComplete), 'nada mudou').toBe(
        true,
      );
    } finally {
      for (const s of sessions) await s.api.dispose();
    }
  });

  test('@flow E26: Financial does not see "Veículos" and gets 403 on vehicles, sees the "Transporte" tab read-only and gets 403 writing; other-tenant vehicle and collaborator give 400 and the other tenant gets 404 on the rental; deleting a vehicle with a future leg is refused; the crew member sees the transport notice in the Portal without navigation and acknowledges, which shows on the tab', async ({
    authApi,
    authPage,
    browser,
    tenant,
  }) => {
    test.setTimeout(300_000);
    await apiCompleteOnboarding(authApi);
    const date = tenantDayPlus(20);
    const { rental } = await setupReservedRental(authApi, tenant.tenantId, { deliveryDate: date });
    const vehicle = await apiCreateVehicle(authApi);
    const driver = await apiCreateCollaborator(authApi);
    const portal = await loginPortalCollaborator(tenant.tenantId, driver.id);
    const sessions: RoleSession[] = [portal];

    try {
      // Financeiro de verdade: sem `Routing.Read`, sem `Rentals.Update`.
      const financial = await loginAsRole(tenant.tenantId, 'Financial');
      sessions.push(financial);
      const vehicles = await financial.api.get('/api/routing/vehicles');
      expect(vehicles.status(), 'Financial não lista veículos').toBe(403);
      expect((await putRentalLogistics(financial.api, rental.id, [])).status(), 'Financial não planeja').toBe(403);
      expect((await notifyRentalCrew(financial.api, rental.id, ['Portal'])).status(), 'Financial não avisa').toBe(403);

      // O gestor vê o item "Veículos" no menu; o Financeiro, não (§10 item 7).
      await openRentalTransportTab(authPage, rental.id);
      await expect(authPage.getByTestId('nav-sub-/app/schedule/routing/vehicles')).toHaveCount(1);
      await expect(authPage.getByTestId('rental-transport-plan')).toBeVisible();

      const financialView = await openSessionPage(browser, financial.tokens);
      try {
        await openRentalTransportTab(financialView.page, rental.id);
        await expect(financialView.page.getByTestId('rental-transport-read-only')).toBeVisible();
        await expect(financialView.page.getByTestId('rental-transport-plan')).toHaveCount(0);
        await expect(financialView.page.getByTestId('rental-transport-notify')).toHaveCount(0);
        await expect(financialView.page.getByTestId('nav-sub-/app/schedule/routing/vehicles')).toHaveCount(0);
      } finally {
        await financialView.context.close();
      }

      // Isolamento: veículo e colaborador de outro tenant no plano dão 400; a
      // locação, vista do outro tenant, dá 404.
      const other = await signupNewTenant();
      enableFeatureFlagDirect(other.tenantId, 'feature_equipment_rental');
      const otherAdmin = await createBearerApiContext(other.accessToken);
      try {
        const foreignVehicle = await apiCreateVehicle(otherAdmin);
        const foreignCollaborator = await apiCreateCollaborator(otherAdmin);

        const withForeignVehicle = await putRentalLogistics(
          authApi,
          rental.id,
          completeLegs({ date, vehicleId: foreignVehicle.id, driverId: driver.id }),
        );
        expect(withForeignVehicle.status(), 'veículo de outro tenant').toBe(400);
        expect(await apiErrorCodes(withForeignVehicle)).toContain('RentalLogistics.ReferenceNotFound');

        const withForeignCrew = await putRentalLogistics(
          authApi,
          rental.id,
          completeLegs({ date, vehicleId: vehicle.id, driverId: foreignCollaborator.id }),
        );
        expect(withForeignCrew.status(), 'colaborador de outro tenant').toBe(400);
        expect(await apiErrorCodes(withForeignCrew)).toContain('RentalLogistics.ReferenceNotFound');
        expect((await apiGetRentalLogistics(authApi, rental.id)).legs.every((l) => l.id === null), 'nada gravado').toBe(
          true,
        );

        const crossRead = await otherAdmin.get(`/api/rentals/${rental.id}/logistics`);
        expect(crossRead.status(), 'locação de outro tenant').toBe(404);
        const crossPut = await putRentalLogistics(otherAdmin, rental.id, []);
        expect(crossPut.status(), 'escrita na locação de outro tenant').toBe(404);
      } finally {
        await otherAdmin.dispose();
      }

      // §10 item 1: veículo com perna de hoje em diante não se exclui.
      await apiPutRentalLogistics(authApi, rental.id, completeLegs({ date, vehicleId: vehicle.id, driverId: driver.id }));
      const remove = await authApi.delete(`/api/routing/vehicles/${vehicle.id}`);
      expect(remove.status(), 'excluir veículo com perna futura').toBe(409);
      expect(await apiErrorCodes(remove)).toContain('Vehicle.HasFutureLegs');
      expect((await authApi.get(`/api/routing/vehicles/${vehicle.id}`)).status(), 'o veículo segue').toBe(200);

      // §10 itens 4 e 7: o aviso chega ao Portal, não navega, e a ciência aparece na aba.
      await assertOk(await notifyRentalCrew(authApi, rental.id, ['Portal']), 'notify-crew');
      await expect.poll(async () => (await transportNotices(portal.api, 'NoticeForwarded')).length).toBe(1);
      const notice = (await transportNotices(portal.api, 'NoticeForwarded'))[0]!;

      const view = await openSessionPage(browser, portal.tokens);
      try {
        await view.page.goto('/portal/notifications');
        const card = view.page.getByTestId(`portal-notification-${notice.id}`);
        await expect(card).toBeVisible({ timeout: 20_000 });
        await expect(card).toContainText(vehicle.name);
        // Sem deep link: abrir o aviso deixa o colaborador na lista.
        await card.click();
        await expect(view.page).toHaveURL(/\/portal\/notifications$/);
        await view.page.getByTestId(`portal-notification-acknowledge-${notice.id}`).click();
        await expect(view.page.getByTestId(`portal-notification-acknowledged-${notice.id}`)).toBeVisible({
          timeout: 20_000,
        });
        await expect(view.page).toHaveURL(/\/portal\/notifications$/);
      } finally {
        await view.context.close();
      }

      await openRentalTransportTab(authPage, rental.id);
      await expect(authPage.getByTestId(`rental-transport-ack-Delivery-${driver.id}`)).toBeVisible({ timeout: 20_000 });
      await expect(authPage.getByTestId(`rental-transport-ack-Pickup-${driver.id}`)).toBeVisible();
    } finally {
      for (const s of sessions) await s.api.dispose();
    }
  });

  // E27 em dois testes: a rota do dia (§10 item 6) e o item do checklist (§10
  // item 5) não dependem um do outro, e a falha de um não esconde o outro.
  test('@flow E27 (day route): the day route built for a vehicle takes only the rental stops whose leg uses it or has no vehicle yet, labeled with its name, and the route without vehicle is unchanged', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(240_000);
    const date = tenantDayPlus(20);

    // A e B no endereço com coordenada; C é avulsa e fica sem plano.
    const a = await setupReservedRental(authApi, tenant.tenantId, {
      deliveryDate: date,
      deliveryAddress: await fakeAddressWithCoordinates(),
    });
    const b = await setupReservedRental(authApi, tenant.tenantId, {
      deliveryDate: date,
      deliveryAddress: await fakeAddressWithCoordinates(),
      enableAddOn: false,
    });
    const c = await setupReservedRental(authApi, tenant.tenantId, {
      deliveryDate: date,
      deliveryAddress: await fakeAddressWithCoordinates(),
      enableAddOn: false,
    });

    // A no veículo 1, B no veículo 2, C sem perna.
    const v1 = await apiCreateVehicle(authApi);
    const v2 = await apiCreateVehicle(authApi);
    const driver1 = await apiCreateCollaborator(authApi);
    const driver2 = await apiCreateCollaborator(authApi);
    await apiPutRentalLogistics(authApi, a.rental.id, completeLegs({ date, vehicleId: v1.id, driverId: driver1.id }));
    await apiPutRentalLogistics(authApi, b.rental.id, completeLegs({ date, vehicleId: v2.id, driverId: driver2.id }));

    // §10 item 6: a rota do veículo 1 traz A (o veículo dela) e C (sem veículo), sem B.
    const byVehicle = await apiBuildDayRoute(authApi, { date, teamLabel: 'Equipe E2E', vehicleId: v1.id });
    expect(byVehicle.vehicleId).toBe(v1.id);
    expect(byVehicle.teamLabel, 'o nome do veículo no lugar da equipe').toBe(v1.name);
    const vehicleRentals = rentalIdsOf(byVehicle);
    expect(vehicleRentals).toContain(a.rental.id);
    expect(vehicleRentals).toContain(c.rental.id);
    expect(vehicleRentals, 'a locação do outro veículo fica de fora').not.toContain(b.rental.id);
    expect(
      byVehicle.stops.filter((s) => s.rentalId === a.rental.id).map((s) => s.kind).sort(),
      'entrega e retirada da locação do veículo',
    ).toEqual(['RentalDelivery', 'RentalPickup']);

    // Sem veículo, como antes: todas as locações do dia, com o rótulo informado.
    const whole = await apiBuildDayRoute(authApi, { date, teamLabel: 'Equipe E2E' });
    expect(whole.vehicleId ?? null).toBeNull();
    expect(whole.teamLabel).toBe('Equipe E2E');
    expect(rentalIdsOf(whole).sort()).toEqual([a.rental.id, b.rental.id, c.rental.id].sort());
  });

  test('@flow E27 (event checklist): the "Planejar o transporte dos brinquedos" event item refuses the manual check pointing to the Transport tab, is checked when every live rental of the party is planned and disappears when the last rental is canceled', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(240_000);
    await apiCompleteOnboarding(authApi);
    const date = tenantDayPlus(20);
    const { eventId, clienteId } = await setupAcceptedEvent(authApi, { budget: { eventDate: date } });
    const a = await setupReservedRental(authApi, tenant.tenantId, { eventId, clientId: clienteId, deliveryDate: date });
    const b = await setupReservedRental(authApi, tenant.tenantId, {
      eventId,
      clientId: clienteId,
      deliveryDate: date,
      enableAddOn: false,
    });

    // §10 item 5 (decisão 19): o item de sistema recusa a marcação à mão e aponta a aba Transporte.
    const item = await rentalTransportItem(authApi, eventId);
    expect(item, 'o item "Planejar o transporte" no checklist do evento').toBeTruthy();
    // A marcação à mão é o `POST .../check` (não existe `/toggle`: dava 404).
    const toggle = await authApi.post(`/api/events/${eventId}/checklist/${item!.id}/check`);
    expect(toggle.status()).toBe(409);
    expect(await apiErrorCodes(toggle)).toContain('EventChecklist.SystemItemReadOnly');
    expect(JSON.stringify(await toggle.json())).toContain('aba Transporte');
    expect((await rentalTransportItem(authApi, eventId))!.isDone, 'nada marcado').toBe(false);

    await authPage.goto(`/app/events/${eventId}`);
    await authPage.getByRole('tab', { name: 'Checklist', exact: true }).click();
    await expect(authPage.getByTestId(`checklist-item-${item!.id}`)).toBeVisible({ timeout: 20_000 });
    await expect(authPage.getByTestId(`checklist-item-checkbox-${item!.id}`)).toHaveCount(0);
    await expect(authPage.getByTestId(`checklist-item-system-hint-${item!.id}`)).toContainText('aba Transporte');

    // Feito só com as duas locações da festa planejadas.
    const vehicle = await apiCreateVehicle(authApi);
    const driver = await apiCreateCollaborator(authApi);
    await apiPutRentalLogistics(authApi, a.rental.id, completeLegs({ date, vehicleId: vehicle.id, driverId: driver.id }));
    expect((await rentalTransportItem(authApi, eventId))!.isDone, 'falta a locação B').toBe(false);
    await apiPutRentalLogistics(authApi, b.rental.id, completeLegs({ date, vehicleId: vehicle.id, driverId: driver.id }));
    expect((await rentalTransportItem(authApi, eventId))!.isDone, 'as duas locações da festa planejadas').toBe(true);

    // §10 item 5: o item fica enquanto houver locação viva da festa e some com a última cancelada.
    await assertOk(await transitionRental(authApi, b.rental.id, 'Canceled'), 'cancel B');
    expect(await rentalTransportItem(authApi, eventId), 'ainda há a locação A').toBeTruthy();
    await assertOk(await transitionRental(authApi, a.rental.id, 'Canceled'), 'cancel A');
    expect(
      (await apiGetEventChecklist(authApi, eventId)).filter((i) => i.systemKey === RENTAL_TRANSPORT_KEY),
      'sem locação viva, sem o item',
    ).toHaveLength(0);
  });

  test('@flow E173: the crew notice in the Portal says "ao endereço de entrega da locação" without street or number; the WhatsApp text carries the address; the template send counts in the daily WhatsApp quota', async ({
    authApi,
    authPage,
    browser,
    tenant,
  }) => {
    test.setTimeout(300_000);
    await apiCompleteOnboarding(authApi);
    enableWhatsAppFeaturesDirect(tenant.tenantId);

    // O aviso encaminhado com a janela fechada sai pelo template do trigger
    // `CollaboratorNoticeForwarded`, aprovado no catálogo e na WABA da empresa.
    // Corpo em ASCII: o `psql` do Windows recebe o argumento em ANSI e o acento
    // vira byte inválido em UTF-8.
    const template = ensureTriggerWhatsAppTemplateDirect({
      trigger: 'CollaboratorNoticeForwarded',
      namePrefix: 'aviso_encaminhado_e2e',
      body: 'Ola, {{1}}! Voce recebeu um aviso: {{2}}. Veja no Portal: {{3}}',
      variables: ['nome', 'titulo', 'link'],
    });
    const channel = seedConnectedWhatsappTenantDirect(tenant.tenantId, [template.id]);

    // Endereço só desta locação, para procurar rua e número nos textos.
    const tag = uid();
    const street = `Rua do Transporte ${tag}`;
    const number = String(100 + Math.floor(Math.random() * 900));
    const date = tenantDayPlus(20);
    const { rental } = await setupReservedRental(authApi, tenant.tenantId, {
      deliveryDate: date,
      deliveryAddress: { ...fakeAddress(), street, number },
    });

    // O motorista escreveu para o número da empresa (janela aberta: texto
    // livre); o ajudante não (janela fechada: template).
    const vehicle = await apiCreateVehicle(authApi);
    const driverPhone = uniquePhoneE164();
    const helperPhone = uniquePhoneE164();
    const driver = await apiCreateCollaborator(authApi, { name: `Motorista ${tag}`, phone: driverPhone });
    const helper = await apiCreateCollaborator(authApi, { name: `Ajudante ${tag}`, phone: helperPhone });
    const driverPortal = await loginPortalCollaborator(tenant.tenantId, driver.id);
    const helperPortal = await loginPortalCollaborator(tenant.tenantId, helper.id);
    const sessions: RoleSession[] = [driverPortal, helperPortal];

    try {
      await receiveInbound(channel.phoneNumberId, driverPhone, 'Oi, sou o motorista');
      const driverConversationId = await apiConversationIdByPhone(authApi, driverPhone);
      await apiPutRentalLogistics(
        authApi,
        rental.id,
        completeLegs({ date, vehicleId: vehicle.id, driverId: driver.id, helperIds: [helper.id] }),
      );

      const before = await apiDailyQuota(authApi);
      const since = new Date().toISOString();
      const notified = await notifyRentalCrew(authApi, rental.id, ['Portal', 'WhatsApp']);
      await assertOk(notified, 'notify-crew');
      const result = await readJson<{
        sentCount: number;
        notices: Array<{ collaboratorId: string; channels: Array<{ channel: string; delivered: boolean }> }>;
      }>(notified);
      expect(result.sentCount, 'motorista e ajudante avisados').toBe(2);
      for (const member of [driver, helper]) {
        const notice = result.notices.find((n) => n.collaboratorId === member.id);
        expect(
          notice?.channels.find((c) => c.channel === 'WhatsApp')?.delivered,
          `WhatsApp entregue a ${member.id === driver.id ? 'motorista' : 'ajudante'}`,
        ).toBe(true);
      }

      // §14 item 1: o aviso gravado no sino do Portal vai sem o endereço.
      for (const portal of sessions) {
        await expect.poll(async () => (await transportNotices(portal.api, 'NoticeForwarded')).length).toBe(1);
        const notice = (await transportNotices(portal.api, 'NoticeForwarded'))[0]!;
        expect(notice.message, 'o aviso diz para onde sem dizer o endereço').toContain(
          'ao endereço de entrega da locação',
        );
        expect(notice.message, 'sem a rua').not.toContain(street);
        expect(`${notice.title} ${notice.message}`, 'sem rua e número juntos').not.toContain(`${street}, ${number}`);
      }

      const driverNotice = (await transportNotices(driverPortal.api, 'NoticeForwarded'))[0]!;
      const view = await openSessionPage(browser, driverPortal.tokens);
      try {
        await view.page.goto('/portal/notifications');
        const card = view.page.getByTestId(`portal-notification-${driverNotice.id}`);
        await expect(card).toBeVisible({ timeout: 20_000 });
        await expect(card).toContainText('ao endereço de entrega da locação');
        await expect(card, 'a tela do Portal sem a rua').not.toContainText(street);
      } finally {
        await view.context.close();
      }

      // O WhatsApp (fake da Meta) leva o endereço: o texto livre do motorista.
      await expect
        .poll(async () => (await fakeTextsTo(driverPhone, since)).join('\n'), {
          message: 'texto do aviso ao motorista no WhatsApp',
        })
        .toContain(rental.rentalNumber);
      const driverText = (await fakeTextsTo(driverPhone, since)).join('\n');
      expect(driverText, 'o WhatsApp leva rua e número').toContain(`${street}, ${number}`);

      // O ajudante, com a janela fechada, recebe o template pelo número da empresa.
      await expect
        .poll(
          async () =>
            (await fakeMessagesTo(helperPhone, since)).filter(
              (e) =>
                e.path === `/${channel.phoneNumberId}/messages` &&
                (e.body as { type?: string } | null)?.type === 'template',
            ).length,
          { message: 'template ao ajudante pelo número da empresa' },
        )
        .toBe(1);

      // §5 item 3: o template conta na cota diária; o texto livre na janela não.
      const after = await apiDailyQuota(authApi);
      expect(after.used, 'um envio de template a mais na cota do dia').toBe(before.used + 1);
      expect(after.remaining).toBe(after.limit - after.used);

      // A tela de envio de WhatsApp mostra a cota com o envio do aviso.
      await openSendTemplateDialog(authPage, driverConversationId);
      const quota = authPage.getByTestId('send-whatsapp-quota');
      await expect(quota).toContainText(`Envios hoje: ${after.used} de ${after.limit}`);
      await expect(authPage.getByTestId('send-whatsapp-quota-remaining')).toHaveText(String(after.remaining));
    } finally {
      for (const s of sessions) await s.api.dispose();
    }
  });
});
