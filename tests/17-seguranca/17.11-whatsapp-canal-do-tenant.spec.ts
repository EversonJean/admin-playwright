import { APIRequestContext } from '@playwright/test';

import { authTest as test, expect } from '../../fixtures/auth.fixture';
import {
  addSessionToContext,
  createApiContext,
  createBearerApiContext,
  signupNewTenant,
} from '../../helpers/api-client';
import {
  apiCompleteOnboarding,
  apiCreateActivity,
  apiCreateClient,
  apiCreateContactIdentity,
  apiSetAiFeature,
} from '../../helpers/api-entities';
import { apiCreateBudget } from '../../helpers/api-event-flow';
import {
  enableFeatureFlagDirect,
  seedApprovedWhatsAppTemplateDirect,
  seedBirthdayCampaignDirect,
  seedConnectedWhatsappTenantDirect,
  setWhatsAppTemplateMetaIdDirect,
  whatsAppTemplateIdByNameDirect,
} from '../../helpers/db-helper';
import { InboxEntry, fakeWhatsApp } from '../../helpers/fake-providers';
import { apiErrorCodes, assertOk, readJson } from '../../helpers/response';
import { loginSuperAdminViaApi } from '../../helpers/super-admin-session';
import { uniqueMobilePhone } from '../../helpers/test-data';
import { snack } from '../../helpers/ui';
import {
  PLATFORM_WHATSAPP_TOKEN,
  apiConversationIdByPhone,
  apiDailyQuota,
  apiSendTemplate,
  authorizationOf,
  digitsOf,
  enableWhatsAppFeaturesDirect,
  fakeCallsMentioning,
  fakeMessagesTo,
  openSendTemplateDialog,
  receiveInbound,
  uid,
  uniquePhoneE164,
} from '../../helpers/whatsapp-flow';

/**
 * Fluxo: 17.11 — WhatsApp pelo canal do tenant e modelos por WABA
 * Diagrama: — (cenários E140 a E145, E147 e E151 do registro e2e de
 * `docs/implementados/PLANO-SEGURANCA.md`; o E146 está em
 * `tests/5-orcamento/5.7-orcamento-por-whatsapp.spec.ts`)
 *
 * Fonte do comportamento: PLANO-SEGURANCA §5b (SEG-C2, Etapa 242): item 1 (o
 * envio resolve o canal pelo tenant da mensagem e usa o número e o token dele,
 * nunca os de `WhatsApp:*`; sem canal ativo, 409
 * `WhatsAppOutbound.ChannelNotConfigured`) e item 2 (modelo vale por WABA: ao
 * conectar, os aprovados do catálogo são submetidos à WABA do tenant; sem
 * vínculo aprovado, 409 `WhatsAppOutbound.TemplateNotInWaba`; o vínculo de uma
 * empresa não serve a outra), mais o painel de modelos da tela de conexão (Front
 * da 242), o status pelo webhook `message_template_status_update`, o modelo com
 * documento no cabeçalho e a campanha de aniversário pelo canal da empresa. O
 * spec afirma o plano; divergência é falha de código, não de asserção.
 */

const SUPER_ADMIN_URL = process.env.SUPER_ADMIN_URL ?? 'http://localhost:4201';
const MESSAGE_NOT_CONNECTED = 'Conecte o WhatsApp da empresa para enviar mensagens.';
const MESSAGE_NOT_IN_WABA = 'Este modelo ainda não foi aprovado no WhatsApp da empresa.';

/** Modelo aprovado no catálogo da plataforma (`seedApprovedWhatsAppTemplateDirect`). */
function seedTemplate(
  prefix: string,
  opts: { category?: 'Utility' | 'Marketing'; body?: string; variables?: string[] } = {},
): { id: string; name: string } {
  const name = `${prefix}_${uid()}`;
  const id = seedApprovedWhatsAppTemplateDirect({
    name,
    body: opts.body ?? `Mensagem ${name}.`,
    category: opts.category,
    variables: opts.variables,
  });
  return { id, name };
}

/** Webhook `message_template_status_update` da WABA, assinado pelo fake. */
async function templateStatusWebhook(
  wabaId: string,
  metaTemplateId: string,
  event: 'APPROVED' | 'REJECTED' | 'PAUSED',
  reason = 'NONE',
): Promise<void> {
  const hook = await fakeWhatsApp.triggerRawWebhook({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: wabaId,
        time: Math.floor(Date.now() / 1000),
        changes: [
          {
            field: 'message_template_status_update',
            value: {
              event,
              message_template_id: metaTemplateId,
              message_template_name: 'e2e',
              message_template_language: 'pt_BR',
              reason,
            },
          },
        ],
      },
    ],
  });
  expect(hook.backStatus, `webhook de status ${event}: ${hook.backBody}`).toBe(200);
}

/** Envia o modelo ao contato cadastrado e espera o fake receber no número do canal. */
async function sendAndExpectDelivered(
  api: APIRequestContext,
  input: { templateId: string; phoneE164: string; phoneNumberId: string; accessToken: string },
): Promise<InboxEntry> {
  const since = new Date().toISOString();
  const res = await apiSendTemplate(api, { templateId: input.templateId, phoneE164: input.phoneE164 });
  await assertOk(res, 'POST /api/whatsapp/outbound/send');
  let sent: InboxEntry | undefined;
  await expect
    .poll(async () => {
      sent = (await fakeMessagesTo(input.phoneE164, since)).find(
        (e) => e.path === `/${input.phoneNumberId}/messages`,
      );
      return sent ? authorizationOf(sent) : null;
    }, { message: 'o fake recebe o envio pelo número da empresa' })
    .toBe(`Bearer ${input.accessToken}`);
  return sent!;
}

test.describe('Fluxo 17.11 — WhatsApp pelo canal do tenant e modelos por WABA', () => {
  test('E140 @flow modelo enviado pelo diálogo sai pelo número e pelo token da empresa, nunca pelo da plataforma', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    enableWhatsAppFeaturesDirect(tenant.tenantId);
    const template = seedTemplate('canal');
    const channel = seedConnectedWhatsappTenantDirect(tenant.tenantId, [template.id]);
    const phone = uniquePhoneE164();
    await receiveInbound(channel.phoneNumberId, phone, 'Oi, quero saber de festa');
    const conversationId = await apiConversationIdByPhone(authApi, phone);

    await apiCompleteOnboarding(authApi);
    const since = new Date().toISOString();
    await openSendTemplateDialog(authPage, conversationId, template.name);
    await authPage.getByTestId('send-whatsapp-send').click();
    await expect(snack(authPage, 'Mensagem enviada à fila de envio.')).toBeVisible();

    let sent: InboxEntry | undefined;
    await expect
      .poll(async () => {
        sent = (await fakeMessagesTo(phone, since)).find((e) => e.path === `/${channel.phoneNumberId}/messages`);
        return sent ? sent.response.status : null;
      }, { message: 'o fake recebe POST /{número da empresa}/messages' })
      .toBe(200);
    expect(authorizationOf(sent!), 'Bearer do canal da empresa').toBe(`Bearer ${channel.accessToken}`);
    const body = sent!.body as { type?: string; template?: { name?: string } };
    expect(body.type).toBe('template');
    expect(body.template?.name, 'o modelo aprovado na WABA da empresa').toBe(template.name);

    const calls = await fakeCallsMentioning(phone, since);
    expect(
      calls.filter((e) => authorizationOf(e) === `Bearer ${PLATFORM_WHATSAPP_TOKEN}` || e.response.status === 401),
      'o token da plataforma nunca aparece (o fake o recusaria com 401)',
    ).toHaveLength(0);
    expect(calls.every((e) => e.path.startsWith(`/${channel.phoneNumberId}/`)), 'só o número da empresa').toBe(true);
  });

  test('E141 @flow empresa sem WhatsApp conectado: modelo, resposta e orçamento dão 409 com o aviso na tela e nada chega ao fake', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(120_000);
    enableWhatsAppFeaturesDirect(tenant.tenantId);
    const template = seedTemplate('sem_canal');
    const channel = seedConnectedWhatsappTenantDirect(tenant.tenantId, [template.id]);

    // A família escreveu (janela aberta) e a empresa desconectou o WhatsApp depois.
    const phone = uniquePhoneE164();
    await receiveInbound(channel.phoneNumberId, phone, 'Oi, vocês fazem festa no sábado?');
    const conversationId = await apiConversationIdByPhone(authApi, phone);
    const disconnect = await authApi.post('/api/conversations/whatsapp/disconnect');
    await assertOk(disconnect, 'POST /api/conversations/whatsapp/disconnect');

    const client = await apiCreateClient(authApi, { phone: digitsOf(phone).slice(2) });
    const activity = await apiCreateActivity(authApi);
    const budget = await apiCreateBudget(authApi, { clientId: client.id, activityIds: [activity.id] });

    await apiCompleteOnboarding(authApi);
    const since = new Date().toISOString();

    // Envio manual de modelo.
    await openSendTemplateDialog(authPage, conversationId, template.name);
    const manual = authPage.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/whatsapp/outbound/send',
    );
    await authPage.getByTestId('send-whatsapp-send').click();
    const manualRes = await manual;
    expect(manualRes.status(), 'envio manual sem canal').toBe(409);
    expect(await apiErrorCodes(manualRes)).toContain('WhatsAppOutbound.ChannelNotConfigured');
    await expect(authPage.getByTestId('send-whatsapp-error')).toContainText(MESSAGE_NOT_CONNECTED);
    await authPage.getByTestId('send-whatsapp-cancel').click();

    // Resposta na conversa (janela aberta).
    await authPage.getByTestId('composer-text').fill('Fazemos sim! Posso mandar o orçamento?');
    const reply = authPage.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/conversations/${conversationId}/reply`,
    );
    await authPage.getByTestId('composer-send').click();
    const replyRes = await reply;
    expect(replyRes.status(), 'resposta sem canal').toBe(409);
    expect(await apiErrorCodes(replyRes)).toContain('WhatsAppOutbound.ChannelNotConfigured');
    await expect(snack(authPage, MESSAGE_NOT_CONNECTED)).toBeVisible();

    // "Enviar por WhatsApp" do orçamento.
    await authPage.goto(`/app/budgets/${budget.id}`);
    const budgetSend = authPage.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === `/api/budgets/${budget.id}/send-whatsapp`,
    );
    await authPage.getByTestId('budget-form-send-whatsapp').click();
    const budgetRes = await budgetSend;
    expect(budgetRes.status(), 'orçamento por WhatsApp sem canal').toBe(409);
    expect(await apiErrorCodes(budgetRes)).toContain('WhatsAppOutbound.ChannelNotConfigured');
    await expect(snack(authPage, MESSAGE_NOT_CONNECTED)).toBeVisible();

    expect(await fakeCallsMentioning(phone, since), 'nada chega ao fake').toHaveLength(0);
  });

  test('E142 @flow modelo aprovado no catálogo sem aprovação na WABA da empresa: 409 e nada sai; o vínculo da empresa B não libera a empresa A', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    enableWhatsAppFeaturesDirect(tenant.tenantId);
    const template = seedTemplate('sem_vinculo');
    // A: canal conectado, sem o vínculo do modelo.
    const channelA = seedConnectedWhatsappTenantDirect(tenant.tenantId, [], { businessAccountId: `waba_a_${uid()}` });
    const phoneA = uniquePhoneE164();
    await receiveInbound(channelA.phoneNumberId, phoneA, 'Oi!');
    const conversationId = await apiConversationIdByPhone(authApi, phoneA);

    // B: o mesmo modelo, aprovado na WABA de B.
    const other = await signupNewTenant();
    const otherApi = await createBearerApiContext(other.accessToken);
    try {
      enableWhatsAppFeaturesDirect(other.tenantId);
      const channelB = seedConnectedWhatsappTenantDirect(other.tenantId, [template.id], {
        businessAccountId: `waba_b_${uid()}`,
      });

      const since = new Date().toISOString();
      const res = await apiSendTemplate(authApi, { templateId: template.id, conversationId });
      expect(res.status(), 'A sem vínculo na própria WABA').toBe(409);
      expect(await apiErrorCodes(res)).toContain('WhatsAppOutbound.TemplateNotInWaba');

      await apiCompleteOnboarding(authApi);
      await openSendTemplateDialog(authPage, conversationId, template.name);
      await authPage.getByTestId('send-whatsapp-send').click();
      await expect(authPage.getByTestId('send-whatsapp-error')).toContainText(MESSAGE_NOT_IN_WABA);

      expect(await fakeCallsMentioning(phoneA, since), 'nada sai de A').toHaveLength(0);

      // O vínculo de B é de verdade: B envia o mesmo modelo.
      const phoneB = uniquePhoneE164();
      await apiCreateContactIdentity(otherApi, { whatsappPhones: [phoneB] });
      await sendAndExpectDelivered(otherApi, {
        templateId: template.id,
        phoneE164: phoneB,
        phoneNumberId: channelB.phoneNumberId,
        accessToken: channelB.accessToken,
      });
    } finally {
      await otherApi.dispose();
    }
  });

  test('E143 @flow conectar o WhatsApp submete os modelos aprovados à WABA da empresa; o painel mostra o status e "Atualizar" relê', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(120_000);
    enableWhatsAppFeaturesDirect(tenant.tenantId);
    const template = seedTemplate('conexao');
    const wabaId = `waba_conn_${uid()}`;
    const phoneNumberId = `pnid_conn_${uid()}`;
    const code = `code_${uid()}`;
    await fakeWhatsApp.seedWabaPhoneNumbers(wabaId, [phoneNumberId]);

    const since = new Date().toISOString();
    const connect = await authApi.post('/api/conversations/whatsapp/connect', {
      data: { code, phoneNumberId, wabaId },
    });
    await assertOk(connect, 'POST /api/conversations/whatsapp/connect');

    // O fake recebe a submissão do modelo na WABA da empresa, com o token trocado.
    const tenantToken = `fake_token_code_${code}`;
    let submission: InboxEntry | undefined;
    await expect
      .poll(async () => {
        const inbox = await fakeWhatsApp.inbox({ since, path: `/${wabaId}/message_templates` });
        submission = inbox.find(
          (e) => e.method === 'POST' && (e.body as { name?: string } | null)?.name === template.name,
        );
        return submission ? submission.response.status : null;
      }, { message: `POST /${wabaId}/message_templates com ${template.name}`, timeout: 60_000 })
      .toBe(200);
    expect(authorizationOf(submission!)).toBe(`Bearer ${tenantToken}`);
    const metaTemplateId = (submission!.response.body as { id: string }).id;

    // Painel de modelos da tela de conexão.
    await apiCompleteOnboarding(authApi);
    await authPage.goto('/app/conversations/connection');
    await expect(authPage.getByTestId('whatsapp-connection-connected')).toBeVisible();
    const status = authPage.getByTestId(`whatsapp-template-waba-status-${template.id}`);
    await expect(status).toHaveText('Aprovado');

    // A Meta pausa o modelo; "Atualizar" relê o status.
    await templateStatusWebhook(wabaId, metaTemplateId, 'PAUSED');
    await authPage.getByTestId('whatsapp-templates-status-refresh').click();
    await expect(status).toHaveText('Pausado');
  });

  test('E144 @flow status da Meta na WABA: Recusado com motivo bloqueia o envio, Aprovado libera; o evento de outra WABA não muda nada', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(120_000);
    enableWhatsAppFeaturesDirect(tenant.tenantId);
    const template = seedTemplate('status_waba');
    const channelA = seedConnectedWhatsappTenantDirect(tenant.tenantId, [template.id], {
      businessAccountId: `waba_a_${uid()}`,
    });
    const metaIdA = channelA.metaTemplateIds[template.id]!;
    const phoneA = uniquePhoneE164();
    await apiCreateContactIdentity(authApi, { whatsappPhones: [phoneA] });

    const other = await signupNewTenant();
    const otherApi = await createBearerApiContext(other.accessToken);
    try {
      enableWhatsAppFeaturesDirect(other.tenantId);
      const channelB = seedConnectedWhatsappTenantDirect(other.tenantId, [template.id], {
        businessAccountId: `waba_b_${uid()}`,
      });
      const metaIdB = channelB.metaTemplateIds[template.id]!;
      const phoneB = uniquePhoneE164();
      await apiCreateContactIdentity(otherApi, { whatsappPhones: [phoneB] });

      // Recusado na WABA de A, com motivo.
      await templateStatusWebhook(channelA.businessAccountId, metaIdA, 'REJECTED', 'INVALID_FORMAT');

      await apiCompleteOnboarding(authApi);
      await authPage.goto('/app/conversations/connection');
      await expect(authPage.getByTestId(`whatsapp-template-waba-status-${template.id}`)).toHaveText('Recusado');
      await expect(authPage.getByTestId(`whatsapp-template-waba-reason-${template.id}`)).toContainText(
        'INVALID_FORMAT',
      );

      const since = new Date().toISOString();
      const refused = await apiSendTemplate(authApi, { templateId: template.id, phoneE164: phoneA });
      expect(refused.status(), 'modelo recusado na WABA da empresa').toBe(409);
      expect(await apiErrorCodes(refused)).toContain('WhatsAppOutbound.TemplateNotInWaba');
      expect(await fakeMessagesTo(phoneA, since), 'nada sai com o modelo recusado').toHaveLength(0);

      // B, com o mesmo modelo na própria WABA, segue enviando.
      await sendAndExpectDelivered(otherApi, {
        templateId: template.id,
        phoneE164: phoneB,
        phoneNumberId: channelB.phoneNumberId,
        accessToken: channelB.accessToken,
      });

      // Aprovado em seguida: A volta a enviar.
      await templateStatusWebhook(channelA.businessAccountId, metaIdA, 'APPROVED');
      await sendAndExpectDelivered(authApi, {
        templateId: template.id,
        phoneE164: phoneA,
        phoneNumberId: channelA.phoneNumberId,
        accessToken: channelA.accessToken,
      });

      // O mesmo evento para a WABA de B não muda o vínculo de A.
      await templateStatusWebhook(channelB.businessAccountId, metaIdB, 'REJECTED', 'INVALID_FORMAT');
      await authPage.getByTestId('whatsapp-templates-status-refresh').click();
      await expect(authPage.getByTestId(`whatsapp-template-waba-status-${template.id}`)).toHaveText('Aprovado');
      await sendAndExpectDelivered(authApi, {
        templateId: template.id,
        phoneE164: phoneA,
        phoneNumberId: channelA.phoneNumberId,
        accessToken: channelA.accessToken,
      });
    } finally {
      await otherApi.dispose();
    }
  });

  test('E145 @flow modelo com documento no cabeçalho não aparece no diálogo; o POST direto dá 409 sem gastar a cota', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    enableWhatsAppFeaturesDirect(tenant.tenantId);
    const budgetTemplateId = whatsAppTemplateIdByNameDirect('orcamento_pronto');
    const template = seedTemplate('sem_documento');
    const channel = seedConnectedWhatsappTenantDirect(tenant.tenantId, [template.id, budgetTemplateId]);
    const phone = uniquePhoneE164();
    await receiveInbound(channel.phoneNumberId, phone, 'Oi!');
    const conversationId = await apiConversationIdByPhone(authApi, phone);

    const listRes = await authApi.get('/api/whatsapp/templates');
    await assertOk(listRes, 'GET /api/whatsapp/templates');
    const available = await readJson<Array<{ id: string; name: string }>>(listRes);
    expect(available.some((t) => t.id === template.id)).toBe(true);
    expect(available.some((t) => t.id === budgetTemplateId), 'o modelo com documento fica fora da lista').toBe(false);

    await apiCompleteOnboarding(authApi);
    await openSendTemplateDialog(authPage, conversationId);
    await authPage.getByTestId('send-whatsapp-template').click();
    await expect(authPage.getByRole('option', { name: new RegExp(`^\\s*${template.name}\\b`) })).toBeVisible();
    await expect(authPage.getByRole('option', { name: /orcamento_pronto/ })).toHaveCount(0);
    await authPage.keyboard.press('Escape');

    const before = await apiDailyQuota(authApi);
    const since = new Date().toISOString();
    const res = await apiSendTemplate(authApi, { templateId: budgetTemplateId, conversationId });
    expect(res.status(), 'POST direto do modelo com documento').toBe(409);
    expect(await apiErrorCodes(res)).toContain('WhatsAppTemplate.RequiresDocument');
    const after = await apiDailyQuota(authApi);
    expect(after.used, 'a recusa não gasta a cota do dia').toBe(before.used);
    expect(await fakeCallsMentioning(phone, since), 'nada sai').toHaveLength(0);
  });

  test('E147 @flow Super Admin cadastra modelo com documento no cabeçalho; a aprovação o submete à WABA de cada empresa conectada', async ({
    tenant,
    browser,
  }) => {
    test.setTimeout(150_000);
    enableWhatsAppFeaturesDirect(tenant.tenantId);
    const channelA = seedConnectedWhatsappTenantDirect(tenant.tenantId, [], { businessAccountId: `waba_a_${uid()}` });
    const other = await signupNewTenant();
    enableWhatsAppFeaturesDirect(other.tenantId);
    const channelB = seedConnectedWhatsappTenantDirect(other.tenantId, [], { businessAccountId: `waba_b_${uid()}` });

    const anon = await createApiContext();
    const tokens = await loginSuperAdminViaApi(anon).finally(() => anon.dispose());
    const superAdminApi = await createBearerApiContext(tokens.accessToken);
    try {
      const name = `doc_cabecalho_${uid()}`;
      const created = await superAdminApi.post('/api/super-admin/whatsapp-templates', {
        data: {
          name,
          language: 'pt_BR',
          category: 'Utility',
          body: 'Olá {{1}}, segue o documento anexo.',
          variables: [{ key: 'nome', description: 'Nome do cliente', example: 'Ana' }],
          headerFormat: 'Document',
        },
      });
      await assertOk(created, 'POST /api/super-admin/whatsapp-templates');
      const templateId = (await readJson<{ id: string }>(created)).id;

      // A Meta atribuiu o id na conta da plataforma; a sincronização o aprova.
      setWhatsAppTemplateMetaIdDirect(templateId, `meta_tmpl_${templateId}`);
      const since = new Date().toISOString();
      const synced = await superAdminApi.post(`/api/super-admin/whatsapp-templates/${templateId}/sync-approval`);
      await assertOk(synced, 'POST sync-approval');
      expect((await readJson<{ status: string }>(synced)).status).toBe('Approved');

      // Cada empresa conectada recebe a submissão na própria WABA, com o exemplo
      // do cabeçalho subido pela Resumable Upload API com o token dela.
      for (const channel of [channelA, channelB]) {
        let submission: InboxEntry | undefined;
        await expect
          .poll(async () => {
            const inbox = await fakeWhatsApp.inbox({ since, path: `/${channel.businessAccountId}/message_templates` });
            submission = inbox.find((e) => e.method === 'POST' && (e.body as { name?: string } | null)?.name === name);
            return submission ? submission.response.status : null;
          }, { message: `submissão de ${name} à WABA ${channel.businessAccountId}`, timeout: 60_000 })
          .toBe(200);
        expect(authorizationOf(submission!)).toBe(`Bearer ${channel.accessToken}`);
        const header = (
          submission!.body as { components?: Array<{ type?: string; format?: string; example?: { header_handle?: string[] } }> }
        ).components?.find((c) => c.type === 'HEADER');
        expect(header?.format, 'cabeçalho de documento').toBe('DOCUMENT');
        expect(header?.example?.header_handle?.[0], 'handle do exemplo subido').toBeTruthy();

        const uploads = (await fakeWhatsApp.inbox({ since, path: '/uploads' })).filter(
          (e) => e.method === 'POST' && authorizationOf(e) === `Bearer ${channel.accessToken}`,
        );
        expect(uploads.length, `sessão de upload do exemplo com o token de ${channel.businessAccountId}`).toBeGreaterThan(0);
      }

      // A lista do painel mostra o rótulo do cabeçalho.
      const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' });
      try {
        await addSessionToContext(context, tokens.refreshToken);
        const page = await context.newPage();
        await page.goto(`${SUPER_ADMIN_URL}/super-admin/whatsapp-templates`);
        await page.getByTestId('whatsapp-templates-search').fill(name);
        await expect(page.getByTestId(`whatsapp-template-header-format-${templateId}`)).toHaveText(
          'Cabeçalho: documento (PDF)',
        );
      } finally {
        await context.close();
      }
    } finally {
      await superAdminApi.dispose();
    }
  });

  test('E151 @flow campanha de aniversário aprovada sai pelo número e pelo token da empresa, com o modelo de Divulgação aprovado na WABA dela', async ({
    authApi,
    tenant,
  }) => {
    enableWhatsAppFeaturesDirect(tenant.tenantId);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_ai');
    const template = seedTemplate('festa_de_novo', {
      category: 'Marketing',
      body: 'Oi! {{1}} vai fazer {{2}} anos. {{3}}',
      variables: ['nome', 'idade', 'mensagem'],
    });
    const channel = seedConnectedWhatsappTenantDirect(tenant.tenantId, [template.id]);
    await apiSetAiFeature(
      authApi,
      'ai_birthday_campaigns',
      true,
      JSON.stringify({ templateId: template.id, messageVariableKey: 'mensagem', leadDays: 75 }),
    );

    const phone = `+55${uniqueMobilePhone()}`;
    const client = await apiCreateClient(authApi, { phone: digitsOf(phone).slice(2) });
    const campaignId = seedBirthdayCampaignDirect({
      tenantId: tenant.tenantId,
      clientId: client.id,
      honoreeFirstName: 'Lia',
      messageText: 'Que tal repetir a festa do ano passado?',
    });

    const since = new Date().toISOString();
    const approved = await authApi.post(`/api/ai/birthday-campaigns/${campaignId}/approve`, {
      data: { messageText: null },
    });
    await assertOk(approved, 'POST /api/ai/birthday-campaigns/{id}/approve');
    expect((await readJson<{ status: string }>(approved)).status).toBe('Sent');

    let sent: InboxEntry | undefined;
    await expect
      .poll(async () => {
        sent = (await fakeMessagesTo(phone, since)).find((e) => e.path === `/${channel.phoneNumberId}/messages`);
        return sent ? authorizationOf(sent) : null;
      }, { message: 'a campanha sai pelo número da empresa' })
      .toBe(`Bearer ${channel.accessToken}`);
    expect((sent!.body as { template?: { name?: string } }).template?.name).toBe(template.name);
  });
});
