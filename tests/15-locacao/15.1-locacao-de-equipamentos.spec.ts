import { tenantTest as test } from '../../fixtures/tenant.fixture';

/**
 * Fluxo: 15.1 — Locação de equipamentos (add-on)
 * Diagrama: docs/fluxos/negocio-15.1-locacao-de-equipamentos.mmd
 * Especificação: docs/FUNCIONALIDADES-NEGOCIO.md §15.1
 *
 * Como implementar:
 *  1. Abrir o .mmd no VSCode (preview Mermaid) ou em https://mermaid.live
 *  2. Cada caixa numerada (N01, N02, ...) vira 1+ ação/assert no teste
 *  3. Decisões (losangos) viram `test()` separados (golden + alternativas)
 *  4. Trocar `test.fixme` por `test` quando rodar verde
 */
test.describe('Fluxo 15.1 — locacao-de-equipamentos', () => {
  test.fixme('TODO: implementar fluxo 15.1', async ({ page, tenant }) => {
    // tenant.accessToken, tenant.email, tenant.companyName disponíveis aqui
    // page já tem ignoreHTTPSErrors e baseURL configurados (http://localhost:4200)
  });
});
