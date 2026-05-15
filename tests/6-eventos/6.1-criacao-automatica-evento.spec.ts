import { tenantTest as test } from '../../fixtures/tenant.fixture';

/**
 * Fluxo: 6.1 — Criação automática do evento
 * Diagrama: docs/fluxos/negocio-6.1-criacao-automatica-evento.mmd
 * Especificação: docs/FUNCIONALIDADES-NEGOCIO.md §6.1
 *
 * Como implementar:
 *  1. Abrir o .mmd no VSCode (preview Mermaid) ou em https://mermaid.live
 *  2. Cada caixa numerada (N01, N02, ...) vira 1+ ação/assert no teste
 *  3. Decisões (losangos) viram `test()` separados (golden + alternativas)
 *  4. Trocar `test.fixme` por `test` quando rodar verde
 */
test.describe('Fluxo 6.1 — criacao-automatica-evento', () => {
  test.fixme('TODO: implementar fluxo 6.1', async ({ page, tenant }) => {
    // tenant.accessToken, tenant.email, tenant.companyName disponíveis aqui
    // page já tem ignoreHTTPSErrors e baseURL configurados (http://localhost:4200)
  });
});
