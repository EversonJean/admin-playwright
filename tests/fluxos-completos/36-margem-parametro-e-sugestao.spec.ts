import { APIRequestContext, Page } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCompleteOnboarding, apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';
import {
  MARGIN_CHILDREN,
  MATERIAL_MARGIN_SETTING_KEY,
  activeReservationOf,
  apiGetMaterialMarginSuggestion,
  apiPurchase,
  apiRegisterActualChildren,
  completeWithLeader,
  setupMarginParty,
  startWithLeader,
} from '../../helpers/material-margin';
import { tenantDayPlus } from '../../helpers/rain-plan';
import { assertOk, readJson } from '../../helpers/response';
import { setupAcceptedEvent } from '../../helpers/setup-flows';
import { snack } from '../../helpers/ui';

/**
 * Fluxo completo 32 — Margem de crianças a mais: o parâmetro e a sugestão
 * Diagrama: — (o plano é a fonte: PLANO-ESTOQUE-DO-RECREADOR §6.1 regras 7 e 8,
 * §6.2 item 1; decisão 24; ER-D, Etapa 334)
 *
 * E16: em Configurações → Parâmetros, com menos de 10 festas concluídas com
 * presentes lançados, "ainda não há festas suficientes"; com 10 ou mais, "Usar
 * N%" preenche o campo sem gravar e o aviso de que compras e reservas passam a
 * contar a margem aparece antes do "Salvar"; salvar reconverge a reserva das
 * festas agendadas do horizonte, não a da festa em andamento.
 *
 * Festas medidas: 20 contratadas; nove com 23 presentes (15% a mais) e uma com
 * 20. O P90 do excesso das que tiveram crianças a mais é 15%, já múltiplo de 5:
 * a sugestão é 15% e, nas festas de 20, a margem é ceil(20 x 15%) = 3.
 */

const SUGGESTED = 15;
const EXTRA = Math.ceil((MARGIN_CHILDREN * SUGGESTED) / 100); // 3

async function measuredParty(
  api: APIRequestContext,
  clientId: string,
  activityId: string,
  day: number,
  actual: number,
): Promise<void> {
  const { eventId } = await setupAcceptedEvent(api, {
    clientId,
    activityIds: [activityId],
    budget: { eventDate: tenantDayPlus(day), startTime: '10:00', endTime: '12:00', childrenCount: MARGIN_CHILDREN },
  });
  await completeWithLeader(api, eventId);
  await apiRegisterActualChildren(api, eventId, actual);
}

async function savedSettingValue(api: APIRequestContext): Promise<string | undefined> {
  const res = await api.get('/api/settings/parameters');
  await assertOk(res, 'GET /api/settings/parameters');
  return (await readJson<Array<{ key: string; value: string }>>(res)).find((s) => s.key === MATERIAL_MARGIN_SETTING_KEY)
    ?.value;
}

async function openStockParameters(page: Page): Promise<void> {
  await page.goto('/app/settings/parameters');
  await expect(page.getByTestId('parameters-page')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('tab', { name: 'Estoque', exact: true }).click();
  await expect(page.getByTestId(`setting-input-${MATERIAL_MARGIN_SETTING_KEY}`)).toBeVisible({ timeout: 20_000 });
}

test.describe('Fluxo completo 32 — Margem: parâmetro e sugestão', () => {
  test('@flow E16: under 10 measured parties the suggestion says there are not enough; with 10 "Usar N%" fills the field without saving and the impact warning shows before "Salvar"; saving reconverges the reservation of the scheduled parties in the horizon, not the one in progress', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(600_000);
    await apiCompleteOnboarding(authApi);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_stock');

    // Duas festas com material: uma agendada no horizonte e uma em andamento.
    const scheduled = await setupMarginParty(authApi, { eventDate: tenantDayPlus(5) });
    const inProgress = await setupMarginParty(authApi, { eventDate: tenantDayPlus(3) });
    await apiPurchase(authApi, scheduled.product.id, 100);
    await apiPurchase(authApi, inProgress.product.id, 100);
    await expect
      .poll(() => activeReservationOf(authApi, scheduled.eventId, scheduled.product.id), { timeout: 30_000 })
      .toBeCloseTo(MARGIN_CHILDREN, 3);
    await expect
      .poll(() => activeReservationOf(authApi, inProgress.eventId, inProgress.product.id), { timeout: 30_000 })
      .toBeCloseTo(MARGIN_CHILDREN, 3);
    await startWithLeader(authApi, inProgress.eventId);
    const inProgressReserved = await activeReservationOf(authApi, inProgress.eventId, inProgress.product.id);

    // Nove festas concluídas com presentes lançados: ainda não basta (regra 8).
    const client = await apiCreateClient(authApi);
    const plain = await apiCreateActivity(authApi, { status: 'Active' });
    for (let i = 0; i < 9; i++) await measuredParty(authApi, client.id, plain.id, 20 + i, MARGIN_CHILDREN + 3);
    const few = await apiGetMaterialMarginSuggestion(authApi);
    expect(few.eventsMeasured).toBe(9);
    expect(few.suggestedPercent).toBeNull();

    await openStockParameters(authPage);
    await expect(authPage.getByTestId('material-margin-suggestion-insufficient')).toBeVisible({ timeout: 20_000 });
    await expect(authPage.getByTestId('material-margin-suggestion-insufficient')).toContainText(
      'Ainda não há festas suficientes',
    );
    await expect(authPage.getByTestId('material-margin-suggestion-insufficient')).toContainText('9 de 10');
    await expect(authPage.getByTestId('material-margin-suggestion-apply')).toHaveCount(0);

    // A décima festa (sem crianças a mais): a sugestão aparece.
    await measuredParty(authApi, client.id, plain.id, 29, MARGIN_CHILDREN);
    const enough = await apiGetMaterialMarginSuggestion(authApi);
    expect(enough).toMatchObject({ eventsMeasured: 10, eventsWithMoreChildren: 9, suggestedPercent: SUGGESTED });

    await openStockParameters(authPage);
    const text = authPage.getByTestId('material-margin-suggestion-text');
    await expect(text).toContainText('Nas últimas 10 festas, 9 tiveram crianças a mais', { timeout: 20_000 });
    await expect(text).toContainText(`com ${SUGGESTED}% você cobriria 90% delas`);
    await expect(authPage.getByTestId('material-margin-warning')).toHaveCount(0);

    // "Usar 15%" preenche o campo e não grava (decisão 24); o aviso aparece antes do "Salvar".
    const input = authPage.getByTestId(`setting-input-${MATERIAL_MARGIN_SETTING_KEY}`);
    await authPage.getByTestId('material-margin-suggestion-apply').click();
    await expect(input).toHaveValue(String(SUGGESTED));
    await expect(authPage.getByTestId('material-margin-warning')).toContainText(
      'A lista de compras e as reservas passam a contar a margem a partir de agora.',
    );
    await expect(authPage.getByTestId(`setting-save-${MATERIAL_MARGIN_SETTING_KEY}`)).toBeVisible();
    expect(await savedSettingValue(authApi), '"Usar" não grava').toBe('0');
    expect(await activeReservationOf(authApi, scheduled.eventId, scheduled.product.id)).toBeCloseTo(MARGIN_CHILDREN, 3);

    // Salvar: a festa agendada do horizonte reconverge; a em andamento, não (regra 7).
    await authPage.getByTestId(`setting-save-${MATERIAL_MARGIN_SETTING_KEY}`).click();
    await expect(snack(authPage, /salvo com sucesso/)).toBeVisible({ timeout: 20_000 });
    expect(await savedSettingValue(authApi)).toBe(String(SUGGESTED));
    await expect
      .poll(() => activeReservationOf(authApi, scheduled.eventId, scheduled.product.id), {
        timeout: 120_000,
        intervals: [2_000],
      })
      .toBeCloseTo(MARGIN_CHILDREN + EXTRA, 3);
    expect(
      await activeReservationOf(authApi, inProgress.eventId, inProgress.product.id),
      'a festa em andamento não reconverge',
    ).toBeCloseTo(inProgressReserved, 3);
  });
});
