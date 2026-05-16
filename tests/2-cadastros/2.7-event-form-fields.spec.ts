import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { smokeRoute } from '../../helpers/smoke';

/**
 * Fluxo extra — Event form fields configuraveis (Etapa 55)
 * Tela /app/settings/event-form-fields permite gestor adicionar campos
 * custom no formulario publico pos-aceite.
 */

test.describe('Event Form Fields (settings)', () => {
  test('@flow tela carrega autenticada', async ({ authPage }) => {
    await smokeRoute(authPage, '/app/settings/event-form-fields');
  });

  test('@crud cria field Text + aparece em GET', async ({ authApi }) => {
    const key = `e2e_field_${Date.now()}`;
    const createRes = await authApi.post('/api/event-form-fields', {
      data: {
        key,
        label: 'Campo E2E',
        fieldType: 'Text',
        isRequired: false,
        displayOrder: 1,
      },
    });
    if (!createRes.ok()) {
      throw new Error(`POST field ${createRes.status()}: ${await createRes.text()}`);
    }
    const field = (await createRes.json()).data ?? (await createRes.json());
    expect(field.id).toBeTruthy();
    expect(field.key).toBe(key);

    const listRes = await authApi.get('/api/event-form-fields');
    expect(listRes.ok()).toBe(true);
    const body = await listRes.json();
    const items: Array<{ id: string }> = body.data?.items ?? body.items ?? body.data ?? body;
    const arr = Array.isArray(items) ? items : [];
    expect(arr.some((f) => f.id === field.id)).toBe(true);
  });
});
