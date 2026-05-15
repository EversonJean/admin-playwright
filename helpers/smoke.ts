import { Page, expect } from '@playwright/test';

/**
 * Helper de smoke pra fluxos: navega pra rota autenticada, valida que carregou
 * sem erro 403/404 e sem mensagem de "Acesso negado".
 *
 * Estratégia mínima viável pra ter cobertura ampla — não substitui asserts
 * detalhados nos fluxos com lógica complexa, mas dá sinal de regressão se a
 * rota quebrar ou se a permissão associada sair de sync com a entidade.
 */
export async function smokeRoute(
  page: Page,
  route: string,
  options: { expectStatus?: number } = {},
): Promise<void> {
  const response = await page.goto(route);
  if (options.expectStatus) {
    expect(response?.status()).toBe(options.expectStatus);
  } else {
    expect(response?.status() ?? 0).toBeLessThan(400);
  }
  await expect(page).toHaveURL(new RegExp(route.replace(/\//g, '\\/')));
  // Sem mensagens de erro genéricas (403, 500, "algo deu errado")
  await expect(page.getByText(/acesso negado|403|erro interno|algo deu errado/i)).toHaveCount(0);
}
