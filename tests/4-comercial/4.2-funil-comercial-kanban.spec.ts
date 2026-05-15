import { tenantTest as test } from '../../fixtures/tenant.fixture';

/**
 * Fluxo: 4.2 — Funil comercial (Kanban)
 * Diagrama: docs/fluxos/negocio-4.2-funil-comercial-kanban.mmd
 * Especificação: docs/FUNCIONALIDADES-NEGOCIO.md §4.2
 *
 * Como implementar:
 *  1. Abrir o .mmd no VSCode (preview Mermaid) ou em https://mermaid.live
 *  2. Cada caixa numerada (N01, N02, ...) vira 1+ ação/assert no teste
 *  3. Decisões (losangos) viram `test()` separados (golden + alternativas)
 *  4. Trocar `test.fixme` por `test` quando rodar verde
 */
test.describe('Fluxo 4.2 — funil-comercial-kanban', () => {
  test.fixme('TODO: implementar fluxo 4.2', async ({ page, tenant }) => {
    // tenant.accessToken, tenant.email, tenant.companyName disponíveis aqui
    // page já tem ignoreHTTPSErrors e baseURL configurados (http://localhost:4200)
  });
});
