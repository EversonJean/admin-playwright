import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { createBearerApiContext, signupNewTenant } from '../../helpers/api-client';
import {
  apiCompleteOnboarding,
  apiCreateCollaborator,
  apiCreateContactIdentity,
  apiSetCollaboratorStatus,
} from '../../helpers/api-entities';
import {
  seedApprovedWhatsAppTemplateDirect,
  seedConnectedWhatsappTenantDirect,
  seedOutboundDispatchesDirect,
  seedWhatsappChannelDirect,
} from '../../helpers/db-helper';
import { fakeEmail, fakeWhatsApp } from '../../helpers/fake-providers';
import { apiErrorCodes, assertOk, readJson, unwrapList } from '../../helpers/response';
import { openSessionPage, setupPortalUser } from '../../helpers/setup-flows';
import { uniqueMobilePhone } from '../../helpers/test-data';
import {
  apiConversationIdByPhone,
  apiDailyQuota,
  apiErrors,
  apiListConversations,
  apiSendTemplate,
  digitsOf,
  enableWhatsAppFeaturesDirect,
  fakeMessagesTo,
  fakeTextsTo,
  openSendTemplateDialog,
  receiveInbound,
  toE164Br,
  uid,
  uniquePhoneE164,
} from '../../helpers/whatsapp-flow';

/**
 * Fluxo: 17.10 — WhatsApp: posse do número, cota diária e vínculo
 * Diagrama: — (cenários E129 a E135 do registro e2e de
 * `docs/implementar/PLANO-SEGURANCA.md`)
 *
 * Fonte do comportamento: PLANO-SEGURANCA §5 (SEG-C, Etapa 239) e a decisão D8:
 * item 3 (cota diária persistida por tenant, 100 em teste e 1.000 no pago, 409
 * `WhatsAppOutbound.DailyQuotaExceeded`; envio manual só para contato da empresa
 * e nunca para quem pediu opt-out), item 5 (telefone único entre colaboradores
 * ativos; trocar o telefone invalida a verificação do WhatsApp), 7a (o webhook
 * roteia por `change`, cada mensagem no tenant do próprio número), 7b (vínculo
 * do gestor vira evento de segurança e e-mail com o telefone mascarado), 7c (5
 * `vincular` errados do mesmo número bloqueiam por 1 h) e 7e (código novo do
 * colaborador aposenta o anterior), e o item 8 do Front (cota no diálogo de
 * envio). O spec afirma o plano; divergência é falha de código, não de asserção.
 */

/** Modelo de utilidade aprovado no catálogo, sem variável. */
function seedTemplate(prefix: string): { id: string; name: string } {
  const name = `${prefix}_${uid()}`;
  return { id: seedApprovedWhatsAppTemplateDirect({ name, body: `Mensagem ${name}.` }), name };
}

test.describe('Fluxo 17.10 — WhatsApp: posse do número, cota e vínculo', () => {
  test('E129 @flow cota diária esgotada: o diálogo mostra a volta e desliga o Enviar; o 101º dá 409; envios de outra empresa não contam', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(120_000);
    enableWhatsAppFeaturesDirect(tenant.tenantId);
    const template = seedTemplate('cota');
    const channel = seedConnectedWhatsappTenantDirect(tenant.tenantId, [template.id]);

    const phone = uniquePhoneE164();
    await receiveInbound(channel.phoneNumberId, phone, 'Oi, quero orçar uma festa');
    const conversationId = await apiConversationIdByPhone(authApi, phone);

    // D8: empresa em teste tem 100 envios de modelo por dia.
    const before = await apiDailyQuota(authApi);
    expect(before.isTrial, 'empresa recém-criada está em teste').toBe(true);
    expect(before.limit, 'teto do período de teste (D8)').toBe(100);
    expect(before.used).toBe(0);

    seedOutboundDispatchesDirect({
      tenantId: tenant.tenantId,
      conversationId,
      templateId: template.id,
      toPhone: phone,
      count: before.limit,
    });
    const full = await apiDailyQuota(authApi);
    expect(full.used).toBe(100);
    expect(full.remaining).toBe(0);

    // Front 8: o diálogo diz que a cota acabou, quando volta, e desliga o Enviar.
    await apiCompleteOnboarding(authApi);
    await openSendTemplateDialog(authPage, conversationId, template.name);
    const exhausted = authPage.getByTestId('send-whatsapp-quota-exhausted');
    await expect(exhausted).toContainText('Cota diária de 100 envios atingida');
    await expect(exhausted, 'horário em que os envios voltam (meia-noite da empresa)').toContainText(
      /Novos envios a partir de .*00:00/,
    );
    await expect(authPage.getByTestId('send-whatsapp-send')).toBeDisabled();

    // O 101º direto na API.
    const since = new Date().toISOString();
    const over = await apiSendTemplate(authApi, { templateId: template.id, conversationId });
    expect(over.status(), 'envio acima da cota').toBe(409);
    expect(await apiErrorCodes(over)).toContain('WhatsAppOutbound.DailyQuotaExceeded');
    expect(await fakeMessagesTo(phone, since), 'nada sai acima da cota').toHaveLength(0);

    // Os 100 envios desta empresa não contam para outra.
    const other = await signupNewTenant();
    const otherApi = await createBearerApiContext(other.accessToken);
    try {
      enableWhatsAppFeaturesDirect(other.tenantId);
      const otherChannel = seedConnectedWhatsappTenantDirect(other.tenantId, [template.id]);
      const otherQuota = await apiDailyQuota(otherApi);
      expect(otherQuota.used, 'a cota é por empresa').toBe(0);
      expect(otherQuota.remaining).toBe(otherQuota.limit);

      const otherPhone = uniquePhoneE164();
      await apiCreateContactIdentity(otherApi, { whatsappPhones: [otherPhone] });
      const otherSince = new Date().toISOString();
      const sent = await apiSendTemplate(otherApi, { templateId: template.id, phoneE164: otherPhone });
      await assertOk(sent, 'envio da outra empresa');
      await expect
        .poll(async () =>
          (await fakeMessagesTo(otherPhone, otherSince)).filter((e) => e.path === `/${otherChannel.phoneNumberId}/messages`)
            .length,
        )
        .toBe(1);
    } finally {
      await otherApi.dispose();
    }
  });

  test('E130 @flow envio manual por telefone: só contato da empresa, nunca quem pediu opt-out (com ou sem conversa)', async ({
    authApi,
    tenant,
  }) => {
    enableWhatsAppFeaturesDirect(tenant.tenantId);
    const template = seedTemplate('contato');
    const channel = seedConnectedWhatsappTenantDirect(tenant.tenantId, [template.id]);
    const since = new Date().toISOString();

    // Número sem conversa e fora dos contatos.
    const stranger = uniquePhoneE164();
    const strangerRes = await apiSendTemplate(authApi, { templateId: template.id, phoneE164: stranger });
    expect(strangerRes.status(), 'número desconhecido').toBe(400);
    const strangerErrors = await apiErrors(strangerRes);
    expect(strangerErrors.map((e) => e.code)).toContain('WhatsAppOutbound.UnknownContact');
    expect(strangerErrors.map((e) => e.description).join(' ')).toContain(
      'só é possível enviar para um contato da empresa',
    );

    // Contato cadastrado: envia.
    const known = uniquePhoneE164();
    await apiCreateContactIdentity(authApi, { whatsappPhones: [known] });
    const knownRes = await apiSendTemplate(authApi, { templateId: template.id, phoneE164: known });
    await assertOk(knownRes, 'envio ao contato cadastrado');
    await expect
      .poll(async () =>
        (await fakeMessagesTo(known, since)).filter((e) => e.path === `/${channel.phoneNumberId}/messages`).length,
      )
      .toBe(1);

    // Contato com opt-out, sem conversa.
    const optedOut = uniquePhoneE164();
    await apiCreateContactIdentity(authApi, { whatsappPhones: [optedOut], consentStatus: 'OptOut' });
    const optedOutRes = await apiSendTemplate(authApi, { templateId: template.id, phoneE164: optedOut });
    expect(optedOutRes.status(), 'opt-out sem conversa').toBe(400);
    const optedOutErrors = await apiErrors(optedOutRes);
    expect(optedOutErrors.map((e) => e.code)).toContain('WhatsAppOutbound.ContactOptedOut');
    expect(optedOutErrors.map((e) => e.description).join(' ')).toContain('pediu para não receber mensagens');

    // Contato com opt-out que já tem conversa: ter conversa não desfaz o opt-out.
    const optedOutWithConversation = uniquePhoneE164();
    await apiCreateContactIdentity(authApi, {
      whatsappPhones: [optedOutWithConversation],
      consentStatus: 'OptOut',
    });
    await receiveInbound(channel.phoneNumberId, optedOutWithConversation, 'Oi, tudo bem?');
    const conversationId = await apiConversationIdByPhone(authApi, optedOutWithConversation);
    for (const body of [
      { templateId: template.id, conversationId },
      { templateId: template.id, phoneE164: optedOutWithConversation },
    ]) {
      const res = await apiSendTemplate(authApi, body);
      expect(res.status(), `opt-out com conversa (${body.conversationId ? 'pela conversa' : 'pelo telefone'})`).toBe(400);
      const errors = await apiErrors(res);
      expect(errors.map((e) => e.code)).toContain('WhatsAppOutbound.ContactOptedOut');
      expect(errors.map((e) => e.description).join(' ')).toContain('pediu para não receber mensagens');
    }

    for (const phone of [stranger, optedOut, optedOutWithConversation]) {
      expect(await fakeMessagesTo(phone, since), `nada chega ao fake para ${phone}`).toHaveLength(0);
    }
  });

  test('E131 @flow um POST assinado com entry de números de duas empresas: cada mensagem só na caixa da empresa do próprio número', async ({
    authApi,
    tenant,
  }) => {
    enableWhatsAppFeaturesDirect(tenant.tenantId);
    const channelA = seedWhatsappChannelDirect(tenant.tenantId);
    const other = await signupNewTenant();
    const otherApi = await createBearerApiContext(other.accessToken);
    try {
      enableWhatsAppFeaturesDirect(other.tenantId);
      const channelB = seedWhatsappChannelDirect(other.tenantId);

      const phoneA = uniquePhoneE164();
      const phoneB = uniquePhoneE164();
      const textA = `Mensagem para a empresa A ${uid()}`;
      const textB = `Mensagem para a empresa B ${uid()}`;
      const entry = (wabaId: string, phoneNumberId: string, phone: string, text: string) => ({
        id: wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '5541999000000', phone_number_id: phoneNumberId },
              contacts: [{ wa_id: digitsOf(phone), profile: { name: `Contato ${digitsOf(phone).slice(-4)}` } }],
              messages: [
                {
                  from: digitsOf(phone),
                  id: `wamid.e2e_${uid()}`,
                  timestamp: Math.floor(Date.now() / 1000).toString(),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      });

      const hook = await fakeWhatsApp.triggerRawWebhook({
        object: 'whatsapp_business_account',
        entry: [entry(`waba_a_${uid()}`, channelA, phoneA, textA), entry(`waba_b_${uid()}`, channelB, phoneB, textB)],
      });
      expect(hook.backStatus, `webhook com dois entry: ${hook.backBody}`).toBe(200);

      await apiConversationIdByPhone(authApi, phoneA);
      await apiConversationIdByPhone(otherApi, phoneB);

      const inA = await apiListConversations(authApi);
      const inB = await apiListConversations(otherApi);
      const hasPhone = (rows: Array<{ contactPhone: string }>, phone: string) =>
        rows.some((c) => digitsOf(c.contactPhone) === digitsOf(phone));
      expect(hasPhone(inA, phoneA), 'A recebe a mensagem do próprio número').toBe(true);
      expect(hasPhone(inA, phoneB), 'A não recebe a mensagem do número de B').toBe(false);
      expect(hasPhone(inB, phoneB), 'B recebe a mensagem do próprio número').toBe(true);
      expect(hasPhone(inB, phoneA), 'B não recebe a mensagem do número de A').toBe(false);
      expect(inA.find((c) => digitsOf(c.contactPhone) === digitsOf(phoneA))?.lastMessagePreview ?? '').toContain(
        textA,
      );
      expect(inB.find((c) => digitsOf(c.contactPhone) === digitsOf(phoneB))?.lastMessagePreview ?? '').toContain(
        textB,
      );
    } finally {
      await otherApi.dispose();
    }
  });

  test('E132 @flow gestor vincula o WhatsApp pelo "vincular CODIGO": evento de segurança e e-mail com o telefone mascarado e o link da tela de vínculo', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    enableWhatsAppFeaturesDirect(tenant.tenantId);
    const phoneNumberId = seedWhatsappChannelDirect(tenant.tenantId);

    const issued = await authApi.post('/api/me/whatsapp-link');
    await assertOk(issued, 'POST /api/me/whatsapp-link');
    const { code } = await readJson<{ code: string }>(issued);

    const phone = uniquePhoneE164();
    const digits = digitsOf(phone);
    const masked = `+55 (${digits.slice(2, 4)}) ****-${digits.slice(-4)}`;
    await receiveInbound(phoneNumberId, phone, `vincular ${code}`);

    await expect
      .poll(async () => {
        const res = await authApi.get('/api/me/whatsapp-link');
        await assertOk(res, 'GET /api/me/whatsapp-link');
        return (await readJson<{ isLinked: boolean }>(res)).isLinked;
      }, { message: 'o número fica vinculado ao gestor' })
      .toBe(true);

    // Evento de segurança do próprio gestor.
    await expect
      .poll(async () => {
        const res = await authApi.get('/api/auth/security-events?page=1&pageSize=50');
        await assertOk(res, 'GET /api/auth/security-events');
        return (await unwrapList<{ type: string }>(res)).some((e) => String(e.type) === 'WhatsappLinked');
      })
      .toBe(true);

    await apiCompleteOnboarding(authApi);
    await authPage.goto('/app/settings/security');
    await expect(authPage.getByTestId('events-list')).toContainText('WhatsApp vinculado à conta');

    // E-mail ao dono da conta: telefone mascarado e link de revogação.
    let body = '';
    await expect
      .poll(async () => {
        const emails = await fakeEmail.emails({ to: tenant.email });
        body = emails.map((e) => `${e.subject}\n${e.bodyHtml}\n${e.bodyText ?? ''}`).find((b) => b.includes(masked)) ?? '';
        return body.length > 0;
      }, { message: `e-mail com ${masked}` })
      .toBe(true);
    expect(body).toContain('/app/settings/whatsapp-link');
    expect(body, 'o número inteiro não vai no e-mail').not.toContain(digits.slice(2));
  });

  test('E133 @flow 5 "vincular" errados do mesmo número: o 6º, mesmo certo, não vincula e vira evento de segurança; de outro número vincula', async ({
    authApi,
    tenant,
  }) => {
    enableWhatsAppFeaturesDirect(tenant.tenantId);
    const phoneNumberId = seedWhatsappChannelDirect(tenant.tenantId);

    const issued = await authApi.post('/api/me/whatsapp-link');
    await assertOk(issued, 'POST /api/me/whatsapp-link');
    const { code } = await readJson<{ code: string }>(issued);

    const attacker = uniquePhoneE164();
    for (let i = 0; i < 5; i++) {
      await receiveInbound(phoneNumberId, attacker, `vincular ZZ${i}Q${uid().slice(-3).toUpperCase()}`);
    }
    // O 6º, com o código certo, vindo do número bloqueado.
    await receiveInbound(phoneNumberId, attacker, `vincular ${code}`);

    await expect
      .poll(async () => {
        const res = await authApi.get('/api/auth/security-events/tenant?page=1&pageSize=50');
        await assertOk(res, 'GET /api/auth/security-events/tenant');
        return (await unwrapList<{ type: string }>(res)).some((e) => String(e.type) === 'WhatsappLinkAttemptsBlocked');
      }, { message: 'bloqueio por tentativas erradas nos eventos de segurança' })
      .toBe(true);

    const afterBlocked = await authApi.get('/api/me/whatsapp-link');
    await assertOk(afterBlocked, 'GET /api/me/whatsapp-link');
    const pending = await readJson<{ isLinked: boolean; pendingCode: string | null }>(afterBlocked);
    expect(pending.isLinked, 'o número bloqueado não vincula').toBe(false);
    expect(pending.pendingCode, 'o código segue pendente').toBe(code);

    // O mesmo código, de outro número, vincula (o código não foi gasto pelo bloqueado).
    const owner = uniquePhoneE164();
    await receiveInbound(phoneNumberId, owner, `vincular ${code}`);
    await expect
      .poll(async () => {
        const res = await authApi.get('/api/me/whatsapp-link');
        await assertOk(res, 'GET /api/me/whatsapp-link');
        const s = await readJson<{ isLinked: boolean; maskedPhone: string | null }>(res);
        return s.isLinked ? (s.maskedPhone ?? '') : '';
      }, { message: 'vinculado pelo outro número' })
      .toContain(digitsOf(owner).slice(-4));
  });

  test('E134 @flow telefone repetido entre colaboradores ativos: 409 com o campo marcado no cadastro e no portal; o de colaborador inativo fica livre', async ({
    authApi,
    authPage,
    tenant,
    browser,
  }) => {
    test.setTimeout(120_000);
    await apiCompleteOnboarding(authApi);
    const takenPhone = uniqueMobilePhone();
    const holder = await apiCreateCollaborator(authApi, { phone: takenPhone });

    // Cadastro pelo gestor.
    await authPage.goto('/app/collaborators/new');
    await authPage.getByTestId('collaborator-form-name').fill(`Recreador Repetido ${uid()}`);
    await authPage.getByTestId('collaborator-form-role').fill('Recreador');
    await authPage.getByTestId('collaborator-form-phone').fill(takenPhone);
    const created = authPage.waitForResponse(
      (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/collaborators',
    );
    await authPage.getByTestId('collaborator-form-save').click();
    const createRes = await created;
    expect(createRes.status(), 'segundo colaborador ativo com o mesmo telefone').toBe(409);
    expect(await apiErrorCodes(createRes)).toContain('Collaborator.PhoneInUse');
    await expect(authPage.getByTestId('collaborator-form-phone-in-use')).toBeVisible();
    await expect(authPage).toHaveURL(/\/app\/collaborators\/new/);

    // Portal: o colaborador troca o telefone para o de um colega.
    const portal = await setupPortalUser(authApi, tenant.tenantId);
    const session = await openSessionPage(browser, portal.tokens);
    try {
      await session.page.goto('/portal/profile');
      const phoneInput = session.page.getByTestId('portal-profile-phone');
      await expect(phoneInput).toBeVisible();
      await phoneInput.fill(takenPhone);
      const saved = session.page.waitForResponse(
        (r) => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/portal/profile',
      );
      await session.page.getByTestId('portal-profile-save').click();
      const saveRes = await saved;
      expect(saveRes.status(), 'telefone de um colega no portal').toBe(409);
      expect(await apiErrorCodes(saveRes)).toContain('Portal.PhoneInUse');
      await expect(session.page.getByTestId('portal-profile-phone-in-use')).toBeVisible();
    } finally {
      await session.context.close();
      await portal.portalApi.dispose();
    }

    // Colaborador inativo não segura o telefone.
    await apiSetCollaboratorStatus(authApi, holder.id, 'Inactive');
    const reuse = await apiCreateCollaborator(authApi, { phone: takenPhone });
    expect(reuse.id, 'o telefone do inativo fica livre').toBeTruthy();
  });

  test('E135 @flow portal: trocar o telefone pede código novo no WhatsApp; com dois códigos emitidos o primeiro é inválido', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(120_000);
    enableWhatsAppFeaturesDirect(tenant.tenantId);
    const phoneNumberId = seedWhatsappChannelDirect(tenant.tenantId);
    const config = await authApi.put('/api/collaborator-assistant/whatsapp-config', {
      data: {
        enabled: true,
        requirePhoneVerification: true,
        whatsappCommissionsEnabled: true,
        whatsappLeaderPhoneEnabled: true,
      },
    });
    await assertOk(config, 'PUT /api/collaborator-assistant/whatsapp-config');

    const portal = await setupPortalUser(authApi, tenant.tenantId);
    try {
      const profileRes = await portal.portalApi.get('/api/portal/profile');
      await assertOk(profileRes, 'GET /api/portal/profile');
      const profile = await readJson<{ phone: string; address: Record<string, unknown> | null }>(profileRes);
      const firstPhone = toE164Br(profile.phone);

      const issueCode = async (): Promise<string> => {
        const res = await portal.portalApi.post('/api/portal/whatsapp-link-code');
        await assertOk(res, 'POST /api/portal/whatsapp-link-code');
        return (await readJson<{ code: string }>(res)).code;
      };
      /** Manda `text` do telefone e devolve a resposta do assistente que o fake recebeu. */
      const say = async (phone: string, text: string): Promise<string> => {
        const since = new Date().toISOString();
        await receiveInbound(phoneNumberId, phone, text);
        let reply = '';
        await expect
          .poll(async () => {
            reply = (await fakeTextsTo(phone, since)).join('\n');
            return reply.length > 0;
          }, { message: `resposta do assistente a "${text}"` })
          .toBe(true);
        return reply;
      };

      // Vínculo pelo telefone atual.
      const firstCode = await issueCode();
      expect(await say(firstPhone, `vincular ${firstCode}`)).toContain('Seu WhatsApp está vinculado');
      expect(await say(firstPhone, 'oi'), 'vinculado, o assistente atende').not.toContain('vincule seu WhatsApp');

      // Troca de telefone no portal: a próxima mensagem pede código novo.
      const newPhone = `+55${uniqueMobilePhone()}`;
      const update = await portal.portalApi.put('/api/portal/profile', {
        data: { phone: digitsOf(newPhone).slice(2), address: profile.address },
      });
      await assertOk(update, 'PUT /api/portal/profile');
      expect(await say(newPhone, 'oi'), 'telefone novo exige código novo').toContain(
        'Antes de começar, vincule seu WhatsApp',
      );

      // Dois códigos emitidos: o primeiro deixa de valer.
      const older = await issueCode();
      const newer = await issueCode();
      expect(older).not.toBe(newer);
      expect(await say(newPhone, `vincular ${older}`), 'o código anterior foi aposentado').toContain('Código inválido');
      expect(await say(newPhone, `vincular ${newer}`)).toContain('Seu WhatsApp está vinculado');
    } finally {
      await portal.portalApi.dispose();
    }
  });
});
