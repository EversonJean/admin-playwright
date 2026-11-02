import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCompleteOnboarding } from '../../helpers/api-entities';
import { setupAcceptedEvent, loginAsRole, openSessionPage } from '../../helpers/setup-flows';
import { apiErrorCodes } from '../../helpers/response';
import {
  apiGetRentalPreparation,
  completePreparationCheck,
  preparationChecks,
  preparationTab,
  rentalPreparationItem,
  setupReservedRental,
} from '../../helpers/rental-preparation';
import { tenantDayPlus } from '../../helpers/rain-plan';

/**
 * Fluxo: 15.3 — A preparação da locação a partir do checklist do evento
 * Diagrama: — (o plano é a fonte: PLANO-PREPARACAO-DE-EQUIPAMENTOS §4 itens 5,
 * 11 e 12; decisão 19)
 *
 * E14: no checklist do evento, o item de sistema da preparação mostra os
 * números das locações, recusa a marcação à mão com o texto que aponta a
 * preparação e leva por "Ver preparação" à lista de locações do evento, que
 * abre a locação na aba "Preparação"; o usuário Financeiro vê a aba sem poder
 * marcar e a escrita pela API dá 403.
 */
test.describe('Fluxo 15.3 — Preparação pelo checklist do evento', () => {
  test('@flow E14: the system item shows the rental numbers, refuses the manual check pointing to the preparation, and "Ver preparação" reaches the event rentals list that opens the rental on the "Preparação" tab; Financial sees the tab read-only and gets 403 writing', async ({
    authApi,
    authPage,
    browser,
    tenant,
  }) => {
    test.setTimeout(240_000);
    await apiCompleteOnboarding(authApi);
    const { eventId, clienteId } = await setupAcceptedEvent(authApi, { budget: { eventDate: tenantDayPlus(20) } });
    const first = await setupReservedRental(authApi, tenant.tenantId, { eventId, clientId: clienteId });
    const second = await setupReservedRental(authApi, tenant.tenantId, {
      eventId,
      clientId: clienteId,
      enableAddOn: false,
    });

    // §4 item 9: a descrição traz os números das locações do evento.
    const item = await rentalPreparationItem(authApi, eventId);
    expect(item, 'item rental.preparation no checklist do evento').toBeTruthy();
    expect(item!.description ?? '').toContain(first.rental.rentalNumber);
    expect(item!.description ?? '').toContain(second.rental.rentalNumber);

    // §4 item 12 (decisão 19): a marcação à mão é recusada com o texto da chave,
    // que aponta a preparação (e não a aba Materiais).
    const toggle = await authApi.post(`/api/events/${eventId}/checklist/${item!.id}/toggle`);
    expect(toggle.status()).toBe(409);
    expect(await apiErrorCodes(toggle)).toContain('EventChecklist.SystemItemReadOnly');
    const refusal = JSON.stringify(await toggle.json());
    expect(refusal).toContain('preparação');
    expect(refusal).not.toContain('aba Materiais');
    expect((await rentalPreparationItem(authApi, eventId))!.isDone, 'nada marcado').toBe(false);

    // Tela: o item mostra os números, não tem checkbox e leva à preparação.
    await authPage.goto(`/app/events/${eventId}`);
    await authPage.getByRole('tab', { name: 'Checklist', exact: true }).click();
    const card = authPage.getByTestId(`checklist-item-${item!.id}`);
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText(first.rental.rentalNumber);
    await expect(card).toContainText(second.rental.rentalNumber);
    await expect(authPage.getByTestId(`checklist-item-checkbox-${item!.id}`)).toHaveCount(0);
    await expect(authPage.getByTestId(`checklist-item-system-icon-${item!.id}`)).toBeVisible();
    await expect(authPage.getByTestId(`checklist-item-system-hint-${item!.id}`)).toContainText('preparação');

    const link = authPage.getByTestId(`checklist-item-system-link-${item!.id}`);
    await expect(link).toContainText('Ver preparação');
    await link.click();

    // A lista de locações filtrada pelo evento (§4 item 12: lê `eventId` da URL).
    await authPage.waitForURL((url) => url.pathname === '/app/rentals/list' && url.searchParams.get('eventId') === eventId);
    await expect(authPage.getByTestId('rentals-list-event-filter')).toBeVisible({ timeout: 20_000 });
    await expect(authPage.getByTestId(`rental-open-${first.rental.id}`)).toBeVisible({ timeout: 20_000 });
    await expect(authPage.getByTestId(`rental-open-${second.rental.id}`)).toBeVisible();

    // Abrir a locação cai na aba "Preparação" (§4 item 11: `?tab=preparation`).
    await authPage.getByTestId(`rental-open-${first.rental.id}`).click();
    await authPage.waitForURL(new RegExp(`/app/rentals/${first.rental.id}`));
    await expect(preparationTab(authPage)).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 });
    const firstUnit = first.rental.items[0]!.id;
    await expect(authPage.getByTestId(`rental-preparation-unit-${firstUnit}`)).toBeVisible({ timeout: 20_000 });
    const prep = await apiGetRentalPreparation(authApi, first.rental.id);
    const mandatory = preparationChecks(prep).find((c) => c.isMandatory)!;
    await expect(authPage.getByTestId(`rental-preparation-check-done-${mandatory.id}`)).toBeVisible();

    // Financeiro de verdade: lê a aba sem os botões e a escrita pela API dá 403.
    const financial = await loginAsRole(tenant.tenantId, 'Financial');
    const session = await openSessionPage(browser, financial.tokens);
    try {
      const read = await financial.api.get(`/api/rentals/${first.rental.id}/preparation`);
      expect(read.status(), 'Financial lê a preparação').toBe(200);
      const write = await completePreparationCheck(financial.api, first.rental.id, mandatory.id, 'Done');
      expect(write.status(), 'Financial não marca').toBe(403);
      const add = await financial.api.post(`/api/rentals/${first.rental.id}/preparation/checks`, {
        data: { rentalItemId: firstUnit, title: 'Conferir o pino', isMandatory: false },
      });
      expect(add.status(), 'Financial não acrescenta item').toBe(403);

      await session.page.goto(`/app/rentals/${first.rental.id}?tab=preparation`);
      await expect(preparationTab(session.page)).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 });
      await expect(session.page.getByTestId(`rental-preparation-unit-${firstUnit}`)).toBeVisible({ timeout: 20_000 });
      await expect(session.page.getByTestId('rental-preparation-read-only')).toBeVisible();
      await expect(session.page.getByTestId(`rental-preparation-check-${mandatory.id}`)).toBeVisible();
      await expect(session.page.getByTestId(`rental-preparation-check-done-${mandatory.id}`)).toHaveCount(0);
      await expect(session.page.getByTestId('rental-preparation-add')).toHaveCount(0);
    } finally {
      await session.context.close();
      await financial.api.dispose();
    }

    const after = await apiGetRentalPreparation(authApi, first.rental.id);
    expect(preparationChecks(after).find((c) => c.id === mandatory.id)!.status, 'nada gravado').toBe('Pending');
  });
});
