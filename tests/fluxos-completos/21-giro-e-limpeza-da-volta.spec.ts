import type { APIRequestContext } from '@playwright/test';
import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateClient, apiListNotifications } from '../../helpers/api-entities';
import { enableFeatureFlagDirect } from '../../helpers/db-helper';
import { TRIGGER_TIMEOUT, apiTriggerDailyJob, tenantDayPlus, uniqueSuffix } from '../../helpers/rain-plan';
import {
  apiCreateEquipmentType,
  apiCreateEquipmentUnit,
  apiCreateRental,
  apiGetRental,
  apiTransitionRental,
  createRental,
  inspectRentalBatch,
  transitionRental,
} from '../../helpers/rental-preparation';
import { apiErrorCodes, assertOk, readJson, unwrapList } from '../../helpers/response';
import { RoleSession, loginAsRole } from '../../helpers/setup-flows';

/**
 * Fluxo: fluxos-completos/21 — Tempo de giro e limpeza na volta
 * Diagrama: docs/fluxos/completo-21-giro-e-limpeza-da-volta.mmd
 * Plano: docs/implementar/PLANO-CICLO-COMPLETO-DOS-BRINQUEDOS.md §5 (CB-C) e §6 (CB-D)
 *
 * E4: tipo com giro de 24 h recusa locação a 10 h da anterior; a volta do
 * inflável abre a limpeza; a próxima saída daquela unidade é recusada até
 * concluir a limpeza; o aviso de limpeza atrasada chega aos gestores; o
 * Financeiro não conclui (§5 item 3; §6 itens 2 a 6).
 *
 * O spec afirma o plano; divergência é falha de código, não de asserção.
 */

interface MaintenanceRecord {
  id: string;
  equipmentUnitId: string;
  type: string;
  description: string;
  status: string;
  actualEndDate: string | null;
  sourceRentalId: string | null;
  sourceRentalNumber: string | null;
}

async function returnCleaningsOf(api: APIRequestContext, unitId: string): Promise<MaintenanceRecord[]> {
  const res = await api.get(`/api/maintenance-records?equipmentUnitId=${unitId}&returnCleaning=true&pageSize=50`);
  await assertOk(res, 'GET /api/maintenance-records?returnCleaning=true');
  return unwrapList<MaintenanceRecord>(res);
}

async function unitOf(api: APIRequestContext, unitId: string): Promise<{ status: string; hasPendingReturnCleaning?: boolean }> {
  const res = await api.get(`/api/equipment-units/${unitId}`);
  await assertOk(res, 'GET /api/equipment-units/{id}');
  return readJson(res);
}

test.describe('Fluxo completo 21 — Giro e limpeza da volta', () => {
  test('@flow E4: a 24 h turnaround refuses a rental 10 h after the previous one; the return opens the cleaning; the next dispatch is refused until it is completed; the overdue notice reaches the managers; Financial does not complete', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(TRIGGER_TIMEOUT + 240_000);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_equipment_rental');
    const today = tenantDayPlus(0);
    const type = await apiCreateEquipmentType(authApi, {
      name: `Castelo inflavel E2E ${uniqueSuffix()}`,
      turnaroundHours: 24,
      requiresReturnCleaning: true,
    });
    const unit = await apiCreateEquipmentUnit(authApi, type.id);
    const client = await apiCreateClient(authApi);

    // A locação de hoje: retirada às 20:00.
    const first = await apiCreateRental(authApi, { clientId: client.id, deliveryDate: today, unitIds: [unit.id] });
    await apiTransitionRental(authApi, first.id, 'Reserved');

    // §5 item 3 e item 4: a 10 h da retirada (06:00 do dia seguinte), dentro do giro de 24 h.
    const tomorrow = tenantDayPlus(1);
    const tooSoon = await createRental(authApi, {
      clientId: client.id,
      deliveryDate: tomorrow,
      deliveryTime: '06:00:00',
      usageStart: `${tomorrow}T12:00:00Z`,
      usageEnd: `${tomorrow}T15:00:00Z`,
      pickupTime: '18:00:00',
      unitIds: [unit.id],
    });
    expect(tooSoon.status(), 'locação a 10 h da anterior num tipo de 24 h').toBe(409);
    expect(await apiErrorCodes(tooSoon)).toContain('Rental.OverlappingReservation');
    const tooSoonBody = (await tooSoon.json()) as { errors: Array<{ code: string; description: string }> };
    const overlap = tooSoonBody.errors.find((e) => e.code === 'Rental.OverlappingReservation')!;
    expect(overlap.description, 'a mensagem diz a locação e o giro do tipo').toContain(first.rentalNumber);
    expect(overlap.description).toContain('giro de 24 h do tipo');

    // A volta: saída, uso e `Returned` abrem a limpeza "Higienizar após LOC-…" (§6 item 2).
    await apiTransitionRental(authApi, first.id, 'Confirmed', 'Preparing');
    await assertOk(await inspectRentalBatch(authApi, first.id, { type: 'Outbound' }), 'inspeção de saída');
    await apiTransitionRental(authApi, first.id, 'Dispatched', 'Delivered', 'InUse', 'Returned');
    const [cleaning, ...more] = await returnCleaningsOf(authApi, unit.id);
    expect(cleaning, 'a volta abre a limpeza da unidade').toBeTruthy();
    expect(more, 'uma limpeza por unidade e locação').toHaveLength(0);
    expect(cleaning!.type).toBe('Cleaning');
    expect(cleaning!.sourceRentalId).toBe(first.id);
    expect(cleaning!.description).toContain(`Higienizar após ${first.rentalNumber}`);
    expect(cleaning!.status).not.toBe('Completed');

    // Concluir a locação não abre outra limpeza nem fecha a aberta.
    await assertOk(await inspectRentalBatch(authApi, first.id, { type: 'Inbound' }), 'inspeção de volta');
    await apiTransitionRental(authApi, first.id, 'Completed');
    expect(await returnCleaningsOf(authApi, unit.id), 'uma limpeza só').toHaveLength(1);

    // Decisão 10: a unidade volta a "Disponível", com a limpeza pendente, e segue reservável.
    const freed = await unitOf(authApi, unit.id);
    expect(freed.status, 'a limpeza não põe a unidade em manutenção').toBe('Available');
    expect(freed.hasPendingReturnCleaning, 'selo "Limpeza pendente"').toBe(true);
    const inTwoDays = tenantDayPlus(2);
    const next = await apiCreateRental(authApi, { clientId: client.id, deliveryDate: inTwoDays, unitIds: [unit.id] });
    await apiTransitionRental(authApi, next.id, 'Reserved', 'Confirmed', 'Preparing');

    // §6 item 4: a saída é recusada antes da inspeção de saída, pela limpeza de outra locação.
    const blocked = await transitionRental(authApi, next.id, 'Dispatched');
    expect(blocked.status(), 'saída com a limpeza da volta anterior aberta').toBe(409);
    expect(await apiErrorCodes(blocked)).toContain('Rental.ReturnCleaningPending');
    const blockedBody = (await blocked.json()) as { errors: Array<{ code: string; description: string }> };
    expect(blockedBody.errors.find((e) => e.code === 'Rental.ReturnCleaningPending')!.description).toContain(
      unit.assetCode,
    );
    await assertOk(await inspectRentalBatch(authApi, next.id, { type: 'Outbound' }), 'inspeção de saída da próxima');
    const stillBlocked = await transitionRental(authApi, next.id, 'Dispatched');
    expect(stillBlocked.status(), 'a inspeção não libera a saída').toBe(409);
    expect(await apiErrorCodes(stillBlocked)).toContain('Rental.ReturnCleaningPending');
    expect((await apiGetRental(authApi, next.id)).status).toBe('Preparing');

    // §6 item 6: a próxima saída da unidade em até 2 dias vira o aviso 41 aos gestores.
    await apiTriggerDailyJob(authApi);
    const notices = (await apiListNotifications(authApi)).filter(
      (n) => n.type === 'RentalReturnCleaningOverdue' && n.contextEntityId === cleaning!.id,
    );
    expect(notices, 'aviso da limpeza pendente ao gestor').toHaveLength(1);
    expect(notices[0]!.title).toContain('Limpeza da volta');
    expect(notices[0]!.message).toContain(first.rentalNumber);

    // §6 item 5 e testes de permissão: o Financeiro não conclui.
    const sessions: RoleSession[] = [];
    try {
      const financial = await loginAsRole(tenant.tenantId, 'Financial');
      sessions.push(financial);
      const denied = await financial.api.post(`/api/maintenance-records/${cleaning!.id}/complete`, { data: {} });
      expect(denied.status(), 'Financeiro não conclui').toBe(403);
      expect((await returnCleaningsOf(authApi, unit.id))[0]!.status, 'a limpeza segue aberta').not.toBe('Completed');
    } finally {
      for (const s of sessions) await s.api.dispose();
    }

    // Concluir (data em branco = hoje) libera a saída.
    const completed = await authApi.post(`/api/maintenance-records/${cleaning!.id}/complete`, {
      data: { actualEndDate: null, cost: null },
    });
    await assertOk(completed, 'POST /api/maintenance-records/{id}/complete');
    const closed = await readJson<MaintenanceRecord>(completed);
    expect(closed.status).toBe('Completed');
    expect(closed.actualEndDate, 'concluída hoje, no fuso da empresa').toBe(today);
    expect((await unitOf(authApi, unit.id)).hasPendingReturnCleaning, 'o selo some').toBe(false);

    const again = await authApi.post(`/api/maintenance-records/${cleaning!.id}/complete`, { data: {} });
    expect(again.status(), 'concluir duas vezes').toBe(409);
    expect(await apiErrorCodes(again)).toContain('Maintenance.AlreadyCompleted');

    await assertOk(await transitionRental(authApi, next.id, 'Dispatched'), 'a próxima sai depois da limpeza');
    expect((await apiGetRental(authApi, next.id)).status).toBe('Dispatched');
  });
});
