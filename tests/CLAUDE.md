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

## Veja também

Pai: `../CLAUDE.md`. `docs/fluxos/FLUXOS.md`.
