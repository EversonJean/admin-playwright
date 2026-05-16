import { superAdminTest, expect } from '../../fixtures/super-admin.fixture';

/**
 * Fluxo extra — SuperAdmin WhatsApp templates CRUD
 * (telas /app/whatsapp-templates, /new, /:id)
 *
 * Templates sao cross-tenant; gestao exclusiva SuperAdmin via
 * /api/super-admin/whatsapp-templates.
 */

superAdminTest.describe('SuperAdmin — WhatsApp templates', () => {
  superAdminTest('@crud cria template Draft + lista', async ({ superAdminApi }) => {
    const name = `tpl_sa_${Date.now()}`;
    const createRes = await superAdminApi.post('/api/super-admin/whatsapp-templates', {
      data: {
        name,
        language: 'pt_BR',
        category: 'Utility',
        body: 'Template SuperAdmin E2E.',
        variables: [],
      },
    });
    if (!createRes.ok()) {
      throw new Error(`POST tpl ${createRes.status()}: ${await createRes.text()}`);
    }
    const tpl = (await createRes.json()).data ?? (await createRes.json());
    expect(tpl.id).toBeTruthy();
    expect(tpl.name).toBe(name);

    const listRes = await superAdminApi.get('/api/super-admin/whatsapp-templates');
    expect(listRes.ok()).toBe(true);
    const body = await listRes.json();
    const items: Array<{ id: string }> =
      body.data?.items ?? body.items ?? body.data ?? body;
    const arr = Array.isArray(items) ? items : [];
    expect(arr.some((t) => t.id === tpl.id)).toBe(true);
  });
});
