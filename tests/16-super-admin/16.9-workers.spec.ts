import { APIRequestContext, Browser, BrowserContext, Page, mergeTests } from '@playwright/test';

import { authTest, expect } from '../../fixtures/auth.fixture';
import { superAdminTest } from '../../fixtures/super-admin.fixture';
import { addSessionToContext, createApiContext } from '../../helpers/api-client';
import { apiErrorCodes, assertOk, unwrapList } from '../../helpers/response';
import { loginSuperAdminViaApi } from '../../helpers/super-admin-session';
import { apiListWorkers } from '../../helpers/workers';

/**
 * Fluxo: 16.9 — Workers da plataforma no Super Admin
 * Diagrama: — (o plano é a fonte: PLANO-EXECUCAO-DOS-WORKERS §5, WK-C,
 * Etapa 264; registro e2e E2 e E3)
 *
 * E2: o Super Admin abre `/super-admin/workers`, pede "Rodar agora" num job
 * automático do grupo 1 (`WorkerHousekeepingWorker`, poda de `WorkerRun` acima
 * de 30 dias, que aceita rodar fora da agenda: D9), confirma, vê a linha
 * "Agendado" e, no próximo despertar do worker (até 1 minuto, §5 regra 4), a
 * execução com gatilho "Rodar agora" no histórico e o último sucesso na tabela.
 * O `PurgeExecutionWorker` (só roda pela agenda, D9) mostra o botão
 * desabilitado com o motivo, e o POST direto leva 409 `Workers.ManualRunNotAllowed`.
 *
 * E3: o usuário de tenant (Owner, quem criou a empresa) não abre a tela e leva
 * 403 no `GET /api/super-admin/workers` e no run-now; sem token, 401.
 */

const test = mergeTests(authTest, superAdminTest);

const SUPER_ADMIN_URL = process.env.SUPER_ADMIN_URL ?? 'http://localhost:4201';
const WORKERS_ROUTE = '/super-admin/workers';
const MANUAL_JOB = 'WorkerHousekeepingWorker';
const SCHEDULE_ONLY_JOB = 'PurgeExecutionWorker';
const SCHEDULE_ONLY_REASON = 'Este job só roda pela agenda';

/** Despertar do worker (até 60 s) + consulta do pedido (até 50 s) + o ciclo, com folga. */
const MANUAL_RUN_TIMEOUT = 240_000;
const POLL_INTERVALS = [3_000, 5_000];

interface WorkerRun {
  id: string;
  workerName: string;
  startedAt: string;
  status: 'Succeeded' | 'Failed' | 'Crashed';
  trigger: 'Schedule' | 'Manual' | 'Boot';
}

async function apiWorkerRuns(api: APIRequestContext, name: string): Promise<WorkerRun[]> {
  const res = await api.get(`/api/super-admin/workers/${name}/runs?page=1&pageSize=50`);
  await assertOk(res, `GET /api/super-admin/workers/${name}/runs`);
  return unwrapList<WorkerRun>(res);
}

/** Painel do Super Admin numa sessão própria (login com o desafio MFA). Quem chama fecha o contexto. */
async function openWorkersAsSuperAdmin(browser: Browser): Promise<{ page: Page; context: BrowserContext }> {
  const anon = await createApiContext();
  const tokens = await loginSuperAdminViaApi(anon).finally(() => anon.dispose());
  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  await addSessionToContext(context, tokens.refreshToken);
  const page = await context.newPage();
  await page.goto(`${SUPER_ADMIN_URL}${WORKERS_ROUTE}`);
  await expect(page.getByTestId('workers-page')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('workers-list')).toBeVisible({ timeout: 30_000 });
  return { page, context };
}

test.describe('Fluxo 16.9 — Workers da plataforma', () => {
  // ─── E2 — Lista, "rodar agora" e histórico ──────────────────────────────
  test('E2 @crud the Super Admin sees the workers, asks "Rodar agora" on a group 1 job, sees the manual run in the history and the last success; PurgeExecutionWorker shows the button disabled with the reason', async ({
    superAdminApi,
    browser,
  }) => {
    test.setTimeout(MANUAL_RUN_TIMEOUT + 180_000);

    const before = await apiListWorkers(superAdminApi);
    const manualJob = before.find((w) => w.name === MANUAL_JOB);
    const scheduleOnly = before.find((w) => w.name === SCHEDULE_ONLY_JOB);
    expect(manualJob, `${MANUAL_JOB} na lista`).toBeDefined();
    expect(scheduleOnly, `${SCHEDULE_ONLY_JOB} na lista`).toBeDefined();
    expect(manualJob!.enabled, `${MANUAL_JOB} ligado no E2E`).toBe(true);
    expect(manualJob!.manualRunAllowed).toBe(true);
    expect(scheduleOnly!.manualRunAllowed).toBe(false);
    const manualRunIdsBefore = new Set(
      (await apiWorkerRuns(superAdminApi, MANUAL_JOB)).filter((r) => r.trigger === 'Manual').map((r) => r.id),
    );

    const { page, context } = await openWorkersAsSuperAdmin(browser);
    try {
      // D9: o executor de expurgo só roda pela agenda; o motivo está no tooltip.
      const blocked = page.getByTestId(`worker-run-now-${SCHEDULE_ONLY_JOB}`);
      await expect(blocked).toBeVisible();
      await expect(blocked).toBeDisabled();
      await page.getByTestId(`worker-run-now-reason-${SCHEDULE_ONLY_JOB}`).hover();
      await expect(page.locator('.mat-mdc-tooltip')).toContainText(SCHEDULE_ONLY_REASON);
      const refused = await superAdminApi.post(`/api/super-admin/workers/${SCHEDULE_ONLY_JOB}/run-now`);
      expect(refused.status(), 'run-now de job só de agenda').toBe(409);
      expect(await apiErrorCodes(refused)).toContain('Workers.ManualRunNotAllowed');

      // "Rodar agora" no job do grupo 1, com confirmação.
      const runNow = page.getByTestId(`worker-run-now-${MANUAL_JOB}`);
      await expect(runNow).toBeEnabled();
      await runNow.click();
      await expect(page.getByTestId('confirm-title')).toHaveText('Rodar agora');
      await page.getByTestId('confirm-ok').click();
      await expect(page.getByTestId(`worker-scheduled-${MANUAL_JOB}`)).toBeVisible({ timeout: 20_000 });

      // O worker consome o pedido no próximo despertar e grava a execução manual.
      let manualRun: WorkerRun | undefined;
      await expect
        .poll(
          async () => {
            manualRun = (await apiWorkerRuns(superAdminApi, MANUAL_JOB)).find(
              (r) => r.trigger === 'Manual' && !manualRunIdsBefore.has(r.id),
            );
            return manualRun?.status ?? null;
          },
          { message: 'execução manual no histórico', timeout: MANUAL_RUN_TIMEOUT, intervals: POLL_INTERVALS },
        )
        .toBe('Succeeded');
      await expect
        .poll(async () => (await apiListWorkers(superAdminApi)).find((w) => w.name === MANUAL_JOB)!.manualRunPending, {
          message: 'pedido consumido',
          timeout: 60_000,
          intervals: POLL_INTERVALS,
        })
        .toBe(false);

      // Tabela: último sucesso, em dia, sem o "Agendado".
      await page.getByTestId('workers-refresh').click();
      await expect(page.getByTestId(`worker-scheduled-${MANUAL_JOB}`)).toHaveCount(0, { timeout: 20_000 });
      await expect(page.getByTestId(`worker-last-success-${MANUAL_JOB}`)).not.toHaveText('nunca');
      await expect(page.getByTestId(`worker-health-${MANUAL_JOB}`)).toHaveText('Em dia');

      // Histórico no painel lateral: a execução manual, com sucesso.
      await page.getByTestId(`worker-row-${MANUAL_JOB}`).click();
      await expect(page.getByTestId('worker-runs-drawer-title')).toHaveText(MANUAL_JOB);
      const row = page.getByTestId(`worker-run-${manualRun!.id}`);
      await expect(row).toBeVisible({ timeout: 20_000 });
      await expect(row).toContainText('Rodar agora');
      await expect(page.getByTestId(`worker-run-status-${manualRun!.id}`)).toHaveText('Sucesso');
    } finally {
      await context.close();
    }
  });

  // ─── E3 — Usuário de tenant ─────────────────────────────────────────────
  test('E3 @flow a tenant user (Owner) does not open the workers page and gets 403 on the list and on run-now; without a token, 401', async ({
    authPage,
    authApi,
  }) => {
    await authPage.goto(`${SUPER_ADMIN_URL}${WORKERS_ROUTE}`);
    await expect
      .poll(() => new URL(authPage.url()).pathname, { message: 'o painel manda o usuário de tenant para fora' })
      .toMatch(/^\/auth\//);
    await expect(authPage.getByTestId('workers-page')).toHaveCount(0);

    const list = await authApi.get('/api/super-admin/workers');
    expect(list.status(), 'GET workers como Owner').toBe(403);
    const runNow = await authApi.post(`/api/super-admin/workers/${MANUAL_JOB}/run-now`);
    expect(runNow.status(), 'run-now como Owner').toBe(403);

    const anon = await createApiContext();
    try {
      expect((await anon.get('/api/super-admin/workers')).status(), 'GET workers sem token').toBe(401);
      expect((await anon.post(`/api/super-admin/workers/${MANUAL_JOB}/run-now`)).status(), 'run-now sem token').toBe(
        401,
      );
    } finally {
      await anon.dispose();
    }
  });
});
