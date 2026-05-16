import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateCollaborator } from '../../helpers/api-entities';

/**
 * Fluxo: 3.2 — Disponibilidade e bloqueios
 * Diagrama: docs/fluxos/negocio-3.2-disponibilidade-e-bloqueios.mmd
 *
 * Disponibilidade ao colaborador no detalhe da entidade (não tem rota
 * dedicada). O block é criado via API; o detalhe do colaborador deve
 * mostrar o bloqueio na timeline de schedule.
 */

test.describe('Fluxo 3.2 — Disponibilidade e bloqueios', () => {
  test('@flow tela de detalhe do colaborador carrega autenticada', async ({ authPage, authApi }) => {
    const created = await apiCreateCollaborator(authApi);
    await authPage.goto(`/app/collaborators/${created.id}`);
    await expect(authPage).toHaveURL(new RegExp(`/app/collaborators/${created.id}`));
    await expect(authPage.getByText(/acesso negado|403/i)).toHaveCount(0);
  });

  test('@crud cria bloqueio via API e aparece no schedule', async ({ authApi }) => {
    const colab = await apiCreateCollaborator(authApi);

    // Bloqueio: amanhã 09:00 → 18:00 (full day)
    const amanha = new Date();
    amanha.setUTCDate(amanha.getUTCDate() + 1);
    amanha.setUTCHours(12, 0, 0, 0); // 12:00 UTC = ~09:00 BRT
    const start = amanha.toISOString();
    const end = new Date(amanha.getTime() + 9 * 3600_000).toISOString();

    const createRes = await authApi.post(`/api/collaborators/${colab.id}/blocks`, {
      data: {
        startDateTime: start,
        endDateTime: end,
        blockType: 'Vacation',
        isFullDay: true,
        description: 'Férias E2E',
      },
    });
    if (!createRes.ok()) {
      throw new Error(`POST block ${createRes.status()}: ${await createRes.text()}`);
    }

    // Schedule do colaborador na janela de amanhã deve incluir o bloqueio
    const from = new Date(amanha.getTime() - 24 * 3600_000).toISOString();
    const to = new Date(amanha.getTime() + 48 * 3600_000).toISOString();
    const schedRes = await authApi.get(
      `/api/collaborators/${colab.id}/schedule?fromUtc=${encodeURIComponent(from)}&toUtc=${encodeURIComponent(to)}`,
    );
    expect(schedRes.ok()).toBe(true);
    const body = await schedRes.json();
    const data = body.data ?? body;
    const blocks = data.blocks ?? [];
    expect(blocks.length).toBeGreaterThan(0);
  });
});
