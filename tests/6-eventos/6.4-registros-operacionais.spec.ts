import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 6.4 — Registros operacionais (não-comerciais)
 * Diagrama: docs/fluxos/negocio-6.4-registros-operacionais.mmd
 */

test.describe('Fluxo 6.4 — Registros operacionais', () => {
  test('@flow criação de evento operacional carrega', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/events/new-operational');
  });
});
