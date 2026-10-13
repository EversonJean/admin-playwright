import { APIRequestContext, APIResponse } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCompleteOnboarding } from '../../helpers/api-entities';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import { apiCreateRainActivity, uniqueSuffix } from '../../helpers/rain-plan';
import { apiErrorCodes, assertOk, readJson } from '../../helpers/response';
import { loginAsRole } from '../../helpers/setup-flows';

/**
 * Fluxo: 2.1.2 — Atividades: dias de chuva (substitutas para chuva)
 * Plano: docs/implementados/PLANO-PLANO-B-DE-CHUVA.md §2.1 e §3 (Etapa 222).
 * Registro e2e: E15.
 *
 * Sem diagrama `.mmd`: verificação de plano.
 */

interface ActivityDetail {
  id: string;
  name: string;
  category: string;
  description: string | null;
  minAge: number;
  maxAge: number;
  durationMinutes: number;
  pricePerChild: number;
  minChildren: number;
  maxChildren: number;
  status: string;
  activityProducts: Array<{ productId: string; qtyPerChild: number; isChecklistOnly: boolean }>;
  targetMarkupPercent: number | null;
  indoorSuitability: string;
  minSquareMetersPerChild: number | null;
  rainSubstitutes: Array<{ substituteActivityId: string }> | null;
}

async function getActivity(api: APIRequestContext, id: string): Promise<ActivityDetail> {
  const res = await api.get(`/api/activities/${id}`);
  await assertOk(res, 'GET /api/activities/{id}');
  return readJson<ActivityDetail>(res);
}

/** PUT da atividade (estado completo) trocando só as substitutas. */
async function putSubstitutes(
  api: APIRequestContext,
  detail: ActivityDetail,
  rainSubstituteActivityIds: string[],
): Promise<APIResponse> {
  return api.put(`/api/activities/${detail.id}`, {
    data: {
      name: detail.name,
      category: detail.category,
      pricePerChild: detail.pricePerChild,
      minAge: detail.minAge,
      maxAge: detail.maxAge,
      durationMinutes: detail.durationMinutes,
      minChildren: detail.minChildren,
      maxChildren: detail.maxChildren,
      description: detail.description,
      status: detail.status,
      activityProducts: detail.activityProducts.map((p) => ({
        productId: p.productId,
        qtyPerChild: p.qtyPerChild,
        isChecklistOnly: p.isChecklistOnly,
      })),
      targetMarkupPercent: detail.targetMarkupPercent,
      indoorSuitability: detail.indoorSuitability,
      minSquareMetersPerChild: detail.minSquareMetersPerChild,
      rainSubstituteActivityIds,
    },
  });
}

const substituteIds = (detail: ActivityDetail) => (detail.rainSubstitutes ?? []).map((r) => r.substituteActivityId);

test.describe('Fluxo 2.1.2 — Atividades: dias de chuva', () => {
  // E15 — §2.1 (regras da substituta) e §3 Front 1.
  test('@crud E15: rain substitutes: the search does not offer "outdoor only"; another company substitute is refused by the server; no activities.update cannot save; deleting the substitute removes it from the other activity', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(150_000);
    await apiCompleteOnboarding(authApi);
    const s = uniqueSuffix();
    const substitute = await apiCreateRainActivity(authApi, `Mímica ${s}`, { indoorSuitability: 'Indoor' });
    const another = await apiCreateRainActivity(authApi, `Massinha ${s}`, { indoorSuitability: 'IndoorAdapted' });
    const outdoorOnly = await apiCreateRainActivity(authApi, `Futebol ${s}`, { indoorSuitability: 'OutdoorOnly' });
    const main = await apiCreateRainActivity(authApi, `Caça ao tesouro ${s}`, {
      indoorSuitability: 'OutdoorOnly',
      rainSubstituteActivityIds: [substitute.id],
    });
    expect(substituteIds(await getActivity(authApi, main.id))).toEqual([substitute.id]);

    // A busca da tela não oferece a "só ao ar livre"; oferece a que funciona com adaptação.
    await authPage.goto(`/app/activities/${main.id}`);
    await expect(authPage.getByTestId(`activity-form-rain-substitute-${substitute.id}`)).toBeVisible({ timeout: 20_000 });
    const search = authPage.getByTestId('activity-form-rain-substitute-add');
    await search.fill(`Futebol ${s}`);
    await expect(authPage.getByTestId('activity-form-rain-substitute-add-empty')).toBeVisible();
    await expect(authPage.getByTestId(`activity-form-rain-substitute-add-option-${outdoorOnly.id}`)).toHaveCount(0);
    await search.fill(`Massinha ${s}`);
    await expect(authPage.getByTestId(`activity-form-rain-substitute-add-option-${another.id}`)).toBeVisible();

    // O servidor recusa a "só ao ar livre" mesmo sem a tela.
    const outdoor = await putSubstitutes(authApi, await getActivity(authApi, main.id), [outdoorOnly.id]);
    expect(outdoor.status()).toBe(400);
    expect(await apiErrorCodes(outdoor)).toContain('Activity.SubstituteOutdoorOnly');

    // Substituta de outra empresa: recusada como validação.
    const other = await signupNewTenant();
    const otherApi = await createBearerApiContext(other.accessToken);
    try {
      const foreign = await apiCreateRainActivity(otherApi, `Atividade de outra empresa ${s}`, {
        indoorSuitability: 'Indoor',
      });
      const refused = await putSubstitutes(authApi, await getActivity(authApi, main.id), [substitute.id, foreign.id]);
      expect(refused.status()).toBe(400);
      expect(await apiErrorCodes(refused)).toContain('Activity.SubstituteNotFound');
    } finally {
      await otherApi.dispose();
    }
    expect(substituteIds(await getActivity(authApi, main.id)), 'nada mudou').toEqual([substitute.id]);

    // Sem `activities.update`: 403, as substitutas ficam como estavam.
    const financial = await loginAsRole(tenant.tenantId, 'Financial');
    try {
      const denied = await putSubstitutes(financial.api, await getActivity(authApi, main.id), []);
      expect(denied.status()).toBe(403);
    } finally {
      await financial.api.dispose();
    }
    expect(substituteIds(await getActivity(authApi, main.id))).toEqual([substitute.id]);

    // Excluir a substituta a tira da lista da outra atividade.
    await assertOk(await authApi.delete(`/api/activities/${substitute.id}`), 'DELETE /api/activities/{id}');
    expect(substituteIds(await getActivity(authApi, main.id))).toEqual([]);
  });
});
