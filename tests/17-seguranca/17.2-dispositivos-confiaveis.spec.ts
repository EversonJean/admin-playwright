import { tenantTest as test } from '../../fixtures/tenant.fixture';

/**
 * Fluxo: 17.2 — Dispositivos confiáveis
 * Diagrama: docs/fluxos/negocio-17.2-dispositivos-confiaveis.mmd
 * Especificação: docs/FUNCIONALIDADES-NEGOCIO.md §17.2
 *
 * Como implementar:
 *  1. Abrir o .mmd no VSCode (preview Mermaid) ou em https://mermaid.live
 *  2. Cada caixa numerada (N01, N02, ...) vira 1+ ação/assert no teste
 *  3. Decisões (losangos) viram `test()` separados (golden + alternativas)
 *  4. Trocar `test.fixme` por `test` quando rodar verde
 */
test.describe('Fluxo 17.2 — dispositivos-confiaveis', () => {
  test.fixme('TODO: implementar fluxo 17.2', async ({ page, tenant }) => {
    // tenant.accessToken, tenant.email, tenant.companyName disponíveis aqui
    // page já tem ignoreHTTPSErrors e baseURL configurados (http://localhost:4200)
  });
});
