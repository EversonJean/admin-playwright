import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { APIRequestContext, Page } from '@playwright/test';

import { authTest as test, expect } from '../../fixtures/auth.fixture';
import {
  apiStepUp,
  createApiContext,
  createBearerApiContext,
  loginViaApi,
  openPageWithTokens,
  signupNewTenant,
} from '../../helpers/api-client';
import { CreatedEntity, apiCompleteOnboarding, apiCreateClient } from '../../helpers/api-entities';
import { createPublicApiContext } from '../../helpers/api-event-flow';
import { readZipEntries } from '../../helpers/binary-files';
import {
  enableChannelMediaStorageDirect,
  enableFeatureFlagDirect,
  messageAttachmentsDirect,
  seedUserWithRoleDirect,
  seedWhatsappChannelDirect,
  softDeleteConversationDirect,
  userIdByEmailDirect,
} from '../../helpers/db-helper';
import { fakeWhatsApp } from '../../helpers/fake-providers';
import { apiErrorCodes, assertOk, readJson } from '../../helpers/response';
import { setupAcceptedEvent } from '../../helpers/setup-flows';
import { uniqueMobilePhone } from '../../helpers/test-data';
import {
  apiConversationIdByPhone,
  digitsOf,
  enableWhatsAppFeaturesDirect,
  receiveInbound,
  uid,
} from '../../helpers/whatsapp-flow';

/**
 * Fluxo: 17.13 — LGPD por titular: buscar, exportar e anonimizar
 * Diagrama: — (cenários E162-E168 do registro e2e de
 * `docs/implementar/PLANO-SEGURANCA.md`, §14 SEG-L, Etapa 241)
 *
 * O titular (família, criança, contato de WhatsApp) não tem login: chega pelo
 * telefone ou pelo e-mail. A tela é Configurações → Privacidade → "Titulares de
 * dados" (`/app/settings/privacy`, permission `privacy.anonymizesubjectdata`);
 * a anonimização exige step-up (`privacy.data_subject.anonymize`).
 */

const PRIVACY_ROUTE = '/app/settings/privacy';
const ANONYMIZE_ACTION = 'privacy.data_subject.anonymize';
const STEP_UP_HEADER = 'X-Step-Up-Token';
const REDACTED_NAME = '[Titular anonimizado]';

/** Storage local do back no E2E (`DocumentStorage:LocalRootPath` do `appsettings.E2E.json`). */
const STORAGE_ROOT = path.resolve(__dirname, '../../../admin-backend/.local-storage/documents');

interface RecordCount {
  key: string;
  label: string;
  count: number;
}

interface Lookup {
  maskedPhone: string | null;
  maskedEmail: string | null;
  totalRecords: number;
  records: RecordCount[];
}

interface Anonymization {
  totalRecords: number;
  records: RecordCount[];
  anonymizedAt: string;
  pendingRecords: RecordCount[];
}

function countOf(records: RecordCount[], key: string): number {
  return records.find((r) => r.key === key)?.count ?? 0;
}

async function apiFindSubject(api: APIRequestContext, query: { phone?: string; email?: string }): Promise<Lookup> {
  const params = new URLSearchParams(query as Record<string, string>);
  const res = await api.get(`/api/privacy/data-subjects?${params.toString()}`);
  await assertOk(res, 'GET /api/privacy/data-subjects');
  return readJson<Lookup>(res);
}

async function apiExportSubject(
  api: APIRequestContext,
  body: { phone?: string; email?: string; includeChildData?: boolean },
): Promise<Map<string, Buffer>> {
  const res = await api.post('/api/privacy/data-subjects/export', { data: body });
  await assertOk(res, 'POST /api/privacy/data-subjects/export');
  return readZipEntries(await res.body());
}

async function apiAnonymizeSubject(api: APIRequestContext, password: string, phone: string) {
  const token = await apiStepUp(api, password, ANONYMIZE_ACTION);
  return api.post('/api/privacy/data-subjects/anonymize', {
    headers: { [STEP_UP_HEADER]: token },
    data: { phone },
  });
}

function jsonEntry<T>(entries: Map<string, Buffer>, name: string): T {
  const entry = entries.get(name);
  expect(entry, `${name} no ZIP`).toBeTruthy();
  return JSON.parse(entry!.toString('utf8')) as T;
}

/** Celular de teste: os 11 dígitos do cadastro e o E.164 do WhatsApp. */
function newPhone(): { local: string; e164: string } {
  const local = uniqueMobilePhone();
  return { local, e164: `+55${local}` };
}

interface Subject {
  phone: { local: string; e164: string };
  secondPhone: { local: string; e164: string };
  email: string;
  client: CreatedEntity;
  identityId: string;
  identityName: string;
  leadId: string;
  conversationId: string;
  eventId: string;
  childName: string;
  restrictions: string;
}

/**
 * O titular completo no tenant: cadastro (telefone e e-mail), contato unificado
 * com o segundo número, lead com nota, conversa pelo SEGUNDO número, festa
 * aceita (o envio do orçamento manda e-mail ao cadastro) e o formulário
 * pós-aceite com aniversariante e restrições.
 */
async function seedSubject(api: APIRequestContext, tenantId: string): Promise<Subject> {
  enableFeatureFlagDirect(tenantId, 'feature_leads');
  enableWhatsAppFeaturesDirect(tenantId);
  const phoneNumberId = seedWhatsappChannelDirect(tenantId);

  const tag = uid();
  const phone = newPhone();
  const secondPhone = newPhone();
  const email = `titular-${tag}@e2e.test`;
  const client = await apiCreateClient(api, { name: `Titular ${tag}`, phone: phone.local, email });

  // Contato unificado: o número do cadastro e um segundo número, ligado ao cliente.
  const identityName = `Contato Titular ${tag}`;
  const identityRes = await api.post('/api/contact-identities', {
    data: {
      displayName: identityName,
      source: 'Manual',
      isKnown: true,
      clientId: client.id,
      tags: null,
      notes: null,
      points: [phone.e164, secondPhone.e164].map((value, i) => ({
        type: 'Whatsapp',
        value,
        isPrimary: i === 0,
        consentStatus: null,
        isVerified: null,
      })),
    },
  });
  await assertOk(identityRes, 'POST /api/contact-identities');
  const identityId = (await readJson<{ id: string }>(identityRes)).id;

  // Lead pelo número do cadastro, com nota interna.
  const leadRes = await api.post('/api/leads', {
    data: {
      name: `Lead Titular ${tag}`,
      whatsAppPhone: phone.local,
      email: null,
      isRecurring: false,
    },
  });
  await assertOk(leadRes, 'POST /api/leads');
  const leadId = (await readJson<{ id: string }>(leadRes)).id;
  const noteRes = await api.post(`/api/leads/${leadId}/notes`, { data: { content: `Ligar para a família ${tag}` } });
  await assertOk(noteRes, 'POST /api/leads/{id}/notes');

  // Conversa pelo SEGUNDO número.
  await receiveInbound(phoneNumberId, secondPhone.e164, `Oi, queria um orçamento ${tag}`);
  const conversationId = await apiConversationIdByPhone(api, secondPhone.e164);

  // Festa aceita (e-mail do orçamento ao cadastro) e o formulário pós-aceite.
  const { eventId } = await setupAcceptedEvent(api, { clientId: client.id });
  const link = await api.post(`/api/events/${eventId}/form-link`);
  await assertOk(link, 'POST /api/events/{id}/form-link');
  const url = (await readJson<{ url: string }>(link)).url;
  const token = url.substring(url.indexOf('/event-form/') + '/event-form/'.length).split(/[?#]/)[0]!;
  const childName = `Aniversariante ${tag}`;
  const restrictions = `Alergia a amendoim ${tag}`;
  const publicApi = await createPublicApiContext();
  try {
    const form = await publicApi.put(`/api/public/events/${token}/form`, {
      data: {
        clientFullName: `Titular ${tag}`,
        clientEmail: email,
        birthdayChildName: childName,
        birthdayChildBirthDate: '2020-05-10',
        restrictions,
        isConfirmed: false,
      },
    });
    await assertOk(form, 'PUT /api/public/events/{token}/form');
  } finally {
    await publicApi.dispose();
  }

  // O e-mail do orçamento é gravado no log de envio; espera ele aparecer.
  await expect
    .poll(async () => countOf((await apiFindSubject(api, { phone: phone.local })).records, 'emailLogs'), {
      message: 'e-mail do orçamento no log do titular',
    })
    .toBeGreaterThan(0);

  return {
    phone,
    secondPhone,
    email,
    client,
    identityId,
    identityName,
    leadId,
    conversationId,
    eventId,
    childName,
    restrictions,
  };
}

/** Abre "Titulares de dados" e busca pelo telefone. */
async function searchByPhone(page: Page, phone: string): Promise<void> {
  await page.goto(PRIVACY_ROUTE);
  await expect(page.getByTestId('data-subjects-card')).toBeVisible();
  await page.getByTestId('data-subjects-phone').fill(phone);
  await page.getByTestId('data-subjects-search').click();
}

async function recordCountShown(page: Page, key: string): Promise<number> {
  const text = await page.getByTestId(`data-subjects-record-${key}`).locator('strong').innerText();
  return parseInt(text.trim(), 10);
}

/** Exporta pela tela e devolve as entradas do ZIP baixado. */
async function exportFromScreen(page: Page): Promise<Map<string, Buffer>> {
  const download = page.waitForEvent('download');
  await page.getByTestId('data-subjects-export').click();
  const file = await download;
  const filePath = await file.path();
  return readZipEntries(readFileSync(filePath));
}

/** Arquivo da key no storage local (`<root>/<bucket>/<key>`), ou null. */
function storedFile(key: string): string | null {
  if (!existsSync(STORAGE_ROOT)) return null;
  for (const bucket of readdirSync(STORAGE_ROOT)) {
    const candidate = path.join(STORAGE_ROOT, bucket, ...key.split('/'));
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

test.describe('Fluxo 17.13 — LGPD por titular (SEG-L)', () => {
  // ─── E162 — Busca por telefone ──────────────────────────────────────────
  test('E162 @crud Owner busca o titular pelo telefone: contato mascarado e contagem por categoria, inclusive o segundo número e o e-mail; telefone sem dado mostra "nenhum dado"', async ({
    authPage,
    authApi,
    tenant,
  }) => {
    test.setTimeout(150_000);
    const subject = await seedSubject(authApi, tenant.tenantId);
    await apiCompleteOnboarding(authApi);

    await searchByPhone(authPage, subject.phone.local);
    await expect(authPage.getByTestId('data-subjects-found')).toBeVisible();
    const label = authPage.getByTestId('data-subjects-subject');
    await expect(label, 'telefone mascarado').toContainText(`****-${subject.phone.local.slice(-4)}`);
    await expect(label, 'e-mail do cadastro mascarado').toContainText(`t***@e2e.test`);
    const shown = await label.innerText();
    expect(shown, 'o telefone não aparece inteiro').not.toContain(subject.phone.local);
    expect(shown, 'o e-mail não aparece inteiro').not.toContain(subject.email);

    for (const key of [
      'clients',
      'eventForms',
      'leads',
      'leads.notes',
      'conversations',
      'conversations.messages',
      'contactIdentities',
      'emailLogs',
    ]) {
      expect(await recordCountShown(authPage, key), `contagem de ${key}`).toBeGreaterThan(0);
    }

    // A conversa é do segundo número e o e-mail é o do cadastro: chegaram pelo contato unificado.
    const lookup = await apiFindSubject(authApi, { phone: subject.phone.local });
    expect(countOf(lookup.records, 'conversations'), 'conversa do segundo número').toBe(1);
    expect(countOf(lookup.records, 'emailLogs'), 'e-mail enviado ao cadastro').toBeGreaterThan(0);
    await expect(authPage.getByTestId('data-subjects-total')).toContainText(String(lookup.totalRecords));

    // Telefone sem dado: "nenhum dado", total zero.
    const nobody = newPhone();
    await authPage.getByTestId('data-subjects-phone').fill(nobody.local);
    await authPage.getByTestId('data-subjects-search').click();
    await expect(authPage.getByTestId('data-subjects-empty')).toContainText('Nenhum dado encontrado');
    expect((await apiFindSubject(authApi, { phone: nobody.local })).totalRecords).toBe(0);
  });

  // ─── E163 — Exportar pela tela ──────────────────────────────────────────
  test('E163 @crud exportar o titular pela tela: ZIP com metadata.json e um arquivo por módulo; dado da criança só com a caixa marcada', async ({
    authPage,
    authApi,
    tenant,
  }) => {
    test.setTimeout(150_000);
    const subject = await seedSubject(authApi, tenant.tenantId);
    await apiCompleteOnboarding(authApi);
    await searchByPhone(authPage, subject.phone.local);
    await expect(authPage.getByTestId('data-subjects-found')).toBeVisible();

    // Sem a caixa: aniversariante e restrições vazios.
    const withoutChild = await exportFromScreen(authPage);
    const names = [...withoutChild.keys()];
    for (const name of [
      'metadata.json',
      'clients.json',
      'eventForms.json',
      'leads.json',
      'conversations.json',
      'contactIdentities.json',
      'emailLogs.json',
    ]) {
      expect(names, `${name} no pacote`).toContain(name);
    }
    const formsWithout = jsonEntry<Array<Record<string, unknown>>>(withoutChild, 'eventForms.json');
    expect(formsWithout.length).toBeGreaterThan(0);
    for (const form of formsWithout) {
      expect(form.birthdayChildName ?? null, 'sem a caixa, sem o aniversariante').toBeNull();
      expect(form.birthdayChildBirthDate ?? null).toBeNull();
      expect(form.restrictions ?? null, 'sem a caixa, sem as restrições').toBeNull();
    }
    expect(withoutChild.get('eventForms.json')!.toString('utf8')).not.toContain(subject.childName);

    // Com a caixa "o responsável pediu os dados da criança": preenchidos.
    await authPage.getByTestId('data-subjects-include-child').getByRole('checkbox').check();
    const withChild = await exportFromScreen(authPage);
    const formsWith = jsonEntry<Array<Record<string, unknown>>>(withChild, 'eventForms.json');
    const filled = formsWith.find((f) => f.birthdayChildName === subject.childName);
    expect(filled, 'com a caixa, o aniversariante vem').toBeTruthy();
    expect(filled!.restrictions, 'com a caixa, as restrições vêm').toBe(subject.restrictions);
    expect(filled!.birthdayChildBirthDate).toBe('2020-05-10');
  });

  // ─── E164 — Cross-tenant ────────────────────────────────────────────────
  test('E164 @flow o mesmo telefone na empresa B não entra na busca nem no ZIP da A, e anonimizar em A deixa B intacta', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(120_000);
    const phone = newPhone();
    const clientA = await apiCreateClient(authApi, { name: `Titular A ${uid()}`, phone: phone.local });

    const tenantB = await signupNewTenant();
    const apiB = await createBearerApiContext(tenantB.accessToken);
    try {
      enableWhatsAppFeaturesDirect(tenantB.tenantId);
      const phoneNumberIdB = seedWhatsappChannelDirect(tenantB.tenantId);
      const clientBName = `Titular B ${uid()}`;
      const clientB = await apiCreateClient(apiB, { name: clientBName, phone: phone.local });
      await receiveInbound(phoneNumberIdB, phone.e164, 'Mensagem só da empresa B');
      const conversationB = await apiConversationIdByPhone(apiB, phone.e164);

      // Busca em A: só o cadastro de A.
      const lookup = await apiFindSubject(authApi, { phone: phone.local });
      expect(countOf(lookup.records, 'clients'), 'só o cadastro de A').toBe(1);
      expect(countOf(lookup.records, 'conversations'), 'a conversa de B não conta em A').toBe(0);
      expect(countOf(lookup.records, 'conversations.messages')).toBe(0);

      // ZIP de A: nada de B.
      const zip = await apiExportSubject(authApi, { phone: phone.local });
      expect([...zip.keys()], 'sem conversa de B no pacote de A').not.toContain('conversations.json');
      const clientsJson = zip.get('clients.json')!.toString('utf8');
      expect(clientsJson).toContain(clientA.id);
      expect(clientsJson, 'o cadastro de B não está no ZIP de A').not.toContain(clientB.id);
      expect(clientsJson).not.toContain(clientBName);
      for (const [, content] of zip) expect(content.toString('utf8')).not.toContain(tenantB.tenantId);

      // Anonimizar em A: B intacta.
      const anonymized = await apiAnonymizeSubject(authApi, tenant.password, phone.local);
      await assertOk(anonymized, 'POST /api/privacy/data-subjects/anonymize');
      const clientBAfter = await apiB.get(`/api/clients/${clientB.id}`);
      await assertOk(clientBAfter, 'GET /api/clients/{id} em B');
      expect((await readJson<{ name: string }>(clientBAfter)).name, 'cadastro de B intacto').toBe(clientBName);
      const conversationBAfter = await apiB.get(`/api/conversations/${conversationB}`);
      await assertOk(conversationBAfter, 'GET /api/conversations/{id} em B');
      const conv = await readJson<{ contactPhone: string; contactName: string | null; status: string }>(
        conversationBAfter,
      );
      expect(digitsOf(conv.contactPhone), 'conversa de B intacta').toBe(digitsOf(phone.e164));
      expect(conv.contactName).not.toBe(REDACTED_NAME);
      expect(conv.status).not.toBe('Archived');
      expect(countOf((await apiFindSubject(apiB, { phone: phone.local })).records, 'conversations')).toBe(1);
    } finally {
      await apiB.dispose();
    }
  });

  // ─── E165 — Anonimizar pela tela ────────────────────────────────────────
  test('E165 @crud anonimizar pela tela: confirmação, step-up (cancelar não anonimiza), total anonimizado; telas de cada um, busca vazia e auditoria sem o dado', async ({
    authPage,
    authApi,
    tenant,
  }) => {
    test.setTimeout(180_000);
    const subject = await seedSubject(authApi, tenant.tenantId);
    await apiCompleteOnboarding(authApi);
    const before = await apiFindSubject(authApi, { phone: subject.phone.local });

    await searchByPhone(authPage, subject.phone.local);
    await expect(authPage.getByTestId('data-subjects-found')).toBeVisible();

    // Confirmar o aviso de irreversível abre o pedido de senha; cancelar a senha não anonimiza.
    await authPage.getByTestId('data-subjects-anonymize').click();
    await expect(authPage.getByTestId('confirm-message')).toContainText('irreversível');
    await authPage.getByTestId('confirm-ok').click();
    await expect(authPage.getByTestId('step-up-password'), 'o pedido de senha abre').toBeVisible();
    await authPage.getByTestId('step-up-cancel').click();
    await expect(authPage.getByTestId('data-subjects-found'), 'a tela segue com o titular').toBeVisible();
    expect(
      (await apiFindSubject(authApi, { phone: subject.phone.local })).totalRecords,
      'cancelar a senha não anonimizou nada',
    ).toBe(before.totalRecords);

    // Com a senha: a tela mostra o total anonimizado.
    await authPage.getByTestId('data-subjects-anonymize').click();
    await authPage.getByTestId('confirm-ok').click();
    await authPage.getByTestId('step-up-password').fill(tenant.password);
    await authPage.getByTestId('step-up-submit').click();
    await expect(authPage.getByTestId('data-subjects-anonymized')).toBeVisible();
    const total = parseInt((await authPage.getByTestId('data-subjects-anonymized-total').innerText()).trim(), 10);
    expect(total, 'total anonimizado').toBeGreaterThan(0);

    // A busca do mesmo telefone volta vazia.
    await authPage.getByTestId('data-subjects-phone').fill(subject.phone.local);
    await authPage.getByTestId('data-subjects-search').click();
    await expect(authPage.getByTestId('data-subjects-empty')).toBeVisible();

    // Cliente.
    await authPage.goto(`/app/clients/${subject.client.id}`);
    await expect(authPage.getByTestId('client-form-name'), 'cliente anonimizado').toHaveValue(REDACTED_NAME);

    // Lead.
    await authPage.goto(`/app/leads/${subject.leadId}`);
    await expect(authPage.getByTestId('lead-form-name'), 'lead anonimizado').toHaveValue(REDACTED_NAME);

    // Conversa: arquivada, como "[Titular anonimizado]".
    await authPage.goto(`/app/conversations/${subject.conversationId}`);
    await expect(authPage.getByTestId('conversation-contact-name'), 'conversa anonimizada').toContainText(REDACTED_NAME);
    await expect(authPage.getByTestId('conversation-status-chip'), 'conversa arquivada').toContainText('Arquivada');

    // Formulário pós-aceite.
    await authPage.goto(`/app/events/${subject.eventId}`);
    await authPage.getByRole('tab', { name: 'Dados do cliente', exact: true }).click();
    await expect(authPage.getByTestId('field-clientFullName'), 'formulário anonimizado').toHaveValue(REDACTED_NAME);
    await expect(authPage.getByTestId('field-birthdayChildName')).toHaveValue('');

    // Contato unificado: nem o nome nem o número do titular aparecem mais.
    await authPage.goto('/app/contacts');
    await authPage.getByTestId('contacts-search').fill(subject.identityName);
    await expect(authPage.getByTestId('contacts-empty'), 'contato sem o nome do titular').toBeVisible();
    await authPage.getByTestId('contacts-search').fill(subject.secondPhone.local);
    await expect(authPage.getByTestId('contacts-empty'), 'contato sem o número do titular').toBeVisible();

    // Auditoria: o ato está lá, sem o telefone nem o e-mail.
    await authPage.goto('/app/settings/audit');
    await authPage.getByTestId('audit-filter-action').fill('privacy.data_subject');
    const row = authPage.locator('[data-testid^="audit-row-"]').filter({ hasText: 'privacy.data_subject.anonymized' });
    await expect(row.first(), 'o ato na auditoria').toBeVisible();
    await row.first().click();
    await expect(authPage.getByTestId('audit-detail-action')).toContainText('privacy.data_subject.anonymized');
    const detail = await authPage.locator('mat-dialog-container').innerText();
    for (const leak of [
      subject.phone.local,
      digitsOf(subject.phone.e164),
      subject.secondPhone.local,
      subject.email,
    ]) {
      expect(detail, `a auditoria não mostra ${leak}`).not.toContain(leak);
    }
  });

  // ─── E166 — Permissão ───────────────────────────────────────────────────
  test('E166 @crud Manager não vê "Titulares de dados" e toma 403 nos três endpoints', async ({
    authApi,
    browser,
    tenant,
  }) => {
    await apiCompleteOnboarding(authApi);
    const manager = seedUserWithRoleDirect({ tenantId: tenant.tenantId, role: 'Manager', emailPrefix: 'mgr-lgpd' });
    const anon = await createApiContext();
    const tokens = await loginViaApi(anon, manager.email, manager.password);
    await anon.dispose();

    const page = await openPageWithTokens(browser, tokens);
    try {
      await page.goto(PRIVACY_ROUTE);
      await expect(page.getByTestId('privacy-export-user-card'), 'a tela de privacidade carrega').toBeVisible();
      await expect(page.getByTestId('data-subjects-card'), 'sem "Titulares de dados" para o Manager').toHaveCount(0);
    } finally {
      await page.context().close();
    }

    const managerApi = await createBearerApiContext(tokens.accessToken);
    try {
      const phone = newPhone().local;
      const find = await managerApi.get(`/api/privacy/data-subjects?phone=${phone}`);
      const exportRes = await managerApi.post('/api/privacy/data-subjects/export', { data: { phone } });
      const anonymize = await managerApi.post('/api/privacy/data-subjects/anonymize', { data: { phone } });
      for (const [label, res] of [
        ['busca', find],
        ['exportação', exportRes],
        ['anonimização', anonymize],
      ] as const) {
        expect(res.status(), `${label} pelo Manager`).toBe(403);
        expect(await apiErrorCodes(res)).toContain('Auth.PermissionDenied');
      }
    } finally {
      await managerApi.dispose();
    }
  });

  test('E166 @flow Admin pedindo os dados do Owner: 403 Privacy.OwnerDataRestricted; o Owner exporta os próprios', async ({
    authApi,
    tenant,
  }) => {
    const admin = seedUserWithRoleDirect({ tenantId: tenant.tenantId, role: 'Admin', emailPrefix: 'adm-lgpd' });
    expect(userIdByEmailDirect(admin.email)).toBeTruthy();
    const anon = await createApiContext();
    const { accessToken } = await loginViaApi(anon, admin.email, admin.password);
    await anon.dispose();
    const adminApi = await createBearerApiContext(accessToken);
    try {
      const res = await adminApi.post('/api/privacy/export-user-data', { data: { targetUserId: tenant.userId } });
      expect(res.status(), 'Admin exportando os dados do Owner').toBe(403);
      expect(await apiErrorCodes(res)).toContain('Privacy.OwnerDataRestricted');
    } finally {
      await adminApi.dispose();
    }

    const own = await authApi.post('/api/privacy/export-user-data', { data: {} });
    await assertOk(own, 'POST /api/privacy/export-user-data (Owner, os próprios)');
  });

  // ─── E167 — Titular já excluído pelo gestor ─────────────────────────────
  test('E167 @flow cliente, lead e conversa excluídos aparecem na busca e são anonimizados juntos; anonimizar de novo dá 404', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(120_000);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_leads');
    enableWhatsAppFeaturesDirect(tenant.tenantId);
    const phoneNumberId = seedWhatsappChannelDirect(tenant.tenantId);
    const phone = newPhone();
    const tag = uid();

    const client = await apiCreateClient(authApi, { name: `Excluído ${tag}`, phone: phone.local });
    const leadRes = await authApi.post('/api/leads', {
      data: { name: `Lead excluído ${tag}`, whatsAppPhone: phone.local, email: null, isRecurring: false },
    });
    await assertOk(leadRes, 'POST /api/leads');
    const leadId = (await readJson<{ id: string }>(leadRes)).id;
    await receiveInbound(phoneNumberId, phone.e164, `Oi ${tag}`);
    const conversationId = await apiConversationIdByPhone(authApi, phone.e164);

    // O gestor exclui os três (a conversa não tem exclusão pela tela: exclusão lógica).
    await assertOk(await authApi.delete(`/api/clients/${client.id}`), 'DELETE /api/clients/{id}');
    await assertOk(await authApi.delete(`/api/leads/${leadId}`), 'DELETE /api/leads/{id}');
    softDeleteConversationDirect(conversationId);

    const lookup = await apiFindSubject(authApi, { phone: phone.local });
    expect(countOf(lookup.records, 'clients'), 'cliente excluído na busca').toBe(1);
    expect(countOf(lookup.records, 'leads'), 'lead excluído na busca').toBe(1);
    expect(countOf(lookup.records, 'conversations'), 'conversa excluída na busca').toBe(1);

    const first = await apiAnonymizeSubject(authApi, tenant.password, phone.local);
    await assertOk(first, 'POST /api/privacy/data-subjects/anonymize');
    const result = await readJson<Anonymization>(first);
    expect(countOf(result.records, 'clients'), 'cliente excluído anonimizado').toBe(1);
    expect(countOf(result.records, 'leads'), 'lead excluído anonimizado').toBe(1);
    expect(countOf(result.records, 'conversations'), 'conversa excluída anonimizada').toBe(1);

    const again = await apiAnonymizeSubject(authApi, tenant.password, phone.local);
    expect(again.status(), 'anonimizar de novo o mesmo telefone').toBe(404);
    expect(await apiErrorCodes(again)).toContain('Privacy.SubjectNotFound');
    expect(await again.text()).toContain('nenhum dado deste titular');
  });

  // ─── E168 — Anexo arquivado ─────────────────────────────────────────────
  test('E168 @flow conversa com anexo arquivado: o ZIP lista o anexo sem os bytes; anonimizar apaga o arquivo do storage e o anexo fica sem nome e legenda', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(180_000);
    enableWhatsAppFeaturesDirect(tenant.tenantId);
    const phoneNumberId = seedWhatsappChannelDirect(tenant.tenantId);
    enableChannelMediaStorageDirect(phoneNumberId);
    const phone = newPhone();
    const tag = uid();

    // Mídia no fake da Meta e o webhook do documento recebido.
    const mediaId = `e2emedia_${tag}`;
    const pdf = Buffer.from(`%PDF-1.4\n% comprovante ${tag}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`, 'latin1');
    await fakeWhatsApp.seedInboundMedia({ id: mediaId, mimeType: 'application/pdf', bytes: pdf });
    const fileName = `comprovante-${tag}.pdf`;
    const caption = `Segue o comprovante ${tag}`;
    const digits = digitsOf(phone.e164);
    const hook = await fakeWhatsApp.triggerRawWebhook({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'fake_waba_id',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '5541999000000', phone_number_id: phoneNumberId },
                contacts: [{ profile: { name: `Titular ${tag}` }, wa_id: digits }],
                messages: [
                  {
                    from: digits,
                    id: `wamid.e2e_${tag}`,
                    timestamp: Math.floor(Date.now() / 1000).toString(),
                    type: 'document',
                    document: { id: mediaId, mime_type: 'application/pdf', filename: fileName, caption },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(hook.backStatus, `webhook do documento: ${hook.backBody}`).toBe(200);
    const conversationId = await apiConversationIdByPhone(authApi, phone.e164);

    // O worker baixa e arquiva (ciclo de 30 s).
    let key = '';
    await expect
      .poll(
        () => {
          const attachment = messageAttachmentsDirect(conversationId)[0];
          key = attachment?.mediaUrl ?? '';
          return key.length > 0 && !key.startsWith('meta-media://');
        },
        { message: 'anexo arquivado no storage', timeout: 90_000, intervals: [2_000] },
      )
      .toBe(true);
    const file = storedFile(key);
    expect(file, `arquivo ${key} no storage do E2E`).not.toBeNull();
    expect(readFileSync(file!).equals(pdf), 'o storage guarda o binário baixado').toBe(true);

    // O ZIP lista o anexo, sem os bytes.
    const zip = await apiExportSubject(authApi, { phone: phone.local });
    const conversations = jsonEntry<
      Array<{ messages: Array<{ attachments: Array<{ fileName: string | null; caption: string | null; mimeType: string | null }> }> }>
    >(zip, 'conversations.json');
    const listed = conversations.flatMap((c) => c.messages).flatMap((m) => m.attachments);
    expect(listed.find((a) => a.fileName === fileName), 'o anexo listado no pacote').toBeTruthy();
    expect([...zip.keys()].every((name) => name.endsWith('.json')), 'só JSON no pacote').toBe(true);
    for (const [name, content] of zip) {
      expect(content.includes(Buffer.from('%PDF-1.4')), `${name} sem os bytes do anexo`).toBe(false);
    }

    // Anonimizar: arquivo apagado, anexo sem nome e sem legenda.
    const res = await apiAnonymizeSubject(authApi, tenant.password, phone.local);
    await assertOk(res, 'POST /api/privacy/data-subjects/anonymize');
    const result = await readJson<Anonymization>(res);
    expect(countOf(result.records, 'conversations.attachments'), 'anexo anonimizado').toBe(1);
    expect(result.pendingRecords, 'nada pendente no storage').toHaveLength(0);
    expect(existsSync(file!), 'arquivo apagado do storage').toBe(false);
    const after = messageAttachmentsDirect(conversationId)[0]!;
    expect(after.fileName, 'anexo sem nome').toBeNull();
    expect(after.caption, 'anexo sem legenda').toBeNull();
    expect(after.mediaUrl).not.toBe(key);
  });
});
