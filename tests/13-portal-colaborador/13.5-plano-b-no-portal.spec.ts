import { APIRequestContext } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateCollaborator } from '../../helpers/api-entities';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import {
  apiCreateRainActivity,
  apiPutRainPlan,
  setupConfirmedPortalCollaborator,
  setupRainParty,
  setupUnassignedPortalCollaborator,
  uniqueSuffix,
} from '../../helpers/rain-plan';
import { apiErrorCodes, assertOk, readJson } from '../../helpers/response';
import { loginPortalCollaborator, openSessionPage } from '../../helpers/setup-flows';

/**
 * Fluxo: 13.5 — Plano B de chuva no Portal do colaborador
 * Plano: docs/implementados/PLANO-PLANO-B-DE-CHUVA.md §5 (PB-C, Etapa 224):
 * `GET /api/portal/my-events/{id}/rain-plan` confere a escala; não escalado,
 * sem plano ou com plano em rascunho respondem o mesmo `EventRainPlan.NotFound`
 * (404), e o card "Plano B (chuva)" some sem esconder a tela.
 * Registro e2e: E21.
 *
 * Sem diagrama `.mmd`: verificação de plano.
 */

async function expectSameNotFound(api: APIRequestContext, eventId: string, who: string): Promise<void> {
  const res = await api.get(`/api/portal/my-events/${eventId}/rain-plan`);
  expect(res.status(), who).toBe(404);
  expect(await apiErrorCodes(res), who).toContain('EventRainPlan.NotFound');
}

test.describe('Fluxo 13.5 — Plano B de chuva no Portal', () => {
  // E21 — §5 item 5, "Endpoints" e "Tela" (isolamento: tenant + colaborador).
  test('@flow E21: a collaborator not assigned and a user of another company do not see the "Plano B (chuva)" card and get the same 404 as no plan or a draft plan; the assigned one sees status, instructions and what each activity replaces', async ({
    authApi,
    browser,
    tenant,
  }) => {
    test.setTimeout(180_000);
    const s = uniqueSuffix();
    const indoor = await apiCreateRainActivity(authApi, `Mímica ${s}`, { indoorSuitability: 'Indoor' });
    const party = await setupRainParty(authApi);
    const assigned = await setupConfirmedPortalCollaborator(authApi, tenant.tenantId, party.eventId);
    const unassigned = await setupUnassignedPortalCollaborator(authApi, tenant.tenantId);

    const other = await signupNewTenant();
    const otherApi = await createBearerApiContext(other.accessToken);
    const otherCollaborator = await apiCreateCollaborator(otherApi);
    const outsider = await loginPortalCollaborator(other.tenantId, otherCollaborator.id);

    try {
      // Sem plano e com plano em rascunho: o mesmo 404 para o escalado.
      await expectSameNotFound(assigned.portal.api, party.eventId, 'escalado, sem plano');
      await apiPutRainPlan(authApi, party.eventId, []);
      await expectSameNotFound(assigned.portal.api, party.eventId, 'escalado, plano em rascunho');

      await apiPutRainPlan(
        authApi,
        party.eventId,
        [
          {
            activityId: indoor.id,
            replacesActivityId: party.contracted.id,
            description: 'Em roda, sentados',
            durationMinutes: 40,
            groups: 2,
          },
        ],
        'Usar a garagem do prédio',
      );

      const res = await assigned.portal.api.get(`/api/portal/my-events/${party.eventId}/rain-plan`);
      await assertOk(res, 'GET portal rain-plan (escalado)');
      const plan = await readJson<{
        status: string;
        notes: string | null;
        items: Array<{ title: string; replacesActivityName: string | null; groups: number | null }>;
      }>(res);
      expect(plan.status).toBe('Ready');
      expect(plan.notes).toBe('Usar a garagem do prédio');
      expect(plan.items[0]?.title).toBe(indoor.name);
      expect(plan.items[0]?.replacesActivityName).toBe(party.contracted.name);
      expect(plan.items[0]?.groups).toBe(2);

      await expectSameNotFound(unassigned.portal.api, party.eventId, 'colaborador não escalado');
      await expectSameNotFound(outsider.api, party.eventId, 'usuário de outra empresa');

      const mine = await openSessionPage(browser, assigned.portal.tokens);
      try {
        await mine.page.goto(`/portal/events/${party.eventId}`);
        const card = mine.page.getByTestId('portal-event-detail-rain-plan');
        await expect(card).toBeVisible({ timeout: 20_000 });
        await expect(mine.page.getByTestId('portal-event-detail-rain-plan-status')).toHaveText('Se chover');
        await expect(mine.page.getByTestId('portal-event-detail-rain-plan-notes')).toContainText(
          'Usar a garagem do prédio',
        );
        const item = mine.page.getByTestId('portal-event-detail-rain-plan-item-0');
        await expect(item).toContainText(indoor.name);
        await expect(item).toContainText(`no lugar de ${party.contracted.name}`);
      } finally {
        await mine.context.close();
      }

      for (const [who, session] of [
        ['não escalado', unassigned.portal],
        ['outra empresa', outsider],
      ] as const) {
        const view = await openSessionPage(browser, session.tokens);
        try {
          // A tela pede a festa ao back (que responde 404 a quem não está
          // escalado); depois disso, o card do Plano B não aparece.
          const detailAnswered = view.page.waitForResponse((r) =>
            r.url().includes(`/api/portal/my-events/${party.eventId}`),
          );
          await view.page.goto(`/portal/events/${party.eventId}`);
          await detailAnswered;
          await expect(view.page.getByTestId('portal-event-detail-rain-plan'), who).toHaveCount(0);
        } finally {
          await view.context.close();
        }
      }
    } finally {
      await assigned.portal.api.dispose();
      await unassigned.portal.api.dispose();
      await outsider.api.dispose();
      await otherApi.dispose();
    }
  });
});
