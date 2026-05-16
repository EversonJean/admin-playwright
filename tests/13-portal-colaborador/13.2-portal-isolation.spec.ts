import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { setupAcceptedEvent, setupPortalUser } from '../../helpers/setup-flows';
import { apiAssignCollaborator } from '../../helpers/api-event-flow';
import { assertOk, readJson } from '../../helpers/response';

/**
 * Cobertura sistemica — Portal do colaborador NAO deve vazar dados
 * sensiveis do evento (pricing, valores financeiros, dados completos
 * do cliente). PLANEJAMENTO §3438 e diagrama 13 N09.
 */

interface PortalEventDetail {
  id: string;
  // Campos OK pro colab
  eventDate?: string;
  startTime?: string;
  endTime?: string;
  location?: string;
  // Campos que NAO deveriam vir pro colab
  total?: number | null;
  pricingItems?: unknown[] | null;
  clientId?: string | null;
  budgetId?: string | null;
}

test.describe('Portal — privacy / dados sensiveis nao vazam pro colab', () => {
  test('@crud GET /api/portal/my-events/:id NAO expoe pricing/total/budgetId', async ({
    authApi,
    tenant,
  }) => {
    // 1. Admin cria evento + collab + escala colab
    const { eventId } = await setupAcceptedEvent(authApi);
    const portalCtx = await setupPortalUser(authApi, tenant.tenantId);
    try {
      await apiAssignCollaborator(authApi, eventId, portalCtx.collaboratorId);

      // 2. Colab acessa my-events/:id via portal
      const res = await portalCtx.portalApi.get(`/api/portal/my-events/${eventId}`);
      await assertOk(res, 'GET /api/portal/my-events/:id');
      const ev = await readJson<PortalEventDetail>(res);

      // 3. Campos operacionais OK: data, horario, local
      expect(ev.id).toBe(eventId);
      expect(ev.eventDate ?? ev.startTime, 'event date/start time presentes').toBeTruthy();

      // 4. Campos financeiros NAO podem aparecer
      expect(ev.total, 'colab NAO deve ver Total do evento').toBeFalsy();
      expect(ev.pricingItems, 'colab NAO deve ver pricingItems').toBeFalsy();
      expect(ev.budgetId, 'colab NAO deve ver budgetId').toBeFalsy();
    } finally {
      await portalCtx.portalApi.dispose();
      await portalCtx.publicApiDispose();
    }
  });
});
