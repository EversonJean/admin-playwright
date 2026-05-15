import { tenantTest as test } from '../../fixtures/tenant.fixture';

/**
 * Fluxo: 1.2 — Configurar identidade da empresa
 * Diagrama: docs/fluxos/negocio-1.2-configurar-identidade-empresa.mmd
 * Especificação: docs/FUNCIONALIDADES-NEGOCIO.md §1.2
 *
 * Como implementar:
 *  1. Abrir o .mmd no VSCode (preview Mermaid) ou em https://mermaid.live
 *  2. Cada caixa numerada (N01, N02, ...) vira 1+ ação/assert no teste
 *  3. Decisões (losangos) viram `test()` separados (golden + alternativas)
 *  4. Trocar `test.fixme` por `test` quando rodar verde
 */
test.describe('Fluxo 1.2 — configurar-identidade-empresa', () => {
  test.fixme('TODO: implementar fluxo 1.2', async ({ page, tenant }) => {
    // tenant.accessToken, tenant.email, tenant.companyName disponíveis aqui
    // page já tem ignoreHTTPSErrors e baseURL configurados (http://localhost:4200)
  });
});
