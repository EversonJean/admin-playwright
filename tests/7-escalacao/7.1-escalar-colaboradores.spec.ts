import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 7.1 — Escalar colaboradores
 * Diagrama: docs/fluxos/negocio-7.1-escalar-colaboradores.mmd
 *
 * Escalação acontece dentro do detalhe do Event. Aqui smoke da listagem
 * de eventos (origem do drill-down).
 */

test.describe('Fluxo 7.1 — Escalar colaboradores', () => {
  test('@flow listagem de eventos carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/events/list');
  });
});
