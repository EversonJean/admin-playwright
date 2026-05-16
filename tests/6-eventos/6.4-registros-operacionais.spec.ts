import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo: 6.4 — Registros operacionais (não-comerciais)
 * Diagrama: docs/fluxos/negocio-6.4-registros-operacionais.mmd
 *
 * ScheduleBlock e ExternalCommitment nascem direto via POST /operational
 * (sem Budget). Domain rejeita Kind=Commercial nessa rota.
 */

test.describe('Fluxo 6.4 — Registros operacionais', () => {
  test('@flow criação de evento operacional carrega', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/events/new-operational');
  });

  test('@crud ExternalCommitment criado via /operational fica visivel na listagem', async ({
    authApi,
  }) => {
    const day = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
    const createRes = await authApi.post('/api/events/operational', {
      data: {
        kind: 'ExternalCommitment',
        eventDate: day,
        startTime: '09:00',
        endTime: '12:00',
        location: 'Casamento externo E2E',
        childrenCount: 10,
      },
    });
    if (!createRes.ok()) {
      throw new Error(`POST operational ${createRes.status()}: ${await createRes.text()}`);
    }
    const created = (await createRes.json()).data ?? (await createRes.json());

    const listRes = await authApi.get('/api/events');
    expect(listRes.ok()).toBe(true);
    const listBody = await listRes.json();
    const items = listBody.data?.items ?? listBody.items ?? listBody.data ?? listBody;
    const arr: Array<{ id: string; kind: string }> = Array.isArray(items) ? items : [];
    const found = arr.find((e) => e.id === created.id);
    expect(found, 'registro operacional deve aparecer na listagem').toBeTruthy();
    expect(found?.kind).toBe('ExternalCommitment');
  });

  test('@crud rejeita Kind=Commercial via /operational (Commercial so de Budget)', async ({
    authApi,
  }) => {
    const day = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const res = await authApi.post('/api/events/operational', {
      data: {
        kind: 'Commercial',
        eventDate: day,
        startTime: '14:00',
        endTime: '18:00',
        location: 'Tentativa invalida',
        childrenCount: 20,
      },
    });
    expect([400, 422], `back deve rejeitar Commercial; got ${res.status()}`).toContain(
      res.status(),
    );
  });
});
