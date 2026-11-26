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

/**
 * Card de festa no calendário (FullCalendar, vista de mês) num dia, pelo texto
 * do card (o nome do cliente). O FullCalendar não aceita `data-testid` por
 * evento; o card se acha pela célula do dia (`data-date`).
 */
export function calendarCard(page: Page, isoDate: string, text: string): Locator {
  return page.locator(`td.fc-daygrid-day[data-date="${isoDate}"] .fc-event`).filter({ hasText: text });
}

/**
 * Arrasta o card da festa para outro dia na vista de mês, como o gestor faz
 * (mouse de verdade: o FullCalendar ignora o `dragTo` sintético).
 */
export async function dragCalendarCard(page: Page, fromIsoDate: string, text: string, toIsoDate: string): Promise<void> {
  const card = calendarCard(page, fromIsoDate, text).and(page.locator('.fc-event-draggable'));
  await card.waitFor({ state: 'visible', timeout: 30_000 });
  const targetCell = page.locator(`td.fc-daygrid-day[data-date="${toIsoDate}"]`);
  await targetCell.waitFor({ state: 'visible' });
  // O quadro do mês fica abaixo da dobra (filtros em cima): o mouse só arrasta
  // o que está na tela, então o card vai para o meio da área visível antes.
  await card.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
  const from = (await card.boundingBox())!;
  const to = (await targetCell.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
  await page.mouse.up();
}
