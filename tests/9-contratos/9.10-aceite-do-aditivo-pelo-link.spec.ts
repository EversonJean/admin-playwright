import { mergeTests, type APIRequestContext, type Browser, type Page } from '@playwright/test';

import { authTest, expect } from '../../fixtures/auth.fixture';
import { superAdminTest } from '../../fixtures/super-admin.fixture';
import {
  addendumTokenFromUrl,
  apiAddendumPdf,
  apiCreateAddendumPublicLink,
  apiCreateContractAddendum,
  apiErrorBody,
  apiGetAddendumState,
  apiGetPublicAddendum,
  apiProposeContractChange,
  apiTryAcceptPublicAddendum,
  apiTryCreateAddendumPublicLink,
  apiTryProposeContractChange,
  freeTextClause,
  setupFormalizedContractWithPlan,
  setupManuallyFormalizedContract,
  waitForAddendumEffects,
} from '../../helpers/addendums';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import { apiCompleteOnboarding, apiListNotifications } from '../../helpers/api-entities';
import { apiGetPaymentPlan, createPublicApiContext } from '../../helpers/api-event-flow';
import { expireAddendumLinkDirect } from '../../helpers/db-helper';
import { assertOk, readJson, unwrapList } from '../../helpers/response';
import { loginAsRole, openSessionPage } from '../../helpers/setup-flows';
import { snack } from '../../helpers/ui';

/**
 * Fluxo: 9.10 — Aceite do aditivo pelo link
 * Diagrama: docs/fluxos/negocio-9.10-aceite-do-aditivo-pelo-link.mmd
 * Cenário: docs/cenarios-de-teste/9-contratos/9.10-aceite-do-aditivo-pelo-link.md
 * (CF-01 a CF-03, CE-01 a CE-05, CE-08 a CE-10)
 *
 * PLANO-ADITIVOS-COM-APROVACAO §8 (AD-F) itens 1 a 6, A22, A23, decisão 4
 * (registro e2e E4, E5, E25 e E26):
 * - o Dono gera o link de um aditivo com PDF (e aprovado, quando a revisão exige):
 *   o aditivo vai a "Enviado" com a validade; o cliente abre sem login, vê o que
 *   muda, as parcelas e as cláusulas, e "Aceito" com nome e CPF formaliza por
 *   aceite eletrônico (ator cliente, IP e user-agent na evidência); os efeitos
 *   aplicam; reabrir mostra "Aditivo já aceito"; "Copiar link" devolve o mesmo;
 * - "Não aceito" com motivo deixa o aditivo recusado, a festa intacta e o aviso no
 *   sino do Dono, do Administrador e de quem criou; aceitar depois é recusado;
 * - o link de antes de uma correção (ou de um "Gerar novo link") dá "Link
 *   inválido, vencido ou substituído" nas quatro rotas, e o novo abre;
 * - outra empresa: 404 no link do aditivo do tenant A; a página do A com a sessão
 *   do B mostra só o A e o aceite grava no A;
 * - validade vencida (worker) e empresa renomeada com a página aberta.
 *
 * Fora do spec: o 429 do E26 (muitas aberturas, aceites e recusas). O teto do
 * e2e é 10000 por minuto (`RateLimit:Public*PermitLimit` do
 * appsettings.E2E.json, para a suíte não cair em 429 intermitente); a rajada até
 * ele não cabe no minuto e satura o back para os testes em paralelo, e a recusa
 * (`public`, por IP) esgotaria a cota de toda a suíte. Coberto no back por
 * `PublicAddendumsRateLimitEndpointTests` e na tela por `public-addendum.spec.ts`.
 */

const test = mergeTests(authTest, superAdminTest);

/** `SystemActors.PublicLinkClient`: o cliente agindo pelo link público. */
const PUBLIC_LINK_CLIENT = '00000000-0000-0000-0000-00000000c11e';
const VALID_CPF = '529.982.247-25';

interface EventFacts {
  eventDate: string;
  location: string | null;
  childrenCount: number;
  total: number;
}

async function eventFacts(api: APIRequestContext, eventId: string): Promise<EventFacts> {
  const res = await api.get(`/api/events/${eventId}`);
  await assertOk(res, 'GET /api/events/{id}');
  const ev = await readJson<EventFacts>(res);
  return { eventDate: ev.eventDate, location: ev.location, childrenCount: ev.childrenCount, total: ev.total };
}

async function pricingItems(api: APIRequestContext, eventId: string) {
  const res = await api.get(`/api/events/${eventId}/pricing-items`);
  await assertOk(res, 'GET /api/events/{id}/pricing-items');
  return (await unwrapList<{ id: string; totalPrice: number }>(res))
    .map((i) => ({ id: i.id, totalPrice: i.totalPrice }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function installments(api: APIRequestContext, eventId: string) {
  return ((await apiGetPaymentPlan(api, eventId))?.installments ?? [])
    .map((i) => ({ id: i.id, expectedAmount: i.expectedAmount, paidAmount: i.paidAmount }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Dia por extenso como o detalhe mostra ("3 de dezembro de 2026"). */
function longDate(iso: string): string {
  return new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${iso}T12:00:00Z`),
  );
}

async function companyName(api: APIRequestContext): Promise<string> {
  const res = await api.get('/api/company');
  await assertOk(res, 'GET /api/company');
  return (await readJson<{ name: string }>(res)).name;
}

/** A aba Contrato da festa, com a seção de aditivos carregada. */
async function openContractTab(page: Page, eventId: string): Promise<void> {
  await page.goto(`/app/events/${eventId}`);
  await page.getByRole('tab', { name: 'Contrato', exact: true }).click({ timeout: 45_000 });
  await expect(page.getByTestId('addendums-section')).toBeVisible({ timeout: 30_000 });
}

/**
 * O endereço da página do cliente no front do e2e. O back monta o link com a base
 * do link público do orçamento (`Budget:PublicLinkBaseUrl`, a de produção no
 * e2e), e a tela do gestor o mostra com a origem do próprio front: o que liga os
 * dois é o token.
 */
function clientUrl(token: string): string {
  return new URL(`/addendums/${token}`, test.info().project.use.baseURL).toString();
}

/** O navegador do cliente: contexto novo, sem sessão. Quem chama fecha. */
async function openClientPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
  return context.newPage();
}

/** As quatro rotas públicas do link: página, PDF, aceite e recusa. */
async function publicRouteStatuses(api: APIRequestContext, token: string): Promise<number[]> {
  const page = await api.get(`/api/public/addendums/${token}`);
  const pdf = await api.get(`/api/public/addendums/${token}/pdf`);
  const accept = await apiTryAcceptPublicAddendum(api, token, { name: 'Cliente E2E' }, 'a'.repeat(64));
  const reject = await api.post(`/api/public/addendums/${token}/reject`, { data: { reason: null } });
  return [page.status(), pdf.status(), accept.status(), reject.status()];
}

async function liveLink(api: APIRequestContext, addendumId: string): Promise<{ url: string } | null> {
  const res = await api.get(`/api/addendums/${addendumId}/public-link`);
  await assertOk(res, 'GET /api/addendums/{id}/public-link');
  const body = (await res.json()) as { data?: { url: string } | null };
  return body.data ?? null;
}

test.describe('Fluxo 9.10 — Aceite do aditivo pelo link', () => {
  // Contrato formalizado, plano, link, página do cliente e o outbox dos efeitos.
  test.describe.configure({ timeout: 300_000 });

  test('@flow E25 gerar o link, o cliente aceita pela pagina sem login e a festa muda; reabrir mostra "Aditivo ja aceito" e "Copiar link" devolve o mesmo link', async ({
    authApi,
    authPage,
    browser,
    tenant,
  }) => {
    const { eventId, contractId } = await setupFormalizedContractWithPlan(authApi, tenant.tenantId);
    const before = await eventFacts(authApi, eventId);
    const installmentsBefore = await installments(authApi, eventId);
    const newDate = addDays(before.eventDate, 7);
    const reason = `Cliente pediu outra data e um personagem a mais ${Date.now()}`;
    const proposal = await apiProposeContractChange(authApi, eventId, reason, {
      eventDate: newDate,
      manualAdjustment: 150,
      manualAdjustmentDescription: 'Personagem extra',
      payment: { mode: 'ExtraInstallments', installmentCount: 1 },
    });
    const id = proposal.addendumId;
    expect(proposal.status).toBe('Draft');
    await apiAddendumPdf(authApi, id);

    // CF-01 passo 1 — "Gerar link de aceite": "Enviado", a validade e o link.
    await apiCompleteOnboarding(authApi);
    await openContractTab(authPage, eventId);
    await authPage.getByTestId(`addendum-public-link-generate-${id}`).click();
    await expect(snack(authPage, `Link de aceite do aditivo #${proposal.addendumNumber} gerado`)).toBeVisible();
    await expect(authPage.getByTestId(`addendum-status-${id}`)).toContainText('Enviado');
    await expect(authPage.getByTestId(`addendum-public-link-validity-${id}`)).toContainText('Link de aceite válido até');
    const urlCode = authPage.getByTestId(`addendum-public-link-url-${id}`);
    await expect(urlCode).toBeVisible();
    const shownUrl = (await urlCode.textContent())!.trim();
    expect(shownUrl).toMatch(/\/addendums\/[^/]+$/);
    await expect(authPage.getByTestId(`addendum-public-link-whatsapp-${id}`)).toBeVisible();

    const sent = await apiGetAddendumState(authApi, id);
    expect(sent.status).toBe('Sent');
    expect((sent as unknown as { publicLinkExpiresAt: string | null }).publicLinkExpiresAt).not.toBeNull();
    expect(addendumTokenFromUrl((await liveLink(authApi, id))!.url), 'o GET devolve o link que a tela mostra').toBe(
      addendumTokenFromUrl(shownUrl),
    );

    // CF-03 — depois de recarregar, "Copiar link" copia o mesmo link.
    await authPage.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(shownUrl).origin });
    await authPage.reload();
    await authPage.getByRole('tab', { name: 'Contrato', exact: true }).click({ timeout: 45_000 });
    await expect(authPage.getByTestId(`addendum-public-link-url-${id}`)).toHaveText(shownUrl, { timeout: 30_000 });
    await authPage.getByTestId(`addendum-public-link-copy-${id}`).click();
    await expect(snack(authPage, 'Link de aceite copiado.')).toBeVisible();
    expect(await authPage.evaluate(() => navigator.clipboard.readText())).toBe(shownUrl);

    // CF-01 passos 2 a 4 — o cliente abre sem login e aceita.
    const name = await companyName(authApi);
    const client = await openClientPage(browser);
    try {
      await client.goto(shownUrl);
      await expect(client.getByTestId('public-addendum-header')).toBeVisible({ timeout: 30_000 });
      await expect(client.getByTestId('public-addendum-company')).toHaveText(name);
      await expect(client.getByTestId('public-addendum-title')).toContainText(`Aditivo #${proposal.addendumNumber}`);
      await expect(client.getByTestId('public-addendum-reason')).toContainText(reason);
      await expect(client.getByTestId('public-addendum-validity')).toContainText('Válido até');
      await expect(client.getByTestId('public-addendum-change-date'), '"O que muda": a data').toBeVisible();
      await expect(client.getByTestId('public-addendum-installments'), '"As parcelas como ficam"').toBeVisible();
      await expect(client.getByTestId('public-addendum-pdf')).toBeVisible();

      await client.getByTestId('public-addendum-accept-open').click();
      await expect(client.getByTestId('public-addendum-acceptance-text')).toContainText(
        'Li este aditivo e concordo com as alterações descritas nele',
      );
      await client.getByTestId('public-addendum-name').fill('Maria Cliente Silva');
      await client.getByTestId('public-addendum-document').fill(VALID_CPF);
      const userAgent = await client.evaluate(() => navigator.userAgent);
      await client.getByTestId('public-addendum-accept-confirm').click();
      await expect(client.getByTestId('public-addendum-accepted-title')).toHaveText('Aceite registrado', { timeout: 30_000 });
      await expect(client.getByTestId('public-addendum-accepted-by')).toContainText('por Maria');
      await expect(client.getByTestId('public-addendum-answer')).toHaveCount(0);

      // Formalizado por aceite eletrônico, com o ator cliente e a evidência do request.
      const formalized = (await readJson<{
        status: string;
        formalizationMethod: string;
        formalization: { formalizedBy: string; evidenceText: string | null; signerName: string | null } | null;
      }>(await authApi.get(`/api/addendums/${id}`)));
      expect(formalized.status).toBe('Formalized');
      expect(formalized.formalizationMethod).toBe('ElectronicAcceptance');
      expect(formalized.formalization?.formalizedBy, 'o ator é o cliente do link').toBe(PUBLIC_LINK_CLIENT);
      expect(formalized.formalization?.signerName).toBe('Maria Cliente Silva');
      expect(formalized.formalization?.evidenceText ?? '').toMatch(/ip=\S+/);
      expect(formalized.formalization?.evidenceText ?? '').toContain(`userAgent=${userAgent.slice(0, 40)}`);

      // Os efeitos aplicam na festa e nas parcelas.
      const applied = await waitForAddendumEffects(authApi, id);
      expect(applied.effectsStatus).toBe('Applied');
      expect((await eventFacts(authApi, eventId)).eventDate).toBe(newDate);
      expect(await installments(authApi, eventId), 'a parcela extra').toHaveLength(installmentsBefore.length + 1);

      // Reabrir o link: "Aditivo já aceito", só leitura.
      await client.reload();
      await expect(client.getByTestId('public-addendum-accepted-title')).toHaveText('Aditivo já aceito', { timeout: 30_000 });
      await expect(client.getByTestId('public-addendum-accept-open')).toHaveCount(0);

      // CF-01 passo 5 — o gestor recarrega: "Formalizado", "Efeitos aplicados", sem o link.
      await openContractTab(authPage, eventId);
      await expect(authPage.getByTestId(`addendum-status-${id}`)).toContainText('Formalizado');
      await expect(authPage.getByTestId(`addendum-effects-${id}`)).toContainText('Efeitos aplicados');
      await expect(authPage.getByTestId(`addendum-public-link-${id}`)).toHaveCount(0);
      await expect(authPage.getByTestId('event-detail-fact-date')).toContainText(longDate(newDate));

      // As cláusulas alteradas aparecem na página (aditivo só de cláusula, depois do primeiro).
      const clause = freeTextClause('link de aceite');
      const clauseAddendum = await apiCreateContractAddendum(authApi, contractId, {
        reason: 'Inclui a clausula de festa ao ar livre',
        clauses: [clause.op],
      });
      const clauseLink = await apiCreateAddendumPublicLink(authApi, clauseAddendum.id);
      await client.goto(clientUrl(clauseLink.token));
      await expect(client.getByTestId('public-addendum-clauses')).toContainText(clause.title, { timeout: 30_000 });
      await expect(client.getByTestId('public-addendum-clauses')).toContainText(clause.bodyText);
    } finally {
      await client.context().close();
    }
  });

  test('@flow E25 aditivo que precisa de aprovacao nao gera link (ApprovalRequired) e quem nao gerencia contratos recebe 403', async ({
    authApi,
    authPage,
    browser,
    tenant,
  }) => {
    const { eventId } = await setupManuallyFormalizedContract(authApi, tenant.tenantId);
    const manager = await loginAsRole(tenant.tenantId, 'Manager');
    const financial = await loginAsRole(tenant.tenantId, 'Financial');
    try {
      const proposed = await apiTryProposeContractChange(manager.api, eventId, 'Gestor propoe outro local', {
        location: `Salao do Gestor ${Date.now()}`,
      });
      await assertOk(proposed, 'POST contract-changes (Gestor)');
      const proposal = await readJson<{ addendumId: string; requiresInternalApproval: boolean }>(proposed);
      const id = proposal.addendumId;
      expect(proposal.requiresInternalApproval).toBe(true);

      // CE-01 — gerar o link antes da aprovação: `Addendums.ApprovalRequired`, para o Gestor e para o Dono.
      for (const [who, api] of [
        ['Gestor', manager.api],
        ['Dono', authApi],
      ] as const) {
        const refused = await apiTryCreateAddendumPublicLink(api, id);
        expect(refused.status(), `public-link do ${who} sem a aprovação`).toBe(409);
        expect((await apiErrorBody(refused)).codes).toContain('Addendums.ApprovalRequired');
      }
      await apiCompleteOnboarding(authApi);
      await openContractTab(authPage, eventId);
      await expect(authPage.getByTestId(`addendum-public-link-generate-${id}`), 'o botão fica indisponível').toBeDisabled();

      // CE-02 — sem `contracts.manage` (nem `contracts.read`): 403 para gerar e para ler, e sem o botão.
      const createRes = await financial.api.post(`/api/addendums/${id}/public-link`);
      expect(createRes.status(), 'POST public-link do Financeiro').toBe(403);
      const readRes = await financial.api.get(`/api/addendums/${id}/public-link`);
      expect(readRes.status(), 'GET public-link do Financeiro').toBe(403);
      const financialPage = await openSessionPage(browser, financial.tokens);
      try {
        await financialPage.page.goto(`/app/events/${eventId}`);
        await expect(financialPage.page.getByTestId('event-detail-fact-date')).toBeVisible({ timeout: 30_000 });
        await expect(financialPage.page.getByTestId(`addendum-public-link-generate-${id}`)).toHaveCount(0);
      } finally {
        await financialPage.context.close();
      }

      // Nada foi gerado: o aditivo segue em rascunho, sem link.
      expect((await apiGetAddendumState(authApi, id)).status).toBe('Draft');
      expect(await liveLink(authApi, id)).toBeNull();
    } finally {
      await manager.api.dispose();
      await financial.api.dispose();
    }
  });

  test('@flow E4 "Nao aceito" com motivo: recusado, festa intacta, aviso a Dono, Administrador e quem criou; aceitar depois da AlreadyRejected', async ({
    authApi,
    authPage,
    browser,
    tenant,
  }) => {
    const { eventId } = await setupFormalizedContractWithPlan(authApi, tenant.tenantId);
    const admin = await loginAsRole(tenant.tenantId, 'Admin');
    const manager = await loginAsRole(tenant.tenantId, 'Manager');
    const client = await openClientPage(browser);
    try {
      // O Gestor cria (precisa de aprovação), o Administrador aprova, o Dono manda o link.
      const proposed = await apiTryProposeContractChange(manager.api, eventId, 'Acrescimo de personagem', {
        manualAdjustment: 150,
        manualAdjustmentDescription: 'Personagem extra',
        payment: { mode: 'ExtraInstallments', installmentCount: 1 },
      });
      await assertOk(proposed, 'POST contract-changes (Gestor)');
      const { addendumId: id, addendumNumber } = await readJson<{ addendumId: string; addendumNumber: number }>(proposed);
      await assertOk(await manager.api.post(`/api/addendums/${id}/submit`), 'POST submit (Gestor)');
      await assertOk(await admin.api.post(`/api/addendums/${id}/approve`), 'POST approve (Administrador)');
      const link = await apiCreateAddendumPublicLink(authApi, id);
      const before = await eventFacts(authApi, eventId);
      const itemsBefore = await pricingItems(authApi, eventId);
      const installmentsBefore = await installments(authApi, eventId);

      // CF-02 passo 2 — "Não aceito" com o motivo.
      const motive = 'O valor ficou alto.';
      await client.goto(clientUrl(link.token));
      await client.getByTestId('public-addendum-reject-open').click();
      await client.getByTestId('public-addendum-reject-reason').fill(motive);
      await client.getByTestId('public-addendum-reject-confirm').click();
      await expect(client.getByTestId('public-addendum-rejected-title')).toHaveText('Aditivo recusado', { timeout: 30_000 });
      await expect(client.getByTestId('public-addendum-rejected-at')).toContainText('nada mudou no seu contrato');
      await expect(client.getByTestId('public-addendum-answer')).toHaveCount(0);

      const rejected = (await apiGetAddendumState(authApi, id)) as unknown as {
        status: string;
        rejectedAt: string | null;
        rejectionReason: string | null;
      };
      expect(rejected.status).toBe('Rejected');
      expect(rejected.rejectedAt).not.toBeNull();
      expect(rejected.rejectionReason).toBe(motive);

      // O aviso no sino do Dono, do Administrador e de quem criou (o Gestor).
      const title = `Aditivo #${addendumNumber} recusado pelo cliente`;
      for (const [who, api] of [
        ['Dono', authApi],
        ['Administrador', admin.api],
        ['Gestor (quem criou)', manager.api],
      ] as const) {
        await expect
          .poll(async () => (await apiListNotifications(api)).find((n) => n.title === title)?.message ?? null, {
            message: `aviso "${title}" no sino do ${who}`,
            timeout: 30_000,
          })
          .toContain(`O cliente recusou o aditivo #${addendumNumber} pelo link: ${motive}`);
      }

      // A festa, os itens e as parcelas continuam como estavam.
      expect(await eventFacts(authApi, eventId)).toEqual(before);
      expect(await pricingItems(authApi, eventId)).toEqual(itemsBefore);
      expect(await installments(authApi, eventId)).toEqual(installmentsBefore);

      // Na linha do aditivo: "Recusado pelo cliente em … — <motivo>", sem link.
      await apiCompleteOnboarding(authApi);
      await openContractTab(authPage, eventId);
      const row = authPage.getByTestId(`addendum-rejected-${id}`);
      await expect(row).toContainText('Recusado pelo cliente em');
      await expect(row).toContainText(`— ${motive}`);
      await expect(authPage.getByTestId(`addendum-public-link-${id}`)).toHaveCount(0);

      // Aceitar depois da recusa: `PublicAddendum.AlreadyRejected`.
      const anon = await createPublicApiContext();
      try {
        const page = await apiGetPublicAddendum(anon, link.token);
        expect(page.status).toBe('Rejected');
        const late = await apiTryAcceptPublicAddendum(anon, link.token, { name: 'Cliente E2E' }, page.pdfSha256);
        expect(late.status()).toBe(409);
        expect((await apiErrorBody(late)).codes).toContain('PublicAddendum.AlreadyRejected');
      } finally {
        await anon.dispose();
      }
      expect((await apiGetAddendumState(authApi, id)).status).toBe('Rejected');
    } finally {
      await client.context().close();
      await admin.api.dispose();
      await manager.api.dispose();
    }
  });

  test('@flow E4 o link de antes de corrigir, ou de "Gerar novo link", da "Link invalido, vencido ou substituido" nas quatro rotas, e o novo abre', async ({
    authApi,
    authPage,
    browser,
    tenant,
  }) => {
    const { eventId } = await setupManuallyFormalizedContract(authApi, tenant.tenantId);
    const proposal = await apiProposeContractChange(authApi, eventId, 'Cliente pediu outro local', {
      location: `Salao primeiro ${Date.now()}`,
    });
    const id = proposal.addendumId;
    const first = await apiCreateAddendumPublicLink(authApi, id);
    const anon = await createPublicApiContext();
    const client = await openClientPage(browser);
    try {
      expect((await anon.get(`/api/public/addendums/${first.token}`)).status()).toBe(200);

      // CE-03 — recolher e corrigir: o link de antes vira 404 nas quatro rotas.
      await assertOk(await authApi.post(`/api/addendums/${id}/recall`), 'POST recall');
      const corrected = await apiProposeContractChange(authApi, eventId, 'Cliente pediu outro local (corrigido)', {
        location: `Salao corrigido ${Date.now()}`,
      });
      expect(corrected.addendumId, 'a correção é no mesmo aditivo').toBe(id);
      expect(corrected.revision).toBe(proposal.revision + 1);
      expect(await publicRouteStatuses(anon, first.token), 'link de antes da correção').toEqual([404, 404, 404, 404]);
      await client.goto(clientUrl(first.token));
      await expect(client.getByTestId('public-addendum-invalid')).toHaveText('Link inválido, vencido ou substituído', {
        timeout: 30_000,
      });
      await expect(client.getByTestId('public-addendum-header')).toHaveCount(0);

      // O link novo abre, com a revisão nova.
      const second = await apiCreateAddendumPublicLink(authApi, id);
      const opened = await apiGetPublicAddendum(anon, second.token);
      expect(opened.revision).toBe(corrected.revision);

      // "Gerar novo link" pela tela (com a confirmação): o anterior para de funcionar.
      await apiCompleteOnboarding(authApi);
      await openContractTab(authPage, eventId);
      const generate = authPage.getByTestId(`addendum-public-link-generate-${id}`);
      await expect(generate).toContainText('Gerar novo link');
      await generate.click();
      await authPage.getByTestId('confirm-ok').click();
      await expect(snack(authPage, `Link de aceite do aditivo #${proposal.addendumNumber} gerado`)).toBeVisible();
      const urlCode = authPage.getByTestId(`addendum-public-link-url-${id}`);
      await expect(urlCode).not.toHaveText(new RegExp(`/addendums/${second.token}$`), { timeout: 30_000 });
      const thirdUrl = (await urlCode.textContent())!.trim();
      const third = { url: thirdUrl, token: addendumTokenFromUrl(thirdUrl) };
      expect(await publicRouteStatuses(anon, second.token), 'link de antes do "Gerar novo link"').toEqual([404, 404, 404, 404]);
      expect((await apiGetPublicAddendum(anon, third.token)).addendumNumber).toBe(proposal.addendumNumber);
      await client.goto(clientUrl(third.token));
      await expect(client.getByTestId('public-addendum-header')).toBeVisible({ timeout: 30_000 });
      await client.goto(clientUrl(second.token));
      await expect(client.getByTestId('public-addendum-invalid')).toBeVisible({ timeout: 30_000 });
    } finally {
      await anon.dispose();
      await client.context().close();
    }
  });

  test('@flow E5 outra empresa: o link do aditivo de A pelo login de B da 404 e nao gera; a pagina de A com a sessao de B mostra so A e o aceite grava em A', async ({
    authApi,
    browser,
    tenant,
  }) => {
    const { eventId } = await setupManuallyFormalizedContract(authApi, tenant.tenantId);
    const proposal = await apiProposeContractChange(authApi, eventId, 'Cliente pediu outro local', {
      location: `Salao de A ${Date.now()}`,
    });
    const id = proposal.addendumId;
    await apiAddendumPdf(authApi, id);
    const nameA = await companyName(authApi);

    const other = await signupNewTenant();
    const apiB = await createBearerApiContext(other.accessToken);
    try {
      // CE-09 passo 1 — o login de B não gera nem lê o link do aditivo de A.
      const create = await apiB.post(`/api/addendums/${id}/public-link`);
      expect(create.status(), 'POST public-link de outra empresa').toBe(404);
      const read = await apiB.get(`/api/addendums/${id}/public-link`);
      expect(read.status(), 'GET public-link de outra empresa').toBe(404);
      expect((await apiGetAddendumState(authApi, id)).status, 'nada mudou em A').toBe('Draft');
      expect(await liveLink(authApi, id), 'nenhum link gerado em A').toBeNull();

      // CE-09 passo 2 — a página do link de A, no navegador com a sessão de B: só o aditivo de A.
      const link = await apiCreateAddendumPublicLink(authApi, id);
      const pageB = await openSessionPage(browser, other);
      try {
        await pageB.page.goto(clientUrl(link.token));
        await expect(pageB.page.getByTestId('public-addendum-company')).toHaveText(nameA, { timeout: 30_000 });
        await expect(pageB.page.getByTestId('public-addendum-title')).toContainText(`Aditivo #${proposal.addendumNumber}`);
      } finally {
        await pageB.context.close();
      }

      // O aceite com o Bearer de B grava no tenant do token (A).
      const view = await apiGetPublicAddendum(apiB, link.token);
      expect(view.companyName).toBe(nameA);
      await assertOk(
        await apiTryAcceptPublicAddendum(apiB, link.token, { name: 'Cliente de A' }, view.pdfSha256),
        'POST accept com a sessão de B',
      );
      expect((await apiGetAddendumState(authApi, id)).status, 'formalizado em A').toBe('Formalized');
      expect((await apiB.get(`/api/addendums/${id}`)).status(), 'B continua sem ver o aditivo').toBe(404);
      const noticesB = await apiListNotifications(apiB);
      expect(noticesB.filter((n) => n.title.includes('Aditivo #')), 'nada do aditivo de A no sino de B').toHaveLength(0);
    } finally {
      await apiB.dispose();
    }
  });

  test('@flow E26 a validade vencida pelo AddendumExpiryWorker deixa o aditivo "Expirado", o link no 404 e o aviso no sino', async ({
    authApi,
    authPage,
    browser,
    superAdminApi,
    tenant,
  }) => {
    const { eventId } = await setupManuallyFormalizedContract(authApi, tenant.tenantId);
    const proposal = await apiProposeContractChange(authApi, eventId, 'Cliente pediu outro local', {
      location: `Salao que vence ${Date.now()}`,
    });
    const id = proposal.addendumId;
    const link = await apiCreateAddendumPublicLink(authApi, id);

    // A validade no passado (SQL) e "rodar agora" do worker no Super Admin.
    expireAddendumLinkDirect(id);
    await assertOk(
      await superAdminApi.post('/api/super-admin/workers/AddendumExpiryWorker/run-now'),
      'POST run-now AddendumExpiryWorker',
    );
    await expect
      .poll(async () => (await apiGetAddendumState(authApi, id)).status, {
        message: 'o worker passa o aditivo a Expired',
        timeout: 240_000,
        intervals: [5_000],
      })
      .toBe('Expired');
    expect(
      ((await apiGetAddendumState(authApi, id)) as unknown as { expiredAt: string | null }).expiredAt,
    ).not.toBeNull();

    // O link dá a mesma página do 404.
    const anon = await createPublicApiContext();
    try {
      expect(await publicRouteStatuses(anon, link.token)).toEqual([404, 404, 404, 404]);
    } finally {
      await anon.dispose();
    }
    const client = await openClientPage(browser);
    try {
      await client.goto(clientUrl(link.token));
      await expect(client.getByTestId('public-addendum-invalid')).toHaveText('Link inválido, vencido ou substituído', {
        timeout: 30_000,
      });
    } finally {
      await client.context().close();
    }

    // O aviso "Aditivo #N expirado" no sino, e a linha "Expirado em …".
    const title = `Aditivo #${proposal.addendumNumber} expirado`;
    await expect
      .poll(async () => (await apiListNotifications(authApi)).some((n) => n.title === title), {
        message: `aviso "${title}" no sino do Dono`,
        timeout: 30_000,
      })
      .toBe(true);
    await apiCompleteOnboarding(authApi);
    await openContractTab(authPage, eventId);
    await expect(authPage.getByTestId(`addendum-expired-${id}`)).toContainText('Expirado em');
    await expect(authPage.getByTestId(`addendum-public-link-${id}`)).toHaveCount(0);
  });

  test('@flow E26 renomear a empresa com a pagina aberta recusa o aceite (PublicAddendum.Changed) e, depois do "Recarregar", o aceite passa com o mesmo link', async ({
    authApi,
    browser,
    tenant,
  }) => {
    const { eventId } = await setupManuallyFormalizedContract(authApi, tenant.tenantId);
    const proposal = await apiProposeContractChange(authApi, eventId, 'Cliente pediu outro local', {
      location: `Salao renomeado ${Date.now()}`,
    });
    const id = proposal.addendumId;
    const link = await apiCreateAddendumPublicLink(authApi, id);
    const client = await openClientPage(browser);
    try {
      await client.goto(clientUrl(link.token));
      await expect(client.getByTestId('public-addendum-accept-open')).toBeVisible({ timeout: 30_000 });

      // CE-05 passo 1 — o Dono renomeia a empresa com a página do cliente aberta.
      const companyRes = await authApi.get('/api/company');
      await assertOk(companyRes, 'GET /api/company');
      const company = await readJson<Record<string, unknown> & { name: string }>(companyRes);
      const renamed = `${company.name} Festas ${Date.now() % 10_000}`;
      await assertOk(
        await authApi.put('/api/company', {
          data: {
            name: renamed,
            legalName: company.legalName ?? null,
            document: company.document ?? null,
            timezone: company.timezone,
            logoBase64: null,
            contactEmail: company.contactEmail ?? null,
            contactPhone: company.contactPhone ?? null,
            address: company.address ?? null,
            billingEmail: company.billingEmail ?? null,
          },
        }),
        'PUT /api/company',
      );

      // Passo 2 — o aceite é recusado: "O aditivo foi alterado…" e "Recarregar".
      await client.getByTestId('public-addendum-accept-open').click();
      await client.getByTestId('public-addendum-name').fill('Joana Cliente');
      await client.getByTestId('public-addendum-accept-confirm').click();
      await expect(client.getByTestId('public-addendum-form-error').last()).toContainText(
        'O aditivo foi alterado depois que você abriu esta página',
        { timeout: 30_000 },
      );
      await expect(client.getByTestId('public-addendum-accept-confirm')).toBeDisabled();
      expect((await apiGetAddendumState(authApi, id)).status, 'nada foi aceito').toBe('Sent');

      // Passo 3 — "Recarregar" traz a versão atual, com o nome mantido; o aceite passa com o mesmo link.
      await client.getByTestId('public-addendum-reload').last().click();
      await expect(client.getByTestId('public-addendum-reloaded')).toBeVisible({ timeout: 30_000 });
      await expect(client.getByTestId('public-addendum-company')).toHaveText(renamed);
      await client.getByTestId('public-addendum-accept-open').click();
      await expect(client.getByTestId('public-addendum-name'), 'o nome digitado se mantém').toHaveValue('Joana Cliente');
      await client.getByTestId('public-addendum-accept-confirm').click();
      await expect(client.getByTestId('public-addendum-accepted-title')).toHaveText('Aceite registrado', { timeout: 30_000 });
      expect((await apiGetAddendumState(authApi, id)).status).toBe('Formalized');
    } finally {
      await client.context().close();
    }
  });
});
