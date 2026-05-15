import { tenantTest as test } from '../../fixtures/tenant.fixture';

/**
 * Fluxo: 9.6 — IA para criação de cláusulas (add-on)
 * Diagrama: docs/fluxos/negocio-9.6-ia-em-clausulas.mmd
 * Especificação: docs/FUNCIONALIDADES-NEGOCIO.md §9.6
 *
 * Como implementar:
 *  1. Abrir o .mmd no VSCode (preview Mermaid) ou em https://mermaid.live
 *  2. Cada caixa numerada (N01, N02, ...) vira 1+ ação/assert no teste
 *  3. Decisões (losangos) viram `test()` separados (golden + alternativas)
 *  4. Trocar `test.fixme` por `test` quando rodar verde
 */
test.describe('Fluxo 9.6 — ia-em-clausulas', () => {
  test.fixme('TODO: implementar fluxo 9.6', async ({ page, tenant }) => {
    // tenant.accessToken, tenant.email, tenant.companyName disponíveis aqui
    // page já tem ignoreHTTPSErrors e baseURL configurados (http://localhost:4200)
  });
});
