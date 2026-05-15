import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 2.3 — Tipos de evento
 * Diagrama: docs/fluxos/negocio-2.3-tipos-de-evento.mmd
 */

test.describe('Fluxo 2.3 — Tipos de evento', () => {
  test('@flow tela de listagem carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/event-categories');
  });

  test('@flow tela de criação carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/event-categories/new');
  });
});
