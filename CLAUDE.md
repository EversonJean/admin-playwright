# admin-playwright

Testes ponta a ponta (Playwright + Chromium) do Recreativo 2: front Angular + back .NET + Postgres local + **fake providers** para toda integração externa. Setup e pré-requisitos no `README.md`.

## Mapa

| Pasta | Papel | CLAUDE.md |
|---|---|---|
| `tests/<N>-<area>/` | specs numerados por área de negócio; `0-infra` é transversal | sim |
| `fixtures/` | `tenantTest` (tenant + admin novos por teste), `authTest` (página e API autenticadas), `twoTenantsTest` (isolamento), `superAdminTest` | — |
| `helpers/` | `api-client` (contexto HTTP, signup+confirmação), `api-entities` (`apiCreateClient`, `apiCreateActivity`… criam pré-condição via API), `api-event-flow`, `setup-flows`, `smoke` (`smokeRoute`), `test-data` (`fake*`), `db-helper`, `fake-providers` (controle dos fakes), `response`, `types` | — |
| `fake-providers/` | um servidor Fastify por provedor externo, com `/_control/*` | sim |
| `scripts/` | `db-reset.js`, `gen-stubs.js` | — |

## Comandos

```
npm test                       # tudo, headless; sobe back, front e fakes via webServer
npm run test:ui                # modo interativo (dev de teste)
npm run test:smoke             # só @smoke
npx playwright test tests/6-eventos/6.2-*.spec.ts   # só o que mudou
SKIP_WEBSERVER=true npm test   # back/front já rodando em outro terminal
npm run db:reset
```

O back sobe com `--launch-profile e2e` e `appsettings.E2E.json` aponta cada integração para o fake correspondente.

[ALERTA] **`reuseExistingServer` + o segundo clone = o e2e roda contra o codigo
ERRADO, em silencio.** Existem dois clones deste workspace na maquina (ver o
`CLAUDE.md` da raiz). Em dev o `playwright.config.ts` usa
`reuseExistingServer: !process.env.CI`: se JA houver algo respondendo em 1501 ou
4200, o Playwright **reusa** em vez de subir o deste clone. Se o que estiver la
for o outro clone, a suite exercita a outra branch — e um verde ali nao prova
nada sobre o que voce acabou de escrever.

O sintoma NAO diz isso. O outro clone roda `appsettings.Development.json` (banco
`admin-dev`) enquanto o `helpers/db-helper.ts` escreve em `adminbackend` (o
default, que e o mesmo do `appsettings.E2E.json`): o helper confirma o e-mail num
banco e o back le o outro, e o teste morre em `Auth.EmailNotVerified`. Parece
problema do teste; e clone trocado.

Antes de rodar, confira **de quem** sao os processos:

```
powershell -c "Get-NetTCPConnection -LocalPort 1501,4200 -State Listen | ForEach-Object { (Get-CimInstance Win32_Process -Filter \"ProcessId = $($_.OwningProcess)\").CommandLine }"
```

O caminho tem de conter o nome DESTE clone. Se nao, derrube o processo — a skill
`start-app` da raiz e quem decide qual dos dois sobe.

[NOTA] O `webServer` tem timeout de 180s e o back sobe com `dotnet run`, que
**compila**. Em build frio isso estoura e o erro e so
`Timed out waiting 180000ms from config.webServer`, sem dizer qual servidor.
Rode `dotnet build` no `admin-backend` antes da primeira execucao do dia.

## Regras

- Pré-condição por **API** (`helpers/api-entities`), nunca por UI: UI só para o fluxo que o teste prova.
- Seletores por `data-testid`; o front os expõe em tudo clicável.
- Cada teste cria o próprio tenant (fixture); o banco fica sujo e isso é aceito: o filtro multi-tenant do back isola.
- Integração externa sempre via fake; asserção no inbox do fake (`/_control/inbox`), webhook disparado via `/_control/trigger-webhook`.
- Todo plano de feature (`docs/implementar/PLANO-*.md`) termina com um spec aqui; o diagrama `docs/fluxos/negocio-N.M-*.mmd` tem o mesmo número do spec.

## Veja também

`README.md` · `docs/fluxos/FLUXOS.md` · `docs/QUALIDADE-TESTES.md`.
