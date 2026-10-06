# fake-providers/

## Papel desta pasta

Um servidor Fastify por provedor externo, cada um um workspace npm (`asaas` 1510, `clicksign` 1511, `whatsapp-meta` 1512, `email` 1513, `openai` 1514, `anthropic` 1515, `google-maps` 1516, `google-calendar` 1517) mais `shared/` (inbox, controle, utilitários). O back faz HTTP real contra eles em E2E; os specs consultam e disparam ações por `/_control/*`. Portas e contrato no `README.md` desta pasta.

## Forma de um fake novo

```
fake-providers/<provider>/
├── package.json            workspace; script `start`
├── tsconfig.json           estende ../tsconfig.base.json
└── src/
    ├── server.ts           `createFakeServer({ name, port, registerRoutes })` de `shared/`: as rotas que o BACK chama
    │                       (shape mínimo que o back lê) e as `/_control/*` próprias do fake, no mesmo arquivo
    ├── state.ts            estado em memória do fake (contas, recursos, modo de falha), sem I/O; fake sem estado não tem
    └── <auxiliar>.ts       opcional, uma preocupação por arquivo (ex.: `google-calendar/src/id-token.ts`, assinatura)
```

- Implementar **só o que o back chama** (rotas listadas no adapter em `admin-backend/src/AdminBackend.Infrastructure/<Provider>/`), com resposta determinística e IDs previsíveis.
- Toda request cai no inbox de `shared/` (`GET /_control/inbox` com filtros `tenantId`, `path`, `since`; `DELETE` para limpar); `GET /_control/health` também vem de `shared/`.
- Webhook para o back via `POST /_control/trigger-webhook` com `endpoint`, `event`, `payload`; assinatura/token válidos para o ambiente E2E (o back é fail-closed).
- Erro simulável por rota de controle do próprio fake, guardada no `state.ts`, não por mudar código. Molde: `google-calendar` (`PUT /_control/accounts/:sub/failure` `{ mode, times? }`, `DELETE` limpa; a rota do provedor consulta o modo antes de responder). Não existe `/_control/fail-next` genérico em `shared/`.
- Credencial que o back manda (client id, segredo, `redirect_uri`) é conferida contra o valor de teste do `appsettings.E2E.json`, com o erro do provedor real; aceitar qualquer valor deixa o E2E verde com o back mandando o cliente errado.
- Escuta só no loopback (`shared/src/server-base.ts`, `host: 'localhost'`).
- Registrar em `playwright.config.ts` (`webServer` com `url: /_control/health`), em `package.json` raiz (`fakes:<provider>`) e em `appsettings.E2E.json` do back (`BaseUrl`).

## Checklist ao criar

1. Ler o adapter do back para listar rotas e campos lidos. 2. Servidor + rotas + inbox. 3. Três registros (config do Playwright, script npm, appsettings E2E). 4. Spec em `0-infra` ou na área que prova o fluxo lendo o inbox.

## O que NÃO vai aqui

- Lógica de negócio do provedor além do que o back precisa. Credencial real. Estado persistente entre execuções.

[DECISAO] Exceção única ao "sem estado entre execuções": a chave RSA de TESTE que assina o `id_token` do `google-calendar` (`src/id-token.ts`) fica em `%TEMP%/fake-google-calendar-e2e-key.pem` (ou `FAKE_GOOGLE_CALENDAR_KEY_FILE`) e é reaproveitada. Por quê: o back guarda em cache as chaves do JWKS (`Google:CertificatesUrl`) e, com `reuseExistingServer`, segue vivo enquanto o fake reinicia; chave nova a cada subida reprovaria todo `id_token` até o cache expirar. A chave não tem valor fora do E2E e não vai para o git. Nenhum outro dado (contas, agendas, eventos) sobrevive ao processo.

## Armadilhas

- Fake respondendo campo a mais "para ficar igual ao real": o teste passa por motivo que o back não lê.
- Porta trocada em um dos três registros: o back chama o provedor real ou recebe conexão recusada.
- Webhook disparado sem assinatura válida: 401 no back e o teste acusa o fluxo errado.

## Veja também

`README.md` desta pasta. Pai: `../CLAUDE.md`. Irmãos no back: `Infrastructure/CLAUDE.md` (adapters).
