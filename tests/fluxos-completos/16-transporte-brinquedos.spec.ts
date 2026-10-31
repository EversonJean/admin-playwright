import type { APIRequestContext } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import {
  NotificationItem,
  apiCompleteOnboarding,
  apiCreateCollaborator,
  apiListNotifications,
} from '../../helpers/api-entities';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';
import { fakeGoogleMaps, uniquePointNear } from '../../helpers/fake-providers';
import { tenantDayPlus } from '../../helpers/rain-plan';
import {
  RENTAL_TRANSPORT_KEY,
  apiCreateVehicle,
  apiGetEventChecklist,
  apiGetRentalLogistics,
  apiPutRentalLogistics,
  completeLegs,
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

interface DayRoutePlan {
  id: string;
  teamLabel: string;
  vehicleId: string | null;
  stops: Array<{ kind: string; rentalId: string | null }>;
  unresolvedStops: Array<{ kind: string; refId: string }>;
}

/** POST /api/routing/day-plans com origem avulsa (coordenada do fake) e, opcional, o veículo. */
async function apiBuildDayRoute(
  api: APIRequestContext,
  input: { date: string; teamLabel: string; vehicleId?: string | null },
): Promise<DayRoutePlan> {
  const places = await fakeGoogleMaps.places();
  const origin = uniquePointNear(places.centro);
  const res = await api.post('/api/routing/day-plans', {
    data: {
      date: input.date,
      teamLabel: input.teamLabel,
      originKind: 'Custom',
      originStockLocationId: null,
      returnsToOrigin: false,
      extraStops: [],
      customOriginLabel: 'Galpão E2E',
      customOriginLat: origin.lat,
      customOriginLng: origin.lng,
      vehicleId: input.vehicleId ?? null,
    },
  });
  await assertOk(res, 'POST /api/routing/day-plans');
  return readJson<DayRoutePlan>(res);
}

/** Endereço de entrega com coordenada única perto de um ponto do fake (vira parada da rota). */
async function addressWithCoordinates(): Promise<Record<string, unknown>> {
  const places = await fakeGoogleMaps.places();
  const point = uniquePointNear(places.batel);
  return { ...fakeAddress(), latitude: point.lat, longitude: point.lng };
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
      deliveryAddress: await addressWithCoordinates(),
    });
    const b = await setupReservedRental(authApi, tenant.tenantId, {
      deliveryDate: date,
      deliveryAddress: await addressWithCoordinates(),
      enableAddOn: false,
    });
    const c = await setupReservedRental(authApi, tenant.tenantId, {
      deliveryDate: date,
      deliveryAddress: await addressWithCoordinates(),
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
    const toggle = await authApi.post(`/api/events/${eventId}/checklist/${item!.id}/toggle`);
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
});
