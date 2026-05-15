import { tenantTest as test } from '../../fixtures/tenant.fixture';

/**
 * Fluxo: 8 — Calendário e agenda
 * Diagrama: docs/fluxos/negocio-8-calendario-e-agenda.mmd
 * Especificação: docs/FUNCIONALIDADES-NEGOCIO.md §8
 *
 * Como implementar:
 *  1. Abrir o .mmd no VSCode (preview Mermaid) ou em https://mermaid.live
 *  2. Cada caixa numerada (N01, N02, ...) vira 1+ ação/assert no teste
 *  3. Decisões (losangos) viram `test()` separados (golden + alternativas)
 *  4. Trocar `test.fixme` por `test` quando rodar verde
 */
test.describe('Fluxo 8 — calendario-e-agenda', () => {
  test.fixme('TODO: implementar fluxo 8', async ({ page, tenant }) => {
    // tenant.accessToken, tenant.email, tenant.companyName disponíveis aqui
    // page já tem ignoreHTTPSErrors e baseURL configurados (http://localhost:4200)
  });
});
