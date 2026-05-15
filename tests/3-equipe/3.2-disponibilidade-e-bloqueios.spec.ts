import { tenantTest as test } from '../../fixtures/tenant.fixture';

/**
 * Fluxo: 3.2 — Disponibilidade e bloqueios
 * Diagrama: docs/fluxos/negocio-3.2-disponibilidade-e-bloqueios.mmd
 * Especificação: docs/FUNCIONALIDADES-NEGOCIO.md §3.2
 *
 * Como implementar:
 *  1. Abrir o .mmd no VSCode (preview Mermaid) ou em https://mermaid.live
 *  2. Cada caixa numerada (N01, N02, ...) vira 1+ ação/assert no teste
 *  3. Decisões (losangos) viram `test()` separados (golden + alternativas)
 *  4. Trocar `test.fixme` por `test` quando rodar verde
 */
test.describe('Fluxo 3.2 — disponibilidade-e-bloqueios', () => {
  test.fixme('TODO: implementar fluxo 3.2', async ({ page, tenant }) => {
    // tenant.accessToken, tenant.email, tenant.companyName disponíveis aqui
    // page já tem ignoreHTTPSErrors e baseURL configurados (http://localhost:4200)
  });
});
