import { APIRequestContext } from '@playwright/test';

import { expect, superAdminTest as test } from '../../fixtures/super-admin.fixture';
import {
  addSessionToContext,
  apiStepUp,
  createApiContext,
  createBearerApiContext,
  signupAndConfirm,
} from '../../helpers/api-client';
import { apiCreateClient } from '../../helpers/api-entities';
import {
  backdateTenantClosureDirect,
  expireTenantClosureGraceDirect,
  pendingPurgeDirect,
  tenantClosureDirect,
  tenantRowCountDirect,
} from '../../helpers/db-helper';
import { assertOk, readJson } from '../../helpers/response';
import {
  SUPER_ADMIN_PASSWORD,
  loginSuperAdminViaApi,
  reserveSuperAdminTotpCode,
} from '../../helpers/super-admin-session';
import { fakeTenant } from '../../helpers/test-data';

/**
 * Fluxo: 17.15 — Purga de empresa encerrada só com aprovação do Super Admin
 * Diagrama: — (cenário E4 do registro e2e de
 * `docs/implementar/PLANO-EXPURGO-DE-DADOS.md`, §5 regra 2, Etapa 337)
 *
 * A empresa encerrada (`TenantClosure` `Closed`) com a purga agendada vencida
 * (90 dias depois do fechamento) vira uma pendência `TenantPurge` com o nome
 * da empresa. Sem aprovação, nada sai; aprovada (step-up
 * `privacy.retention.purge`), o executor apaga os dados da empresa e marca o
 * encerramento como `Purged`. A detecção e o executor rodam a cada 60 s no E2E;
 * o spec espera pelo estado, e as datas do encerramento são recuadas pelo
 * `db-helper` (o encerramento não nasce no passado). A empresa é descartável,
 * criada pelo próprio teste.
 */

const SUPER_ADMIN_URL = process.env.SUPER_ADMIN_URL ?? 'http://localhost:4201';
const KIND = 'TenantPurge';
const CARD_KEY = `purge.${KIND}`;
const STEP_UP_ACTION = 'privacy.retention.purge';
const STEP_UP_HEADER = 'X-Step-Up-Token';

const DETECTION_TIMEOUT = 240_000;
const EXECUTION_TIMEOUT = 240_000;
const POLL_INTERVALS = [3_000, 5_000];

interface PendingActionItem {
  pendingPurgeId: string;
  tenantId: string | null;
  tenantName: string | null;
  targetLabel: string | null;
  count: number;
  status: string;
}

interface PendingAction {
  key: string;
  items: PendingActionItem[];
}

interface PurgeHistoryItem {
  id: string;
  kind: string;
  tenantName: string | null;
  processedCount: number;
  status: string;
}

async function pendingItem(api: APIRequestContext, tenantId: string): Promise<PendingActionItem | undefined> {
  const res = await api.get('/api/super-admin/pending-actions');
  await assertOk(res, 'GET /api/super-admin/pending-actions');
  const card = (await readJson<PendingAction[]>(res)).find((a) => a.key === CARD_KEY);
  return card?.items.find((i) => i.tenantId === tenantId);
}

async function apiPurgeHistory(api: APIRequestContext): Promise<PurgeHistoryItem[]> {
  const res = await api.get('/api/super-admin/purges/history?page=1&pageSize=100');
  await assertOk(res, 'GET /api/super-admin/purges/history');
  return (await readJson<{ items: PurgeHistoryItem[] }>(res)).items;
}

test.describe('Fluxo 17.15 — Purga de empresa aprovada', () => {
  test('E4 @flow empresa encerrada há 90 dias aparece como pendência com o nome; sem aprovação continua inteira; aprovada, os dados saem e o encerramento vira Purged', async ({
    superAdminApi,
    browser,
  }) => {
    test.setTimeout(900_000);

    // Empresa descartável com dados próprios.
    const fake = fakeTenant();
    const anon = await createApiContext();
    const company = await signupAndConfirm(anon, {
      companyName: fake.companyName,
      adminName: fake.adminName,
      adminEmail: fake.adminEmail,
      adminPassword: fake.adminPassword,
    }).finally(() => anon.dispose());
    const ownerApi = await createBearerApiContext(company.accessToken);
    try {
      await apiCreateClient(ownerApi);
      await apiCreateClient(ownerApi);

      // O dono pede o encerramento; a carência vence e o sweep fecha.
      const requested = await ownerApi.post('/api/privacy/request-tenant-closure', {
        data: { confirmText: 'ENCERRAR CONTA' },
      });
      await assertOk(requested, 'POST /api/privacy/request-tenant-closure');
    } finally {
      await ownerApi.dispose();
    }

    // O encerramento é lido pelo banco: o `GET /api/super-admin/tenant-closures`
    // respondeu 500 no Postgres do E2E (2026-11-13), fora do escopo deste plano.
    const pendingClosure = tenantClosureDirect(company.tenantId);
    expect(pendingClosure?.status, 'encerramento pedido').toBe('PendingGracePeriod');
    expireTenantClosureGraceDirect(pendingClosure!.id);
    await assertOk(
      await superAdminApi.post('/api/super-admin/tenant-closures/process-expired'),
      'POST /api/super-admin/tenant-closures/process-expired',
    );
    expect(tenantClosureDirect(company.tenantId)?.status, 'carência vencida: fechada').toBe('Closed');

    // Encerrada há 91 dias: a purga agendada (90 dias) venceu ontem.
    backdateTenantClosureDirect(pendingClosure!.id, 91);
    const clientsBefore = tenantRowCountDirect(company.tenantId, 'Clients');
    expect(clientsBefore, 'os clientes da empresa').toBeGreaterThanOrEqual(2);

    // A detecção cria a pendência, com o nome da empresa e a data do fechamento.
    let item: PendingActionItem | undefined;
    await expect
      .poll(
        async () => {
          item = await pendingItem(superAdminApi, company.tenantId);
          return item?.status ?? null;
        },
        { message: 'pendência da purga da empresa', timeout: DETECTION_TIMEOUT, intervals: POLL_INTERVALS },
      )
      .toBe('AwaitingApproval');
    expect(item!.tenantName, 'o nome da empresa').toBe(fake.companyName);
    expect(item!.targetLabel ?? '', 'a data do fechamento').toMatch(/^Encerrada em \d{2}\/\d{2}\/\d{4}$/);

    // A tela de pendências mostra a empresa pelo nome.
    const login = await createApiContext();
    const tokens = await loginSuperAdminViaApi(login).finally(() => login.dispose());
    const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
    try {
      await addSessionToContext(context, tokens.refreshToken);
      const page = await context.newPage();
      await page.goto(`${SUPER_ADMIN_URL}/super-admin/pending-actions`);
      await expect(page.getByTestId('pending-actions-page')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId(`pending-action-${CARD_KEY}`)).toBeVisible();
      await expect(page.getByTestId(`pending-item-${item!.pendingPurgeId}`)).toContainText(fake.companyName);
      await expect(page.getByTestId(`pending-item-status-${item!.pendingPurgeId}`)).toContainText(
        'Aguardando aprovação',
      );
    } finally {
      await context.close();
    }

    // Sem aprovação, mais um ciclo passa e a empresa continua inteira.
    const lastDetected = Date.parse(pendingPurgeDirect(item!.pendingPurgeId).lastDetectedAt);
    await expect
      .poll(() => Date.parse(pendingPurgeDirect(item!.pendingPurgeId).lastDetectedAt), {
        message: 'mais um ciclo da detecção sem aprovação',
        timeout: DETECTION_TIMEOUT,
        intervals: POLL_INTERVALS,
      })
      .toBeGreaterThan(lastDetected);
    expect(tenantRowCountDirect(company.tenantId, 'Clients'), 'sem aprovação, os clientes ficam').toBe(clientsBefore);
    expect(tenantClosureDirect(company.tenantId)?.status, 'sem aprovação, segue fechada').toBe('Closed');

    // O Super Admin aprova, com step-up.
    const stepUp = await apiStepUp(superAdminApi, SUPER_ADMIN_PASSWORD, STEP_UP_ACTION, await reserveSuperAdminTotpCode());
    const approved = await superAdminApi.post('/api/super-admin/purges/approve', {
      headers: { [STEP_UP_HEADER]: stepUp },
      data: { ids: [item!.pendingPurgeId] },
    });
    await assertOk(approved, 'POST /api/super-admin/purges/approve');
    expect((await readJson<{ approved: number }>(approved)).approved).toBe(1);

    // No minuto seguinte: os dados saem e o encerramento vira `Purged`.
    await expect
      .poll(() => tenantClosureDirect(company.tenantId)?.status ?? null, {
        message: 'o executor purga a empresa',
        timeout: EXECUTION_TIMEOUT,
        intervals: POLL_INTERVALS,
      })
      .toBe('Purged');
    const purged = tenantClosureDirect(company.tenantId);
    expect(purged?.purgedAt, 'data da purga').toBeTruthy();
    expect(tenantRowCountDirect(company.tenantId, 'Clients'), 'os clientes saíram').toBe(0);

    // A pendência vai ao histórico, concluída.
    let history: PurgeHistoryItem[] = [];
    await expect
      .poll(
        async () => {
          history = await apiPurgeHistory(superAdminApi);
          return history.find((h) => h.id === item!.pendingPurgeId)?.status ?? null;
        },
        { message: 'a purga no histórico', timeout: EXECUTION_TIMEOUT, intervals: POLL_INTERVALS },
      )
      .toBe('Done');
    const done = history.find((h) => h.id === item!.pendingPurgeId)!;
    expect(done.kind).toBe(KIND);
    expect(done.processedCount).toBe(1);
    expect(done.tenantName).toBe(fake.companyName);
    expect(await pendingItem(superAdminApi, company.tenantId), 'sem pendência aberta').toBeUndefined();
  });
});
