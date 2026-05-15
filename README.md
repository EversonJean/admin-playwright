# admin-playwright — Testes E2E (Playwright)

Suite de testes ponta-a-ponta do Recreativo 2. Cobre fluxos front (Angular 21) + back (.NET 10) + Postgres local, simulando interações reais do usuário no navegador.

## Pré-requisitos

| Componente | Versão | Como conferir |
|---|---|---|
| Node.js | ≥ 22 | `node --version` |
| PostgreSQL local | 18 (rodando na porta 5432) | `psql -U postgres -l` |
| Database `adminbackend` criado | qualquer | já criado durante setup do Postgres |
| .NET SDK | 10 | `dotnet --version` |
| Repos irmãos | `../admin-backend` e `../admin-frontend` clonados ao lado deste | `ls ..` |

> Se ainda não tem o Postgres local, veja as instruções na pasta `c:\Pessoal\admin` (Postgres 18 + db `adminbackend` + usuário `postgres/postgres`).

## Setup inicial (1ª vez)

```powershell
cd source\admin-playwright
npm install
npm run install:browsers        # baixa Chromium (~150MB)
Copy-Item .env.example .env     # ajuste se precisar
```

## Rodar

```powershell
npm test                # roda toda a suite headless (sobe back+front automaticamente)
npm run test:headed     # com navegador visível
npm run test:ui         # modo interativo (recomendado pra dev de teste)
npm run test:smoke      # só os marcados com @smoke
npm run codegen         # grava ações no navegador → gera TypeScript
npm run report          # abre o relatório HTML do último run
```

Playwright **sobe back e front automaticamente** (via `webServer` no config). Se você já tem ambos rodando em outros terminais, exporte `SKIP_WEBSERVER=true` no `.env` pra ele só conectar.

## Estrutura

```
source/admin-playwright/
├── playwright.config.ts          ← config (webServer, timeouts, projects)
├── tsconfig.json
├── package.json
├── .env / .env.example
├── helpers/
│   ├── api-client.ts             ← chamadas diretas ao back (signup, login)
│   ├── db-helper.ts              ← psql.exe para SQL ad-hoc (confirm email, cleanup)
│   └── test-data.ts              ← factories de dados fake
├── fixtures/
│   ├── tenant.fixture.ts         ← cria tenant isolado por teste
│   └── auth.fixture.ts           ← storageState (login uma vez, reusa)
└── tests/
    ├── 1-onboarding/             ← 1.1–1.4
    ├── 2-cadastros/              ← 2.1–2.6
    ├── 3-equipe/                 ← 3.1–3.3
    ├── 4-comercial/              ← 4.1–4.4
    ├── 5-orcamento/              ← 5.1–5.5
    ├── 6-eventos/                ← 6.1–6.5
    ├── 7-escalacao/              ← 7.1–7.3
    ├── 9-contratos/              ← 9.1–9.6
    ├── 10-financeiro/            ← 10.1–10.6
    ├── 11-comunicacao/           ← 11.1–11.3
    ├── 12-dashboard/             ← 12.1–12.2
    ├── 13-portal-colaborador/    ← 13
    ├── 14-governanca/            ← 14.1–14.3
    ├── 15-locacao/               ← 15.1
    ├── 16-super-admin/           ← 16.1–16.5
    └── 17-seguranca/             ← 17.1–17.4
```

Cada `.spec.ts` espelha um dos 47 fluxos de negócio em [`docs/fluxos/negocio-*.mmd`](../../docs/fluxos/).

## Estado atual (15/05/2026)

- **3 testes implementados** rodando contra back+front locais
- **44 testes em `test.fixme`** — esqueleto pronto, aguarda implementação. Cada um cita o `.mmd` correspondente

Pra implementar um fluxo pendente:
1. Lê o `.mmd` em `docs/fluxos/negocio-X.Y-*.mmd`
2. Lê a seção correspondente em `docs/FUNCIONALIDADES-NEGOCIO.md`
3. Tira o `.fixme` do `test()`, implementa, valida com `npm run test:ui`

## Estratégia de dados

**1 tenant isolado por teste.** Cada teste invoca a fixture `tenantTest`, que via API cria um tenant novo + 1 usuário Admin + confirma email via SQL. Após o teste, o tenant fica no banco (sem rollback) — não afeta outros testes porque o filtro multi-tenant do back garante isolamento.

**Limpeza periódica** (opcional):
```powershell
npm run db:reset    # DROP DATABASE + CREATE + reinicia API (re-migra)
```

## Troubleshooting

| Sintoma | Provável causa | Solução |
|---|---|---|
| `webServer` timeout em 180s | back/front demorando demais no boot | Sobe ambos à mão e seta `SKIP_WEBSERVER=true` |
| `ECONNREFUSED localhost:5432` | Postgres parado | `Start-Service postgresql-x64-18` |
| `psql: command not found` no helper | `PSQL_PATH` errado | Ajusta no `.env` apontando pra `psql.exe` real |
| `401 Unauthorized` em todas as chamadas | Token expirou ou refresh não rodou | Reduz `RefreshLifetimeMinutes` no back ou re-cria storageState |
| Testes flakeam em CI | Workers paralelos brigando | Reduz `workers` no config; isolamento por tenant deve resolver |

## Relação com docs

| Documento | O que vem dele |
|---|---|
| [`FUNCIONALIDADES-NEGOCIO.md`](../../docs/FUNCIONALIDADES-NEGOCIO.md) | Linguagem do produto; cada seção `X.Y` vira um `.spec.ts` |
| [`docs/fluxos/negocio-X.Y-*.mmd`](../../docs/fluxos/) | Diagrama do fluxo; cada caixa numerada vira 1+ asserts no teste |
| [`BACKEND-IMPLEMENTADO.md`](../../docs/BACKEND-IMPLEMENTADO.md) | O que existe no back hoje (não escreva teste de feature não implementada) |
| [`FRONTEND-IMPLEMENTADO.md`](../../docs/FRONTEND-IMPLEMENTADO.md) | O que existe no front hoje |
