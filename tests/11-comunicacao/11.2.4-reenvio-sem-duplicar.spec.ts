import { APIRequestContext, mergeTests } from '@playwright/test';

import { authTest, expect } from '../../fixtures/auth.fixture';
import { superAdminTest } from '../../fixtures/super-admin.fixture';
import { apiCreateContactIdentity } from '../../helpers/api-entities';
import {
  enableFeatureFlagDirect,
  seedApprovedWhatsAppTemplateDirect,
  seedWhatsAppTemplateBindingDirect,
  seedWhatsappChannelDirect,
} from '../../helpers/db-helper';
import { InboxEntry, fakeWhatsApp } from '../../helpers/fake-providers';
import { assertOk, readJson, unwrapList } from '../../helpers/response';
import { apiSendTemplate, fakeMessagesTo, uid, uniquePhoneE164 } from '../../helpers/whatsapp-flow';
import { backendUtcMs, waitForWorkerCycleAfter } from '../../helpers/workers';

/**
 * Fluxo: 11.2.4 — reenvio do modelo que falhou de forma transitória, sem duplicar
 * Diagrama: — (o plano é a fonte: PLANO-EXECUCAO-DOS-WORKERS §6 regra 4, WK-D,
 * Etapa 265; registro e2e E20)
 *
 * E20: o envio de modelo que falha de forma transitória no fake (a Meta fora por
 * um instante, 503) fica na fila (`Queued`) e sai UMA vez quando o fake volta,
 * mesmo passando por dois ciclos do despacho antes do envio, e os outros envios
 * que estavam na fila saem no mesmo ciclo em que ele ainda falha.
 *
 * Desenho: o fake recusa o destinatário X nas próximas 4 chamadas. O provider do
 * back tenta `WhatsApp:MaxAttempts` vezes por envio (2 no E2E), então o envio
 * síncrono (tentativa 1) e o primeiro reenvio do `WhatsAppOutboundDispatchWorker`
 * (tentativa 2) falham, e o segundo reenvio (tentativa 3, a última de
 * `MaxAttempts` 3 do dispatch) sai. Y e Z falham só no envio síncrono e saem no
 * primeiro reenvio, o mesmo em que X ainda falha: o envio que continua na fila
 * não derruba o lote (antes da Etapa 265 o lote ia num commit só, e a violação
 * do único `(TenantId, MessageId)` do Outbox derrubava todos a cada 10 s).
 *
 * "Sai uma vez" é contado no inbox do fake: um `POST /messages` aceito (200) por
 * destinatário, e continua um depois de dois ciclos do despacho além do que
 * enviou (esperados pelo `lastSucceededAt` do worker, helpers/workers.ts).
 *
 * O reenvio espera o `NextRetryAt` (30 s depois da falha) e o ciclo de 10 s do
 * worker; as esperas são `expect.poll` com teto explícito.
 */

const test = mergeTests(authTest, superAdminTest);

const DISPATCH_WORKER = 'WhatsAppOutboundDispatchWorker';
/** `Messaging:WhatsAppDispatchPollIntervalSeconds` (padrão; o E2E não troca). */
const DISPATCH_PERIOD_MS = 10_000;
/** Chamadas HTTP do provider por envio no E2E (`WhatsApp:MaxAttempts`). */
const PROVIDER_ATTEMPTS = 2;
/** Dois reenvios (30 s de `NextRetryAt` + ciclo de 10 s + Outbox cada), com folga para a máquina carregada. */
const RETRY_TIMEOUT = 240_000;

interface DispatchItem {
  id: string;
  status: string;
  toPhone: string;
  sentAt: string | null;
  lastError: string | null;
}

async function dispatchOf(api: APIRequestContext, conversationId: string, dispatchId: string): Promise<DispatchItem> {
  const res = await api.get(`/api/whatsapp/outbound/history?conversationId=${conversationId}&page=1&pageSize=20`);
  await assertOk(res, 'GET /api/whatsapp/outbound/history');
  const item = (await unwrapList<DispatchItem>(res)).find((d) => d.id === dispatchId);
  expect(item, `envio ${dispatchId} no histórico`).toBeTruthy();
  return item!;
}

/** Envio de modelo pelo endpoint real; com a Meta fora, a resposta já diz `Queued`. */
async function sendQueued(
  api: APIRequestContext,
  templateId: string,
  phone: string,
): Promise<{ dispatchId: string; conversationId: string }> {
  const res = await apiSendTemplate(api, { templateId, phoneE164: phone });
  await assertOk(res, 'POST /api/whatsapp/outbound/send');
  const body = await readJson<{ id: string; conversationId: string; status: string }>(res);
  expect(body.status, `envio para ${phone} com a Meta fora`).toBe('Queued');
  return { dispatchId: body.id, conversationId: body.conversationId };
}

const accepted = (calls: InboxEntry[]) => calls.filter((e) => e.response.status === 200);
const refused = (calls: InboxEntry[]) => calls.filter((e) => e.response.status !== 200);

test.describe('Fluxo 11.2.4 — reenvio sem duplicar', () => {
  test('E20 @flow a template send that fails transiently stays queued and goes out once when the provider is back, after two dispatch cycles, and the other queued sends go out in the same cycle', async ({
    authApi,
    tenant,
    superAdminApi,
  }) => {
    test.setTimeout(RETRY_TIMEOUT + 240_000);
    enableFeatureFlagDirect(tenant.tenantId, 'feature_whatsapp');
    enableFeatureFlagDirect(tenant.tenantId, 'feature_conversations');
    seedWhatsappChannelDirect(tenant.tenantId);
    const templateId = seedApprovedWhatsAppTemplateDirect({
      name: `reenvio_e2e_${uid()}`,
      body: 'Sua festa esta confirmada!',
    });
    seedWhatsAppTemplateBindingDirect(tenant.tenantId, templateId);

    const phoneX = uniquePhoneE164();
    const phoneY = uniquePhoneE164();
    const phoneZ = uniquePhoneE164();
    // Etapa 239: sem conversa, o telefone tem de ser contato do tenant.
    for (const phone of [phoneX, phoneY, phoneZ]) {
      await apiCreateContactIdentity(authApi, { whatsappPhones: [phone] });
    }

    // X: o envio síncrono e o primeiro reenvio falham; Y e Z: só o síncrono.
    await fakeWhatsApp.failMessagesTo(phoneX, 2 * PROVIDER_ATTEMPTS);
    await fakeWhatsApp.failMessagesTo(phoneY, PROVIDER_ATTEMPTS);
    await fakeWhatsApp.failMessagesTo(phoneZ, PROVIDER_ATTEMPTS);
    const since = new Date(Date.now() - 1_000).toISOString();

    try {
      const x = await sendQueued(authApi, templateId, phoneX);
      const y = await sendQueued(authApi, templateId, phoneY);
      const z = await sendQueued(authApi, templateId, phoneZ);

      // Y e Z saem no primeiro reenvio, com X ainda falhando no mesmo lote.
      for (const [label, phone, sent] of [
        ['Y', phoneY, y],
        ['Z', phoneZ, z],
      ] as const) {
        await expect
          .poll(async () => (await dispatchOf(authApi, sent.conversationId, sent.dispatchId)).status, {
            message: `envio para ${label} sai no reenvio`,
            timeout: RETRY_TIMEOUT,
            intervals: [3_000],
          })
          .toBe('Sent');
        expect(accepted(await fakeMessagesTo(phone, since)), `${label} recebeu uma vez`).toHaveLength(1);
      }

      // X sai uma vez, no segundo reenvio, quando o fake volta.
      await expect
        .poll(async () => (await dispatchOf(authApi, x.conversationId, x.dispatchId)).status, {
          message: 'envio para X sai quando o fake volta',
          timeout: RETRY_TIMEOUT,
          intervals: [3_000],
        })
        .toBe('Sent');
      const callsX = await fakeMessagesTo(phoneX, since);
      expect(refused(callsX), 'X recusado no envio e no primeiro reenvio').toHaveLength(2 * PROVIDER_ATTEMPTS);
      expect(accepted(callsX), 'X recebeu uma vez').toHaveLength(1);

      // Ordem: Y e Z saíram antes de X, junto do reenvio em que X ainda falhava.
      // Os três ficam devidos com 1 a 2 s de diferença (o `NextRetryAt` conta da
      // falha de cada um), então o corte do scan pode separar um deles para o
      // ciclo seguinte: a tolerância é de dois períodos do worker. O que o plano
      // prova é que X falhando no lote não segura os outros.
      const sentX = Date.parse(accepted(callsX)[0]!.capturedAt);
      const lastRefusedX = Math.max(...refused(callsX).map((e) => Date.parse(e.capturedAt)));
      for (const [label, phone] of [
        ['Y', phoneY],
        ['Z', phoneZ],
      ] as const) {
        const sentAt = Date.parse(accepted(await fakeMessagesTo(phone, since))[0]!.capturedAt);
        expect(sentAt, `${label} não esperou X sair`).toBeLessThan(sentX);
        expect(
          Math.abs(sentAt - lastRefusedX),
          `${label} saiu no ciclo do reenvio em que X ainda falhou`,
        ).toBeLessThan(2 * DISPATCH_PERIOD_MS);
      }

      // Dois ciclos do despacho depois do envio de X: nada sai de novo.
      const sentXDispatch = await dispatchOf(authApi, x.conversationId, x.dispatchId);
      await waitForWorkerCycleAfter(
        superAdminApi,
        DISPATCH_WORKER,
        Math.max(sentX, backendUtcMs(sentXDispatch.sentAt)) + 2 * DISPATCH_PERIOD_MS,
        { message: 'dois ciclos do despacho depois do envio de X' },
      );
      for (const [label, phone] of [
        ['X', phoneX],
        ['Y', phoneY],
        ['Z', phoneZ],
      ] as const) {
        expect(accepted(await fakeMessagesTo(phone, since)), `${label} continua com um envio`).toHaveLength(1);
      }
      expect((await dispatchOf(authApi, x.conversationId, x.dispatchId)).status).toBe('Sent');
    } finally {
      for (const phone of [phoneX, phoneY, phoneZ]) await fakeWhatsApp.failMessagesTo(phone, 0);
    }
  });
});
