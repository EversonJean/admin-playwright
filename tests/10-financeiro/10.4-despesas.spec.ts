import { tenantTest as test } from '../../fixtures/tenant.fixture';

/**
 * Fluxo: 10.4 — Despesas operacionais do evento
 * Diagrama: docs/fluxos/negocio-10.4-despesas.mmd
 * Especificação: docs/FUNCIONALIDADES-NEGOCIO.md §10.4
 *
 * Como implementar:
 *  1. Abrir o .mmd no VSCode (preview Mermaid) ou em https://mermaid.live
 *  2. Cada caixa numerada (N01, N02, ...) vira 1+ ação/assert no teste
 *  3. Decisões (losangos) viram `test()` separados (golden + alternativas)
 *  4. Trocar `test.fixme` por `test` quando rodar verde
 */
test.describe('Fluxo 10.4 — despesas', () => {
  test.fixme('TODO: implementar fluxo 10.4', async ({ page, tenant }) => {
    // tenant.accessToken, tenant.email, tenant.companyName disponíveis aqui
    // page já tem ignoreHTTPSErrors e baseURL configurados (http://localhost:4200)
  });
});
