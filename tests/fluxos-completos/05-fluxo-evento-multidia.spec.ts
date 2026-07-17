import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import {
  apiAcceptPublicBudget,
  apiCreateBudget,
  apiGetEvent,
  apiSendBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';

/**
 * Fluxo multi-dia / vira-noite (PLANO-EVENTO-MULTI-DIA §6 — cenário E2E
 * obrigatório): orçamento 20:00→02:00 (+1 dia) → enviar → aceitar → evento
 * nasce com a data de término no dia seguinte e aparece no calendário nos
 * DOIS dias do intervalo (query por overlap, não por EventDate BETWEEN).
 */

function todayPlus(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

test.describe('Fluxo de evento — cross-midnight (+1 dia)', () => {
  test('@flow orcamento 20:00→02:00 -> aceite -> evento nos dois dias do calendário', async ({
    authApi,
  }) => {
    const diaInicio = todayPlus(30);
    const diaTermino = todayPlus(31);

    // 1. Cadastros base
    const cliente = await apiCreateClient(authApi);
    const atividade = await apiCreateActivity(authApi);

    // 2. Orçamento que vira a madrugada — só é aceito pelo back porque o
    //    payload traz eventEndDate no dia seguinte (invariante composta).
    const orcamento = await apiCreateBudget(authApi, {
      clientId: cliente.id,
      activityIds: [atividade.id],
      eventDate: diaInicio,
      eventEndDate: diaTermino,
      startTime: '20:00',
      endTime: '02:00',
    });
    expect(orcamento.id).toBeTruthy();
    expect((orcamento as { eventEndDate?: string }).eventEndDate).toBe(diaTermino);

    // 3. Envia e aceita pelo link público
    const enviado = await apiSendBudget(authApi, orcamento.id);
    const token = extractTokenFromPublicUrl(enviado.publicUrl);
    const publicApi = await createPublicApiContext();
    let eventId: string;
    try {
      const aceito = await apiAcceptPublicBudget(publicApi, token);
      expect(aceito.eventId).toBeTruthy();
      eventId = aceito.eventId;
    } finally {
      await publicApi.dispose();
    }

    // 4. Evento herda o período composto do orçamento
    const evento = (await apiGetEvent(authApi, eventId)) as unknown as {
      eventDate: string;
      endDate: string;
      startTime: string;
      endTime: string;
    };
    expect(evento.eventDate).toBe(diaInicio);
    expect(evento.endDate).toBe(diaTermino);
    expect(evento.startTime.substring(0, 5)).toBe('20:00');
    expect(evento.endTime.substring(0, 5)).toBe('02:00');

    // 5. Calendário acha o evento nos DOIS dias (overlap [eventDate, endDate])
    const idsNoDia = async (dia: string): Promise<string[]> => {
      const res = await authApi.get(`/api/events/calendar?from=${dia}&to=${dia}`);
      expect(res.ok()).toBeTruthy();
      const body = (await res.json()) as { data: Array<{ id: string }> };
      return body.data.map((e) => e.id);
    };

    expect(await idsNoDia(diaInicio)).toContain(eventId);
    expect(await idsNoDia(diaTermino)).toContain(eventId);
    expect(await idsNoDia(todayPlus(32))).not.toContain(eventId);
  });
});
