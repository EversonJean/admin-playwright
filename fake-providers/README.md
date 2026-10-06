# Fake providers — servidores Node simulando integrações externas em E2E

Cada subpasta é um workspace npm independente que sobe um servidor Fastify
respondendo como o provider real. O back faz HTTP **de verdade** contra eles,
e os testes consultam/disparam ações via endpoints `/_control/*`.

## Servidores e portas

| Pasta | Porta | Simula |
|---|---|---|
| `asaas/` | 1510 | Asaas v3 (customers, payments, subscriptions, webhooks) |
| `clicksign/` | 1511 | ClickSign v1/v3 (documents, signers, webhook callbacks) |
| `whatsapp-meta/` | 1512 | Meta Graph API v18+ (messages, message_templates) |
| `email/` | 1513 | REST simples — `POST /send` (provider `Http` no back) |
| `openai/` | 1514 | OpenAI v1 (`/v1/chat/completions`) |
| `anthropic/` | 1515 | Anthropic v1 (`/v1/messages`) |
| `google-maps/` | 1516 | Maps API (Places autocomplete/details + DistanceMatrix) |
| `google-calendar/` | 1517 | Google Agenda: OAuth (`/token`, `/revoke`), JWKS do id_token (`/oauth2/v3/certs`) e Calendar API v3 (`/calendar/v3/...`) |

### `google-calendar/` — controle

Estado por **conta** (`sub` do id_token): cada spec autoriza a sua e não enxerga
as outras. Helper: `fakeGoogleCalendar` em `helpers/fake-providers.ts`;
conexão pelo back em `helpers/external-calendar.ts` (`apiConnectGoogleCalendar`).

- `POST /_control/authorize` `{ sub?, email?, scope?, omitRefreshToken?, omitIdToken?, idTokenAudience? }`
  devolve `{ code, sub, email }`: o código de uso único que o "popup" do GIS daria.
  O `connect` do back troca esse código em `/token` e recebe um id_token RS256
  assinado pela chave do fake (o back confere pelo `Google:CertificatesUrl`).
  O `/token` confere `client_id` e `client_secret` contra os valores de teste do
  `appsettings.E2E.json` do back (`invalid_client`, 401) e, na troca de código,
  `redirect_uri=postmessage` (`redirect_uri_mismatch`, 400).
- `GET /_control/accounts/:sub`: grants, falha ativa, agendas e todos os eventos
  (com `colorId`, `summary`, `description`, `reminders`, `visibility`,
  `transparency`, `extendedProperties`, `status`; `cancelled` = lixeira).
- `POST /_control/accounts/:sub/revoke`: "remover acesso" na conta Google
  (API 401 e refresh `invalid_grant` para todos os grants da conta).
- `PUT /_control/accounts/:sub/failure` `{ mode, times? }` / `DELETE` limpa:
  `500` (API e token), `429`, `invalid_grant`, `401` (só API), `404calendar`.
- `GET|DELETE /_control/calendars/:id`: lê, ou apaga a agenda "à mão".
- `POST /_control/calendars/:id/events`: evento criado à mão (sem marcador, salvo
  `extendedProperties` no corpo).
- `DELETE /_control/calendars/:id/events/:eid[?purge=true]`: apagado à mão; sem
  `purge` vai para a lixeira (PATCH restaura, insert do mesmo id dá 409), com
  `purge` some (404).
- `DELETE /_control/state`: limpa todas as contas (só depuração, nunca num spec).

## Contrato uniforme de cada server

Todo server expõe, além dos endpoints específicos do provider:

- `GET /_control/health` — probe usado pelo Playwright `webServer.url`
- `GET /_control/inbox` — lista todos os requests recebidos. Filtros opcionais:
  - `?tenantId=<guid>` (quando o back propaga via header `X-Tenant-Id`)
  - `?path=<substring>` filtra pela URL recebida
  - `?since=<iso8601>` só itens após determinado ts
- `DELETE /_control/inbox` — limpa o inbox
- `POST /_control/trigger-webhook` — dispara webhook real (HTTP) pro back. Body:
  ```json
  { "endpoint": "/api/billing/asaas/webhook", "event": "...", "payload": {...} }
  ```

## Como sobem nos testes

`playwright.config.ts` declara cada server na lista `webServer`. Playwright
sobe todos antes de rodar os specs e mata todos depois. O back (`dotnet run
--launch-profile e2e`) aponta `BaseUrl` de cada provider pra `http://localhost:<porta>`
via `appsettings.E2E.json`.

## Desenvolvimento

Cada workspace tem `npm run start` (Fastify com hot reload via tsx). Pra rodar
isolado:

```
npm run fakes:asaas
```

Compartilham `shared/` que exporta:
- `createFakeServer(options)` — base Fastify com inbox e control endpoints
- `WebhookDispatcher` — envia HTTP real assinado pro back
- `tenantFromRequest(req)` — extrai TenantId do header
