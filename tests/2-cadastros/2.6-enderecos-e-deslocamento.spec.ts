import { authTest as test } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 2.6 — Endereços e deslocamento
 * Diagrama: docs/fluxos/negocio-2.6-enderecos-e-deslocamento.mmd
 *
 * O Address é Value Object embutido (Tenant, Client, Collaborator, Event).
 * Aqui validamos a tela de tabela de deslocamento (settings/displacement)
 * usada pelo cálculo de frete por distância (Etapa 35).
 */

test.describe('Fluxo 2.6 — Endereços e deslocamento', () => {
  test('@flow tela de tabela de deslocamento carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/displacement');
  });

  test('@flow tela de criação de regra carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/displacement/new');
  });
});
