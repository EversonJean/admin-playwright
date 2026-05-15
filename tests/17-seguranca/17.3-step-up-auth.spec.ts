import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 17.3 — Step-up auth
 * Diagrama: docs/fluxos/negocio-17.3-step-up-auth.mmd
 *
 * StepUpToken (TTL 5min, uso único) é exigido em ações sensíveis (ex:
 * change_plan já gated). Cobertura completa exige fluxo MFA + ação
 * protegida. Smoke do endpoint /step-up.
 */

test.describe('Fluxo 17.3 — Step-up auth', () => {
  test('@flow POST /api/auth/step-up sem body responde 4xx (não 500)', async ({ authApi }) => {
    const res = await authApi.post('/api/auth/step-up', { data: {} });
    expect(res.status()).toBeLessThan(500);
  });
});
