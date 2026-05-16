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
