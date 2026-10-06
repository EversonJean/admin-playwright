import { execFileSync } from 'child_process';

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
}): string {
  const id = execSql(`SELECT gen_random_uuid()::text;`);
  const safeName = input.name.replace(/'/g, "''");
  const safeBody = input.body.replace(/'/g, "''");
  const safeCat = (input.category ?? 'Utility').replace(/'/g, "''");
  const safeLang = (input.language ?? 'pt_BR').replace(/'/g, "''");
  execSql(`
    INSERT INTO "WhatsAppTemplates"
      ("Id", "Name", "Language", "Category", "Status", "Body",
       "MetaTemplateId", "CreatedAt", "UpdatedAt", "IsDeleted")
    VALUES
      ('${id}', '${safeName}', '${safeLang}', '${safeCat}', 'Approved',
       '${safeBody}', 'meta_tmpl_${id}', now(), now(), false);
  `);
  return id;
}

/**
 * Liga o canal WhatsApp de um tenant direto no banco, para o webhook de
 * entrada (fake `whatsapp-meta`, `/_control/trigger-webhook` kind=inbound)
 * achar o tenant. Nao ha caminho por API: o `connect` do Embedded Signup troca
 * `code` por token na Graph API, que o fake nao implementa.
 *
 * O fake manda SEMPRE `phone_number_id = 'fake_phone'` e o back resolve o
 * tenant pelo PRIMEIRO canal ATIVO com esse id (sem unique global). Por isso
 * os canais ativos de outros tenants com o mesmo id sao desativados antes:
 * o banco E2E e sujo por design, e sem isso o inbound cairia no tenant de uma
 * execucao anterior. Consequencia: dois specs que usam inbound nao podem rodar
 * ao mesmo tempo.
 *
 * Classificacao e auto-lead ficam desligados: o spec quer so a conversa.
 */
export function seedWhatsappChannelDirect(tenantId: string, phoneNumberId = 'fake_phone'): void {
  const safeTenant = tenantId.replace(/'/g, "''");
  const safePhone = phoneNumberId.replace(/'/g, "''");
  execSql(`
    UPDATE "WhatsappChannelConfigs" SET "IsActive" = false, "UpdatedAt" = now()
     WHERE "PhoneNumberId" = '${safePhone}' AND "IsActive" = true;
    INSERT INTO "WhatsappChannelConfigs"
      ("Id", "TenantId", "PhoneNumberId", "BusinessAccountId", "VerifyTokenHash",
       "IsActive", "MirrorSentMessages", "SaveMedia", "IgnoreGroups",
       "AutoClassify", "UseAiClassifier", "AutoCreateLeadFromWhatsapp",
       "StoreMediaFiles", "CreatedAt", "UpdatedAt", "IsDeleted")
    VALUES
      (gen_random_uuid(), '${safeTenant}', '${safePhone}', 'fake_waba_id', 'e2e',
       true, false, false, true,
       false, false, false,
       false, now(), now(), false);
  `);
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
       "CreatedAt", "UpdatedAt", "IsDeleted")
    VALUES
      (gen_random_uuid(), '${safeTenant}', 'User', '${safeEmail}',
       '${safeHash}', 'Test ${input.role}', '${input.role}', 'Active',
       true, 0, now(), now(), false);
  `);
  return { email, password: 'Dev12345!' };
}

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
       "CreatedAt", "UpdatedAt", "IsDeleted")
    VALUES
      (gen_random_uuid(), '${safeTenant}', 'User', '${safeEmail}',
       '${safeHash}', 'Portal User',
       'CollaboratorPortal', '${safeCollab}', 'Active',
       true, 0,
       now(), now(), false);
  `);
  return { email, password: 'Dev12345!' };
}

/**
 * Le o `FormPublicToken` do Event direto do DB. Nao eh exposto no
 * EventDetailDto por padrao (Etapa 55 — token publico nao volta em
 * /api/events/:id); aqui pegamos via SQL pra exercitar o endpoint
 * publico /api/public/events/:token/form em E2E.
 */
export function getEventFormPublicTokenDirect(eventId: string): string {
  const safeId = eventId.replace(/'/g, "''");
  const token = execSql(
    `SELECT "FormPublicToken" FROM "Events" WHERE "Id" = '${safeId}';`,
  );
  if (!token) {
    throw new Error(`Event ${eventId} sem FormPublicToken (ou nao existe)`);
  }
  return token;
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
