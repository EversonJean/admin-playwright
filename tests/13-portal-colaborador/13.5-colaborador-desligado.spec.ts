import { APIRequestContext } from '@playwright/test';

import { authTest as test, expect } from '../../fixtures/auth.fixture';
import {
  CSRF_HEADER,
  createApiContext,
  createBearerApiContext,
  loginViaApi,
  refreshCookieHeader,
} from '../../helpers/api-client';
import { apiCompleteOnboarding } from '../../helpers/api-entities';
import { apiAssignCollaborator } from '../../helpers/api-event-flow';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';
import { apiErrorCodes, assertOk, readJson } from '../../helpers/response';
import { openSessionPage, portalDeclineEvent, setupAcceptedEvent, setupPortalUser } from '../../helpers/setup-flows';

/**
 * Fluxo: 13.5 — Colaborador desligado, escala recusada e fronteira do portal
 * Diagrama: docs/fluxos/negocio-13-portal-do-colaborador.mmd
 * (cenários E92 a E95 do registro e2e de `docs/implementar/PLANO-SEGURANCA.md`)
 *
 * Fonte do comportamento: PLANO-SEGURANCA §8 (SEG-F): item 1 (colaborador
 * inativo perde o portal com 403 `Portal.NotLinked`; o evento de desligamento
 * revoga os refresh tokens e troca o `SecurityStamp`, sem `Block()`; reativar
 * devolve o acesso sem desbloqueio manual; A8), itens 3 e 4 (consumo de
 * material só com escala `Pending`/`Confirmed`, 403 `Portal.NotAssigned`;
 * briefing, detalhe e roteiro excluem escala recusada), item 9a (`POST
 * /api/me/whatsapp-link` recusa o usuário do portal com
 * `UserWhatsappLink.PortalUserNotAllowed`) e item 11 do front (o shell `/app`
 * barra o papel do portal), mais a decisão da Etapa 236 de que excluir
 * colaborador com usuário de portal é recusado e o caminho é a inativação. O
 * spec afirma o plano; divergência é falha de código, não de asserção.
 */

const PORTAL_PASSWORD = 'Dev12345!';

interface CollaboratorDetail {
  id: string;
  name: string;
  role: string;
  email: string | null;
  phone: string | null;
  defaultPaymentPerEvent: number | null;
  address: Record<string, unknown> | null;
  notes: string | null;
  status: string;
  levelId?: string | null;
}

/** PUT do colaborador com o mesmo cadastro e só o status trocado (o PUT é estado completo). */
async function setCollaboratorStatus(api: APIRequestContext, id: string, status: 'Active' | 'Inactive'): Promise<void> {
  const get = await api.get(`/api/collaborators/${id}`);
  await assertOk(get, 'GET /api/collaborators/{id}');
  const c = await readJson<CollaboratorDetail>(get);
  const res = await api.put(`/api/collaborators/${id}`, {
    data: {
      name: c.name,
      role: c.role,
      email: c.email,
      phone: c.phone,
      defaultPaymentPerEvent: c.defaultPaymentPerEvent,
      address: c.address,
      notes: c.notes,
      status,
      levelId: c.levelId ?? null,
    },
  });
  await assertOk(res, `PUT colaborador ${status}`);
}

/** Renovação da sessão por um contexto anônimo descartado; devolve o status. */
async function refreshStatus(refreshToken: string): Promise<number> {
  const anon = await createApiContext();
  try {
    const res = await anon.post('/api/auth/refresh', { headers: { ...refreshCookieHeader(refreshToken), ...CSRF_HEADER } });
    return res.status();
  } finally {
    await anon.dispose();
  }
}

function isoDay(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

test.describe('Fluxo 13.5 — Colaborador desligado e escala recusada', () => {
  test('E92 @flow gestor inativa o colaborador: o portal dá 403 Portal.NotLinked, a renovação dá 401 e a tela sai do portal; reativado, entra de novo', async ({
    authApi,
    tenant,
    browser,
  }) => {
    test.setTimeout(180_000);
    await apiCompleteOnboarding(authApi);
    const portal = await setupPortalUser(authApi, tenant.tenantId);
    // Segunda sessão do mesmo usuário, só para a tela (o boot gira o refresh dela).
    const uiTokens = await (async () => {
      const anon = await createApiContext();
      try {
        return await loginViaApi(anon, portal.email, PORTAL_PASSWORD);
      } finally {
        await anon.dispose();
      }
    })();
    const { page, context } = await openSessionPage(browser, uiTokens);
    try {
      await page.goto('/portal');
      await page.waitForURL(/\/portal(\/|\?|$)/, { timeout: 15_000 });
      expect((await portal.portalApi.get('/api/portal/my-events')).status(), 'portal antes').toBe(200);

      await setCollaboratorStatus(authApi, portal.collaboratorId, 'Inactive');

      // No request seguinte o portal dele dá 403 Portal.NotLinked.
      const denied = await portal.portalApi.get('/api/portal/my-events');
      expect(denied.status(), 'portal depois de inativar').toBe(403);
      expect(await apiErrorCodes(denied)).toContain('Portal.NotLinked');

      // O evento de desligamento é assíncrono: quando ele troca o SecurityStamp,
      // o access token antigo passa a 401. Esperar por isso (e não pelo refresh,
      // que um 200 no meio do caminho giraria e consumiria) e então renovar UMA vez.
      await expect
        .poll(async () => (await portal.portalApi.get('/api/portal/my-events')).status(), {
          message: 'o desligamento troca o SecurityStamp',
          timeout: 60_000,
          intervals: [1_000, 2_000],
        })
        .toBe(401);
      expect(await refreshStatus(portal.tokens.refreshToken), 'renovação da sessão recusada').toBe(401);

      // A tela sai do portal.
      await page.reload();
      await page.waitForURL(/\/auth\/login/, { timeout: 20_000 });

      // Reativado: login novo, sem desbloqueio manual.
      await setCollaboratorStatus(authApi, portal.collaboratorId, 'Active');
      const again = await (async () => {
        const anon = await createApiContext();
        try {
          return await loginViaApi(anon, portal.email, PORTAL_PASSWORD);
        } finally {
          await anon.dispose();
        }
      })();
      const againApi = await createBearerApiContext(again.accessToken);
      try {
        expect((await againApi.get('/api/portal/my-events')).status(), 'portal depois de reativar').toBe(200);
      } finally {
        await againApi.dispose();
      }
    } finally {
      await context.close();
      await portal.portalApi.dispose();
    }
  });

  test('E93 @flow excluir colaborador com usuário de portal é recusado (409) e o portal dele segue funcionando', async ({
    authApi,
    tenant,
  }) => {
    const portal = await setupPortalUser(authApi, tenant.tenantId);
    try {
      const del = await authApi.delete(`/api/collaborators/${portal.collaboratorId}`);
      expect(del.status(), 'excluir colaborador com portal').toBe(409);
      expect(await apiErrorCodes(del)).toContain('Collaborator.HasReferences');

      expect((await authApi.get(`/api/collaborators/${portal.collaboratorId}`)).status(), 'cadastro segue').toBe(200);
      expect((await portal.portalApi.get('/api/portal/my-events')).status(), 'portal segue').toBe(200);
    } finally {
      await portal.portalApi.dispose();
    }
  });

  test('E94 @flow escala recusada: detalhe, briefing e roteiro dão 404 e o consumo de material 403 Portal.NotAssigned; a outra festa segue normal', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(180_000);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_stock');
    const portal = await setupPortalUser(authApi, tenant.tenantId);
    try {
      const declined = await setupAcceptedEvent(authApi, { budget: { eventDate: isoDay(30) } });
      const kept = await setupAcceptedEvent(authApi, { budget: { eventDate: isoDay(37) } });
      await apiAssignCollaborator(authApi, declined.eventId, portal.collaboratorId);
      await apiAssignCollaborator(authApi, kept.eventId, portal.collaboratorId);

      // Antes da recusa, as duas festas abrem no portal.
      for (const id of [declined.eventId, kept.eventId]) {
        expect((await portal.portalApi.get(`/api/portal/my-events/${id}`)).status(), `detalhe ${id} antes`).toBe(200);
      }

      await portalDeclineEvent(portal.portalApi, declined.eventId);

      for (const path of ['', '/briefing', '/playbook']) {
        const res = await portal.portalApi.get(`/api/portal/my-events/${declined.eventId}${path}`);
        expect(res.status(), `festa recusada ${path || '(detalhe)'}`).toBe(404);
      }
      const consumption = await portal.portalApi.post(
        `/api/portal/my-events/${declined.eventId}/material-consumption`,
        { data: { lines: [] } },
      );
      expect(consumption.status(), 'consumo na festa recusada').toBe(403);
      expect(await apiErrorCodes(consumption)).toContain('Portal.NotAssigned');

      // A escala Pending de outra festa segue normal.
      expect((await portal.portalApi.get(`/api/portal/my-events/${kept.eventId}`)).status(), 'outra festa: detalhe').toBe(200);
      expect(
        (await portal.portalApi.get(`/api/portal/my-events/${kept.eventId}/briefing`)).status(),
        'outra festa: briefing',
      ).toBe(200);
      const keptConsumption = await portal.portalApi.post(
        `/api/portal/my-events/${kept.eventId}/material-consumption`,
        { data: { lines: [] } },
      );
      expect(await apiErrorCodes(keptConsumption).catch(() => [] as string[]), 'outra festa: consumo não barra por escala').not.toContain(
        'Portal.NotAssigned',
      );
      expect(keptConsumption.status(), 'outra festa: consumo não é 403').not.toBe(403);
    } finally {
      await portal.portalApi.dispose();
    }
  });

  test('E95 @flow usuário do portal que abre /app cai em /portal; POST /api/me/whatsapp-link dá 403 UserWhatsappLink.PortalUserNotAllowed', async ({
    authApi,
    tenant,
    browser,
  }) => {
    test.setTimeout(120_000);
    await apiCompleteOnboarding(authApi);
    const portal = await setupPortalUser(authApi, tenant.tenantId);
    const { page, context } = await openSessionPage(browser, portal.tokens);
    try {
      for (const path of ['/app', '/app/clients/list', '/app/events/list']) {
        await page.goto(path);
        await page.waitForURL(/\/portal(\/|\?|$)/, { timeout: 20_000 });
        expect(new URL(page.url()).pathname, `${path} vai ao portal`).toMatch(/^\/portal/);
      }

      const link = await portal.portalApi.post('/api/me/whatsapp-link');
      expect(link.status(), 'vínculo de WhatsApp na lane do gestor').toBe(403);
      expect(await apiErrorCodes(link)).toContain('UserWhatsappLink.PortalUserNotAllowed');
    } finally {
      await context.close();
      await portal.portalApi.dispose();
    }
  });
});
