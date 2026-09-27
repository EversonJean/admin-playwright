import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';
import {
  apiAddCollaboratorSkill,
  apiCompleteOnboarding,
  apiCreateActivity,
  apiCreateCollaborator,
  apiCreateSkill,
} from '../../helpers/api-entities';
import { assertOk, readJson, unwrapList } from '../../helpers/response';

/**
 * Fluxo: 3.4 — Catálogo de habilidades
 * Diagrama: docs/fluxos/negocio-3.4-catalogo-de-habilidades.mmd
 *
 * Etapa 192 — habilidade virou entidade do tenant (Configurações ->
 * Habilidades). Nome único por forma normalizada (trim, espaços colapsados,
 * minúsculas, SEM acento): "Pintura fácial" é duplicata de "Pintura Facial".
 * Colaborador e atividade apontam por `skillId`. "Mesclar em…" soft-deleta a
 * origem e publica `SkillMergedIntegrationEvent`; os handlers de Collaborators
 * e Activities reatribuem as próprias linhas DEPOIS do commit, pelo Outbox —
 * por isso o teste espera a condição com teto, nunca um sleep.
 *
 * Etapa 193 — no cadastro do colaborador o painel é "Habilidades (opcional)",
 * escolhe do catálogo por select com busca e tem "Pedir revisão ao
 * colaborador", que grava o pedido mesmo sem usuário de portal.
 */

/** Teto do Outbox: poll de 5s no worker + folga para o handler. */
const OUTBOX_TIMEOUT_MS = 30_000;

interface SkillListItem {
  id: string;
  name: string;
  collaboratorCount: number;
  activityCount: number;
}

interface CollaboratorSkillRow {
  skillId: string;
  skillName: string;
}

test.describe('Flow 3.4 — Skill catalog', () => {
  // Tenant novo cai no assistente de configuração a cada carga de página; as
  // telas deste fluxo só aparecem com a configuração inicial concluída.
  test.beforeEach(async ({ authApi }) => {
    await apiCompleteOnboarding(authApi);
  });

  test('@smoke skills settings page loads authenticated', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/skills');
    await expect(authPage.getByTestId('skills-inactive-hint')).toBeVisible();
  });

  test('@crud creates a skill via UI and refuses the accented duplicate', async ({
    authPage,
    authApi,
  }) => {
    const suffix = Date.now();
    const name = `Pintura Facial ${suffix}`;

    await authPage.goto('/app/settings/skills/new');
    await authPage.getByTestId('skill-form-name').fill(name);
    await authPage.getByTestId('skill-form-save').click();
    await authPage.waitForURL(/\/app\/settings\/skills(\?|$)/, { timeout: 10_000 });

    const listRes = await authApi.get(`/api/skills?search=${encodeURIComponent(String(suffix))}`);
    await assertOk(listRes, 'GET /api/skills');
    const created = (await unwrapList<SkillListItem>(listRes)).find((s) => s.name === name);
    expect(created, 'habilidade criada pela UI aparece no catálogo').toBeTruthy();

    // Mesma habilidade com outra caixa e com acento: a tela fica no form e
    // mostra o erro de duplicata vindo do back.
    await authPage.goto('/app/settings/skills/new');
    await authPage.getByTestId('skill-form-name').fill(`pintura  fácial ${suffix}`);
    await authPage.getByTestId('skill-form-save').click();
    // O errorInterceptor global notifica todo erro HTTP e o form substitui a
    // mensagem pela do tradutor: durante a troca os dois snackbars coexistem.
    await expect(
      authPage
        .locator('simple-snack-bar', { hasText: /já cadastrada|já existe uma habilidade/i })
        .last(),
    ).toBeVisible({ timeout: 10_000 });
    await expect(authPage).toHaveURL(/\/app\/settings\/skills\/new$/);

    // O contrato por trás da mensagem: 409 com o código de domínio.
    const duplicate = await authApi.post('/api/skills', { data: { name: `PINTURA FÁCIAL ${suffix}` } });
    expect(duplicate.status()).toBe(409);
    expect(JSON.stringify(await duplicate.json())).toContain('Skill.AlreadyExists');
  });

  test('@flow merge-into moves collaborators and activities to the target through the Outbox', async ({
    authApi,
  }) => {
    const source = await apiCreateSkill(authApi, { name: `pintura facil ${Date.now()}` });
    const target = await apiCreateSkill(authApi, { name: `Pintura Artistica ${Date.now()}` });
    const collaborator = await apiCreateCollaborator(authApi);
    const activity = await apiCreateActivity(authApi);
    await apiAddCollaboratorSkill(authApi, collaborator.id, source.id);
    await assertOk(
      await authApi.post(`/api/activities/${activity.id}/skill-requirements`, {
        data: { skillId: source.id, isRequired: true },
      }),
      'POST activity skill-requirement',
    );

    const mergeRes = await authApi.post(`/api/skills/${source.id}/merge-into/${target.id}`);
    await assertOk(mergeRes, 'POST merge-into');
    const summary = await readJson<{
      targetSkillId: string;
      targetSkillName: string;
      collaboratorCount: number;
      activityCount: number;
    }>(mergeRes);
    // Resumo calculado ANTES do commit: é o "N colaboradores e M atividades passam para X".
    expect(summary).toMatchObject({
      targetSkillId: target.id,
      targetSkillName: target.name,
      collaboratorCount: 1,
      activityCount: 1,
    });

    // A origem sai do catálogo na hora (soft delete no mesmo commit).
    expect((await authApi.get(`/api/skills/${source.id}`)).status()).toBe(404);

    // A reatribuição das linhas é assíncrona (handlers do evento, via Outbox).
    await expect
      .poll(
        async () => {
          const res = await authApi.get(`/api/collaborators/${collaborator.id}/skills`);
          if (!res.ok()) return `HTTP ${res.status()}`;
          return (await readJson<CollaboratorSkillRow[]>(res)).map((r) => r.skillId).join(',');
        },
        { timeout: OUTBOX_TIMEOUT_MS, message: 'colaborador passa a ter a habilidade alvo' },
      )
      .toBe(target.id);

    await expect
      .poll(
        async () => {
          const res = await authApi.get(`/api/activities/${activity.id}/skill-requirements`);
          if (!res.ok()) return `HTTP ${res.status()}`;
          return (await readJson<Array<{ skillId: string; isRequired: boolean }>>(res))
            .map((r) => `${r.skillId}:${r.isRequired}`)
            .join(',');
        },
        { timeout: OUTBOX_TIMEOUT_MS, message: 'requisito da atividade passa para a habilidade alvo' },
      )
      .toBe(`${target.id}:true`);

    // O uso do alvo soma o que era da origem.
    const targetRes = await authApi.get(`/api/skills/${target.id}`);
    await assertOk(targetRes, 'GET target skill');
    expect(await readJson<SkillListItem>(targetRes)).toMatchObject({
      collaboratorCount: 1,
      activityCount: 1,
    });
  });

  test('@crud collaborator form picks from the catalog with search and requests a review', async ({
    authPage,
    authApi,
  }) => {
    const skill = await apiCreateSkill(authApi, { name: `Oficina de Slime ${Date.now()}` });
    // Uma segunda habilidade para a busca ter o que esconder.
    const other = await apiCreateSkill(authApi, { name: `Malabares ${Date.now()}` });
    const collaborator = await apiCreateCollaborator(authApi);

    await authPage.goto(`/app/collaborators/${collaborator.id}`);
    await expect(authPage.getByTestId('skills-panel-title')).toHaveText('Habilidades (opcional)');
    await expect(authPage.getByTestId('skills-panel-empty')).toBeVisible();
    await expect(authPage.getByTestId('collaborator-skills-review-status')).toContainText(
      'Ainda não revisadas pelo colaborador',
    );

    await authPage.getByTestId('skills-panel-select').click();
    await authPage.getByTestId('skills-panel-search').fill('slime');
    await expect(authPage.getByTestId(`skills-panel-option-${other.id}`)).toHaveCount(0);
    await authPage.getByTestId(`skills-panel-option-${skill.id}`).click();
    await authPage.getByTestId('skills-panel-add').click();

    await expect(authPage.getByTestId('skills-panel-item-name')).toHaveText(skill.name);
    const skillsRes = await authApi.get(`/api/collaborators/${collaborator.id}/skills`);
    await assertOk(skillsRes, 'GET collaborator skills');
    expect((await readJson<CollaboratorSkillRow[]>(skillsRes)).map((r) => r.skillId)).toEqual([
      skill.id,
    ]);

    // Sem usuário de portal: o pedido é gravado e a tela diz que ninguém foi avisado agora.
    await authPage.getByTestId('collaborator-skills-request-review').click();
    await expect(
      authPage.locator('simple-snack-bar', { hasText: /Pedido registrado/ }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(authPage.getByTestId('collaborator-skills-review-status')).toContainText(
      'Revisão pedida em',
    );

    const collabRes = await authApi.get(`/api/collaborators/${collaborator.id}`);
    await assertOk(collabRes, 'GET collaborator');
    const collab = await readJson<{ skillsReviewRequestedAt: string | null }>(collabRes);
    expect(collab.skillsReviewRequestedAt).toBeTruthy();
  });
});
