import { authTest as test, expect } from '../../fixtures/auth.fixture';
import { apiCreateActivity, apiCreateClient } from '../../helpers/api-entities';
import {
  apiCreateBudget,
  apiGetBudget,
  apiGetPublicBudget,
  createPublicApiContext,
  extractTokenFromPublicUrl,
} from '../../helpers/api-event-flow';
import { seedConnectedWhatsappTenantDirect, whatsAppTemplateIdByNameDirect } from '../../helpers/db-helper';
import { InboxEntry, fakeWhatsApp } from '../../helpers/fake-providers';
import { assertOk, readJson } from '../../helpers/response';
import {
  apiConversationIdByPhone,
  authorizationOf,
  digitsOf,
  enableWhatsAppFeaturesDirect,
  fakeMessagesTo,
  receiveInbound,
  uniquePhoneE164,
} from '../../helpers/whatsapp-flow';

/**
 * Fluxo: 5.7 — Orçamento enviado por WhatsApp pelo canal da empresa
 * Diagrama: — (cenário E146 do registro e2e de `docs/implementar/PLANO-SEGURANCA.md`)
 *
 * Fonte do comportamento: PLANO-SEGURANCA §5b (SEG-C2, Etapa 242), item 1 (o
 * envio sai pelo número e pelo token do canal do tenant) e o "além do plano" da
 * 242: fora da janela de 24 h o orçamento sai pelo modelo `orcamento_pronto`,
 * com o PDF no cabeçalho, aprovado na WABA da empresa; dentro da janela sai como
 * documento. Nos dois casos o orçamento fica `Sent` com o link público. O spec
 * afirma o plano; divergência é falha de código, não de asserção.
 */

interface SendViaWhatsAppResult {
  budgetId: string;
  conversationId: string;
  windowOpen: boolean;
  publicUrl: string;
  messageId: string | null;
  templateUsed: string | null;
}

test.describe('Fluxo 5.7 — Orçamento por WhatsApp', () => {
  test('E146 @flow fora da janela sai pelo orcamento_pronto com o PDF no cabeçalho; dentro dela, como documento; sempre pelo número e token da empresa', async ({
    authApi,
    tenant,
  }) => {
    test.setTimeout(120_000);
    enableWhatsAppFeaturesDirect(tenant.tenantId);
    const budgetTemplateId = whatsAppTemplateIdByNameDirect('orcamento_pronto');
    const channel = seedConnectedWhatsappTenantDirect(tenant.tenantId, [budgetTemplateId]);

    const phone = uniquePhoneE164();
    const client = await apiCreateClient(authApi, { phone: digitsOf(phone).slice(2) });
    const activity = await apiCreateActivity(authApi);
    const bearer = `Bearer ${channel.accessToken}`;

    /** Envia o orçamento por WhatsApp e devolve o resultado e o que o fake recebeu desde o envio. */
    const sendBudget = async (budgetId: string) => {
      const since = new Date().toISOString();
      const res = await authApi.post(`/api/budgets/${budgetId}/send-whatsapp`);
      await assertOk(res, 'POST /api/budgets/{id}/send-whatsapp');
      const result = await readJson<SendViaWhatsAppResult>(res);
      let message: InboxEntry | undefined;
      await expect
        .poll(async () => {
          message = (await fakeMessagesTo(phone, since)).find((e) => e.path === `/${channel.phoneNumberId}/messages`);
          return message ? authorizationOf(message) : null;
        }, { message: 'o fake recebe POST /{número da empresa}/messages' })
        .toBe(bearer);
      const media = (await fakeWhatsApp.inbox({ since, path: `/${channel.phoneNumberId}/media` })).filter(
        (e) => e.method === 'POST',
      );
      return { result, message: message!, media };
    };

    /** O orçamento ficou `Sent` e o link público abre. */
    const expectSentWithPublicLink = async (budgetId: string, publicUrl: string) => {
      const budget = await apiGetBudget(authApi, budgetId);
      expect(budget.status, 'orçamento enviado').toBe('Sent');
      const publicApi = await createPublicApiContext();
      try {
        const shown = await apiGetPublicBudget(publicApi, extractTokenFromPublicUrl(publicUrl));
        expect(shown.id ?? budgetId).toBeTruthy();
      } finally {
        await publicApi.dispose();
      }
    };

    // Fora da janela (o cliente nunca escreveu): modelo com o PDF no cabeçalho.
    const first = await apiCreateBudget(authApi, { clientId: client.id, activityIds: [activity.id] });
    const outside = await sendBudget(first.id);
    expect(outside.result.windowOpen).toBe(false);
    expect(outside.result.templateUsed).toBe('orcamento_pronto');
    expect(outside.media.length, 'o PDF sobe em /media').toBeGreaterThan(0);
    for (const upload of outside.media) {
      expect(authorizationOf(upload), 'upload com o token da empresa').toBe(bearer);
    }
    const templateBody = outside.message.body as {
      type?: string;
      template?: {
        name?: string;
        components?: Array<{ type?: string; parameters?: Array<{ type?: string; document?: { id?: string } }> }>;
      };
    };
    expect(templateBody.type).toBe('template');
    expect(templateBody.template?.name).toBe('orcamento_pronto');
    const headerDocument = templateBody.template?.components
      ?.find((c) => c.type === 'header')
      ?.parameters?.find((p) => p.type === 'document')?.document?.id;
    const mediaIds = outside.media.map((m) => (m.response.body as { id?: string }).id);
    expect(mediaIds, 'o cabeçalho leva o PDF subido').toContain(headerDocument);
    await expectSentWithPublicLink(first.id, outside.result.publicUrl);

    // Dentro da janela (o cliente acabou de escrever): sai como documento.
    await receiveInbound(channel.phoneNumberId, phone, 'Oi! Pode mandar o orçamento por aqui?');
    await apiConversationIdByPhone(authApi, phone);
    const second = await apiCreateBudget(authApi, { clientId: client.id, activityIds: [activity.id] });
    const inside = await sendBudget(second.id);
    expect(inside.result.windowOpen).toBe(true);
    expect(inside.result.templateUsed).toBeNull();
    expect((inside.message.body as { type?: string }).type).toBe('document');
    for (const upload of inside.media) {
      expect(authorizationOf(upload), 'upload com o token da empresa').toBe(bearer);
    }
    await expectSentWithPublicLink(second.id, inside.result.publicUrl);
  });
});
