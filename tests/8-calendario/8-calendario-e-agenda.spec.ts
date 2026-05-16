import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import { apiCreateCollaborator } from '../../helpers/api-entities';

/**
 * Fluxo: 8 — Calendário e agenda
 * Diagrama: docs/fluxos/negocio-8-calendario-e-agenda.mmd
 *
 * Endpoint principal: GET /api/collaborators/:id/schedule?fromUtc=&toUtc=
 * devolve eventos do colaborador no periodo (vista de calendario).
 */

test.describe('Fluxo 8 — Calendário e agenda', () => {
  test('@flow tela de calendário carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/schedule/calendar');
  });

  test('@crud GET schedule de colab novo retorna lista vazia no periodo', async ({
    authApi,
  }) => {
    const colab = await apiCreateCollaborator(authApi);
    const from = new Date(Date.now() - 30 * 86400000).toISOString();
    const to = new Date(Date.now() + 60 * 86400000).toISOString();
    const res = await authApi.get(
      `/api/collaborators/${colab.id}/schedule?fromUtc=${from}&toUtc=${to}`,
    );
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const data = body.data ?? body;
    // Colab novo sem eventos -> array vazio (ou objeto com items vazio)
    const items: Array<unknown> = Array.isArray(data) ? data : data.items ?? data.events ?? [];
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBe(0);
  });
});
