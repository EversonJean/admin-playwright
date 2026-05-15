import { tenantTest as test } from '../../fixtures/tenant.fixture';

/**
 * Fluxo: 16.5 — Personalização por tenant
 * Diagrama: docs/fluxos/negocio-16.5-personalizacao-por-tenant.mmd
 * Especificação: docs/FUNCIONALIDADES-NEGOCIO.md §16.5
 *
 * Como implementar:
 *  1. Abrir o .mmd no VSCode (preview Mermaid) ou em https://mermaid.live
 *  2. Cada caixa numerada (N01, N02, ...) vira 1+ ação/assert no teste
 *  3. Decisões (losangos) viram `test()` separados (golden + alternativas)
 *  4. Trocar `test.fixme` por `test` quando rodar verde
 */
test.describe('Fluxo 16.5 — personalizacao-por-tenant', () => {
  test.fixme('TODO: implementar fluxo 16.5', async ({ page, tenant }) => {
    // tenant.accessToken, tenant.email, tenant.companyName disponíveis aqui
    // page já tem ignoreHTTPSErrors e baseURL configurados (http://localhost:4200)
  });
});
