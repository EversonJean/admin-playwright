# tests/

## Papel desta pasta

Specs por área de negócio, numerados como os fluxos de `docs/fluxos/`: `tests/<N>-<area>/<N.M>-<fluxo>.spec.ts`. `0-infra/` guarda os transversais (isolamento multi-tenant, gates de permission e entitlement, idempotência de webhook, invariantes de dinheiro, rejeição de transição de estado, paginação/filtros, health). `fluxos-completos/` encadeia várias áreas.

## Forma de um spec novo

```ts
import { authTest as test, expect } from '../../fixtures/auth.fixture';   // ou tenantTest / twoTenantsTest / superAdminTest
import { smokeRoute } from '../../helpers/smoke';
import { apiCreateClient } from '../../helpers/api-entities';

/**
 * Fluxo: <N.M> — <nome>
 * Diagrama: docs/fluxos/negocio-<N.M>-<nome>.mmd
 */
test.describe('Fluxo <N.M> — <nome>', () => {
  test('@smoke tela carrega autenticada', async ({ authPage }) => { await smokeRoute(authPage, '/app/<rota>'); });

  test('@flow cria via API e aparece na listagem', async ({ authApi }) => { const c = await apiCreateClient(authApi); … });

  test('@crud cria via UI e valida no back', async ({ authPage, authApi }) => {
    await authPage.goto('/app/<rota>/new');
    await authPage.getByTestId('<feature>-form-name').fill(`E2E ${Date.now()}`);
    await authPage.getByTestId('<feature>-form-save').click();
    await authPage.waitForURL(/\/app\/<rota>\/list/);
    const res = await authApi.get('/api/<recurso>'); expect(res.ok()).toBe(true);
  });
});
```

- Cabeçalho com número do fluxo e caminho do diagrama.
- Tags: `@smoke` (um por área, caminho crítico), `@flow` (via API), `@crud` (via UI). `npm run test:smoke` filtra `@smoke`.
- Fixture escolhida pelo que o teste prova: `twoTenantsTest` para isolamento; `superAdminTest` para `16-super-admin`.
- Pré-condição via `helpers/api-entities`; se falta helper para a entidade nova, criar lá (padrão `apiCreate{X}` com `expectOk`).
- Dado único por `Date.now()`; nunca depender de dado semeado.
- Integração externa: agir, depois ler `/_control/inbox` do fake com filtro por `tenantId`/`path`.

## Checklist ao criar

1. Número livre na área (ou área nova `<N>-<area>` se não existe). 2. Diagrama `.mmd` em `docs/fluxos/` com o mesmo número e linha em `FLUXOS.md`. 3. `data-testid` no front para tudo que o spec toca. 4. Rodar só o spec novo antes de rodar a área.

## O que NÃO vai aqui

- Teste de componente isolado (spec Karma no front). Chamada a provedor real. Sleep fixo (`waitFor*`).

## Armadilhas

- Criar pré-condição pela UI: lento e frágil; um `getByTestId` renomeado derruba dez specs.
- Assumir formato do envelope na resposta da API: o `authApi` recebe o JSON cru do back (`{ isError, data, errors }`); ler `data`.
- Spec sem `data-testid` novo no front: o seletor por texto quebra na primeira tradução.
- [ALERTA] **Tenant recém-criado cai no assistente de configuração.** O `onboardingGuard` do front (Etapa 109) redireciona para `/app/onboarding` a cada `page.goto` (o "uma vez por sessão" dele reinicia a cada carga de página), e o spec de UI espera um `data-testid` que nunca aparece. Regra: spec de UI do tenant chama `apiCompleteOnboarding(authApi)` no `beforeEach` (`1.3`, `2.x`, `3.1`) ou no teste, antes do primeiro `goto` (`7.x`).
- [ALERTA] **Festa de hoje não nasce por orçamento.** A validade do orçamento fica entre hoje e a véspera da festa (o back mede pela data do tenant), e a véspera da festa de hoje já passou. Crie a festa no futuro e mova a data depois do aceite com `PATCH /api/events/{id}` (`apiPatchEvent`); o `setupAcceptedEvent` já faz isso sozinho quando a véspera cai antes da data UTC de hoje — o que, na sexta das 21:00 à meia-noite de Brasília, desloca também a festa de amanhã, por folga (o produto aceitaria).
- [ALERTA] **Canal WhatsApp é por tenant, e o webhook do fake tem de dizer qual.** O back acha o tenant pelo `phone_number_id` do payload. Use o id que `seedWhatsappChannelDirect` devolve e passe-o em `fakeWhatsApp.triggerWebhook({ phoneNumberId })`. Com o `fake_phone` compartilhado, um spec em outro worker (ou a cópia de um `--repeat`) desligava o canal no meio do teste, e o webhook seguinte caía no tenant alheio com 200 (11.2.1, 2026-10-07). O `mode: 'serial'` só serializa dentro do arquivo.
- `<mat-tab data-testid>` não chega ao cabeçalho renderizado: aba por `getByRole('tab', { name, exact: true })` (sem `exact`, "Equipe" casa "Roteiro da equipe").
- Snackbar de erro aparece duas vezes por instantes: o `errorInterceptor` global notifica e a feature substitui pela mensagem do tradutor. Localize com `.last()`.

## Veja também

Pai: `../CLAUDE.md`. `docs/fluxos/FLUXOS.md`.
