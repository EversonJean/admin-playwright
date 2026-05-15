import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 7.2 — Confirmação do colaborador
 * Diagrama: docs/fluxos/negocio-7.2-confirmacao-colaborador.mmd
 *
 * Colaborador confirma/recusa via portal `/portal/*` — fluxo desse usuário
 * tem rota separada e fixture própria (CollaboratorPortal). Aqui smoke da
 * listagem de eventos onde aparece quem confirmou.
 */

test.describe('Fluxo 7.2 — Confirmação do colaborador', () => {
  test('@flow tela de calendário time-timeline carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/schedule/calendar');
  });
});
