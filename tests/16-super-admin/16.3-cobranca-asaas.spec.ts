import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 16.3 — Cobrança Asaas (webhook + faturas)
 * Diagrama: docs/fluxos/negocio-16.3-cobranca-asaas.mmd
 *
 * Asaas é integração externa de gateway. Validação E2E completa exige
 * mock do webhook. Aqui smoke da tela de invoices visíveis ao tenant.
 *
 * TODO E2E: cobrir webhook do Asaas quando o time decidir mock strategy.
 */

test.describe('Fluxo 16.3 — Cobrança Asaas', () => {
  test('@flow tela de faturas carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/billing/invoices');
  });
});
