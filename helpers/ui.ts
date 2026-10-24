import { Locator, Page, Route } from '@playwright/test';

/**
 * Localizadores de UI que nao sao de uma tela so (Angular Material).
 */

/**
 * Snackbar do Material com o texto pedido. `.last()` porque o `errorInterceptor`
 * global pode empilhar o proprio aviso antes do que a feature mostra (ver
 * `tests/CLAUDE.md`, "Snackbar de erro aparece duas vezes").
 */
export function snack(page: Page, text: string | RegExp): Locator {
  return page.locator('mat-snack-bar-container').filter({ hasText: text }).last();
}

/**
 * A tela recebe a lista de permissions do usuário SEM os códigos dados (molde
 * do `17.6`, E62). É o papel customizado visto pelo front: os perfis são fixos
 * e o mapa papel -> permissions é global no back (`Role`, sem `TenantId`), então
 * o e2e não monta um papel de verdade sem uma permission que todos os perfis
 * padrão têm. O back continua valendo: o spec confere a API com um usuário real
 * quando existe perfil padrão sem a permission. Chamar ANTES do primeiro `goto`.
 */
export async function stripUiPermissions(page: Page, codes: readonly string[]): Promise<void> {
  await page.route('**/api/me/permissions', async (route: Route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { data?: { permissions: string[] }; permissions?: string[] };
    const holder = (body.data ?? body) as { permissions?: string[] };
    holder.permissions = (holder.permissions ?? []).filter((p) => !codes.includes(p));
    await route.fulfill({ response, json: body });
  });
}
