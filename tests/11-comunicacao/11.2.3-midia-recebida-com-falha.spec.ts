import { readFileSync } from 'node:fs';

import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCompleteOnboarding } from '../../helpers/api-entities';
import { enableChannelMediaStorageDirect, messageAttachmentsDirect, seedWhatsappChannelDirect } from '../../helpers/db-helper';
import { InboxEntry, fakeWhatsApp } from '../../helpers/fake-providers';
import { storedDocumentFile } from '../../helpers/local-storage';
import {
  apiConversationIdByPhone,
  apiListMessages,
  digitsOf,
  enableWhatsAppFeaturesDirect,
  uid,
  uniquePhoneE164,
} from '../../helpers/whatsapp-flow';

/**
 * Fluxo: 11.2.3 — mídia recebida cuja mídia a Meta não entrega
 * Diagrama: — (o plano é a fonte: PLANO-EXECUCAO-DOS-WORKERS §6 regra 3, WK-D,
 * Etapa 265; registro e2e E19)
 *
 * E19: com o arquivamento de mídia ligado no canal (`StoreMediaFiles`), o anexo
 * recebido cujo id a Meta não entrega (nunca cadastrado no fake: o
 * `GET /:mediaId` volta sem `url`) fica como ponteiro `meta-media://<id>` e não
 * impede que o anexo seguinte, cadastrado no fake, seja baixado, guardado no
 * storage e mostrado na conversa. O anexo que falhou não é pedido de novo ao fake
 * antes da espera de 1 minuto (backoff 1, 5, 30 min e 2 h, 5 tentativas): a
 * segunda chamada pelo id dele sai pelo menos 60 s depois da primeira.
 *
 * O `ConversationMediaDownloadWorker` roda a cada 30 s; as esperas são
 * `expect.poll` com teto explícito. A segunda tentativa do anexo que falhou sai
 * no primeiro ciclo depois de 1 min da falha, até ~1,5 min depois dela.
 */

/** Primeira tentativa (até 1 ciclo de 30 s) + o download do anexo bom, com folga. */
const DOWNLOAD_TIMEOUT = 120_000;
/** Backoff da primeira falha (1 min) + até um ciclo + folga. */
const RETRY_TIMEOUT = 180_000;
const FIRST_BACKOFF_MS = 60_000;

/** Webhook de UMA mensagem com mídia (o `triggerWebhook` do fake só monta texto). */
async function receiveMedia(
  phoneNumberId: string,
  phoneE164: string,
  message: Record<string, unknown> & { id: string; type: string },
): Promise<void> {
  const digits = digitsOf(phoneE164);
  const hook = await fakeWhatsApp.triggerRawWebhook({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'fake_waba_id',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '5541999000000', phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: `Cliente ${digits.slice(-4)}` }, wa_id: digits }],
              messages: [{ from: digits, timestamp: Math.floor(Date.now() / 1000).toString(), ...message }],
            },
          },
        ],
      },
    ],
  });
  expect(hook.backStatus, `webhook da mídia: ${hook.backBody}`).toBe(200);
}

/** `GET /:mediaId` que o back fez ao fake desde `since` (a consulta da url assinada). */
async function lookupsOf(mediaId: string, since: string): Promise<InboxEntry[]> {
  const inbox = await fakeWhatsApp.inbox({ since });
  return inbox
    .filter((e) => e.method === 'GET' && e.path.split('?')[0] === `/${mediaId}`)
    .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
}

test.describe('Fluxo 11.2.3 — mídia recebida com falha no download', () => {
  test('E19 @flow the attachment the provider does not deliver stays a pointer and does not block the next one, which is downloaded and shown in the conversation; the failed one is not asked again before the 1 minute wait', async ({
    authApi,
    authPage,
    tenant,
  }) => {
    test.setTimeout(DOWNLOAD_TIMEOUT + RETRY_TIMEOUT + 120_000);
    enableWhatsAppFeaturesDirect(tenant.tenantId);
    const phoneNumberId = seedWhatsappChannelDirect(tenant.tenantId);
    enableChannelMediaStorageDirect(phoneNumberId);
    await apiCompleteOnboarding(authApi);

    const tag = uid();
    const phone = uniquePhoneE164();
    const missingMediaId = `e2emissing_${tag}`;
    const goodMediaId = `e2emedia_${tag}`;
    const fileName = `comprovante-${tag}.pdf`;
    const pdf = Buffer.from(`%PDF-1.4\n% comprovante ${tag}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`, 'latin1');
    await fakeWhatsApp.seedInboundMedia({ id: goodMediaId, mimeType: 'application/pdf', bytes: pdf });
    const since = new Date(Date.now() - 1_000).toISOString();

    // Primeiro a imagem que a Meta não entrega, depois o documento cadastrado.
    await receiveMedia(phoneNumberId, phone, {
      id: `wamid.e2e_missing_${tag}`,
      type: 'image',
      image: { id: missingMediaId, mime_type: 'image/jpeg' },
    });
    await receiveMedia(phoneNumberId, phone, {
      id: `wamid.e2e_good_${tag}`,
      type: 'document',
      document: { id: goodMediaId, mime_type: 'application/pdf', filename: fileName },
    });
    const conversationId = await apiConversationIdByPhone(authApi, phone);

    // O anexo bom é baixado e guardado, mesmo com o outro falhando na frente.
    const attachmentOf = (mediaId: string) =>
      messageAttachmentsDirect(conversationId).find(
        (a) => a.mediaUrl === `meta-media://${mediaId}` || (mediaId === goodMediaId && a.fileName === fileName),
      );
    let goodKey = '';
    await expect
      .poll(
        () => {
          goodKey = attachmentOf(goodMediaId)?.mediaUrl ?? '';
          return goodKey.length > 0 && !goodKey.startsWith('meta-media://');
        },
        { message: 'o anexo cadastrado no fake é arquivado', timeout: DOWNLOAD_TIMEOUT, intervals: [2_000] },
      )
      .toBe(true);
    const file = storedDocumentFile(goodKey);
    expect(file, `arquivo ${goodKey} no storage do E2E`).not.toBeNull();
    expect(readFileSync(file!).equals(pdf), 'o storage guarda o binário baixado').toBe(true);

    // O que a Meta não entregou: tentado uma vez, segue ponteiro.
    await expect
      .poll(async () => (await lookupsOf(missingMediaId, since)).length, {
        message: 'o anexo que falha foi pedido ao fake',
        timeout: DOWNLOAD_TIMEOUT,
        intervals: [2_000],
      })
      .toBeGreaterThanOrEqual(1);
    const firstLookup = (await lookupsOf(missingMediaId, since))[0]!;
    expect(attachmentOf(missingMediaId)?.mediaUrl, 'o anexo que falhou fica como ponteiro').toBe(
      `meta-media://${missingMediaId}`,
    );

    // A conversa mostra os dois anexos; o baixado com o nome do arquivo e a key do storage.
    const messages = await apiListMessages(authApi, conversationId);
    const attachments = messages.flatMap((m) => m.attachments);
    const goodAttachment = attachments.find((a) => a.fileName === fileName);
    const missingAttachment = attachments.find((a) => a.mediaUrl === `meta-media://${missingMediaId}`);
    expect(goodAttachment, 'o anexo baixado na conversa').toBeTruthy();
    expect(missingAttachment, 'o anexo que falhou na conversa').toBeTruthy();
    expect(goodAttachment!.mediaUrl).toBe(goodKey);

    await authPage.goto(`/app/conversations/${conversationId}`);
    const goodLink = authPage.getByTestId(`conversation-attachment-${goodAttachment!.id}`);
    await expect(goodLink).toBeVisible({ timeout: 30_000 });
    await expect(goodLink).toContainText(fileName);
    expect(await goodLink.getAttribute('href'), 'o link do anexo baixado não é o ponteiro da Meta').not.toContain(
      'meta-media://',
    );
    const missingLink = authPage.getByTestId(`conversation-attachment-${missingAttachment!.id}`);
    await expect(missingLink).toBeVisible();
    expect(await missingLink.getAttribute('href'), 'o anexo que falhou segue como ponteiro na tela').toContain(
      `meta-media://${missingMediaId}`,
    );

    // A segunda tentativa só sai depois da espera de 1 min.
    await expect
      .poll(async () => (await lookupsOf(missingMediaId, since)).length, {
        message: 'segunda tentativa do anexo que falhou',
        timeout: RETRY_TIMEOUT,
        intervals: [5_000],
      })
      .toBeGreaterThanOrEqual(2);
    const lookups = await lookupsOf(missingMediaId, since);
    expect(
      Date.parse(lookups[1]!.capturedAt) - Date.parse(firstLookup.capturedAt),
      'a segunda tentativa espera o backoff de 1 min',
    ).toBeGreaterThanOrEqual(FIRST_BACKOFF_MS);
    expect(attachmentOf(missingMediaId)?.mediaUrl, 'depois da segunda falha, ainda ponteiro').toBe(
      `meta-media://${missingMediaId}`,
    );
    // O documento baixado não volta ao fake.
    expect((await lookupsOf(goodMediaId, since)).length, 'o anexo baixado é pedido uma vez').toBe(1);
  });
});
