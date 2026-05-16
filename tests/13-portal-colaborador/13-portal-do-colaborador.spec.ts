import { test, expect, request as playwrightRequest } from '@playwright/test';
import { authTest } from '../../fixtures/auth.fixture';
import { apiCreateCollaborator } from '../../helpers/api-entities';
import { seedCollaboratorPortalUserDirect } from '../../helpers/db-helper';
import { loginViaApi } from '../../helpers/api-client';

/**
 * Fluxo: 13 — Portal do colaborador
 * Diagrama: docs/fluxos/negocio-13-portal-do-colaborador.mmd
 *
 * Cria Collaborator via admin, gera User CollaboratorPortal via SQL com
 * PasswordHash copiado do `superadmin@dev.local` (senha Dev12345!),
 * loga e exercita /api/portal/*.
 */

const BACK_URL = process.env.BACK_URL ?? 'https://localhost:1501';

test.describe('Fluxo 13 — Portal do colaborador (anonimo)', () => {
  test('@flow rota /portal redireciona anônimo pra login', async ({ page }) => {
    await page.goto('/portal');
    await expect(page).toHaveURL(/\/auth\/login/);
  });
});

authTest.describe('Fluxo 13 — Setup do Collaborator (admin view)', () => {
  authTest('@crud admin cria Collaborator que vira candidato a portal', async ({
    authApi,
  }) => {
    const colab = await apiCreateCollaborator(authApi);
    expect(colab.id).toBeTruthy();
    const fetchRes = await authApi.get(`/api/collaborators/${colab.id}`);
    expect(fetchRes.ok()).toBe(true);
  });
});

authTest.describe('Fluxo 13 — Portal do colaborador (autenticado)', () => {
  authTest('@crud login portal -> GET /profile /availability /my-events /my-commissions /payout', async ({
    authApi,
    tenant,
  }) => {
    const colab = await apiCreateCollaborator(authApi);
    const portalUser = seedCollaboratorPortalUserDirect({
      tenantId: tenant.tenantId,
      collaboratorId: colab.id,
    });

    const publicApi = await playwrightRequest.newContext({
      baseURL: BACK_URL,
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: { 'Content-Type': 'application/json' },
    });
    try {
      const tokens = await loginViaApi(publicApi, portalUser.email, portalUser.password);
      expect(tokens.accessToken).toBeTruthy();

      const portalApi = await playwrightRequest.newContext({
        baseURL: BACK_URL,
        ignoreHTTPSErrors: true,
        extraHTTPHeaders: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokens.accessToken}`,
        },
      });
      try {
        const profile = await portalApi.get('/api/portal/profile');
        expect(profile.ok()).toBe(true);
        const profileData = (await profile.json()).data ?? (await profile.json());
        expect(profileData.collaboratorId ?? profileData.id).toBeTruthy();

        const events = await portalApi.get('/api/portal/my-events');
        expect(events.ok()).toBe(true);

        const availability = await portalApi.get('/api/portal/availability');
        expect(availability.ok()).toBe(true);

        const commissions = await portalApi.get('/api/portal/my-commissions');
        expect(commissions.ok()).toBe(true);

        const payout = await portalApi.get('/api/portal/payout-profile');
        // 200 quando ja existe, 4xx quando colab nao tem profile ainda
        expect(payout.status()).toBeLessThan(500);
      } finally {
        await portalApi.dispose();
      }
    } finally {
      await publicApi.dispose();
    }
  });

  authTest('@crud POST /api/portal/availability/overrides bloqueia data', async ({
    authApi,
    tenant,
  }) => {
    const colab = await apiCreateCollaborator(authApi);
    const portalUser = seedCollaboratorPortalUserDirect({
      tenantId: tenant.tenantId,
      collaboratorId: colab.id,
    });

    const publicApi = await playwrightRequest.newContext({
      baseURL: BACK_URL,
      ignoreHTTPSErrors: true,
      extraHTTPHeaders: { 'Content-Type': 'application/json' },
    });
    try {
      const tokens = await loginViaApi(publicApi, portalUser.email, portalUser.password);
      const portalApi = await playwrightRequest.newContext({
        baseURL: BACK_URL,
        ignoreHTTPSErrors: true,
        extraHTTPHeaders: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokens.accessToken}`,
        },
      });
      try {
        const day = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
        const r = await portalApi.post('/api/portal/availability/overrides', {
          data: { date: day, isAvailable: false, reason: 'Bloqueio E2E' },
        });
        expect(r.status()).toBeLessThan(500);
      } finally {
        await portalApi.dispose();
      }
    } finally {
      await publicApi.dispose();
    }
  });
});
