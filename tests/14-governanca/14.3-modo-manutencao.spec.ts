import { test, expect, request as playwrightRequest } from '@playwright/test';
import { superAdminTest } from '../../fixtures/super-admin.fixture';

/**
 * Fluxo: 14.3 — Modo manutenção
 * Diagrama: docs/fluxos/negocio-14.3-modo-manutencao.mmd
 *
 * SuperAdmin liga/desliga via POST /api/super-admin/maintenance/{enable|
 * disable} (override em memoria do `IRuntimeMaintenanceOverride`).
 * Quando ativo (Full), requests pra `/api/*` que nao estao na whitelist
 * respondem 503; SuperAdmin sempre bypassa.
 */

const BACK_URL = process.env.BACK_URL ?? 'https://localhost:1501';

test.describe('Fluxo 14.3 — Modo manutenção (rota publica)', () => {
  test('@flow rota /maintenance carrega', async ({ page }) => {
    const res = await page.goto('/maintenance');
    expect(res?.status() ?? 0).toBeLessThan(500);
    await expect(page).toHaveURL(/\/maintenance/);
  });
});

superAdminTest.describe('Fluxo 14.3 — Modo manutenção (SuperAdmin runtime)', () => {
  // IMPORTANTE: tests dentro deste describe rodam em sequencia (cada um
  // garante que desliga manutencao no finally pra nao quebrar outros specs).
  superAdminTest.describe.configure({ mode: 'serial' });

  superAdminTest('@crud GET status retorna inactive em estado limpo', async ({
    superAdminApi,
  }) => {
    // Garante limpo
    await superAdminApi.post('/api/super-admin/maintenance/disable');
    const res = await superAdminApi.get('/api/super-admin/maintenance');
    expect(res.ok()).toBe(true);
    const body = await res.json();
    expect(body.data.active).toBe(false);
  });

  superAdminTest('@crud enable Full bloqueia anonimo + libera SuperAdmin + disable libera todos', async ({
    superAdminApi,
  }) => {
    // Ativa modo Full
    const enableRes = await superAdminApi.post('/api/super-admin/maintenance/enable', {
      data: { mode: 'Full', message: 'Manutencao E2E' },
    });
    expect(enableRes.ok()).toBe(true);

    try {
      // Status agora reflete ativo
      const statusRes = await superAdminApi.get('/api/super-admin/maintenance');
      const status = (await statusRes.json()).data;
      expect(status.active).toBe(true);
      expect(status.mode).toBe('Full');

      // Request anonimo (sem Bearer) pra endpoint nao-whitelisted -> 503
      const anon = await playwrightRequest.newContext({
        baseURL: BACK_URL,
        ignoreHTTPSErrors: true,
      });
      try {
        const blocked = await anon.get('/api/clauses');
        expect(
          blocked.status(),
          'anonimo em endpoint protegido deve receber 503',
        ).toBe(503);
      } finally {
        await anon.dispose();
      }

      // SuperAdmin bypassa — GET tenants funciona normalmente
      const bypass = await superAdminApi.get('/api/super-admin/tenants');
      expect(bypass.ok()).toBe(true);
    } finally {
      // Desliga pra nao afetar outros tests
      await superAdminApi.post('/api/super-admin/maintenance/disable');
    }
  });

  superAdminTest('@crud disable apos enable volta tudo ao normal', async ({
    superAdminApi,
  }) => {
    await superAdminApi.post('/api/super-admin/maintenance/enable', {
      data: { mode: 'Full', message: 'temp' },
    });
    const disable = await superAdminApi.post('/api/super-admin/maintenance/disable');
    expect(disable.ok()).toBe(true);

    const status = (await (await superAdminApi.get('/api/super-admin/maintenance')).json()).data;
    expect(status.active).toBe(false);

    // Anonimo agora retorna 401 (auth required) — nao 503 (manutencao desligada)
    const anon = await playwrightRequest.newContext({
      baseURL: BACK_URL,
      ignoreHTTPSErrors: true,
    });
    try {
      const r = await anon.get('/api/clauses');
      expect(r.status(), 'manutencao desligada: 401 (nao 503)').not.toBe(503);
    } finally {
      await anon.dispose();
    }
  });
});
