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

## Regras

- Pré-condição por **API** (`helpers/api-entities`), nunca por UI: UI só para o fluxo que o teste prova.
- Seletores por `data-testid`; o front os expõe em tudo clicável.
- Cada teste cria o próprio tenant (fixture); o banco fica sujo e isso é aceito: o filtro multi-tenant do back isola.
- Integração externa sempre via fake; asserção no inbox do fake (`/_control/inbox`), webhook disparado via `/_control/trigger-webhook`.
- Todo plano de feature (`docs/implementar/PLANO-*.md`) termina com um spec aqui; o diagrama `docs/fluxos/negocio-N.M-*.mmd` tem o mesmo número do spec.

## Veja também

`README.md` · `docs/fluxos/FLUXOS.md` · `docs/QUALIDADE-TESTES.md`.
