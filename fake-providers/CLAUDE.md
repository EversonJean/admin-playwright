# fake-providers/

## Papel desta pasta

Um servidor Fastify por provedor externo, cada um um workspace npm (`asaas` 1510, `clicksign` 1511, `whatsapp-meta` 1512, `email` 1513, `openai` 1514, `anthropic` 1515, `google-maps` 1516) mais `shared/` (inbox, controle, utilitários). O back faz HTTP real contra eles em E2E; os specs consultam e disparam ações por `/_control/*`. Portas e contrato no `README.md` desta pasta.

## Forma de um fake novo

```
fake-providers/<provider>/
├── package.json            workspace; script `start`
├── tsconfig.json           estende ../tsconfig.base.json
└── src/
    ├── server.ts           Fastify na porta fixa; registra rotas do provider + as de controle de `shared/`
    └── routes/*.ts         uma rota por endpoint que o BACK chama, com o shape mínimo que o back lê
```

- Implementar **só o que o back chama** (rotas listadas no adapter em `admin-backend/src/AdminBackend.Infrastructure/<Provider>/`), com resposta determinística e IDs previsíveis.
- Toda request cai no inbox de `shared/` (`GET /_control/inbox` com filtros `tenantId`, `path`, `since`; `DELETE` para limpar).
- Webhook para o back via `POST /_control/trigger-webhook` com `endpoint`, `event`, `payload`; assinatura/token válidos para o ambiente E2E (o back é fail-closed).
- Erro simulável por header ou rota de controle (`/_control/fail-next`), não por mudar código.
- Registrar em `playwright.config.ts` (`webServer` com `url: /_control/health`), em `package.json` raiz (`fakes:<provider>`) e em `appsettings.E2E.json` do back (`BaseUrl`).

## Checklist ao criar

1. Ler o adapter do back para listar rotas e campos lidos. 2. Servidor + rotas + inbox. 3. Três registros (config do Playwright, script npm, appsettings E2E). 4. Spec em `0-infra` ou na área que prova o fluxo lendo o inbox.

## O que NÃO vai aqui

- Lógica de negócio do provedor além do que o back precisa. Credencial real. Estado persistente entre execuções.

## Armadilhas

- Fake respondendo campo a mais "para ficar igual ao real": o teste passa por motivo que o back não lê.
- Porta trocada em um dos três registros: o back chama o provedor real ou recebe conexão recusada.
- Webhook disparado sem assinatura válida: 401 no back e o teste acusa o fluxo errado.

## Veja também

`README.md` desta pasta. Pai: `../CLAUDE.md`. Irmãos no back: `Infrastructure/CLAUDE.md` (adapters).
