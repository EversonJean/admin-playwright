import { createFakeServer } from '@fake-providers/shared';

/**
 * Fake Anthropic server (compatível com /v1). Endpoint usado pelo back:
 *
 *   POST /messages
 *   Body: { model, max_tokens, system?, messages: [{role, content}] }
 *   Auth: x-api-key + anthropic-version
 *   Resposta: { id, type: 'message', role: 'assistant', model,
 *               content: [{ type: 'text', text: '...' }],
 *               stop_reason: 'end_turn',
 *               usage: { input_tokens, output_tokens } }
 */

const PORT = Number(process.env.FAKE_ANTHROPIC_PORT ?? 1515);

function makeId(): string {
  return 'msg-fake-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

await createFakeServer({
  name: 'anthropic',
  port: PORT,
  registerRoutes: (app) => {
    app.post<{
      Body: {
        model?: string;
        system?: string;
        messages?: Array<{ role?: string; content?: string }>;
      };
    }>('/messages', async (req, reply) => {
      const body = req.body;
      if (!body?.model || !Array.isArray(body.messages)) {
        reply.status(400);
        return { type: 'error', error: { type: 'invalid_request_error', message: 'invalid' } };
      }
      const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
      const echo = lastUser?.content?.slice(0, 200) ?? 'no-prompt';
      reply.status(200);
      return {
        id: makeId(),
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [{ type: 'text', text: `[fake anthropic] echo: ${echo}` }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 24 },
      };
    });
  },
});
