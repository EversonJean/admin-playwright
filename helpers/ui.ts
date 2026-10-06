import { Locator, Page } from '@playwright/test';

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
