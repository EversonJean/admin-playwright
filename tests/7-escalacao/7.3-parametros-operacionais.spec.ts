import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 7.3 — Parâmetros operacionais (configuráveis por empresa)
 * Diagrama: docs/fluxos/negocio-7.3-parametros-operacionais.mmd
 *
 * Inclui modalidades, níveis, prazos de pagamento — todos sob /app/settings/*.
 */

test.describe('Fluxo 7.3 — Parâmetros operacionais', () => {
  test('@flow modalidades carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/service-modalities');
  });

  test('@flow níveis de colaborador carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/collaborator-levels');
  });

  test('@flow termos de pagamento carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/payment-terms');
  });

  test('@flow tela geral de parâmetros carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/parameters');
  });

  test('@crud cria modalidade via UI e valida no back', async ({ authPage, authApi }) => {
    const nome = `Modalidade E2E ${Date.now()}`;

    await authPage.goto('/app/settings/service-modalities/new');
    await authPage.getByTestId('modality-form-name').fill(nome);
    await authPage.getByTestId('modality-form-value').fill('150');
    await authPage.getByTestId('modality-form-save').click();

    await authPage.waitForURL(/\/app\/settings\/service-modalities(\?|$)/, { timeout: 10_000 });

    const res = await authApi.get('/api/service-modalities');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const items = body.data?.items ?? body.items ?? body.data ?? body;
    const list = Array.isArray(items) ? items : items.items ?? [];
    expect(list.some((m: { name?: string }) => m.name === nome)).toBe(true);
  });

  test('@crud cria nível de colaborador via UI e valida no back', async ({ authPage, authApi }) => {
    const nome = `Nível E2E ${Date.now()}`;

    await authPage.goto('/app/settings/collaborator-levels/new');
    await authPage.getByTestId('level-form-name').fill(nome);
    await authPage.getByTestId('level-form-order').fill('99');
    await authPage.getByTestId('level-form-base-value').fill('200');
    await authPage.getByTestId('level-form-save').click();

    await authPage.waitForURL(/\/app\/settings\/collaborator-levels(\?|$)/, { timeout: 10_000 });

    const res = await authApi.get('/api/collaborator-levels');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    const items = body.data?.items ?? body.items ?? body.data ?? body;
    const list = Array.isArray(items) ? items : items.items ?? [];
    expect(list.some((l: { name?: string }) => l.name === nome)).toBe(true);
  });
});
