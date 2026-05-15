import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 14.1 — Auditoria
 * Diagrama: docs/fluxos/negocio-14.1-auditoria.mmd
 */

test.describe('Fluxo 14.1 — Auditoria', () => {
  test('@flow tela de audit logs carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/audit');
  });
});
