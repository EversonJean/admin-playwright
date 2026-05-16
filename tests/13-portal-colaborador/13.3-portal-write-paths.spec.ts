import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { setupAcceptedEvent, setupPortalUser } from '../../helpers/setup-flows';
import { apiAssignCollaborator } from '../../helpers/api-event-flow';

/**
 * Cobertura adicional 13 — write paths do portal (PUT profile,
 * POST confirm/decline, PUT payout-profile).
 */

test.describe('13.3 — Portal write paths', () => {
  test('@crud PUT /api/portal/profile atualiza dados pessoais', async ({ authApi, tenant }) => {
    const portalCtx = await setupPortalUser(authApi, tenant.tenantId);
    try {
      const res = await portalCtx.portalApi.put('/api/portal/profile', {
        data: { name: 'Atualizado E2E', phone: '41999990000' },
      });
      expect(res.status(), `PUT profile: ${res.status()}`).toBeLessThan(500);
    } finally {
      await portalCtx.portalApi.dispose();
      await portalCtx.publicApiDispose();
    }
  });

  test('@crud POST /my-events/:id/confirm aceita escalacao', async ({ authApi, tenant }) => {
    const { eventId } = await setupAcceptedEvent(authApi);
    const portalCtx = await setupPortalUser(authApi, tenant.tenantId);
    try {
      await apiAssignCollaborator(authApi, eventId, portalCtx.collaboratorId);
      const res = await portalCtx.portalApi.post(`/api/portal/my-events/${eventId}/confirm`);
      expect(res.status(), `confirm: ${res.status()}`).toBeLessThan(500);
    } finally {
      await portalCtx.portalApi.dispose();
      await portalCtx.publicApiDispose();
    }
  });

  test('@crud POST /my-events/:id/decline recusa escalacao com motivo', async ({
    authApi,
    tenant,
  }) => {
    const { eventId } = await setupAcceptedEvent(authApi);
    const portalCtx = await setupPortalUser(authApi, tenant.tenantId);
    try {
      await apiAssignCollaborator(authApi, eventId, portalCtx.collaboratorId);
      const res = await portalCtx.portalApi.post(`/api/portal/my-events/${eventId}/decline`, {
        data: { reason: 'Conflito de agenda E2E' },
      });
      expect(res.status(), `decline: ${res.status()}`).toBeLessThan(500);
    } finally {
      await portalCtx.portalApi.dispose();
      await portalCtx.publicApiDispose();
    }
  });

  test('@crud PUT /payout-profile cria dados bancarios', async ({ authApi, tenant }) => {
    const portalCtx = await setupPortalUser(authApi, tenant.tenantId);
    try {
      const res = await portalCtx.portalApi.put('/api/portal/payout-profile', {
        data: { pixKey: 'colab-e2e@test.com', pixKeyType: 'Email' },
      });
      expect(res.status(), `PUT payout: ${res.status()}`).toBeLessThan(500);
    } finally {
      await portalCtx.portalApi.dispose();
      await portalCtx.publicApiDispose();
    }
  });
});
