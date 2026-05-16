import { createFakeServer } from '@fake-providers/shared';

/**
 * Fake OpenAI server (compatível com /v1). Endpoint usado pelo back:
 *
 *   POST /chat/completions
 *   Body: { model, messages: [{role, content}], temperature, max_tokens,
 *           response_format? }
 *   Auth: Authorization: Bearer <ApiKey>
 *   Resposta: { id, model, choices: [{ message: { role: 'assistant',
 *               content: '...' } }], usage: { prompt_tokens, completion_tokens } }
 *
 * O conteudo da resposta eh ECHO determinista do ultimo prompt user — se
 * o request tem `response_format = json_object`, devolve JSON minimo
 * { "result": "<echo>" } pra que parsers do back nao falhem.
 */

const PORT = Number(process.env.FAKE_OPENAI_PORT ?? 1514);

function makeId(): string {
  return 'chatcmpl-fake-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

await createFakeServer({
  name: 'openai',
  port: PORT,
  registerRoutes: (app) => {
    app.post<{
      Body: {
        model?: string;
        messages?: Array<{ role?: string; content?: string }>;
        response_format?: { type?: string };
      };
    }>('/chat/completions', async (req, reply) => {
      const body = req.body;
      if (!body?.model || !Array.isArray(body.messages)) {
        reply.status(400);
        return { error: { message: 'invalid request', type: 'invalid_request_error' } };
      }
      const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
      const echo = lastUser?.content?.slice(0, 200) ?? 'no-prompt';
      const wantJson = body.response_format?.type === 'json_object';
      // Schema generico que cobre o GenerateClause do back (Etapa 77):
      // { bodyHtml, bodyPlain, suggestedTitle, suggestedCategory }.
      // Outras acoes (propose-budget, event-timeline) parseiam keys
      // proprias do schema — quando precisar de um spec deep delas,
      // estender este return condicionalmente pelo conteudo do prompt.
      const content = wantJson
        ? JSON.stringify({
            bodyHtml: `<p>Clausula gerada (fake) a partir de: ${echo.slice(0, 60)}</p>`,
            bodyPlain: `Clausula gerada (fake) a partir de: ${echo.slice(0, 60)}`,
            suggestedTitle: 'Clausula Fake E2E',
            suggestedCategory: 'Geral',
          })
        : `[fake openai] echo: ${echo}`;
      reply.status(200);
      return {
        id: makeId(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 24,
          total_tokens: 36,
        },
      };
    });
  },
});
