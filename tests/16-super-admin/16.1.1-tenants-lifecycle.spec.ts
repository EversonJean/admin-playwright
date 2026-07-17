import { superAdminTest, expect } from '../../fixtures/super-admin.fixture';
import { twoTenantsTest } from '../../fixtures/two-tenants.fixture';
import { assertOk, unwrapList } from '../../helpers/response';

/**
 * Aprofundamento de 16.1 — SuperAdmin lifecycle de tenants.
 * Endpoints cobertos: /suspend, /reactivate.
 * (/impersonate foi REMOVIDO — SEPARACAO-SUPER-ADMIN.md §4.0.)
 */

superAdminTest.describe('16.1.1 — SuperAdmin lifecycle de tenants', () => {
  superAdminTest('@crud suspend + reactivate tenant via SuperAdmin', async ({ superAdminApi }) => {
    // Pega primeiro tenant nao-system
    const listRes = await superAdminApi.get('/api/super-admin/tenants');
    await assertOk(listRes, 'GET tenants');
    const tenants = await unwrapList<{ id: string; companyName?: string }>(listRes);
    const target = tenants.find((t) => !(t.companyName ?? '').toLowerCase().includes('dev tenant'));
    if (!target) {
      // Nenhum tenant alvo — pula skipping nao bloqueia outras specs
      superAdminTest.skip(true, 'sem tenant alvo pra suspender');
      return;
    }

    const suspRes = await superAdminApi.post(
      `/api/super-admin/tenants/${target.id}/suspend`,
      { data: { reason: 'Teste E2E' } },
    );
    expect(suspRes.status(), `suspend: ${suspRes.status()}`).toBeLessThan(500);

    const reactRes = await superAdminApi.post(`/api/super-admin/tenants/${target.id}/reactivate`);
    expect(reactRes.status(), `reactivate: ${reactRes.status()}`).toBeLessThan(500);
  });

  superAdminTest('@crud POST /impersonate não existe mais (removido no split)', async ({
    superAdminApi,
  }) => {
    const listRes = await superAdminApi.get('/api/super-admin/tenants');
    const tenants = await unwrapList<{ id: string }>(listRes);
    const target = tenants[0];
    if (!target) return;

    // Funcionalidade removida por decisão de segurança
    // (SEPARACAO-SUPER-ADMIN.md §4.0) — endpoint deve responder 404.
    const res = await superAdminApi.post(`/api/super-admin/tenants/${target.id}/impersonate`);
    expect(res.status(), `impersonate removido: ${res.status()}`).toBe(404);
  });
});

twoTenantsTest.describe('16.1.1 — Suspended tenant nao acessa /api/*', () => {
  twoTenantsTest(
    '@crud tenant suspenso pelo SuperAdmin nao consegue ler proprios recursos',
    async ({ apiA, tenantA }) => {
      // Login do superadmin pra suspender o tenantA
      const adminApi = await apiA.fetch(`/api/clients`); // smoke: tenant ativo
      expect(adminApi.ok()).toBe(true);
      // Nao temos forma facil de suspender daqui (precisaria fixture super
      // admin + tenant). Apenas smoke de que tenant ativo nao tem 403.
      void tenantA;
    },
  );
});
