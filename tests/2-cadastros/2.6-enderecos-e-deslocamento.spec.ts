import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 2.6 — Endereços e deslocamento
 * Diagrama: docs/fluxos/negocio-2.6-enderecos-e-deslocamento.mmd
 *
 * O Address é Value Object embutido (Tenant, Client, Collaborator, Event).
 * Aqui validamos a tela de tabela de deslocamento (settings/displacement)
 * usada pelo cálculo de frete por distância (Etapa 35).
 */

test.describe('Fluxo 2.6 — Endereços e deslocamento', () => {
  test('@flow tela de tabela de deslocamento carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/displacement');
  });

  test('@flow tela de criação de regra carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/displacement/new');
  });

  test('@crud cria regra de deslocamento via UI (1 faixa Free open-ended)', async ({
    authPage,
  }) => {
    // GET /api/displacement-rules sofre de bug LINQ não-traduzível
    // (subquery .Count() dentro da projeção do ORDER BY). Aqui validamos a
    // criação pela UI: form submetido com sucesso devolve snackbar e redirect.
    // O bug do GET será coberto em fatia separada de correções do back.
    const nome = `Regra E2E ${Date.now()}`;

    await authPage.goto('/app/settings/displacement/new');
    await authPage.getByTestId('displacement-form-name').fill(nome);
    await authPage.getByTestId('displacement-form-minimum').fill('0');

    // Form já inicializa com 1 faixa vazia. Preenche fromKm e marca "Sem limite".
    await authPage.getByTestId('displacement-form-band-fromKm-0').fill('0');
    await authPage
      .getByTestId('displacement-form-band-openEnded-0')
      .locator('input[type="checkbox"]')
      .check({ force: true });

    await authPage.getByTestId('displacement-form-save').click();

    // Redirect só acontece se o POST retornou 2xx — equivale a "back gravou".
    await authPage.waitForURL(/\/app\/settings\/displacement(\?|$)/, { timeout: 10_000 });
    await expect(authPage.locator('simple-snack-bar', { hasText: /Regra criada/i })).toBeVisible({
      timeout: 5_000,
    });
  });
});
