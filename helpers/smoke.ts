import { Page, expect } from '@playwright/test';

export interface SmokeRouteOptions {
  /**
   * `data-testid` de um elemento que só existe quando a tela pedida abriu (a
   * raiz do template, `<feature>-page`). Obrigatório: sem ele as checagens
   * rodavam logo depois do `goto`, antes de os guards e a tela agirem, e o
   * redirect do `onboardingGuard` passava ou derrubava o teste conforme a
   * velocidade (Etapa 244).
   */
  ready: string;
  expectStatus?: number;
}

/** Escapa a rota para o regex da URL: `?`, `.` e afins valem literais. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Helper de smoke pra fluxos: navega pra rota autenticada, espera a tela abrir
 * e valida que ficou nela, sem erro 403/404 e sem mensagem de "Acesso negado".
 *
 * Estratégia mínima viável pra ter cobertura ampla — não substitui asserts
 * detalhados nos fluxos com lógica complexa, mas dá sinal de regressão se a
 * rota quebrar ou se a permissão associada sair de sync com a entidade.
 *
 * [ALERTA] Tenant recém-criado cai no assistente de configuração: o spec chama
 * `apiCompleteOnboarding(authApi)` antes, senão a tela nunca abre.
 */
export async function smokeRoute(page: Page, route: string, options: SmokeRouteOptions): Promise<void> {
  const response = await page.goto(route);
  if (options.expectStatus) {
    expect(response?.status()).toBe(options.expectStatus);
  } else {
    expect(response?.status() ?? 0).toBeLessThan(400);
  }
  // Primeiro a tela: só depois dela os guards já decidiram e a URL é a final.
  await expect(page.getByTestId(options.ready)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`${escapeRegExp(route)}(?:[?#]|$)`));
  // Sem mensagens de erro genéricas (403, 500, "algo deu errado"). O `403` vai
  // entre \b: o nome do tenant de teste leva um sufixo hex ("Festinha 796403a6",
  // no topo da tela) e o `403` solto casava com ele (Etapa 244).
  await expect(page.getByText(/acesso negado|\b403\b|erro interno|algo deu errado/i)).toHaveCount(0);
}
