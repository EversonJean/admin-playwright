# admin-playwright

Testes ponta a ponta (Playwright + Chromium) do Recreativo 2: front Angular + back .NET + Postgres local + **fake providers** para toda integração externa. Setup e pré-requisitos no `README.md`.

## Mapa

| Pasta | Papel | CLAUDE.md |
|---|---|---|
| `tests/<N>-<area>/` | specs numerados por área de negócio; `0-infra` é transversal | sim |
| `fixtures/` | `tenantTest` (tenant + admin novos por teste), `authTest` (página e API autenticadas), `twoTenantsTest` (isolamento), `superAdminTest` | — |
| `helpers/` | `api-client` (contexto HTTP, signup+confirmação), `api-entities` (`apiCreateClient`, `apiCreateActivity`… criam pré-condição via API), `api-event-flow`, `setup-flows`, `external-calendar` (conectar o Google pelo fake, com step-up), `smoke` (`smokeRoute(page, rota, { ready })`, `ready` = `data-testid` da raiz da tela, obrigatório), `test-data` (`fake*`), `db-helper`, `fake-providers` (controle dos fakes), `response` (`readJson`, `assertOk`, `apiErrorCodes`, `unwrapList`), `ui` (`snack`), `types`, `whatsapp-flow` (canal, inbound, conversas e envios pelo fake), `workers` (estado dos workers no Super Admin; `waitForWorkerCycleAfter` espera um ciclo seguinte sem sleep fixo), `local-storage` (`storedDocumentFile`, o arquivo de uma key no storage local do back) | — |
| `fake-providers/` | um servidor Fastify por provedor externo, com `/_control/*` | sim |
| `scripts/` | `db-reset.js`, `gen-stubs.js` | — |

## Comandos

Agente roda pelo `run-tests.js` da raiz do workspace (modo leve, confere o dono das portas, saída resumida); `npm test`, `npm run test:*` e `npx playwright test` crus são negados pelo hook `guard-git.js` do workspace. Os comandos crus abaixo ficam para quem roda à mão.

```
node .claude/scripts/run-tests.js e2e tests/6-eventos/6.2-*.spec.ts   # agente: só o que mudou
node .claude/scripts/run-tests.js e2e tests --grep @smoke             # agente: só @smoke
npm test                       # tudo, headless; sobe back, front e fakes via webServer
npm run test:ui                # modo interativo (dev de teste)
npm run test:smoke             # só @smoke
SKIP_WEBSERVER=true npm test   # back/front já rodando em outro terminal
npm run db:reset
```

Agente roda pelo script, não pelo `npx` cru: `node .claude/scripts/run-tests.js e2e <spec>[,<spec2>]` (da raiz do workspace) confere o dono das portas (para se for o outro clone), faz o `dotnet build`, roda com relatório JSON e devolve só teste, `arquivo:linha`, mensagem e o caminho do `error-context.md`, screenshot e trace de cada falha. `--check` faz só a conferência das portas.

O back sobe com `--launch-profile e2e` e `appsettings.E2E.json` aponta cada integração para o fake correspondente.

[ALERTA] **`reuseExistingServer` + o segundo clone = o e2e roda contra o codigo
ERRADO, em silencio.** Existem dois clones deste workspace na maquina (ver o
`CLAUDE.md` da raiz). Em dev o `playwright.config.ts` usa
`reuseExistingServer: !process.env.CI`: se JA houver algo respondendo nas portas
do e2e, o Playwright **reusa** em vez de subir o deste clone. Se o que estiver la
for o outro clone, a suite exercita a outra branch — e um verde ali nao prova
nada sobre o que voce acabou de escrever.

[DECISAO] **Cada clone roda o e2e nas proprias portas e no proprio banco**
(2026-11-09). O `.env` (gitignored, modelo no `.env.example`) troca `BACK_URL`,
`FRONT_URL`, `SUPER_ADMIN_URL`, `PG_DATABASE` e `BACK_CONNECTION_STRING`; sem ele
valem 1501/4200/4201 e `adminbackend`. Com outro back, o `playwright.config.ts`
sobe front e super-admin com `--port` e um proxy gerado do `proxy.conf.json`
(target trocado, gravado no `%TEMP%`), e passa ao back `Kestrel__Endpoints__Https__Url`,
`ConnectionStrings__Default` e `Email__FrontBaseUrl`; os fakes que disparam
webhook leem o `BACK_URL` do ambiente. O clone `new-features` usa back 1503, front
4310, super-admin 4311 e o banco `new-features-e2e` (fora tambem das portas de dev
dele, 1502/4300). Os fakes (1510-1517) sao comuns: a fila da maquina nunca roda
duas suites juntas. O `run-tests.js` le o mesmo `.env` para saber que portas conferir.

O sintoma NAO diz isso. O outro clone roda `appsettings.Development.json` (banco
`admin-dev`) enquanto o `helpers/db-helper.ts` escreve em `adminbackend` (o
default, que e o mesmo do `appsettings.E2E.json`): o helper confirma o e-mail num
banco e o back le o outro, e o teste morre em `Auth.EmailNotVerified`. Parece
problema do teste; e clone trocado.

Antes de rodar, confira **de quem** sao os processos:

```
node .claude/scripts/run-tests.js e2e --check
```

O script le a linha de comando do dono de cada porta: o caminho tem de conter o
nome DESTE clone. Se nao, ele para; nunca derrube processo do outro clone — dê a
este clone portas proprias no `.env` (decisao acima).

[NOTA] No perfil `e2e` o `Program.cs` re-adiciona as variaveis de ambiente DEPOIS
do `appsettings.E2E.json` (ate 2026-11-09 o arquivo vencia, e o
`ConnectionStrings__Default` do `env` do webServer era ignorado em silencio). O
`MigrateAsync` do boot aplica as migrations do working tree no banco do `.env`;
banco que nao existe e criado.

[ALERTA] **Configuracao do back para o e2e vai no `appsettings.E2E.json`, nunca
no `env` do webServer** — salvo porta, banco e `Email:FrontBaseUrl`, que sao do
clone e saem do mesmo `.env` tanto quando o Playwright sobe o back quanto quando
reaproveita o que ele mesmo subiu. Com `reuseExistingServer`, o back que ja estava de pe e
reaproveitado e nunca recebe as variaveis do `env`: o spec passa quando o
Playwright sobe o back e falha quando reaproveita. Valor que o fake precisa
conferir (ex.: `WhatsApp:AppId`/`AppSecret`, PLANO-SEGURANCA E143/E147) e
default literal no fake, igual ao do `appsettings.E2E.json`.

[NOTA] O `webServer` tem timeout de 180s e o back sobe com `dotnet run`, que
**compila**. Em build frio isso estoura e o erro e so
`Timed out waiting 180000ms from config.webServer`, sem dizer qual servidor.
Rode `dotnet build` no `admin-backend` antes da primeira execucao do dia.

## Regras

- Pré-condição por **API** (`helpers/api-entities`), nunca por UI: UI só para o fluxo que o teste prova.
- Seletores por `data-testid`; o front os expõe em tudo clicável.
- Cada teste cria o próprio tenant (fixture); o banco fica sujo e isso é aceito: o filtro multi-tenant do back isola.
- Integração externa sempre via fake; asserção no inbox do fake (`/_control/inbox`), webhook disparado via `/_control/trigger-webhook`.
- Spec nasce **no fim de um plano**, não por etapa: as etapas anotam os cenários no registro e2e do plano (`docs/CLAUDE.md` da raiz, "Registro e2e do plano") e o `/e2e-plano` escreve e roda todos de uma vez. O spec afirma o que o plano pede; falha em que o código diverge do plano não se conserta afrouxando a asserção. O diagrama `docs/fluxos/negocio-N.M-*.mmd` tem o mesmo número do spec.
- [ALERTA] `helpers/backend-cipher.ts` repete a cifra do `AesEncryptionService` do back (HKDF com info `recreativo:data-protection:v2:k1`, formato `v2:k1:`, AAD `{Entidade}|{tenant}|{id}` em minúsculas; Etapa 242, para semear o canal do WhatsApp com token cifrado). Mudança de chave, de `KeyId` ou de nome de entidade no back exige mudar o helper junto; a quebra aparece como 409 `WhatsAppOutbound.ChannelNotConfigured` no envio.

## Veja também

`README.md` · `docs/fluxos/FLUXOS.md` · `docs/QUALIDADE-TESTES.md`.
