import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';
import { apiCreateActivity } from '../../helpers/api-entities';

/**
 * Fluxo: 15.1 — Locação de equipamentos
 * Diagrama: docs/fluxos/negocio-15.1-locacao-de-equipamentos.mmd
 *
 * Stock + Rentals são add-ons gated (`feature_stock` e `feature_equipment_rental`).
 * O @crud habilita os entitlements via SQL e cria entidades via API.
 */

test.describe('Fluxo 15.1 — Locação de equipamentos', () => {
  test('@flow rota /stock carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/stock');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test('@flow rota /rentals carrega autenticada', async ({ authPage }) => {
    const res = await authPage.goto('/app/rentals');
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test('@crud cria equipment-type via API (feature_equipment_rental) e valida no back', async ({
    authApi,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_equipment_rental');

    const nome = `Pula-pula E2E ${Date.now()}`;
    const createRes = await authApi.post('/api/equipment-types', {
      data: {
        name: nome,
        code: `PP${Date.now()}`,
        category: 'Inflatable',
        requiresPower: true,
        setupTimeMinutes: 30,
        teardownTimeMinutes: 20,
        minMonitors: 1,
        pricing: {
          basePriceDaily: 250,
          basePriceHourly: 40,
          extraHourPrice: 30,
          setupFee: 50,
          deliveryFeePerKm: 2,
          depositAmount: 100,
          lateReturnFeePerHour: 50,
          damageFeeMinimum: 200,
        },
        setupRequirements: [],
        description: 'Equipamento de teste E2E',
      },
    });
    if (!createRes.ok()) {
      throw new Error(`POST /api/equipment-types ${createRes.status()}: ${await createRes.text()}`);
    }

    const list = await authApi.get('/api/equipment-types');
    expect(list.ok()).toBe(true);
    const body = await list.json();
    const items = body.data?.items ?? body.items ?? body.data ?? body;
    const arr = Array.isArray(items) ? items : items.items ?? [];
    expect(arr.some((e: { name?: string }) => e.name === nome)).toBe(true);
  });

  test('@crud cria movimentação de estoque via API (feature_stock) e valida saldo', async ({
    authApi,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_stock');

    // Precisa de um Product existente — usa o helper que já cria Activity
    // (não — produto é diferente). Vou criar um produto inline.
    const prodRes = await authApi.post('/api/products', {
      data: {
        name: `Doce E2E ${Date.now()}`,
        category: 'Alimentos',
        unit: 'un',
        unitCost: 1.5,
        isReusable: false,
        activityProducts: [],
      },
    });
    if (!prodRes.ok()) {
      throw new Error(`POST /api/products ${prodRes.status()}: ${await prodRes.text()}`);
    }
    const product = (await prodRes.json()).data ?? (await prodRes.json());

    // Entrada de estoque: 100 unidades
    const movRes = await authApi.post('/api/stock/movements', {
      data: {
        productId: product.id,
        type: 'Purchase',
        quantity: 100,
        unitCost: 1.5,
        supplierName: 'Fornecedor E2E',
      },
    });
    if (!movRes.ok()) {
      throw new Error(`POST /api/stock/movements ${movRes.status()}: ${await movRes.text()}`);
    }

    const balRes = await authApi.get(`/api/stock/balances/${product.id}`);
    expect(balRes.ok()).toBe(true);
    const balBody = await balRes.json();
    const balance = balBody.data ?? balBody;
    expect(Number(balance.currentBalance ?? 0)).toBe(100);
  });
});
