import { randomUUID } from 'node:crypto';
import { APIRequestContext, Browser, BrowserContext, Page, mergeTests } from '@playwright/test';

import { authTest, expect } from '../../fixtures/auth.fixture';
import { superAdminTest } from '../../fixtures/super-admin.fixture';
import {
  SignupResult,
  addSessionToContext,
  createApiContext,
  createBearerApiContext,
  signupAndConfirm,
} from '../../helpers/api-client';
import { backdateRentalPickupDirect, expirePendingPurgePostponementDirect, pendingPurgeDirect } from '../../helpers/db-helper';
import { apiTransitionRental, setupReservedRental } from '../../helpers/rental-preparation';
import { apiErrorCodes, assertOk, readJson } from '../../helpers/response';
import {
  SUPER_ADMIN_PASSWORD,
  loginSuperAdminViaApi,
  reserveSuperAdminTotpCode,
} from '../../helpers/super-admin-session';
import { fakeAddress, fakeTenant } from '../../helpers/test-data';
import { snack } from '../../helpers/ui';
import { uid } from '../../helpers/whatsapp-flow';

/**
 * Fluxo: 17.14 — Pendências de expurgo do Super Admin (expurgo só com aprovação)
 * Diagrama: — (cenários E1, E2 e E3 do registro e2e de
 * `docs/implementar/PLANO-EXPURGO-DE-DADOS.md`, §4, Etapa 336)
 *
 * A detecção (`PurgeDetectionWorker`) roda a cada 60 s no E2E, sem atraso de
 * subida (`appsettings.E2E.json`, `Privacy:PurgeDetection*`), e só grava a
 * `PendingPurge`: detectar nunca apaga. O executor (`PurgeExecutionWorker`, a
 * cada 60 s) aplica só o que o Super Admin aprovou, até o corte congelado. O
 * spec espera pelo estado (poll da API ou da tela), nunca por tempo fixo.
 *
 * O tipo exercitado é o endereço de entrega da locação (P7): locação concluída
 * ou cancelada com retirada há mais de 5 anos. A locação não nasce no passado,
 * então a retirada é recuada pelo `db-helper`.
 */

const test = mergeTests(authTest, superAdminTest);

const SUPER_ADMIN_URL = process.env.SUPER_ADMIN_URL ?? 'http://localhost:4201';
const PENDING_ACTIONS_ROUTE = '/super-admin/pending-actions';
const KIND = 'RentalDeliveryAddress';
const CARD_KEY = `purge.${KIND}`;
const STEP_UP_HEADER = 'X-Step-Up-Token';

/** Um ciclo da detecção (60 s) mais a varredura dos tenants, com folga. */
const DETECTION_TIMEOUT = 240_000;
/** Um ciclo do executor (60 s) mais a execução, com folga. */
const EXECUTION_TIMEOUT = 240_000;
const POLL_INTERVALS = [3_000, 5_000];

interface PendingActionItem {
  pendingPurgeId: string;
  tenantId: string | null;
  tenantName: string | null;
  targetLabel: string | null;
  count: number;
  status: string;
  cutoff: string;
  awaitingSince: string;
  postponedUntil: string | null;
  lastError: string | null;
}

interface PendingAction {
  key: string;
  kind: string;
  title: string;
  totalCount: number;
  cutoff: string | null;
  status: string;
  items: PendingActionItem[];
}

interface PurgeHistoryItem {
  id: string;
  kind: string;
  tenantId: string | null;
  tenantName: string | null;
  processedCount: number;
  status: string;
  approvedBy: string | null;
  approvedAt: string | null;
  finishedAt: string | null;
}

interface RentalAddress {
  zipCode: string | null;
  street: string | null;
  number: string | null;
  complement: string | null;
  neighborhood: string | null;
  city: string | null;
  state: string | null;
}

interface NamedTenant extends SignupResult {
  companyName: string;
}

/** Data `yyyy-MM-dd` em UTC, `days` a partir de hoje (o back mede o adiamento por `DateOnly` UTC). */
function utcIsoDate(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Data `yyyy-MM-dd` em UTC, `years` anos atrás deslocada de `extraDays` dias. */
function utcIsoDateYearsAgo(years: number, extraDays: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() + extraDays);
  return d.toISOString().slice(0, 10);
}

/** Empresa descartável do próprio teste, com o nome que a tela de pendências mostra. */
async function signupNamedTenant(): Promise<NamedTenant> {
  const fake = fakeTenant();
  const api = await createApiContext();
  try {
    const result = await signupAndConfirm(api, {
      companyName: fake.companyName,
      adminName: fake.adminName,
      adminEmail: fake.adminEmail,
      adminPassword: fake.adminPassword,
    });
    return { ...result, companyName: fake.companyName };
  } finally {
    await api.dispose();
  }
}

/**
 * Locação cancelada com o endereço de entrega marcado pelo `tag`, e a
 * retirada recuada para `pickupDate`. Devolve o id e o endereço gravado.
 */
async function seedCanceledRental(
  api: APIRequestContext,
  tenantId: string,
  pickupDate: string,
): Promise<{ id: string; street: string; tag: string }> {
  const tag = uid();
  const street = `Rua do Expurgo ${tag}`;
  const { rental } = await setupReservedRental(api, tenantId, {
    deliveryAddress: {
      ...fakeAddress(),
      street,
      number: '501',
      complement: `Casa ${tag}`,
      neighborhood: `Bairro Expurgo ${tag}`,
    },
  });
  await apiTransitionRental(api, rental.id, 'Canceled');
  backdateRentalPickupDirect(rental.id, pickupDate);
  return { id: rental.id, street, tag };
}

async function apiRentalAddress(api: APIRequestContext, rentalId: string): Promise<RentalAddress> {
  const res = await api.get(`/api/rentals/${rentalId}`);
  await assertOk(res, 'GET /api/rentals/{id}');
  return (await readJson<{ deliveryAddress: RentalAddress }>(res)).deliveryAddress;
}

/** O endereço segue inteiro: rua, número e bairro do cadastro. */
async function expectAddressIntact(
  api: APIRequestContext,
  rental: { id: string; street: string; tag: string },
  message: string,
): Promise<void> {
  const address = await apiRentalAddress(api, rental.id);
  expect(address.street, message).toBe(rental.street);
  expect(address.number, message).toBe('501');
  expect(address.neighborhood, message).toBe(`Bairro Expurgo ${rental.tag}`);
}

/** O endereço ficou só com cidade e UF (§4 regra 6, o mesmo `RedactDeliveryAddress` da Etapa 281). */
async function expectAddressRedacted(api: APIRequestContext, rental: { id: string; street: string; tag: string }) {
  const address = await apiRentalAddress(api, rental.id);
  expect(address.city, 'a cidade fica').toBe('Curitiba');
  expect(address.state, 'a UF fica').toBe('PR');
  expect(address.street, 'sem a rua').not.toBe(rental.street);
  for (const field of ['zipCode', 'number', 'complement', 'neighborhood'] as const) {
    expect(address[field] ?? '', `sem ${field}`).toBe('');
  }
  expect(JSON.stringify(address), 'nada do endereço do cadastro').not.toContain(rental.tag);
}

async function apiPendingActions(api: APIRequestContext): Promise<PendingAction[]> {
  const res = await api.get('/api/super-admin/pending-actions');
  await assertOk(res, 'GET /api/super-admin/pending-actions');
  return readJson<PendingAction[]>(res);
}

async function pendingItem(api: APIRequestContext, tenantId: string): Promise<PendingActionItem | undefined> {
  const card = (await apiPendingActions(api)).find((a) => a.key === CARD_KEY);
  return card?.items.find((i) => i.tenantId === tenantId);
}

/** Espera a pendência do tenant aparecer em `status` (a detecção roda a cada 60 s). */
async function waitForPendingItem(
  api: APIRequestContext,
  tenantId: string,
  status: string,
  message: string,
  timeout = DETECTION_TIMEOUT,
): Promise<PendingActionItem> {
  let found: PendingActionItem | undefined;
  await expect
    .poll(
      async () => {
        found = await pendingItem(api, tenantId);
        return found?.status ?? null;
      },
      { message, timeout, intervals: POLL_INTERVALS },
    )
    .toBe(status);
  return found!;
}

/** Espera mais um ciclo da detecção passar pela pendência (o `LastDetectedAt` avança). */
async function waitForAnotherDetection(pendingPurgeId: string, message: string): Promise<void> {
  const before = Date.parse(pendingPurgeDirect(pendingPurgeId).lastDetectedAt);
  await expect
    .poll(() => Date.parse(pendingPurgeDirect(pendingPurgeId).lastDetectedAt), {
      message,
      timeout: DETECTION_TIMEOUT,
      intervals: POLL_INTERVALS,
    })
    .toBeGreaterThan(before);
}

async function apiPurgeHistory(api: APIRequestContext): Promise<PurgeHistoryItem[]> {
  const res = await api.get('/api/super-admin/purges/history?page=1&pageSize=100');
  await assertOk(res, 'GET /api/super-admin/purges/history');
  return (await readJson<{ items: PurgeHistoryItem[] }>(res)).items;
}

/**
 * Painel do Super Admin numa sessão própria (login com o desafio MFA), aberto
 * na tela "Pendências". Quem chama fecha o contexto.
 */
async function openPendingActionsAsSuperAdmin(browser: Browser): Promise<{ page: Page; context: BrowserContext }> {
  const anon = await createApiContext();
  const tokens = await loginSuperAdminViaApi(anon).finally(() => anon.dispose());
  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  await addSessionToContext(context, tokens.refreshToken);
  const page = await context.newPage();
  await page.goto(`${SUPER_ADMIN_URL}${PENDING_ACTIONS_ROUTE}`);
  await expect(page.getByTestId('pending-actions-page')).toBeVisible({ timeout: 30_000 });
  return { page, context };
}

/** Marca a pendência na tabela do cartão (só `AwaitingApproval` tem a caixa). */
async function selectItem(page: Page, pendingPurgeId: string): Promise<void> {
  await page.getByTestId(`pending-item-select-${pendingPurgeId}`).getByRole('checkbox').check();
}

test.describe('Fluxo 17.14 — Pendências de expurgo do Super Admin', () => {
  // ─── E1 — Detecta, não apaga, aprova com step-up, executa ───────────────
  test('E1 @crud locação com retirada há mais de 5 anos em duas empresas: a detecção cria a pendência sem apagar; o Super Admin aprova com step-up e no minuto seguinte a locação fica só com cidade e UF, a não vencida fica intacta e a pendência vai ao histórico', async ({
    authApi,
    tenant,
    superAdminApi,
    browser,
  }) => {
    test.setTimeout(900_000);

    // Empresa A: uma locação vencida (retirada há 5 anos e 10 dias) e uma não
    // vencida (5 anos menos 10 dias), as duas canceladas.
    const dueA = await seedCanceledRental(authApi, tenant.tenantId, utcIsoDateYearsAgo(5, -10));
    const notDueA = await seedCanceledRental(authApi, tenant.tenantId, utcIsoDateYearsAgo(5, 10));

    // Empresa B: uma locação vencida.
    const tenantB = await signupNamedTenant();
    const apiB = await createBearerApiContext(tenantB.accessToken);
    try {
      const dueB = await seedCanceledRental(apiB, tenantB.tenantId, utcIsoDateYearsAgo(5, -10));

      // A detecção cria uma pendência por empresa, com o nome dela; a não
      // vencida não entra na contagem de A.
      const itemA = await waitForPendingItem(superAdminApi, tenant.tenantId, 'AwaitingApproval', 'pendência da empresa A');
      const itemB = await waitForPendingItem(superAdminApi, tenantB.tenantId, 'AwaitingApproval', 'pendência da empresa B');
      expect(itemA.count, 'só a locação vencida de A').toBe(1);
      expect(itemB.count, 'a locação vencida de B').toBe(1);
      expect(itemA.tenantName).toBe(tenant.companyName);
      expect(itemB.tenantName).toBe(tenantB.companyName);

      // Detectar nunca apaga: nem na detecção, nem no ciclo seguinte.
      await expectAddressIntact(authApi, dueA, 'detectada, a locação vencida de A segue inteira');
      await expectAddressIntact(apiB, dueB, 'detectada, a locação vencida de B segue inteira');
      await waitForAnotherDetection(itemA.pendingPurgeId, 'mais um ciclo da detecção sem aprovação');
      await expectAddressIntact(authApi, dueA, 'dois ciclos sem aprovação: A segue inteira');
      await expectAddressIntact(apiB, dueB, 'dois ciclos sem aprovação: B segue inteira');
      expect((await pendingItem(superAdminApi, tenant.tenantId))?.status).toBe('AwaitingApproval');

      // O Super Admin aprova as duas pela tela, com a confirmação e o step-up.
      const { page, context } = await openPendingActionsAsSuperAdmin(browser);
      try {
        const card = page.getByTestId(`pending-action-${CARD_KEY}`);
        await expect(card).toBeVisible();
        await expect(page.getByTestId(`pending-item-${itemA.pendingPurgeId}`)).toContainText(tenant.companyName);
        await expect(page.getByTestId(`pending-item-${itemB.pendingPurgeId}`)).toContainText(tenantB.companyName);
        await expect(page.getByTestId(`pending-item-status-${itemA.pendingPurgeId}`)).toContainText('Aguardando aprovação');

        await selectItem(page, itemA.pendingPurgeId);
        await selectItem(page, itemB.pendingPurgeId);
        await page.getByTestId(`pending-action-approve-selected-${CARD_KEY}`).click();

        const message = page.getByTestId('confirm-message');
        await expect(message).toContainText('Expurgar 2 registros');
        await expect(message).toContainText('em 2 empresas');
        await expect(message).toContainText('Não dá para desfazer');
        await page.getByTestId('confirm-ok').click();

        const code = await reserveSuperAdminTotpCode();
        await page.getByTestId('step-up-password').fill(SUPER_ADMIN_PASSWORD);
        await page.getByTestId('step-up-mfa-code').fill(code);
        const approved = page.waitForResponse(
          (r) => r.url().includes('/api/super-admin/purges/approve') && r.request().method() === 'POST',
        );
        await page.getByTestId('step-up-submit').click();
        expect((await approved).status(), 'aprovação com step-up').toBe(200);
        await expect(snack(page, 'Aprovado: o expurgo roda no próximo minuto.')).toBeVisible();

        // Aprovada, sai do "Aguardando aprovação" na hora.
        await expect(page.getByTestId(`pending-item-select-${itemA.pendingPurgeId}`)).toHaveCount(0);

        // No minuto seguinte o executor aplica: só cidade e UF nas vencidas.
        await expect
          .poll(async () => (await apiRentalAddress(authApi, dueA.id)).street, {
            message: 'o executor redige a locação vencida de A',
            timeout: EXECUTION_TIMEOUT,
            intervals: POLL_INTERVALS,
          })
          .not.toBe(dueA.street);
        await expectAddressRedacted(authApi, dueA);
        await expect
          .poll(async () => (await apiRentalAddress(apiB, dueB.id)).street, {
            message: 'o executor redige a locação vencida de B',
            timeout: EXECUTION_TIMEOUT,
            intervals: POLL_INTERVALS,
          })
          .not.toBe(dueB.street);
        await expectAddressRedacted(apiB, dueB);

        // A não vencida fica intacta.
        await expectAddressIntact(authApi, notDueA, 'a locação não vencida de A fica intacta');

        // A pendência sai das abertas e vai para o histórico, concluída.
        let history: PurgeHistoryItem[] = [];
        await expect
          .poll(
            async () => {
              history = await apiPurgeHistory(superAdminApi);
              return [itemA.pendingPurgeId, itemB.pendingPurgeId]
                .map((id) => history.find((h) => h.id === id)?.status ?? null)
                .join(',');
            },
            { message: 'as duas pendências no histórico', timeout: EXECUTION_TIMEOUT, intervals: POLL_INTERVALS },
          )
          .toBe('Done,Done');
        const doneA = history.find((h) => h.id === itemA.pendingPurgeId)!;
        expect(doneA.kind).toBe(KIND);
        expect(doneA.processedCount, 'uma locação redigida em A').toBe(1);
        expect(doneA.tenantName).toBe(tenant.companyName);
        expect(doneA.approvedAt, 'quem e quando aprovou').toBeTruthy();
        expect(doneA.finishedAt).toBeTruthy();
        expect(history.find((h) => h.id === itemB.pendingPurgeId)!.processedCount).toBe(1);
        expect(await pendingItem(superAdminApi, tenant.tenantId), 'A sem pendência aberta').toBeUndefined();

        // A aba "Histórico" mostra o expurgo concluído de A.
        await page.getByRole('tab', { name: 'Histórico', exact: true }).click();
        await expect(page.getByTestId('purge-history-list')).toBeVisible();
        await expect(
          page.locator('[data-testid^="purge-history-row-"]').filter({ hasText: tenant.companyName }),
          'linha do expurgo de A no histórico',
        ).toHaveCount(1);
      } finally {
        await context.close();
      }
    } finally {
      await apiB.dispose();
    }
  });

  // ─── E2 — Adiar exige motivo; a pendência volta na data ─────────────────
  test('E2 @crud adiar exige motivo: sem motivo ou com a data de hoje a API recusa e a tela não deixa confirmar; adiada, a pendência sai de "Aguardando aprovação" e volta na data', async ({
    superAdminApi,
    browser,
  }) => {
    test.setTimeout(900_000);

    const tenantC = await signupNamedTenant();
    const apiC = await createBearerApiContext(tenantC.accessToken);
    try {
      const due = await seedCanceledRental(apiC, tenantC.tenantId, utcIsoDateYearsAgo(5, -10));
      const item = await waitForPendingItem(superAdminApi, tenantC.tenantId, 'AwaitingApproval', 'pendência da empresa C');

      // A API recusa o adiamento sem motivo, com motivo curto e com a data de hoje.
      const postpone = (until: string, reason: string) =>
        superAdminApi.post('/api/super-admin/purges/postpone', {
          data: { ids: [item.pendingPurgeId], until, reason },
        });
      for (const [label, res] of [
        ['sem motivo', await postpone(utcIsoDate(7), '')],
        ['motivo com 7 caracteres', await postpone(utcIsoDate(7), '1234567')],
      ] as const) {
        expect(res.status(), `adiar ${label}`).toBe(400);
        expect(await apiErrorCodes(res), `adiar ${label}`).toContain('PendingPurge.PostponeReasonRequired');
      }
      const today = await postpone(utcIsoDate(0), 'Cliente em disputa judicial (E2E)');
      expect(today.status(), 'adiar para hoje').toBe(400);
      expect(await apiErrorCodes(today)).toContain('PendingPurge.PostponeDateInvalid');
      expect((await pendingItem(superAdminApi, tenantC.tenantId))?.status, 'as recusas não adiaram').toBe(
        'AwaitingApproval',
      );

      // Pela tela: o botão fica desabilitado até o motivo ter 8 caracteres.
      const until = utcIsoDate(7);
      const { page, context } = await openPendingActionsAsSuperAdmin(browser);
      try {
        await selectItem(page, item.pendingPurgeId);
        await page.getByTestId(`pending-action-postpone-${CARD_KEY}`).click();
        await expect(page.getByTestId('postpone-purges-summary')).toContainText('Adiar 1 pendência');
        await page.getByTestId('postpone-purges-until').fill(until);
        const confirm = page.getByTestId('postpone-purges-confirm');
        await expect(confirm, 'sem motivo').toBeDisabled();
        await page.getByTestId('postpone-purges-reason').fill('1234567');
        await expect(confirm, 'motivo com 7 caracteres').toBeDisabled();
        await page.getByTestId('postpone-purges-reason').fill('Cliente em disputa judicial (E2E)');
        await expect(confirm).toBeEnabled();
        const postponed = page.waitForResponse(
          (r) => r.url().includes('/api/super-admin/purges/postpone') && r.request().method() === 'POST',
        );
        await confirm.click();
        expect((await postponed).status(), 'adiamento pela tela').toBe(200);
        const [y, m, d] = until.split('-');
        await expect(snack(page, `Adiado até ${d}/${m}/${y}.`)).toBeVisible();

        // Adiada: fora do "Aguardando aprovação" (sem caixa, situação "Adiada").
        await expect(page.getByTestId(`pending-item-status-${item.pendingPurgeId}`)).toContainText('Adiada');
        await expect(page.getByTestId(`pending-item-select-${item.pendingPurgeId}`)).toHaveCount(0);
        await expect(page.getByTestId(`pending-item-${item.pendingPurgeId}`)).toContainText(`${d}/${m}/${y}`);
        const postponedItem = await pendingItem(superAdminApi, tenantC.tenantId);
        expect(postponedItem?.status).toBe('Postponed');
        expect(postponedItem?.postponedUntil).toBe(until);

        // Na data, a detecção a devolve para "Aguardando aprovação". A data
        // mínima é amanhã: o spec traz o adiamento para ontem pelo banco.
        expirePendingPurgePostponementDirect(item.pendingPurgeId);
        await waitForPendingItem(superAdminApi, tenantC.tenantId, 'AwaitingApproval', 'a pendência volta na data');
        await page.reload();
        await expect(page.getByTestId(`pending-item-status-${item.pendingPurgeId}`)).toContainText(
          'Aguardando aprovação',
        );
        await expect(page.getByTestId(`pending-item-select-${item.pendingPurgeId}`)).toHaveCount(1);

        // Adiar não apagou nada.
        await expectAddressIntact(apiC, due, 'adiada e devolvida, a locação segue inteira');
      } finally {
        await context.close();
      }
    } finally {
      await apiC.dispose();
    }
  });

  // ─── E3 — Usuário de tenant ─────────────────────────────────────────────
  test('E3 @flow usuário de tenant não abre a tela de pendências e toma 403 nos quatro endpoints', async ({
    authPage,
    authApi,
  }) => {
    await authPage.goto(`${SUPER_ADMIN_URL}${PENDING_ACTIONS_ROUTE}`);
    await expect
      .poll(() => new URL(authPage.url()).pathname, { message: 'o painel manda o usuário de tenant para fora' })
      .toMatch(/^\/auth\//);
    await expect(authPage.getByTestId('pending-actions-page')).toHaveCount(0);

    const ids = [randomUUID()];
    const responses = [
      ['GET pending-actions', await authApi.get('/api/super-admin/pending-actions')],
      ['POST purges/approve', await authApi.post('/api/super-admin/purges/approve', { data: { ids } })],
      [
        'POST purges/postpone',
        await authApi.post('/api/super-admin/purges/postpone', {
          data: { ids, until: utcIsoDate(7), reason: 'Tentativa do tenant (E2E)' },
        }),
      ],
      ['GET purges/history', await authApi.get('/api/super-admin/purges/history')],
    ] as const;
    for (const [label, res] of responses) {
      expect(res.status(), `${label} pelo Owner do tenant`).toBe(403);
      expect(await apiErrorCodes(res), label).toContain('Auth.PermissionDenied');
    }

    // Nem com um token de step-up do próprio tenant a aprovação passa.
    const withHeader = await authApi.post('/api/super-admin/purges/approve', {
      headers: { [STEP_UP_HEADER]: 'token-qualquer' },
      data: { ids },
    });
    expect(withHeader.status()).toBe(403);
  });
});
