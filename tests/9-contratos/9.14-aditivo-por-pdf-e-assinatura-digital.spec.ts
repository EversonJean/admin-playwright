import { createHash } from 'crypto';

import type { APIRequestContext, Page } from '@playwright/test';

import { authTest as test, expect } from '../../fixtures/auth.fixture';
import {
  addendumFormalizedOutboxDirect,
  addendumDocumentFilesDirect,
  disableFeatureFlagDirect,
  enableFeatureFlagDirect,
  setSubscriptionPlanDirect,
  signatureEnvelopeStatusDirect,
} from '../../helpers/db-helper';
import {
  apiAddendumPdf,
  apiErrorBody,
  apiFormalizeAddendumManually,
  apiGetAddendumState,
  apiProposeContractChange,
  apiTryProposeContractChange,
  setupFormalizedContractWithPlan,
  setupManuallyFormalizedContract,
  waitForAddendumEffects,
} from '../../helpers/addendums';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import { apiCompleteOnboarding, apiListNotifications } from '../../helpers/api-entities';
import { apiGetPaymentPlan } from '../../helpers/api-event-flow';
import { fakeClicksign } from '../../helpers/fake-providers';
import { assertOk, readJson, unwrapList } from '../../helpers/response';
import { loginAsRole, openSessionPage } from '../../helpers/setup-flows';
import { snack } from '../../helpers/ui';

/**
 * Fluxo: 9.14 — Aditivo por PDF assinado e assinatura digital
 * Diagrama: docs/fluxos/negocio-9.14-aditivo-por-pdf-e-assinatura-digital.mmd
 * Cenário: docs/cenarios-de-teste/9-contratos/9.14-aditivo-por-pdf-e-assinatura-digital.md
 * (CF-01 a CF-03, CE-01, CE-02, CE-03, CE-05 a CE-09)
 *
 * PLANO-ADITIVOS-COM-APROVACAO §9 (AD-G) itens 1 a 5, A2 a A7 (registro e2e E6,
 * E28 a E31):
 * - "Enviar para assinatura digital" (fake da Clicksign) com o contato do cliente
 *   da festa leva o aditivo a "Enviado" com o card do envelope; o webhook `sign`
 *   formaliza (Assinatura digital, robustez Alta, PDF do provedor com o
 *   `AddendumId`) e, entregue o outbox, a festa e as parcelas mudam uma vez só;
 *   reentregar o webhook não formaliza de novo;
 * - "Formalizar (PDF assinado)" formaliza com "PDF assinado externo" e robustez
 *   Média, guarda o nome enviado e aplica os efeitos; as quatro guardas do PDF;
 *   o aditivo que precisa de aprovação não tem o botão (ApprovalRequired);
 * - o webhook `refusal` recusa o aditivo, avisa Dono e quem criou, uma vez só;
 * - "Recolher" cancela o envelope, e a assinatura atrasada do envelope antigo não
 *   formaliza; cancelar e reenviar; segundo envio ativo recusado; formalizar à mão
 *   cancela o envelope ativo;
 * - sem o add-on, 403 `Entitlement.NotIncludedInPlan`; Gestor só lê; outra
 *   empresa, 404.
 */

const DIGITAL_SIGNATURE = 'feature_digital_signature';
const TWENTY_FIVE_MB = 25 * 1024 * 1024;

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

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** O detalhe do aditivo no que a formalização grava. */
async function formalizationOf(api: APIRequestContext, addendumId: string) {
  const res = await api.get(`/api/addendums/${addendumId}`);
  await assertOk(res, 'GET /api/addendums/{id}');
  return readJson<{
    status: string;
    revision: number;
    formalizationMethod: string | null;
    formalizationRobustness: string | null;
    hasActiveSignatureEnvelope: boolean;
    rejectionReason: string | null;
  }>(res);
}

interface Envelope {
  id: string;
  status: string;
  providerDocumentKey: string;
  providerSignerKey: string | null;
}

async function apiGetAddendumEnvelope(api: APIRequestContext, addendumId: string): Promise<Envelope> {
  const res = await api.get(`/api/addendums/${addendumId}/digital-signature`);
  await assertOk(res, 'GET /api/addendums/{id}/digital-signature');
  return readJson<Envelope>(res);
}

/** `POST .../digital-signature/send` por e-mail; devolve a resposta crua. */
async function apiTrySendDigital(api: APIRequestContext, addendumId: string) {
  return api.post(`/api/addendums/${addendumId}/digital-signature/send`, {
    data: {
      signerName: 'Cliente E2E',
      signerEmail: `cliente-${Date.now()}@e2e.test`,
      signerPhone: null,
      deliveryChannel: 'Email',
      message: 'Por favor, assine o aditivo.',
    },
  });
}

async function apiSendDigital(api: APIRequestContext, addendumId: string): Promise<Envelope> {
  await apiAddendumPdf(api, addendumId);
  await assertOk(await apiTrySendDigital(api, addendumId), 'POST /api/addendums/{id}/digital-signature/send');
  return apiGetAddendumEnvelope(api, addendumId);
}

/** Corpo do `formalize-external-pdf` (o `FormalizeExternalPdfDto` do contrato). */
function externalPdfBody(bytes: Buffer, fileName: string, expectedHash = sha256(bytes)) {
  return {
    fileBase64: bytes.toString('base64'),
    fileName,
    expectedHashSha256: expectedHash,
    signerName: 'Cliente E2E',
    signerEmail: null,
    signerPhone: null,
    evidenceText: null,
    formalizedAt: null,
  };
}

async function openContractTab(page: Page, eventId: string): Promise<void> {
  await page.goto(`/app/events/${eventId}`);
  await page.getByRole('tab', { name: 'Contrato', exact: true }).click({ timeout: 45_000 });
  await expect(page.getByTestId('addendums-section')).toBeVisible({ timeout: 30_000 });
}

test.describe('Fluxo 9.14 — Aditivo por PDF assinado e assinatura digital', () => {
  // Contrato formalizado, plano, envelope no fake, webhook e o outbox dos efeitos.
  test.describe.configure({ timeout: 300_000 });

  test('@flow E6 enviar para assinatura digital pelo fake: o webhook sign formaliza (Alta, PDF do provedor) e a festa muda uma vez so; reentregar nao formaliza de novo', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, DIGITAL_SIGNATURE);
    const { eventId, clienteId } = await setupFormalizedContractWithPlan(authApi, tenant.tenantId);
    const clientRes = await authApi.get(`/api/clients/${clienteId}`);
    await assertOk(clientRes, 'GET /api/clients/{id}');
    const client = await readJson<{ name: string; email: string }>(clientRes);
    const before = await eventFacts(authApi, eventId);
    const installmentsBefore = await installments(authApi, eventId);
    const newDate = addDays(before.eventDate, 7);
    const proposal = await apiProposeContractChange(authApi, eventId, 'Cliente pediu outra data e um personagem', {
      eventDate: newDate,
      manualAdjustment: 150,
      manualAdjustmentDescription: 'Personagem extra',
      payment: { mode: 'ExtraInstallments', installmentCount: 1 },
    });
    const id = proposal.addendumId;
    const n = proposal.addendumNumber;
    await apiAddendumPdf(authApi, id);

    // CF-02 passos 1 e 2 — o diálogo vem com o contato do cliente da festa.
    await apiCompleteOnboarding(authApi);
    await openContractTab(authPage, eventId);
    await authPage.getByTestId(`addendum-send-digital-${id}`).click();
    await expect(authPage.getByTestId('send-digital-title')).toContainText(`aditivo #${n} do contrato`);
    await expect(authPage.getByTestId('send-digital-signer-email')).toHaveValue(client.email);
    await authPage.getByTestId('send-digital-submit').click();
    await expect(snack(authPage, `Link de assinatura do aditivo #${n} enviado ao contratante.`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(authPage.getByTestId(`addendum-status-${id}`)).toContainText('Enviado');
    await expect(authPage.getByTestId(`addendum-signature-${id}`)).toContainText(`Assinatura digital do aditivo #${n}`);
    await expect(authPage.getByTestId(`addendum-send-digital-${id}`), 'com envio ativo, o botão fica indisponível').toBeDisabled();

    const envelope = await apiGetAddendumEnvelope(authApi, id);
    expect(envelope.providerDocumentKey).toMatch(/^fake_doc_/);
    expect((await formalizationOf(authApi, id)).hasActiveSignatureEnvelope).toBe(true);

    // O cliente assina: o fake dispara o webhook `sign` com HMAC válido.
    const occurredAt = new Date().toISOString();
    const signed = await fakeClicksign.triggerWebhook({
      event: 'sign',
      providerDocumentKey: envelope.providerDocumentKey,
      providerSignerKey: envelope.providerSignerKey ?? undefined,
      occurredAt,
    });
    expect(signed.backStatus, 'o back aceita o webhook').toBe(200);
    const formalized = await formalizationOf(authApi, id);
    expect(formalized.status).toBe('Formalized');
    expect(formalized.formalizationMethod).toBe('DigitalSignatureProvider');
    expect(formalized.formalizationRobustness).toBe('High');
    const docs = addendumDocumentFilesDirect(id);
    expect(
      docs.some((d) => d.documentType === 'Formalized'),
      `o PDF do provedor no histórico com o AddendumId: ${JSON.stringify(docs)}`,
    ).toBe(true);

    // Entregue o outbox, a festa e as parcelas mudam uma vez.
    const applied = await waitForAddendumEffects(authApi, id);
    expect(applied.effectsStatus).toBe('Applied');
    const after = await eventFacts(authApi, eventId);
    expect(after.eventDate).toBe(newDate);
    const installmentsAfter = await installments(authApi, eventId);
    expect(installmentsAfter, 'uma parcela extra').toHaveLength(installmentsBefore.length + 1);

    // Reentregar o mesmo webhook não formaliza de novo nem aplica outra vez.
    const again = await fakeClicksign.triggerWebhook({
      event: 'sign',
      providerDocumentKey: envelope.providerDocumentKey,
      providerSignerKey: envelope.providerSignerKey ?? undefined,
      occurredAt,
    });
    expect(again.backStatus).toBe(200);
    expect(addendumFormalizedOutboxDirect(tenant.tenantId, id), 'uma formalização só no outbox').toHaveLength(1);
    expect(addendumDocumentFilesDirect(id)).toHaveLength(docs.length);
    expect(await eventFacts(authApi, eventId)).toEqual(after);
    expect(await installments(authApi, eventId)).toEqual(installmentsAfter);

    // Na tela: "Formalizado", "Assinatura digital", "Robustez: Alta" e "Efeitos aplicados".
    await openContractTab(authPage, eventId);
    await expect(authPage.getByTestId(`addendum-status-${id}`)).toContainText('Formalizado');
    await expect(authPage.getByTestId(`addendum-formalized-at-${id}`)).toContainText('Assinatura digital');
    await expect(authPage.getByTestId(`addendum-formalized-at-${id}`)).toContainText('Robustez: Alta');
    await expect(authPage.getByTestId(`addendum-effects-${id}`)).toContainText('Efeitos aplicados');
  });

  test('@flow E28 "Formalizar (PDF assinado)": PDF assinado externo, robustez Media, nome guardado e efeitos aplicados; as guardas do PDF e o aditivo que precisa de aprovacao', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    const { eventId, contractId } = await setupFormalizedContractWithPlan(authApi, tenant.tenantId);
    const before = await eventFacts(authApi, eventId);
    const newDate = addDays(before.eventDate, 7);
    const proposal = await apiProposeContractChange(authApi, eventId, 'Cliente pediu outra data', { eventDate: newDate });
    const id = proposal.addendumId;
    const n = proposal.addendumNumber;
    const pdf = await apiAddendumPdf(authApi, id);

    // CE-01 — arquivo que não é PDF, acima de 25 MB ou com o hash divergente: recusado, sem formalizar.
    const notPdf = Buffer.from('isto nao e um pdf, e texto puro renomeado', 'utf-8');
    const tooLarge = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(TWENTY_FIVE_MB + 1024, 0x20)]);
    for (const [label, body, code] of [
      ['não é PDF', externalPdfBody(notPdf, 'foto.pdf'), 'Contracts.PdfFileInvalid'],
      ['acima de 25 MB', externalPdfBody(tooLarge, 'grande.pdf'), 'Contracts.PdfFileTooLarge'],
      ['hash divergente', externalPdfBody(pdf, 'aditivo.pdf', sha256(Buffer.from('outro arquivo'))), 'Contracts.PdfHashMismatch'],
    ] as const) {
      const res = await authApi.post(`/api/addendums/${id}/formalize-external-pdf`, { data: body });
      expect(res.status(), `formalize-external-pdf (${label})`).toBe(400);
      expect((await apiErrorBody(res)).codes, label).toContain(code);
    }
    expect((await formalizationOf(authApi, id)).status, 'nada foi formalizado').toBe('Draft');

    // CF-01 — pela tela, com o PDF que o cliente assinou.
    const fileName = `aditivo-${n}-assinado-cliente-${Date.now()}.pdf`;
    await apiCompleteOnboarding(authApi);
    await openContractTab(authPage, eventId);
    await authPage.getByTestId(`addendum-formalize-external-pdf-${id}`).click();
    await expect(authPage.getByTestId('external-pdf-title')).toContainText(
      `Formalizar aditivo #${n} (PDF assinado externamente)`,
    );
    await authPage
      .getByTestId('external-pdf-file-input')
      .setInputFiles({ name: fileName, mimeType: 'application/pdf', buffer: pdf });
    await expect(authPage.getByTestId('external-pdf-state-ready')).toBeVisible({ timeout: 30_000 });
    await expect(authPage.getByTestId('external-pdf-hash')).toContainText(sha256(pdf).slice(0, 8));
    await authPage.getByTestId('external-pdf-signer-name').fill('Cliente que assinou');
    await authPage.getByTestId('external-pdf-submit').click();
    await expect(snack(authPage, `Aditivo #${n} formalizado com PDF assinado`)).toBeVisible({ timeout: 30_000 });

    const formalized = await formalizationOf(authApi, id);
    expect(formalized.status).toBe('Formalized');
    expect(formalized.formalizationMethod).toBe('ExternalSignedPdf');
    expect(formalized.formalizationRobustness).toBe('Medium');
    expect(
      addendumDocumentFilesDirect(id).some((d) => d.originalFilename === fileName),
      'o documento do aditivo guarda o nome enviado',
    ).toBe(true);
    const docsRes = await authApi.get(`/api/documents/by-contract/${contractId}`);
    await assertOk(docsRes, 'GET /api/documents/by-contract/{id}');
    const doc = (await unwrapList<{ id: string; originalFilename: string | null }>(docsRes)).find(
      (d) => d.originalFilename === fileName,
    );
    expect(doc, 'o documento no histórico do contrato').toBeTruthy();

    // Os efeitos aplicam na festa.
    expect((await waitForAddendumEffects(authApi, id)).effectsStatus).toBe('Applied');
    expect((await eventFacts(authApi, eventId)).eventDate).toBe(newDate);
    await openContractTab(authPage, eventId);
    await expect(authPage.getByTestId(`addendum-formalized-at-${id}`)).toContainText('PDF assinado externo');
    await expect(authPage.getByTestId(`addendum-formalized-at-${id}`)).toContainText('Robustez: Média');
    await expect(authPage.getByTestId(`addendum-effects-${id}`)).toContainText('Efeitos aplicados');
    await expect(authPage.getByTestId(`contract-tab-document-download-${doc!.id}`)).toHaveAttribute(
      'aria-label',
      `Baixar ${fileName}`,
    );

    // CE-02 — o aditivo que precisa de aprovação não tem o botão e a API recusa.
    const manager = await loginAsRole(tenant.tenantId, 'Manager');
    try {
      const proposed = await apiTryProposeContractChange(manager.api, eventId, 'Gestor propoe outro local', {
        location: `Salao do Gestor ${Date.now()}`,
      });
      await assertOk(proposed, 'POST contract-changes (Gestor)');
      const pending = await readJson<{ addendumId: string; requiresInternalApproval: boolean }>(proposed);
      expect(pending.requiresInternalApproval).toBe(true);
      const pendingPdf = await apiAddendumPdf(authApi, pending.addendumId);
      const refused = await authApi.post(`/api/addendums/${pending.addendumId}/formalize-external-pdf`, {
        data: externalPdfBody(pendingPdf, 'aditivo-sem-aprovacao.pdf'),
      });
      expect(refused.status(), 'formalize-external-pdf sem a aprovação').toBe(409);
      expect((await apiErrorBody(refused)).codes).toContain('Addendums.ApprovalRequired');
      await openContractTab(authPage, eventId);
      await expect(authPage.getByTestId(`addendum-requires-approval-${pending.addendumId}`)).toBeVisible();
      await expect(authPage.getByTestId(`addendum-formalize-external-pdf-${pending.addendumId}`)).toHaveCount(0);
      expect((await formalizationOf(authApi, pending.addendumId)).status).toBe('Draft');
    } finally {
      await manager.api.dispose();
    }
  });

  test('@flow E29 o webhook refusal recusa o aditivo, avisa o Dono e quem criou uma vez so, e a festa fica intacta', async ({
    authApi,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, DIGITAL_SIGNATURE);
    const { eventId } = await setupFormalizedContractWithPlan(authApi, tenant.tenantId);
    const manager = await loginAsRole(tenant.tenantId, 'Manager');
    try {
      // O Gestor cria (precisa de aprovação), o Dono aprova e envia à assinatura.
      const proposed = await apiTryProposeContractChange(manager.api, eventId, 'Acrescimo de personagem', {
        manualAdjustment: 150,
        manualAdjustmentDescription: 'Personagem extra',
        payment: { mode: 'ExtraInstallments', installmentCount: 1 },
      });
      await assertOk(proposed, 'POST contract-changes (Gestor)');
      const { addendumId: id, addendumNumber: n } = await readJson<{ addendumId: string; addendumNumber: number }>(proposed);
      await assertOk(await manager.api.post(`/api/addendums/${id}/submit`), 'POST submit (Gestor)');
      await assertOk(await authApi.post(`/api/addendums/${id}/approve`), 'POST approve (Dono)');
      const envelope = await apiSendDigital(authApi, id);
      const before = await eventFacts(authApi, eventId);
      const itemsBefore = await pricingItems(authApi, eventId);
      const installmentsBefore = await installments(authApi, eventId);

      // CE-06 — o cliente recusa na Clicksign.
      const motive = `O valor ficou alto ${Date.now()}`;
      const occurredAt = new Date().toISOString();
      const refusal = { event: 'refusal', providerDocumentKey: envelope.providerDocumentKey, occurredAt, reason: motive };
      expect((await fakeClicksign.triggerWebhook(refusal)).backStatus).toBe(200);
      const rejected = await formalizationOf(authApi, id);
      expect(rejected.status).toBe('Rejected');
      expect(rejected.rejectionReason ?? '').toContain(motive);

      const title = `Aditivo #${n} recusado pelo cliente`;
      for (const [who, api] of [
        ['Dono', authApi],
        ['Gestor (quem criou)', manager.api],
      ] as const) {
        await expect
          .poll(async () => (await apiListNotifications(api)).filter((n2) => n2.title === title).length, {
            message: `aviso "${title}" no sino do ${who}`,
            timeout: 30_000,
          })
          .toBe(1);
      }
      expect(await eventFacts(authApi, eventId)).toEqual(before);
      expect(await pricingItems(authApi, eventId)).toEqual(itemsBefore);
      expect(await installments(authApi, eventId)).toEqual(installmentsBefore);

      // Repetir o evento não avisa de novo (o webhook processa na própria requisição).
      expect((await fakeClicksign.triggerWebhook(refusal)).backStatus).toBe(200);
      expect((await apiListNotifications(authApi)).filter((x) => x.title === title)).toHaveLength(1);
      expect((await apiListNotifications(manager.api)).filter((x) => x.title === title)).toHaveLength(1);
      expect((await formalizationOf(authApi, id)).status).toBe('Rejected');
    } finally {
      await manager.api.dispose();
    }
  });

  test('@flow E30 recolher cancela o envelope e a assinatura atrasada nao formaliza; cancelar e reenviar; segundo envio ativo recusado; formalizar a mao cancela o envio', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, DIGITAL_SIGNATURE);
    const { eventId } = await setupManuallyFormalizedContract(authApi, tenant.tenantId);
    const before = await eventFacts(authApi, eventId);
    const newDate = addDays(before.eventDate, 7);
    const proposal = await apiProposeContractChange(authApi, eventId, 'Cliente pediu outra data', { eventDate: newDate });
    const id = proposal.addendumId;
    const n = proposal.addendumNumber;
    const first = await apiSendDigital(authApi, id);

    // CE-07 passo 1 — "Recolher": o card sai e o envelope é cancelado no fake.
    const since = new Date(Date.now() - 1_000).toISOString();
    await apiCompleteOnboarding(authApi);
    await openContractTab(authPage, eventId);
    await expect(authPage.getByTestId(`addendum-signature-${id}`)).toBeVisible();
    await authPage.getByTestId(`addendum-recall-${id}`).click();
    await expect(snack(authPage, 'Aditivo voltou para rascunho')).toBeVisible();
    await expect(authPage.getByTestId(`addendum-signature-${id}`)).toHaveCount(0, { timeout: 30_000 });
    const cancels = (await fakeClicksign.inbox({ since })).filter(
      (e) => e.method === 'PATCH' && e.path === `/documents/${first.providerDocumentKey}/cancel`,
    );
    expect(cancels.length, 'o envelope cancelado no provedor').toBeGreaterThan(0);

    // Passo 2 — a correção sobe a revisão.
    const corrected = await apiProposeContractChange(authApi, eventId, 'Cliente pediu outra data (corrigido)', {
      eventDate: newDate,
      location: `Salao corrigido ${Date.now()}`,
    });
    expect(corrected.addendumId).toBe(id);
    expect(corrected.revision).toBe(proposal.revision + 1);

    // Passo 3 — a assinatura atrasada do envelope antigo não formaliza.
    const late = await fakeClicksign.triggerWebhook({
      event: 'sign',
      providerDocumentKey: first.providerDocumentKey,
      providerSignerKey: first.providerSignerKey ?? undefined,
    });
    expect(late.backStatus).toBe(200);
    expect((await formalizationOf(authApi, id)).status, 'a assinatura atrasada não formaliza').toBe('Draft');
    // E30: "o webhook sign do envelope antigo chega depois e não formaliza (envelope
    // `Failed`, festa sem mudança)". `soft` para o resto do fluxo seguir; a falha conta.
    expect.soft(signatureEnvelopeStatusDirect(first.providerDocumentKey), 'o envelope antigo (E30)').toBe('Failed');
    expect(addendumFormalizedOutboxDirect(tenant.tenantId, id)).toHaveLength(0);
    expect(await eventFacts(authApi, eventId)).toEqual(before);

    // CF-03 — enviar a revisão nova, "Cancelar envio" pelo card e mandar de novo.
    const second = await apiSendDigital(authApi, id);
    expect(second.providerDocumentKey).not.toBe(first.providerDocumentKey);
    // CE-03 — um segundo envio com o primeiro ativo é recusado.
    const twice = await apiTrySendDigital(authApi, id);
    expect(twice.status(), 'segundo envio com o envelope ativo').toBe(409);
    expect((await apiErrorBody(twice)).codes).toContain('Addendums.SignatureAlreadyInFlight');

    await openContractTab(authPage, eventId);
    const card = authPage.getByTestId(`addendum-signature-${id}`);
    await expect(card).toContainText(`Assinatura digital do aditivo #${n}`);
    await card.getByTestId('digital-signature-cancel').click();
    await authPage.getByTestId('confirm-ok').click();
    await expect(snack(authPage, 'Envio para assinatura cancelado.')).toBeVisible({ timeout: 30_000 });
    await expect(card).toHaveCount(0, { timeout: 30_000 });
    await expect(authPage.getByTestId(`addendum-status-${id}`)).toContainText('Enviado');
    expect(signatureEnvelopeStatusDirect(second.providerDocumentKey)).toBe('Canceled');

    const third = await apiSendDigital(authApi, id);
    expect(third.status).not.toBe('Canceled');

    // CE-07 — formalizar à mão com o envio ativo também o cancela.
    await apiFormalizeAddendumManually(authApi, id);
    expect((await formalizationOf(authApi, id)).status).toBe('Formalized');
    expect(signatureEnvelopeStatusDirect(third.providerDocumentKey), 'o envio ativo cancelado').toBe('Canceled');
    expect((await formalizationOf(authApi, id)).hasActiveSignatureEnvelope).toBe(false);
  });

  test('@flow E31 sem o add-on: sem o botao e 403 Entitlement.NotIncludedInPlan, com o PDF assinado ainda disponivel', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    const { eventId } = await setupManuallyFormalizedContract(authApi, tenant.tenantId);
    const proposal = await apiProposeContractChange(authApi, eventId, 'Cliente pediu outro local', {
      location: `Salao sem add-on ${Date.now()}`,
    });
    const id = proposal.addendumId;
    await apiAddendumPdf(authApi, id);
    // O `setupDraftContract` liga o add-on (ativação, que vence o plano) e o signup
    // nasce no `plan_professional`, que também o traz: a empresa sem o add-on é a do
    // `plan_free` com a ativação desligada (molde do `0-infra/entitlement-gates`).
    disableFeatureFlagDirect(tenant.tenantId, DIGITAL_SIGNATURE);
    setSubscriptionPlanDirect(tenant.tenantId, 'plan_free');

    for (const [route, res] of [
      ['send', await apiTrySendDigital(authApi, id)],
      ['GET', await authApi.get(`/api/addendums/${id}/digital-signature`)],
      ['cancel', await authApi.post(`/api/addendums/${id}/digital-signature/cancel`)],
    ] as const) {
      expect(res.status(), `${route} sem o add-on`).toBe(403);
      expect((await apiErrorBody(res)).codes, route).toContain('Entitlement.NotIncludedInPlan');
    }

    await apiCompleteOnboarding(authApi);
    await openContractTab(authPage, eventId);
    await expect(authPage.getByTestId(`addendum-formalize-external-pdf-${id}`), 'o PDF assinado não depende do add-on').toBeVisible();
    await expect(authPage.getByTestId(`addendum-send-digital-${id}`)).toHaveCount(0);
    await expect(authPage.getByTestId(`addendum-signature-${id}`)).toHaveCount(0);
    expect((await formalizationOf(authApi, id)).status).toBe('Draft');
  });

  test('@flow E31 o Gestor nao formaliza nem envia (403) e ve o card so para leitura; o aditivo de outra empresa da 404 nas quatro rotas', async ({
    authApi,
    browser,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, DIGITAL_SIGNATURE);
    const { eventId } = await setupManuallyFormalizedContract(authApi, tenant.tenantId);
    const proposal = await apiProposeContractChange(authApi, eventId, 'Cliente pediu outro local', {
      location: `Salao do Gestor ${Date.now()}`,
    });
    const id = proposal.addendumId;
    const n = proposal.addendumNumber;
    const envelope = await apiSendDigital(authApi, id);
    const pdf = await apiAddendumPdf(authApi, id);

    // CE-08 — o Gestor: sem os dois botões, card só para leitura, 403 nas escritas e 200 no GET.
    const manager = await loginAsRole(tenant.tenantId, 'Manager');
    try {
      const managerPage = await openSessionPage(browser, manager.tokens);
      try {
        await openContractTab(managerPage.page, eventId);
        const card = managerPage.page.getByTestId(`addendum-signature-${id}`);
        await expect(card).toContainText(`Assinatura digital do aditivo #${n}`);
        await expect(card.getByTestId('digital-signature-cancel')).toHaveCount(0);
        await expect(managerPage.page.getByTestId(`addendum-formalize-external-pdf-${id}`)).toHaveCount(0);
        await expect(managerPage.page.getByTestId(`addendum-send-digital-${id}`)).toHaveCount(0);
      } finally {
        await managerPage.context.close();
      }
      expect((await apiTrySendDigital(manager.api, id)).status(), 'send do Gestor').toBe(403);
      expect((await manager.api.post(`/api/addendums/${id}/digital-signature/cancel`)).status(), 'cancel do Gestor').toBe(403);
      const external = await manager.api.post(`/api/addendums/${id}/formalize-external-pdf`, {
        data: externalPdfBody(pdf, 'gestor.pdf'),
      });
      expect(external.status(), 'formalize-external-pdf do Gestor').toBe(403);
      const read = await manager.api.get(`/api/addendums/${id}/digital-signature`);
      expect(read.status(), 'GET do Gestor').toBe(200);
    } finally {
      await manager.api.dispose();
    }

    // CE-09 — outra empresa (com o add-on, para o 404 vir do isolamento e não do plano).
    const other = await signupNewTenant();
    enableFeatureFlagDirect(other.tenantId, DIGITAL_SIGNATURE);
    const apiB = await createBearerApiContext(other.accessToken);
    try {
      for (const [route, res] of [
        ['formalize-external-pdf', await apiB.post(`/api/addendums/${id}/formalize-external-pdf`, { data: externalPdfBody(pdf, 'b.pdf') })],
        ['send', await apiTrySendDigital(apiB, id)],
        ['GET', await apiB.get(`/api/addendums/${id}/digital-signature`)],
        ['cancel', await apiB.post(`/api/addendums/${id}/digital-signature/cancel`)],
      ] as const) {
        expect(res.status(), `${route} de outra empresa`).toBe(404);
      }
    } finally {
      await apiB.dispose();
    }
    const still = await formalizationOf(authApi, id);
    expect(still.status, 'nada muda no aditivo de A').toBe('Sent');
    expect(still.hasActiveSignatureEnvelope).toBe(true);
    expect(signatureEnvelopeStatusDirect(envelope.providerDocumentKey)).not.toBe('Canceled');
  });
});
