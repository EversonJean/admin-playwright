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

// ---------------------------------------------------------------------------
// Controle por teste (Etapa 221, e2e da escalacao da semana). Os workers do
// Playwright rodam em paralelo contra este mesmo fake, entao a resposta
// roteirizada e a falha valem so para a chamada cujas mensagens contem o
// `match` do teste (um id de festa que so ele tem), nunca por contagem global.
//
//   POST /_control/next-response  { match, content, count? }  resposta roteirizada
//   POST /_control/fail-next      { match, count?, status? }  provider fora (count 0 desarma)
// ---------------------------------------------------------------------------

interface Scripted {
  match: string;
  content: string;
  remaining: number;
}

interface Failure {
  match: string;
  status: number;
  remaining: number;
}

const scripted: Scripted[] = [];
const failures: Failure[] = [];

function promptText(messages: Array<{ content?: unknown }>): string {
  return messages
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')))
    .join('\n');
}

function take<T extends { match: string; remaining: number }>(list: T[], text: string): T | undefined {
  const hit = list.find((x) => x.remaining > 0 && text.includes(x.match));
  if (hit) hit.remaining -= 1;
  return hit;
}

await createFakeServer({
  name: 'openai',
  port: PORT,
  registerRoutes: (app) => {
    app.post<{ Body: { match?: string; content?: string; count?: number } }>(
      '/_control/next-response',
      async (req, reply) => {
        const { match, content } = req.body ?? {};
        if (!match || typeof content !== 'string') {
          reply.status(400);
          return { error: 'match e content sao obrigatorios' };
        }
        scripted.push({ match, content, remaining: Math.max(1, Math.floor(req.body?.count ?? 1)) });
        return { armed: true };
      },
    );

    app.post<{ Body: { match?: string; count?: number; status?: number } }>(
      '/_control/fail-next',
      async (req, reply) => {
        const match = req.body?.match;
        if (!match) {
          reply.status(400);
          return { error: 'match e obrigatorio' };
        }
        const remaining = Math.max(0, Math.floor(req.body?.count ?? 1));
        for (let i = failures.length - 1; i >= 0; i--) {
          if (failures[i]!.match === match) failures.splice(i, 1);
        }
        if (remaining > 0) failures.push({ match, remaining, status: req.body?.status ?? 500 });
        return { remaining };
      },
    );

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
      const text = promptText(body.messages);
      const failure = take(failures, text);
      if (failure) {
        reply.status(failure.status);
        return { error: { message: 'falha simulada (fake)', type: 'server_error' } };
      }
      const script = take(scripted, text);
      if (script) {
        reply.status(200);
        return {
          id: makeId(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{ index: 0, message: { role: 'assistant', content: script.content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 24, total_tokens: 36 },
        };
      }
      const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
      const echo = lastUser?.content?.slice(0, 200) ?? 'no-prompt';
      const wantJson = body.response_format?.type === 'json_object';
      // Schema generico que cobre o GenerateClause do back (Etapa 77):
      // { bodyHtml, bodyPlain, suggestedTitle, suggestedCategory }.
      // Outras acoes (propose-budget, event-timeline) parseiam keys
      // proprias do schema — quando precisar de um spec deep delas,
      // estender este return condicionalmente pelo conteudo do prompt.
      // Raio-X das recusas (`RefusalAnalysisPrompt`, AiAction.AnalyzeRefusal):
      // o parser do back rejeita categoria fora da taxonomia, entao o shape
      // generico abaixo nunca completaria a analise. Reconhecido pela
      // instrucao fixa do prompt; categoria `price` deterministica.
      const isRefusalAnalysis = (lastUser?.content ?? '').includes('Classifique a perda');
      const content = isRefusalAnalysis
        ? JSON.stringify({
            category: 'price',
            customCategory: null,
            confidence: 0.9,
            summary: 'Cliente achou o valor alto (fake).',
            competitorName: null,
          })
        : wantJson
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
