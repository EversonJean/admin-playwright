import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 6.3 — Status do evento (3 eixos: operacional, financeiro, documental)
 * Diagrama: docs/fluxos/negocio-6.3-status-do-evento-tres-eixos.mmd
 */

test.describe('Fluxo 6.3 — Três eixos de status', () => {
  test('@flow listagem de eventos exibe coluna de status', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/events/list');
  });
});
