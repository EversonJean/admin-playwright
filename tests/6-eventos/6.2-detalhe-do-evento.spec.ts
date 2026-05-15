import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 6.2 — Detalhe do evento
 * Diagrama: docs/fluxos/negocio-6.2-detalhe-do-evento.mmd
 */

test.describe('Fluxo 6.2 — Detalhe do evento', () => {
  test('@flow listagem de eventos carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/events/list');
  });
});
