import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';
import { apiCompleteOnboarding } from '../../helpers/api-entities';
import { assertOk, readJson } from '../../helpers/response';

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

  /**
   * E9 do PLANO-AJUSTES-DA-CONVERSAO (revisão pós-entrega da Etapa 195, D20):
   * o autocomplete "Adicionar unidade" mostra o NOME DO TIPO como rótulo, então
   * o usuário procura por ele. O `Search` do read de unidades passou a comparar
   * também o nome do tipo; antes, digitar "Cama elástica" não achava nada.
   */
  test('@flow "Add unit" finds the unit by typing the equipment type name (D20)', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    enableFeatureFlagDirect(tenant.tenantId, 'feature_equipment_rental');
    await apiCompleteOnboarding(authApi);

    const stamp = Date.now();
    const typeName = `Cama elástica E2E ${stamp}`;
    const typeRes = await authApi.post('/api/equipment-types', {
      data: {
        name: typeName,
        code: `CE${stamp}`,
        category: 'Trampoline',
        requiresPower: false,
        setupTimeMinutes: 20,
        teardownTimeMinutes: 15,
        minMonitors: 1,
        pricing: {
          basePriceDaily: 200,
          basePriceHourly: 35,
          extraHourPrice: 25,
          setupFee: 0,
          deliveryFeePerKm: 2,
          depositAmount: 0,
          lateReturnFeePerHour: 30,
          damageFeeMinimum: 100,
        },
        setupRequirements: [],
        description: 'Tipo do E9',
      },
    });
    await assertOk(typeRes, 'POST /api/equipment-types');
    const type = await readJson<{ id: string }>(typeRes);

    // O código do patrimônio não contém o nome do tipo: só a busca pelo tipo acha.
    const assetCode = `PAT-${stamp}`;
    const unitRes = await authApi.post('/api/equipment-units', {
      data: {
        equipmentTypeId: type.id,
        assetCode,
        acquisitionDate: new Date().toISOString().slice(0, 10),
        acquisitionCost: 1500,
        condition: 'Good',
      },
    });
    await assertOk(unitRes, 'POST /api/equipment-units');
    const unit = await readJson<{ id: string }>(unitRes);

    await authPage.goto('/app/rentals/new');
    await authPage.getByRole('tab', { name: 'Itens', exact: true }).click();

    const addUnit = authPage.getByTestId('rental-add-unit');
    await addUnit.click();
    await addUnit.fill('Cama elástica');
    const option = authPage.getByTestId(`rental-add-unit-option-${unit.id}`);
    await expect(option).toBeVisible({ timeout: 10_000 });
    await expect(option).toContainText(typeName);
    await option.click();

    // Seletor de ação: a unidade entra na lista e o campo volta vazio.
    const item = authPage.getByTestId('rental-item-0');
    await expect(item).toContainText(typeName);
    await expect(item).toContainText(assetCode);
    await expect(addUnit).toHaveValue('');
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
