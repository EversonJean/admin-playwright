import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 11.2 — WhatsApp (add-on)
 * Diagrama: docs/fluxos/negocio-11.2-whatsapp.mmd
 *
 * WhatsApp passivo é add-on gated. Validação E2E completa exige mock do
 * provider WhatsApp (webhook + envio). Aqui smoke da tela conversations.
 */

test.describe('Fluxo 11.2 — WhatsApp', () => {
  test('@flow tela de conversations carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/conversations');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });
});
