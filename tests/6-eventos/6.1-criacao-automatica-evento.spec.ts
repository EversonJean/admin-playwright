import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 6.1 — Criação automática do evento (no aceite do orçamento)
 * Diagrama: docs/fluxos/negocio-6.1-criacao-automatica-evento.mmd
 *
 * Event nasce automaticamente no aceite do Budget. Fluxo completo coberto
 * incrementalmente; aqui smoke da listagem.
 */

test.describe('Fluxo 6.1 — Criação automática do evento', () => {
  test('@flow listagem de eventos carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/events/list');
  });

  test('@flow criação manual operacional carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/events/new-operational');
  });
});
