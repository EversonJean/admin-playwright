import type { Page } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateSkill } from '../../helpers/api-entities';
import { setupPortalUser } from '../../helpers/setup-flows';
import { assertOk, readJson } from '../../helpers/response';

/**
 * Fluxo: 13.4 — Minhas habilidades (Portal do colaborador)
 * Diagrama: docs/fluxos/negocio-13-portal-do-colaborador.mmd
 *
 * Etapa 193 — quem sabe o que domina é o colaborador. Quem NUNCA revisou é
 * levado do Início para `/portal/skills?first=1` (uma vez por sessão, só na
 * página Início); salvar — mesmo sem nada marcado — confirma a revisão e volta
 * ao Início sem lembrete. Habilidade nova no catálogo depois da revisão faz a
 * faixa "Lembretes" (P9) mostrar `skills-review-catalog`.
 *
 * O usuário de portal é semeado por SQL (`seedCollaboratorPortalUserDirect`,
 * via `setupPortalUser`): nenhum fluxo do produto cria esse usuário hoje
 * (PLANO-HABILIDADES §1, ideia 9).
 */

interface MySkills {
  mySkillIds: string[];
  reviewedAt: string | null;
  reason: 'None' | 'Never' | 'Requested' | 'CatalogChanged';
  catalogIsEmpty: boolean;
}

/** Abre o Portal como o colaborador: mesmo mecanismo do `authPage`, com os tokens dele. */
async function usePortalTokens(
  page: Page,
  tokens: { accessToken: string; refreshToken: string },
): Promise<void> {
  await page.addInitScript(
    ({ access, refresh }) => {
      localStorage.setItem('access_token', access);
      if (refresh) localStorage.setItem('refresh_token', refresh);
    },
    { access: tokens.accessToken, refresh: tokens.refreshToken ?? null },
  );
}

const SKILLS_REMINDER_KEYS = [
  'skills-review-never',
  'skills-review-requested',
  'skills-review-catalog',
] as const;

test.describe('Flow 13.4 — My skills on the collaborator portal', () => {
  test('@crud first visit redirects to skills; saving returns home with no skills reminder', async ({
    authApi,
    tenant,
    page,
  }) => {
    // Catálogo não vazio: com catálogo vazio o back não pede revisão nenhuma.
    const face = await apiCreateSkill(authApi, { name: `Pintura Facial ${Date.now()}` });
    await apiCreateSkill(authApi, { name: `Balões ${Date.now()}` });

    const portal = await setupPortalUser(authApi, tenant.tenantId);
    try {
      await usePortalTokens(page, portal.tokens);

      await page.goto('/portal');
      await page.waitForURL(/\/portal\/skills\?first=1$/, { timeout: 15_000 });
      await expect(page.getByTestId('portal-skills-status-never')).toBeVisible();
      await expect(page.getByTestId('portal-skills-later')).toBeVisible();

      await page.getByTestId(`portal-skills-chip-${face.id}`).click();
      await page.getByTestId('portal-skills-save').click();

      await expect(
        page.locator('simple-snack-bar', { hasText: /Habilidades salvas/ }),
      ).toBeVisible({ timeout: 10_000 });
      await page.waitForURL(/\/portal$/, { timeout: 10_000 });
      await expect(page.getByTestId('portal-home-greeting')).toBeVisible();
      for (const key of SKILLS_REMINDER_KEYS) {
        await expect(page.getByTestId(`portal-home-reminder-${key}`)).toHaveCount(0);
      }

      // O back gravou a escolha e a revisão ("relogar" não traria lembrete).
      const res = await portal.portalApi.get('/api/portal/skills');
      await assertOk(res, 'GET /api/portal/skills');
      const mine = await readJson<MySkills>(res);
      expect(mine.mySkillIds).toEqual([face.id]);
      expect(mine.reason).toBe('None');
      expect(mine.reviewedAt).toBeTruthy();

      const homeRes = await portal.portalApi.get('/api/portal/home');
      await assertOk(homeRes, 'GET /api/portal/home');
      const home = await readJson<{ reminders?: Array<{ key: string }> }>(homeRes);
      expect((home.reminders ?? []).map((r) => r.key)).not.toContain('skills-review-never');
    } finally {
      await portal.portalApi.dispose();
      await portal.publicApiDispose();
    }
  });

  test('@flow a skill created by the manager after the review brings the catalog reminder back', async ({
    authApi,
    tenant,
    page,
  }) => {
    await apiCreateSkill(authApi, { name: `Recreação Aquática ${Date.now()}` });
    const portal = await setupPortalUser(authApi, tenant.tenantId);
    try {
      // Pré-condição por API: o colaborador já revisou ("não domino nenhuma"
      // é resposta válida e marca como revisado — decisão 6).
      await assertOk(
        await portal.portalApi.put('/api/portal/skills', { data: { skillIds: [] } }),
        'PUT /api/portal/skills',
      );

      // O gestor amplia o catálogo depois da revisão.
      await apiCreateSkill(authApi, { name: `Contação de Histórias ${Date.now()}` });

      await usePortalTokens(page, portal.tokens);
      await page.goto('/portal');
      await expect(page.getByTestId('portal-home-reminder-skills-review-catalog')).toBeVisible({
        timeout: 15_000,
      });
      // Não é "nunca revisou": sem interstício, o Início fica onde está.
      await expect(page).toHaveURL(/\/portal$/);
      await expect(page.getByTestId('portal-home-reminder-skills-review-never')).toHaveCount(0);

      // O lembrete leva para a tela, que explica o motivo.
      await page.getByTestId('portal-home-reminder-skills-review-catalog').getByRole('link').click();
      await page.waitForURL(/\/portal\/skills$/, { timeout: 10_000 });
      await expect(page.getByTestId('portal-skills-status-catalog')).toBeVisible();
      await expect(page.getByTestId('portal-skills-later')).toHaveCount(0);
    } finally {
      await portal.portalApi.dispose();
      await portal.publicApiDispose();
    }
  });
});
