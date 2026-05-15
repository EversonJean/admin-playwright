import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 8 — Calendário e agenda
 * Diagrama: docs/fluxos/negocio-8-calendario-e-agenda.mmd
 */

test.describe('Fluxo 8 — Calendário e agenda', () => {
  test('@flow tela de calendário carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/schedule/calendar');
  });
});
