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
