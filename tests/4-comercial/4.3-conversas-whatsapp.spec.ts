import { authTest as test, expect } from '../../fixtures/auth.fixture';

/**
 * Fluxo: 4.3 — Conversas / WhatsApp
 * Diagrama: docs/fluxos/negocio-4.3-conversas-whatsapp.mmd
 *
 * Conversations + WhatsApp passivo são add-ons gated. Validação E2E completa
 * requer mockar o provider WhatsApp (webhook + envio), que está fora do
 * escopo local. Aqui só validamos que a rota carrega sem 500.
 *
 * TODO E2E: cobrir o fluxo completo quando o time decidir como mockar
 * o provider WhatsApp em ambiente de teste.
 */

test.describe('Fluxo 4.3 — Conversas / WhatsApp', () => {
  test('@flow tela de conversas carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/conversations');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });
});
