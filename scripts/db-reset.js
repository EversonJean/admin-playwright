#!/usr/bin/env node
/**
 * db-reset — apaga TODOS os dados do banco `adminbackend` (preserva schema).
 *
 * Útil quando os testes E2E sujam o banco a ponto de queries ficarem lentas,
 * ou quando você quer um ambiente totalmente virgem antes de uma suite.
 *
 * NÃO usa `DROP DATABASE` — apenas TRUNCATE em todas as tabelas exceto
 * `__EFMigrationsHistory`. O back não precisa re-migrar; PermissionSeeder
 * só não roda de novo (ele só popula on-boot).
 *
 * Se você quiser reset COMPLETO (incl. permissions), pare o back, rode
 * `dropdb adminbackend && createdb adminbackend` e suba o back de novo.
 */

const { execFileSync } = require('child_process');
require('dotenv').config();

const PSQL_PATH = process.env.PSQL_PATH ?? 'C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe';
const PG_HOST = process.env.PG_HOST ?? 'localhost';
const PG_PORT = process.env.PG_PORT ?? '5432';
const PG_USER = process.env.PG_USER ?? 'postgres';
const PG_PASSWORD = process.env.PG_PASSWORD ?? 'postgres';
const PG_DATABASE = process.env.PG_DATABASE ?? 'adminbackend';

const sql = `
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
`;

try {
  execFileSync(
    PSQL_PATH,
    ['-U', PG_USER, '-h', PG_HOST, '-p', PG_PORT, '-d', PG_DATABASE, '-c', sql],
    { env: { ...process.env, PGPASSWORD: PG_PASSWORD }, stdio: 'inherit' },
  );
  console.log(`\n✔ Banco ${PG_DATABASE} resetado (schema preservado).`);
} catch (err) {
  console.error('✘ Falha ao resetar o banco:', err.message);
  process.exit(1);
}
