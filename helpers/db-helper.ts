import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';

import { encryptForBackend, rowAssociatedData } from './backend-cipher';

/**
 * Helper de DB via `psql.exe` local. Usado para operações que não têm endpoint
 * público — principalmente marcar email como confirmado pra bypass do fluxo
 * de verificação por email durante testes.
 *
 * Não é elegante, mas é simples e funciona contra o Postgres local sem
 * precisar mockar provider de email no back.
 */

const PSQL_PATH = process.env.PSQL_PATH ?? 'C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe';
const PG_HOST = process.env.PG_HOST ?? 'localhost';
const PG_PORT = process.env.PG_PORT ?? '5432';
const PG_USER = process.env.PG_USER ?? 'postgres';
const PG_PASSWORD = process.env.PG_PASSWORD ?? 'postgres';
const PG_DATABASE = process.env.PG_DATABASE ?? 'adminbackend';

export function execSql(sql: string): string {
  return execFileSync(
    PSQL_PATH,
    ['-U', PG_USER, '-h', PG_HOST, '-p', PG_PORT, '-d', PG_DATABASE, '-t', '-A', '-c', sql],
    {
      env: { ...process.env, PGPASSWORD: PG_PASSWORD },
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}

/**
 * Marca o usuário como ativo direto no banco — usado após signup nos testes
 * E2E pra pular a etapa de verificação por email. O signup cria User com
 * Status='PendingEmailVerification'; aqui força pra 'Active', que é o estado
 * pós-confirmação esperado pelos endpoints autenticados.
 */
export function confirmEmailDirect(email: string): void {
  const safeEmail = email.replace(/'/g, "''");
  execSql(
    `UPDATE "Users" SET "Status" = 'Active' WHERE LOWER("Email") = LOWER('${safeEmail}');`,
  );
}

/**
 * Força status do orçamento direto no banco — usado pra simular cenários que
 * não têm endpoint público (ex: cliente comunica recusa por fora, gestor
 * historicamente marcou como Refused; ou orçamento expirou). Necessário pro
 * fluxo de versionamento (restart-as-draft só aceita Refused/Expired como
 * origem da transição).
 *
 * `status` aceita string do enum BudgetStatus (Draft/Sent/Accepted/Refused/
 * Expired/Canceled) — o EF persiste enum por nome (ProviderValueComparer).
 */
export function setBudgetStatusDirect(budgetId: string, status: string): void {
  const safeId = budgetId.replace(/'/g, "''");
  const safeStatus = status.replace(/'/g, "''");
  execSql(`UPDATE "Budgets" SET "Status" = '${safeStatus}' WHERE "Id" = '${safeId}';`);
}

/**
 * Crédito do cliente vencido sem esperar o calendário: o back recusa emitir
 * crédito com validade no passado (`FinancialAdjustment.CreditExpiresInPast`),
 * então o vencimento de pré-condição é gravado direto. O status fica como
 * está (`Available`): é a data que decide, como no back até o `expire-due` rodar.
 */
export function setCreditExpiresAtDirect(creditBalanceId: string, isoDate: string): void {
  const safeId = creditBalanceId.replace(/'/g, "''");
  const safeDate = isoDate.replace(/'/g, "''");
  execSql(`UPDATE "CreditBalances" SET "ExpiresAt" = '${safeDate}' WHERE "Id" = '${safeId}';`);
}

/**
 * Habilita um entitlement (feature flag bool) para um tenant via INSERT direto
 * em AddonActivations. Usado pra testar telas com `entitlementGuard` no front
 * (feature_leads, feature_equipment_rental, feature_stock, feature_ai,
 * feature_whatsapp, feature_conversations) sem precisar passar pelo fluxo
 * completo de assinatura de plano.
 *
 * AddonCode usa "e2e_test" pra deixar rastreável que veio dos testes.
 */
export function enableFeatureFlagDirect(tenantId: string, entitlementKey: string): void {
  const safeTenant = tenantId.replace(/'/g, "''");
  const safeKey = entitlementKey.replace(/'/g, "''").toLowerCase();
  execSql(`
    INSERT INTO "AddonActivations"
      ("Id", "TenantId", "AddonCode", "EntitlementKey", "Type", "ValueBool",
       "IsActive", "ActivatedAt", "CreatedAt", "UpdatedAt", "IsDeleted")
    VALUES
      (gen_random_uuid(), '${safeTenant}', 'e2e_test', '${safeKey}', 'Bool', true,
       true, now(), now(), now(), false);
  `);
}

/**
 * Cria um WhatsAppTemplate Approved direto no banco — necessario pros
 * specs de outbound (11.2) ja que templates sao cross-tenant gerenciados
 * por SuperAdmin, e o fixture `tenant` so cria admin de tenant. Devolve
 * o Id pra spec usar no POST /api/whatsapp/outbound/send.
 *
 * MetaTemplateId fica `meta_tmpl_<id>` — o fake WhatsApp tambem auto-cria
 * com Approved no GET, entao o sync nao quebra.
 */
export function seedApprovedWhatsAppTemplateDirect(input: {
  name: string;
  body: string;
  category?: 'Utility' | 'Authentication' | 'Marketing';
  language?: string;
  /**
   * Chaves das variáveis, na ordem dos placeholders `{{1}}`, `{{2}}`… do
   * corpo (`WhatsAppTemplateVariables`). Omitida = template sem variável.
   */
  variables?: string[];
}): string {
  const id = execSql(`SELECT gen_random_uuid()::text;`);
  const safeName = input.name.replace(/'/g, "''");
  const safeBody = input.body.replace(/'/g, "''");
  const safeCat = (input.category ?? 'Utility').replace(/'/g, "''");
  const safeLang = (input.language ?? 'pt_BR').replace(/'/g, "''");
  const variableRows = (input.variables ?? []).map((key, i) => {
    const safeKey = key.replace(/'/g, "''");
    return `(gen_random_uuid(), '${id}', ${i + 1}, '${safeKey}', '${safeKey}', '${safeKey} E2E', now(), now(), false)`;
  });
  execSql(`
    INSERT INTO "WhatsAppTemplates"
      ("Id", "Name", "Language", "Category", "Status", "Body",
       "MetaTemplateId", "CreatedAt", "UpdatedAt", "IsDeleted")
    VALUES
      ('${id}', '${safeName}', '${safeLang}', '${safeCat}', 'Approved',
       '${safeBody}', 'meta_tmpl_${id}', now(), now(), false);
    ${
      variableRows.length > 0
        ? `INSERT INTO "WhatsAppTemplateVariables"
             ("Id", "WhatsAppTemplateId", "Placeholder", "Key", "Description", "Example",
              "CreatedAt", "UpdatedAt", "IsDeleted")
           VALUES ${variableRows.join(', ')};`
        : ''
    }
  `);
  return id;
}

/** Id do template do catálogo pelo nome (`orcamento_pronto` é semeado pelo back em E2E). */
export function whatsAppTemplateIdByNameDirect(name: string): string {
  const safeName = name.replace(/'/g, "''");
  const id = execSql(
    `SELECT "Id"::text FROM "WhatsAppTemplates" WHERE "Name" = '${safeName}' AND "IsDeleted" = false ORDER BY "CreatedAt" LIMIT 1;`,
  );
  if (!id) throw new Error(`template ${name} não está no catálogo — o back E2E semeia o orcamento_pronto no boot`);
  return id;
}

/**
 * A Meta atribuiu o id ao template da conta da plataforma: sem `MetaTemplateId`
 * o `sync-approval` devolve `Pending` sem consultar (o fake aprova quem ele
 * conhece). Pré-condição de quem testa a aprovação do catálogo (Etapa 242).
 */
export function setWhatsAppTemplateMetaIdDirect(templateId: string, metaTemplateId: string): void {
  const safeId = templateId.replace(/'/g, "''");
  const safeMeta = metaTemplateId.replace(/'/g, "''");
  execSql(`UPDATE "WhatsAppTemplates" SET "MetaTemplateId" = '${safeMeta}' WHERE "Id" = '${safeId}';`);
}

/**
 * `count` envios de template (`OutboundDispatch` manual, `Sent`) criados agora
 * no tenant, para encher a cota diária sem passar pelo rate limit de 30/min do
 * envio (Etapa 239: a cota conta os dispatches não `Failed` desde a
 * meia-noite do tenant). A conversa e o template são do próprio teste.
 */
export function seedOutboundDispatchesDirect(input: {
  tenantId: string;
  conversationId: string;
  templateId: string;
  toPhone: string;
  count: number;
}): void {
  const safeTenant = input.tenantId.replace(/'/g, "''");
  const safeConversation = input.conversationId.replace(/'/g, "''");
  const safeTemplate = input.templateId.replace(/'/g, "''");
  const safePhone = input.toPhone.replace(/'/g, "''");
  execSql(`
    INSERT INTO "OutboundDispatches"
      ("Id", "TenantId", "ConversationId", "WhatsAppTemplateId", "TemplateNameSnapshot",
       "ToPhone", "Source", "Status", "RenderedBody", "SentAt", "Attempts", "MaxAttempts",
       "CreatedAt", "UpdatedAt", "IsDeleted")
    SELECT gen_random_uuid(), '${safeTenant}', '${safeConversation}', '${safeTemplate}', 'cota_e2e',
       '${safePhone}', 'Manual', 'Sent', 'Envio semeado (cota E2E)', now(), 1, 3,
       now(), now(), false
      FROM generate_series(1, ${Math.trunc(input.count)});
  `);
}

/**
 * Campanha "Festa de novo" `Suggested` (Etapa 121) direto no banco: o worker
 * diário que a gera precisa de festa passada com formulário e consentimento, e
 * roda a cada 24 h. Sem FK na tabela; `SourceEventId` é só referência.
 */
export function seedBirthdayCampaignDirect(input: {
  tenantId: string;
  clientId: string;
  honoreeFirstName: string;
  messageText: string;
}): string {
  const id = randomUUID();
  const safeTenant = input.tenantId.replace(/'/g, "''");
  const safeClient = input.clientId.replace(/'/g, "''");
  const safeName = input.honoreeFirstName.replace(/'/g, "''");
  const safeText = input.messageText.replace(/'/g, "''");
  execSql(`
    INSERT INTO "BirthdayCampaigns"
      ("Id", "TenantId", "ClientId", "SourceEventId", "HonoreeFirstName", "HonoreeBirthDate",
       "AgeTurning", "BirthdayYear", "BirthdayDate", "Status", "MessageText", "RenderedPreview",
       "GeneratedAt", "CreatedAt", "UpdatedAt", "IsDeleted")
    VALUES
      ('${id}', '${safeTenant}', '${safeClient}', gen_random_uuid(), '${safeName}',
       (current_date + 70 - interval '6 years')::date,
       6, extract(year from current_date + 70)::int, (current_date + 70)::date, 1,
       '${safeText}', '${safeText}',
       now(), now(), now(), false);
  `);
  return id;
}

/**
 * Liga o canal WhatsApp de um tenant direto no banco, para o webhook de
 * entrada (fake `whatsapp-meta`, `/_control/trigger-webhook` kind=inbound)
 * achar o tenant. Nao ha caminho por API: o `connect` do Embedded Signup troca
 * `code` por token na Graph API, que o fake nao implementa.
 *
 * O back resolve o tenant pelo PRIMEIRO canal ATIVO com o `phone_number_id`
 * do payload (sem unique global). Por isso o canal ganha um id PROPRIO DO
 * TENANT (`fake_phone_<tenant>`), devolvido aqui, e o spec o passa ao
 * `fakeWhatsApp.triggerWebhook({ phoneNumberId })`.
 *
 * [ALERTA] Ate 2026-10-07 todos usavam o mesmo `fake_phone` e este helper
 * desligava o canal dos outros tenants: dois specs em workers paralelos (ou
 * as copias de um `--repeat`) roubavam o canal um do outro no meio do teste,
 * e o webhook seguinte caia no tenant alheio, ignorado com 200 (status do
 * envio parado em `Delivered`/`Sent`, conversa que nao aparece). O
 * `describe.configure({ mode: 'serial' })` so serializa DENTRO do arquivo.
 *
 * Os canais ativos com o mesmo id ainda sao desligados antes (o banco E2E e
 * sujo por design); com o id por tenant isso so alcanca o proprio tenant.
 *
 * [ALERTA] Canal ativo criado ha mais de 1 h (de qualquer tenant) tambem e
 * desligado antes. A aprovacao de um template no Super Admin faz fan-out para
 * TODO tenant com canal ativo (E147, PLANO-SEGURANCA): com os canais das
 * execucoes anteriores vivos, cada aprovacao submetia o modelo a todas as WABAs
 * acumuladas no banco, e a espera pela do proprio tenant crescia a cada execucao. Nenhum
 * teste dura 1 h, entao o canal de um teste em curso nunca e alcancado; nenhum
 * spec depende de canal semeado antes da propria execucao.
 *
 * Classificacao e auto-lead ficam desligados: o spec quer so a conversa.
 *
 * Etapa 242 (SEG-C2): o envio ativo sai pelo canal DO TENANT, com o token dele
 * decifrado pelo back. O canal nasce com `AccessTokenCipher` (token
 * `whatsappChannelToken(phoneNumberId)`, cifrado com o AAD da linha por
 * `helpers/backend-cipher`) e `ConnectedAt`; sem isso todo envio do tenant
 * volta 409 `WhatsAppOutbound.ChannelNotConfigured`. Template enviado tambem
 * precisa do vinculo aprovado na WABA: `seedWhatsAppTemplateBindingDirect`.
 */
export function seedWhatsappChannelDirect(
  tenantId: string,
  phoneNumberId = `fake_phone_${tenantId.replace(/-/g, '')}`,
  businessAccountId: string = WHATSAPP_E2E_WABA_ID,
): string {
  const channelId = randomUUID();
  const safeTenant = tenantId.replace(/'/g, "''");
  const safePhone = phoneNumberId.replace(/'/g, "''");
  const safeWaba = businessAccountId.replace(/'/g, "''");
  const cipher = encryptForBackend(
    whatsappChannelToken(phoneNumberId),
    rowAssociatedData('WhatsappChannelConfig', tenantId, channelId),
  );
  execSql(`
    UPDATE "WhatsappChannelConfigs" SET "IsActive" = false, "UpdatedAt" = now()
     WHERE "IsActive" = true
       AND ("PhoneNumberId" = '${safePhone}' OR "CreatedAt" < now() - interval '1 hour');
    INSERT INTO "WhatsappChannelConfigs"
      ("Id", "TenantId", "PhoneNumberId", "BusinessAccountId", "VerifyTokenHash",
       "IsActive", "MirrorSentMessages", "SaveMedia", "IgnoreGroups",
       "AutoClassify", "UseAiClassifier", "AutoCreateLeadFromWhatsapp",
       "StoreMediaFiles", "AccessTokenCipher", "ConnectedAt",
       "CreatedAt", "UpdatedAt", "IsDeleted")
    VALUES
      ('${channelId}', '${safeTenant}', '${safePhone}', '${safeWaba}', 'e2e',
       true, false, false, true,
       false, false, false,
       false, '${cipher}', now(),
       now(), now(), false);
  `);
  return phoneNumberId;
}

/**
 * WABA dos canais semeados. A mesma para todos os tenants: o vinculo do template
 * e por (tenant, template) e o back o compara com a WABA do canal do proprio
 * tenant, entao um id compartilhado nao cruza tenants no ENVIO.
 *
 * [ALERTA] O webhook `message_template_status_update` acha os tenants pela WABA
 * (`entry.id`) e o vinculo pelo id da Meta, que o seed deriva do template: com a
 * WABA compartilhada, o status mandado para um tenant muda o vinculo do mesmo
 * template em todo tenant semeado. Spec que dispara esse webhook passa uma WABA
 * propria em `seedConnectedWhatsappTenantDirect(..., { businessAccountId })`.
 */
export const WHATSAPP_E2E_WABA_ID = 'fake_waba_id';

/**
 * Token do canal semeado por `seedWhatsappChannelDirect`. Deterministico por
 * numero para o spec conferir, no inbox do fake, que o envio saiu com o token
 * DO TENANT e nao com o `WhatsApp:ApiKey` da plataforma (Etapa 242).
 */
export function whatsappChannelToken(phoneNumberId: string): string {
  return `fake_token_${phoneNumberId}`;
}

/**
 * Vinculo (tenant, template) APROVADO na WABA do canal semeado (Etapa 242), o
 * que o back exige para enviar template pelo canal do tenant (senao 409
 * `WhatsAppOutbound.TemplateNotInWaba`). Em producao ele nasce na conexao (o
 * back submete os templates aprovados do catalogo a WABA); no E2E o canal e
 * semeado, entao o vinculo tambem.
 *
 * O `MetaTemplateId` e o da WABA do tenant, nao o do catalogo
 * (`meta_tmpl_<id>` de `seedApprovedWhatsAppTemplateDirect`): `waba_tmpl_<id>`.
 */
export function seedWhatsAppTemplateBindingDirect(
  tenantId: string,
  templateId: string,
  businessAccountId = WHATSAPP_E2E_WABA_ID,
): string {
  const safeTenant = tenantId.replace(/'/g, "''");
  const safeTemplate = templateId.replace(/'/g, "''");
  const safeWaba = businessAccountId.replace(/'/g, "''");
  const metaTemplateId = `waba_tmpl_${templateId.replace(/-/g, '')}`.slice(0, 64);
  execSql(`
    INSERT INTO "WhatsAppTemplateWabaBindings"
      ("Id", "TenantId", "WhatsAppTemplateId", "BusinessAccountId", "MetaTemplateId",
       "Status", "RejectionReason", "SubmittedAt", "StatusUpdatedAt",
       "CreatedAt", "UpdatedAt", "IsDeleted")
    VALUES
      (gen_random_uuid(), '${safeTenant}', '${safeTemplate}', '${safeWaba}', '${metaTemplateId}',
       'Approved', NULL, now(), now(),
       now(), now(), false);
  `);
  return metaTemplateId;
}

/**
 * Tenant pronto para enviar WhatsApp pelo proprio canal (Etapa 242): canal
 * ativo com token e, para cada template, o vinculo aprovado na WABA. Devolve o
 * `phoneNumberId` (o do webhook) e o token que o fake deve receber.
 */
export function seedConnectedWhatsappTenantDirect(
  tenantId: string,
  templateIds: string[] = [],
  opts: { businessAccountId?: string } = {},
): {
  phoneNumberId: string;
  accessToken: string;
  businessAccountId: string;
  /** Id da Meta de cada vínculo, por template (o `message_template_id` do webhook de status). */
  metaTemplateIds: Record<string, string>;
} {
  const businessAccountId = opts.businessAccountId ?? WHATSAPP_E2E_WABA_ID;
  const phoneNumberId = seedWhatsappChannelDirect(tenantId, undefined, businessAccountId);
  const metaTemplateIds: Record<string, string> = {};
  for (const templateId of templateIds) {
    metaTemplateIds[templateId] = seedWhatsAppTemplateBindingDirect(tenantId, templateId, businessAccountId);
  }
  return {
    phoneNumberId,
    accessToken: whatsappChannelToken(phoneNumberId),
    businessAccountId,
    metaTemplateIds,
  };
}

/**
 * Cria User adicional num tenant com role especifico (Owner/Admin/Manager/
 * Financial) reusando o PasswordHash do superadmin. Usado pra exercitar
 * gates de permission (403) sem rodar fluxo de invite.
 */
export function seedUserWithRoleDirect(input: {
  tenantId: string;
  role: 'Owner' | 'Admin' | 'Manager' | 'Financial';
  emailPrefix?: string;
}): { email: string; password: string } {
  const safeTenant = input.tenantId.replace(/'/g, "''");
  const email = `${input.emailPrefix ?? 'user'}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e.test`;
  const safeEmail = email.replace(/'/g, "''");
  const hash = execSql(
    `SELECT "PasswordHash" FROM "Users" WHERE "Email" = 'superadmin@dev.local';`,
  );
  if (!hash) {
    throw new Error('superadmin@dev.local nao seedado — rode npm run db:reset');
  }
  const safeHash = hash.replace(/'/g, "''");
  execSql(`
    INSERT INTO "Users"
      ("Id", "TenantId", "Type", "Email", "PasswordHash", "Name",
       "Role", "Status", "HasPasswordCredential", "FailedLoginAttempts",
       "SecurityStamp", "CreatedAt", "UpdatedAt", "IsDeleted")
    VALUES
      (gen_random_uuid(), '${safeTenant}', 'User', '${safeEmail}',
       '${safeHash}', 'Test ${input.role}', '${input.role}', 'Active',
       true, 0, ${NEW_SECURITY_STAMP_SQL}, now(), now(), false);
  `);
  return { email, password: 'Dev12345!' };
}

/**
 * Carimbo de segurança de usuário semeado por SQL, no formato do
 * `User.SecurityStamp` (Guid "N"). Desde a Etapa 231 o token sem
 * `security_stamp` toma 401 em todo request autenticado (falha fechada), e a
 * coluna nasce vazia por default: sem isto, o usuário semeado loga mas não
 * passa de nenhuma rota autenticada.
 */
const NEW_SECURITY_STAMP_SQL = `replace(gen_random_uuid()::text, '-', '')`;

/**
 * Cria User com role=CollaboratorPortal vinculado a um Collaborator
 * existente, reusando o PasswordHash do `superadmin@dev.local` (senha
 * "Dev12345!"). Devolve email+senha pra login subsequente em portal.
 */
export function seedCollaboratorPortalUserDirect(input: {
  tenantId: string;
  collaboratorId: string;
  emailPrefix?: string;
}): { email: string; password: string } {
  const safeTenant = input.tenantId.replace(/'/g, "''");
  const safeCollab = input.collaboratorId.replace(/'/g, "''");
  const email = `${input.emailPrefix ?? 'portal'}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e.test`;
  const safeEmail = email.replace(/'/g, "''");
  const hash = execSql(
    `SELECT "PasswordHash" FROM "Users" WHERE "Email" = 'superadmin@dev.local';`,
  );
  if (!hash) {
    throw new Error('superadmin@dev.local nao seedado — rode npm run db:reset');
  }
  const safeHash = hash.replace(/'/g, "''");
  execSql(`
    INSERT INTO "Users"
      ("Id", "TenantId", "Type", "Email", "PasswordHash", "Name",
       "Role", "CollaboratorId", "Status",
       "HasPasswordCredential", "FailedLoginAttempts",
       "SecurityStamp", "CreatedAt", "UpdatedAt", "IsDeleted")
    VALUES
      (gen_random_uuid(), '${safeTenant}', 'User', '${safeEmail}',
       '${safeHash}', 'Portal User',
       'CollaboratorPortal', '${safeCollab}', 'Active',
       true, 0,
       ${NEW_SECURITY_STAMP_SQL}, now(), now(), false);
  `);
  return { email, password: 'Dev12345!' };
}

/**
 * Fuso do tenant e fim do período de teste N dias depois de HOJE NO FUSO DELE
 * (meio-dia local). Sem endpoint: o fim do teste nasce no signup (14 dias) e só
 * o Super Admin o estende. O e-mail de fim do teste (Etapa 201) conta os dias
 * pelo calendário do tenant, então a data é montada no fuso informado.
 */
export function setTrialEndDirect(tenantId: string, timezone: string, daysFromTenantToday: number): void {
  const safeTenant = tenantId.replace(/'/g, "''");
  const safeTz = timezone.replace(/'/g, "''");
  const days = Math.trunc(daysFromTenantToday);
  execSql(`
    UPDATE "Tenants" SET "Timezone" = '${safeTz}', "UpdatedAt" = now() WHERE "Id" = '${safeTenant}';
    UPDATE "Subscriptions"
       SET "TrialEndsAt" = (((now() AT TIME ZONE '${safeTz}')::date + ${days}) + time '12:00') AT TIME ZONE '${safeTz}',
           "UpdatedAt" = now()
     WHERE "TenantId" = '${safeTenant}' AND "Status" <> 'Canceled';
  `);
}

/**
 * Assinatura do tenant como paga (`Active`, prazo de 30 dias). Sem endpoint de
 * tenant para isso: contratar passa pelo Asaas e pelo Super Admin.
 * `keepTrialEndsAt` deixa a data do teste gravada — mais estrito que o real
 * (`Subscription.Activate()` a zera), para provar que quem decide é o status.
 */
export function setSubscriptionActiveDirect(tenantId: string, opts: { keepTrialEndsAt?: boolean } = {}): void {
  const safeTenant = tenantId.replace(/'/g, "''");
  execSql(`
    UPDATE "Subscriptions"
       SET "Status" = 'Active',
           "ExpiresAt" = now() + interval '30 days',
           ${opts.keepTrialEndsAt ? '' : '"TrialEndsAt" = NULL,'}
           "UpdatedAt" = now()
     WHERE "TenantId" = '${safeTenant}' AND "Status" <> 'Canceled';
  `);
}

/**
 * Troca o plano da assinatura vigente do tenant, pelo código (`plan_free`,
 * `plan_essential`…). O signup nasce em teste do `plan_professional`, que já
 * traz `feature_ai`: o tenant "sem IA" de um gate de entitlement é o do
 * `plan_free`. O `EntitlementService` não tem cache, então vale no próximo request.
 */
export function setSubscriptionPlanDirect(tenantId: string, planCode: string): void {
  const safeTenant = tenantId.replace(/'/g, "''");
  const safeCode = planCode.replace(/'/g, "''");
  execSql(`
    UPDATE "Subscriptions"
       SET "PlanId" = (SELECT "Id" FROM "Plans" WHERE "Code" = '${safeCode}'),
           "UpdatedAt" = now()
     WHERE "TenantId" = '${safeTenant}' AND "Status" <> 'Canceled';
  `);
}

/**
 * Fatura vencida sem esperar o calendário: a fatura que nasce do webhook do
 * Asaas é emitida "agora" e o domínio recusa vencimento anterior à emissão
 * (`Invoice.Create`), então o vencimento passado da pré-condição é gravado
 * direto, pela id do payment no Asaas. Mesmo desenho do `setCreditExpiresAtDirect`.
 */
export function setInvoiceDueDateDirect(asaasPaymentId: string, isoDate: string): void {
  const safeId = asaasPaymentId.replace(/'/g, "''");
  const safeDate = isoDate.replace(/'/g, "''");
  execSql(
    `UPDATE "Invoices" SET "DueDate" = '${safeDate}', "UpdatedAt" = now() WHERE "AsaasPaymentId" = '${safeId}';`,
  );
}

/**
 * Envelhece o `CreatedAt` do evento. Para métrica com carência sobre a criação
 * (o alerta `missing-links` do SuperAdmin ignora os criados nos últimos 15 min,
 * que ainda estariam no Outbox): sem isto o evento do spec nunca entra na conta.
 */
export function backdateEventCreatedAtDirect(eventId: string, minutes: number): void {
  const safeId = eventId.replace(/'/g, "''");
  const safeMinutes = Math.trunc(minutes);
  execSql(
    `UPDATE "Events" SET "CreatedAt" = "CreatedAt" - interval '${safeMinutes} minutes' WHERE "Id" = '${safeId}';`,
  );
}

/**
 * Formulário pós-aceite respondido com "festa ao ar livre e descoberta". O
 * `PATCH /api/events/{id}/form-data` devolve 409 na PRIMEIRA gravação do
 * formulário (achado do e2e de 2026-10-04: o AppService faz `AddAsync` e depois
 * `Update` da mesma entidade nova), então a pré-condição vai direto no banco.
 */
export function seedOpenAirFormDataDirect(eventId: string): void {
  const safeId = eventId.replace(/'/g, "''");
  execSql(`
    INSERT INTO "PostApprovalFormData"
      ("Id", "TenantId", "EventId", "IsCovered", "IsIndoor", "IsConfirmed",
       "LastFilledAt", "CreatedAt", "UpdatedAt", "IsDeleted", "ReengagementConsent")
    SELECT gen_random_uuid(), e."TenantId", e."Id", false, false, false,
           now(), now(), now(), false, false
      FROM "Events" e WHERE e."Id" = '${safeId}';
  `);
}

/**
 * Endereço estruturado do evento (cidade e UF do argumento, o resto fixo).
 * Evento aberto ao público nasce só com o texto de `location` e não há
 * endpoint que grave o endereço dele (o do evento comercial vem do aceite do
 * orçamento). Todos os campos obrigatórios do `Address` vão preenchidos: com
 * algum nulo, o EF materializa o endereço como ausente.
 */
export function setEventAddressDirect(eventId: string, city: string, state: string): void {
  const safeId = eventId.replace(/'/g, "''");
  const safeCity = city.replace(/'/g, "''");
  const safeState = state.replace(/'/g, "''");
  execSql(`
    UPDATE "Events"
       SET "Address_ZipCode" = '80010-000', "Address_Street" = 'Rua XV de Novembro',
           "Address_Number" = '1000', "Address_Neighborhood" = 'Centro',
           "Address_City" = '${safeCity}', "Address_State" = '${safeState}',
           "Address_Country" = 'BR', "UpdatedAt" = now()
     WHERE "Id" = '${safeId}';
  `);
}

/**
 * Super Admin novo SEM MFA (o `superadmin@dev.local` do seed nasce com TOTP
 * desde a Etapa 235). Sem fluxo de criação de Super Admin pela API, vai por SQL
 * como o `User.CreateSuperAdmin` do back: `TenantId` vazio, `Type`/`Role`
 * `SuperAdmin`; senha `Dev12345!` pelo hash reusado do seed.
 */
export function seedSuperAdminDirect(emailPrefix = 'superadmin'): { email: string; password: string } {
  const email = `${emailPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@e2e.test`;
  const safeEmail = email.replace(/'/g, "''");
  const hash = execSql(
    `SELECT "PasswordHash" FROM "Users" WHERE "Email" = 'superadmin@dev.local';`,
  );
  if (!hash) {
    throw new Error('superadmin@dev.local nao seedado — rode npm run db:reset');
  }
  const safeHash = hash.replace(/'/g, "''");
  execSql(`
    INSERT INTO "Users"
      ("Id", "TenantId", "Type", "Email", "PasswordHash", "Name",
       "Role", "Status", "HasPasswordCredential", "FailedLoginAttempts",
       "SecurityStamp", "CreatedAt", "UpdatedAt", "IsDeleted")
    VALUES
      (gen_random_uuid(), '00000000-0000-0000-0000-000000000000', 'SuperAdmin', '${safeEmail}',
       '${safeHash}', 'E2E SuperAdmin', 'SuperAdmin', 'Active',
       true, 0, ${NEW_SECURITY_STAMP_SQL}, now(), now(), false);
  `);
  return { email, password: 'Dev12345!' };
}

/**
 * Envelhece o `CreatedAt` do usuário: a carência do MFA obrigatório (Etapa 235)
 * conta da criação da conta. Chamar ANTES do primeiro request autenticado do
 * usuário: o validador de token guarda a data num snapshot em cache.
 */
export function backdateUserCreatedAtDirect(userId: string, days: number): void {
  const safeId = userId.replace(/'/g, "''");
  const safeDays = Math.trunc(days);
  execSql(
    `UPDATE "Users" SET "CreatedAt" = now() - interval '${safeDays} days' WHERE "Id" = '${safeId}';`,
  );
}

/**
 * Marca o tenant como já configurado (`Tenant.CompleteOnboarding`). Para o dono
 * que toma 403 do MFA em toda rota, inclusive no `complete-onboarding`, e para a
 * sessão de impersonação, que é só leitura.
 */
export function setTenantOnboardedDirect(tenantId: string): void {
  const safeId = tenantId.replace(/'/g, "''");
  execSql(`UPDATE "Tenants" SET "IsOnboarded" = true WHERE "Id" = '${safeId}';`);
}

/** Quantos links mágicos já foram emitidos para a conta deste e-mail (só o hash fica no banco). */
export function countMagicLinkTokensDirect(email: string): number {
  const safeEmail = email.replace(/'/g, "''");
  const result = execSql(`
    SELECT COUNT(*) FROM "MagicLinkTokens" m
      JOIN "Users" u ON u."Id" = m."UserId"
     WHERE LOWER(u."Email") = LOWER('${safeEmail}');
  `);
  return parseInt(result, 10);
}

/**
 * Exclusão lógica do evento. Não há endpoint que exclua evento comercial (o
 * caminho é cancelar); o soft-delete existe para o que vem de fora (purga do
 * tenant), e o link público do formulário tem de fechar nele também (Etapa 233).
 */
export function softDeleteEventDirect(eventId: string): void {
  const safeId = eventId.replace(/'/g, "''");
  execSql(`UPDATE "Events" SET "IsDeleted" = true, "UpdatedAt" = now() WHERE "Id" = '${safeId}';`);
}

/**
 * Validade do link do formulário pós-aceite vencida agora. O prazo real é o
 * fim de D+1 no fuso do evento, gravado na emissão (Etapa 233); a festa não
 * nasce no passado, então o "depois de D+1" se reproduz movendo o prazo.
 */
export function expireEventFormLinkDirect(eventId: string): void {
  const safeId = eventId.replace(/'/g, "''");
  execSql(
    `UPDATE "Events" SET "FormPublicTokenExpiresAt" = now() - interval '1 minute' WHERE "Id" = '${safeId}';`,
  );
}

/**
 * Exclusão lógica da conversa. Não há endpoint nem tela que exclua conversa (o
 * caminho é arquivar); o soft-delete existe e a anonimização por titular tem de
 * alcançá-lo (PLANO-SEGURANCA §14, E167).
 */
export function softDeleteConversationDirect(conversationId: string): void {
  const safeId = conversationId.replace(/'/g, "''");
  execSql(`UPDATE "Conversations" SET "IsDeleted" = true, "UpdatedAt" = now() WHERE "Id" = '${safeId}';`);
}

/**
 * Canal semeado passa a guardar a mídia recebida (`SaveMedia`) e a arquivar o
 * binário no storage (`StoreMediaFiles`, opt-in LGPD da Etapa 106): o
 * `ConversationMediaDownloadWorker` baixa do fake e grava a key no anexo.
 */
export function enableChannelMediaStorageDirect(phoneNumberId: string): void {
  const safePhone = phoneNumberId.replace(/'/g, "''");
  execSql(`
    UPDATE "WhatsappChannelConfigs"
       SET "SaveMedia" = true, "StoreMediaFiles" = true, "UpdatedAt" = now()
     WHERE "PhoneNumberId" = '${safePhone}' AND "IsActive" = true;
  `);
}

/** Anexos das mensagens de uma conversa como estão no banco (key de storage, nome e legenda). */
export function messageAttachmentsDirect(
  conversationId: string,
): Array<{ mediaUrl: string; fileName: string | null; caption: string | null }> {
  const safeId = conversationId.replace(/'/g, "''");
  const json = execSql(`
    SELECT COALESCE(json_agg(json_build_object(
             'mediaUrl', a."MediaUrl", 'fileName', a."FileName", 'caption', a."Caption")), '[]')
      FROM "MessageAttachments" a
      JOIN "Messages" m ON m."Id" = a."MessageId"
     WHERE m."ConversationId" = '${safeId}';
  `);
  return JSON.parse(json || '[]') as Array<{ mediaUrl: string; fileName: string | null; caption: string | null }>;
}

/** Id do usuário pelo e-mail (o `seedUserWithRoleDirect` só devolve e-mail e senha). */
export function userIdByEmailDirect(email: string): string {
  const safeEmail = email.replace(/'/g, "''");
  const id = execSql(`SELECT "Id" FROM "Users" WHERE LOWER("Email") = LOWER('${safeEmail}');`);
  if (!id) throw new Error(`usuário ${email} não encontrado`);
  return id;
}

/**
 * Troca o papel do usuário e gira o `SecurityStamp`, como faria a troca de papel
 * de uma tela que ainda não existe: o access token aberto morre no próximo
 * request (depois que o cache de estado do token é esquecido) e o refresh emite
 * outro com o papel novo. Usado para o "Admin rebaixado com a tela aberta".
 */
export function setUserRoleDirect(userId: string, role: 'Owner' | 'Admin' | 'Manager' | 'Financial'): void {
  const safeId = userId.replace(/'/g, "''");
  execSql(`
    UPDATE "Users"
       SET "Role" = '${role}', "SecurityStamp" = replace(gen_random_uuid()::text, '-', ''), "UpdatedAt" = now()
     WHERE "Id" = '${safeId}';
  `);
}

/**
 * Grava a categoria do orçamento sem passar pela validação do back: é a
 * referência a uma categoria de OUTRO tenant que já estava no banco antes da
 * Etapa 230, e que o aceite não pode transformar em checklist do evento.
 */
export function setBudgetEventCategoryDirect(budgetId: string, eventCategoryId: string): void {
  const safeId = budgetId.replace(/'/g, "''");
  const safeCategory = eventCategoryId.replace(/'/g, "''");
  execSql(`UPDATE "Budgets" SET "EventCategoryId" = '${safeCategory}' WHERE "Id" = '${safeId}';`);
}

/**
 * Gateway de cartão do tenant como TESTADO (`Enabled`). O teste de conexão
 * (`POST /api/ticketing/gateway/verify`) chama o Asaas de verdade, com o
 * endereço fixo no provider, e o E2E não tem essa saída: a credencial é gravada
 * pelo `PUT` (cifrada pelo back) e só a marca de verificado vai por SQL.
 */
export function enableTicketingGatewayDirect(tenantId: string): void {
  const safeTenant = tenantId.replace(/'/g, "''");
  execSql(`
    UPDATE "TenantPaymentGatewayConfigs"
       SET "Enabled" = true, "LastVerifiedAt" = now(), "UpdatedAt" = now()
     WHERE "TenantId" = '${safeTenant}';
  `);
}

/** `Document` e `DocumentHash` do cliente como estão no banco (Etapa 234: cifrado + hash). */
export function getClientDocumentColumnsDirect(clientId: string): { document: string; documentHash: string } {
  const safeId = clientId.replace(/'/g, "''");
  const row = execSql(
    `SELECT coalesce("Document", '') || '|' || coalesce("DocumentHash", '') FROM "Clients" WHERE "Id" = '${safeId}';`,
  );
  const [document = '', documentHash = ''] = row.split('|');
  return { document, documentHash };
}

/** `ClientCpf` e `Restrictions` do formulário pós-aceite como estão no banco. */
export function getFormDataPersonalColumnsDirect(eventId: string): { clientCpf: string; restrictions: string } {
  const safeId = eventId.replace(/'/g, "''");
  const row = execSql(`
    SELECT coalesce("ClientCpf", '') || '|' || coalesce("Restrictions", '')
      FROM "PostApprovalFormData" WHERE "EventId" = '${safeId}' AND "IsDeleted" = false;
  `);
  const [clientCpf = '', restrictions = ''] = row.split('|');
  return { clientCpf, restrictions };
}

/** Nomes das colunas de uma tabela, para afirmar que uma coluna NÃO existe mais. */
export function tableColumnsDirect(table: string): string[] {
  const safeTable = table.replace(/'/g, "''");
  return execSql(
    `SELECT column_name FROM information_schema.columns WHERE table_name = '${safeTable}' ORDER BY 1;`,
  )
    .split(/\r?\n/)
    .filter((c) => c.length > 0);
}

/** A linha inteira do pedido de exportação em JSON (`row_to_json`), para procurar o token cru nela. */
export function dataExportRowJsonDirect(exportId: string): string {
  const safeId = exportId.replace(/'/g, "''");
  return execSql(`SELECT row_to_json(r)::text FROM "DataExportRequests" r WHERE "Id" = '${safeId}';`);
}

/**
 * Slug do link público de leads (`/leads/by-slug/{slug}`): é o `Subdomain` do
 * tenant, que o signup não grava e o tenant não edita pela API (fica com o
 * Super Admin). Grava um slug único, minúsculo como o lookup espera, e o
 * devolve.
 */
export function setTenantSubdomainDirect(tenantId: string, slug: string): string {
  const safeId = tenantId.replace(/'/g, "''");
  const safeSlug = slug.toLowerCase().replace(/'/g, "''");
  execSql(`UPDATE "Tenants" SET "Subdomain" = '${safeSlug}', "UpdatedAt" = now() WHERE "Id" = '${safeId}';`);
  return safeSlug;
}

/**
 * Insight do Painel (`AiInsights`) já detectado, status `New`. Quem os cria é o
 * worker de detecção, que precisa de meses de histórico: para a tela mostrar a
 * faixa com um cartão, a linha vai direto no banco. Devolve o id.
 */
export function seedAiInsightDirect(tenantId: string, title: string): string {
  const safeTenant = tenantId.replace(/'/g, "''");
  const safeTitle = title.replace(/'/g, "''");
  return execSql(`
    INSERT INTO "AiInsights"
      ("Id", "TenantId", "Kind", "Severity", "DedupeKey", "Title", "Explanation",
       "SuggestedAction", "MetricSnapshotJson", "AiGenerated", "DetectedAt", "DetectedOn",
       "Status", "CreatedAt", "UpdatedAt", "IsDeleted")
    VALUES
      (gen_random_uuid(), '${safeTenant}', 1, 2, 'e2e-' || gen_random_uuid()::text,
       '${safeTitle}', 'Receita do mes abaixo da media (E2E).', 'Revise as cobrancas em aberto.',
       '{}', false, now(), current_date, 1, now(), now(), false)
    RETURNING "Id";
  `).split(/\r?\n/)[0]!.trim();
}

/**
 * Conta tenants — útil pra smoke tests de "API está respondendo e DB tem dados".
 */
export function countTenants(): number {
  const result = execSql('SELECT COUNT(*) FROM "Tenants";');
  return parseInt(result, 10);
}

/**
 * Apaga tudo do banco (cuidado!). Usado pelo script db:reset.
 * Preserva schema (não dropa tabelas) — só limpa dados.
 */
export function truncateAllData(): void {
  execSql(`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN (
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename != '__EFMigrationsHistory'
      ) LOOP
        EXECUTE 'TRUNCATE TABLE "' || r.tablename || '" RESTART IDENTITY CASCADE';
      END LOOP;
    END $$;
  `);
}
