import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateActivity, apiCreateProduct, apiSetSettingParameter } from '../../helpers/api-entities';
import { enableFeatureFlagDirect, seedWhatsappChannelDirect } from '../../helpers/db-helper';
import {
  TRIGGER_TIMEOUT,
  apiGetMaterialChecklist,
  apiTriggerDailyJob,
  setupConfirmedPortalCollaborator,
  tenantDayPlus,
  uniqueSuffix,
} from '../../helpers/rain-plan';
import { assertOk } from '../../helpers/response';
import { setupAcceptedEvent } from '../../helpers/setup-flows';
import { fakeTextsTo, receiveInbound, uniquePhoneE164 } from '../../helpers/whatsapp-flow';

/**
 * Fluxo: 31 — Lembrete de material da festa, uma vez por colaborador
 * Diagrama: — (o plano é a fonte: PLANO-EXECUCAO-DOS-WORKERS §3 regra 2, WK-A,
 * Etapa 262; registro e2e E1)
 *
 * E1: o lembrete D-2 do material chega pelo WhatsApp UMA vez a cada
 * colaborador confirmado da festa, mesmo com duas varreduras diárias no mesmo
 * dia: cada envio reivindica (festa, colaborador, dia local) no `IWorkLedger`
 * antes de sair. O "Pedir conferência" do gestor fica fora do ledger e
 * reenvia (§3 regra 2, terceiro item).
 *
 * A varredura é o ciclo diário do `NotificationTriggerService`, disparado pelo
 * gatilho manual `POST /api/notifications/trigger-overdue`. O ciclo de segundo
 * plano (`NotificationTriggerWorker`, desde a Etapa 264 a qualquer hora depois
 * das 07h locais) pode ter rodado para este tenant também: a contagem continua
 * sendo uma por colaborador, que é o que o plano pede.
 *
 * Os dois recreadores falaram com o número da empresa (webhook inbound do fake),
 * então a janela de 24 h está aberta e o lembrete sai como texto livre.
 */

const REMINDER_TEXT = 'lista de materiais';

test.describe('Fluxo 31 —Lembrete de material uma vez por colaborador', () => {
  test('@flow E1: the D-2 material reminder reaches each confirmed collaborator once by WhatsApp with two daily sweeps on the same day; the manager "pedir conferência" sends it again', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(3 * TRIGGER_TIMEOUT + 240_000);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_whatsapp');
    const phoneNumberId = seedWhatsappChannelDirect(tenant.tenantId);
    await apiSetSettingParameter(authApi, 'EVENT_MATERIAL_CHECKLIST_REMINDER_DAYS', 2);

    // Festa daqui a 2 dias com uma atividade que leva material: a lista
    // principal nasce pendente.
    const s = uniqueSuffix();
    const product = await apiCreateProduct(authApi, { name: `Giz ${s}` });
    const activity = await apiCreateActivity(authApi, {
      name: `Amarelinha ${s}`,
      activityProducts: [{ productId: product.id, qtyPerChild: 1, isChecklistOnly: false }],
    });
    const { eventId } = await setupAcceptedEvent(authApi, {
      activityIds: [activity.id],
      budget: { eventDate: tenantDayPlus(2), childrenCount: 12, startTime: '14:00', endTime: '18:00' },
    });
    const checklist = await apiGetMaterialChecklist(authApi, eventId);
    expect(checklist.pending, 'a festa tem material pendente para lembrar').toBeGreaterThan(0);

    const since = new Date(Date.now() - 1_000).toISOString();
    const phoneA = uniquePhoneE164();
    const phoneB = uniquePhoneE164();
    const teamA = await setupConfirmedPortalCollaborator(authApi, tenant.tenantId, eventId, { phone: phoneA });
    const teamB = await setupConfirmedPortalCollaborator(authApi, tenant.tenantId, eventId, {
      phone: phoneB,
      isLeader: false,
    });
    await receiveInbound(phoneNumberId, phoneA, 'Oi, sou da equipe');
    await receiveInbound(phoneNumberId, phoneB, 'Oi, também sou da equipe');

    const remindersTo = async (phone: string) =>
      (await fakeTextsTo(phone, since)).filter((text) => text.includes(REMINDER_TEXT)).length;

    try {
      // Duas varreduras no mesmo dia.
      await apiTriggerDailyJob(authApi);
      await apiTriggerDailyJob(authApi);

      for (const [label, phone] of [
        ['recreador A', phoneA],
        ['recreador B', phoneB],
      ] as const) {
        await expect
          .poll(() => remindersTo(phone), { message: `lembrete D-2 ao ${label}` })
          .toBe(1);
      }

      // Uma terceira passada no mesmo dia também não repete.
      await apiTriggerDailyJob(authApi);
      expect(await remindersTo(phoneA), 'terceira passada, recreador A').toBe(1);
      expect(await remindersTo(phoneB), 'terceira passada, recreador B').toBe(1);

      // O "Pedir conferência" do gestor não passa pelo ledger: reenvia.
      await assertOk(
        await authApi.post(`/api/events/${eventId}/material-checklist/remind`, { data: {} }),
        'POST material-checklist/remind',
      );
      await expect.poll(() => remindersTo(phoneA), { message: 'reenvio manual ao recreador A' }).toBe(2);
      await expect.poll(() => remindersTo(phoneB), { message: 'reenvio manual ao recreador B' }).toBe(2);
    } finally {
      await teamA.portal.api.dispose();
      await teamB.portal.api.dispose();
    }
  });
});
