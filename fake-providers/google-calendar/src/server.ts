import type { FastifyReply, FastifyRequest } from 'fastify';
import { createFakeServer } from '@fake-providers/shared';
import { jwks, signIdToken } from './id-token.js';
import * as state from './state.js';

/**
 * Fake Google Agenda (PLANO-AGENDAS-EXTERNAS §12) — o subconjunto que o
 * `GoogleCalendarHttpClient` do back chama, com `OAuthBaseUrl` =
 * `http://localhost:1517` e `ApiBaseUrl` = `http://localhost:1517/calendar/v3`:
 *
 *   POST /token                                   troca de código e refresh (form)
 *   POST /revoke                                  revogação, token no CORPO (form)
 *   GET  /oauth2/v3/certs                         JWKS que assina o id_token (Google:CertificatesUrl)
 *   POST   /calendar/v3/calendars                 cria a agenda dedicada
 *   GET    /calendar/v3/calendars/:cid            agenda existe? (reconectar, recriar)
 *   DELETE /calendar/v3/calendars/:cid            desconectar apagando a agenda
 *   POST   /calendar/v3/calendars/:cid/events     insert com `id` determinístico (repetido = 409)
 *   PATCH  /calendar/v3/calendars/:cid/events/:id atualiza; restaura da lixeira com status confirmed
 *   DELETE /calendar/v3/calendars/:cid/events/:id lixeira (de novo = 410)
 *   GET    /calendar/v3/calendars/:cid/events     list (timeMin/timeMax, showDeleted, pageToken; item com id, status e marcador)
 *
 * Erros no formato do Google: OAuth `{ error, error_description }`; API
 * `{ error: { code, message, errors: [{ reason }] } }` (o back classifica pelo reason).
 *
 * O popup do GIS não roda no E2E: o spec pede um código em
 * `POST /_control/authorize` e o entrega ao `connect` do back. Controle completo
 * no `README.md` desta pasta e em `helpers/fake-providers.ts` (`fakeGoogleCalendar`).
 */

const PORT = Number(process.env.FAKE_GOOGLE_CALENDAR_PORT ?? 1517);

/**
 * O cliente OAuth que o `/token` aceita: os valores de teste do
 * `admin-backend/src/AdminBackend.Api/appsettings.E2E.json` (`Google:ClientId`,
 * `GoogleCalendar:ClientSecret`) e o `redirect_uri` fixo do fluxo de popup do GIS
 * (`GoogleCalendarOptions.RedirectUri`). Conferir os três, como o Google confere,
 * é o que faz o E2E pegar o back mandando o cliente errado (ou um `redirect_uri`
 * vindo do navegador). Mudou no appsettings, muda aqui (ou pela env).
 */
const EXPECTED_CLIENT_ID =
  process.env.FAKE_GOOGLE_CLIENT_ID ?? 'fake-google-client-id-e2e.apps.googleusercontent.com';
const EXPECTED_CLIENT_SECRET = process.env.FAKE_GOOGLE_CLIENT_SECRET ?? 'fake-google-calendar-secret-e2e';
const EXPECTED_REDIRECT_URI = 'postmessage';

const DEFAULT_SCOPE = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/calendar.app.created',
].join(' ');

type Json = Record<string, unknown>;

function apiError(reply: FastifyReply, code: number, message: string, reason: string): Json {
  reply.status(code);
  return { error: { code, message, errors: [{ domain: 'global', reason, message }] } };
}

function oauthError(reply: FastifyReply, status: number, error: string, description: string): Json {
  reply.status(status);
  return { error, error_description: description };
}

/** Aplica o modo de falha da conta na Calendar API; devolve a resposta de erro ou null. */
function apiFailure(reply: FastifyReply, sub: string): Json | null {
  const mode = state.takeFailure(sub, 'api');
  switch (mode) {
    case '500':
      return apiError(reply, 500, 'Backend Error', 'backendError');
    case '429':
      return apiError(reply, 429, 'Rate Limit Exceeded', 'rateLimitExceeded');
    case 'invalid_grant':
    case '401':
      return apiError(reply, 401, 'Invalid Credentials', 'authError');
    case '404calendar':
      return apiError(reply, 404, 'Not Found', 'notFound');
    default:
      return null;
  }
}

/** Bearer -> conta. Token desconhecido ou grant revogado: 401 como o Google. */
type Auth = { ok: true; sub: string } | { ok: false; body: Json };

function authenticate(req: FastifyRequest, reply: FastifyReply): Auth {
  const header = req.headers.authorization ?? '';
  const accessToken = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
  const grant = accessToken ? state.grantByAccessToken(accessToken) : undefined;
  if (!grant || grant.revoked) {
    return { ok: false, body: apiError(reply, 401, 'Invalid Credentials', 'authError') };
  }
  const failure = apiFailure(reply, grant.sub);
  return failure ? { ok: false, body: failure } : { ok: true, sub: grant.sub };
}

/** Agenda viva e da conta do token; senão 404 (o Google não diz que é de outro). */
function ownedCalendar(sub: string, calendarId: string): state.FakeCalendar | null {
  const calendar = state.getCalendar(calendarId);
  return calendar && !calendar.deleted && calendar.sub === sub ? calendar : null;
}

function eventResponse(ev: state.FakeEvent): Json {
  return { kind: 'calendar#event', id: ev.id, status: ev.status, htmlLink: ev.htmlLink };
}

await createFakeServer({
  name: 'google-calendar',
  port: PORT,
  registerRoutes: (app) => {
    // O endpoint de token e o de revogação recebem form, como no Google.
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(body as string)));
      },
    );

    // ─── OAuth ─────────────────────────────────────────────────────────────

    app.get('/oauth2/v3/certs', async () => jwks());

    app.post<{ Body: Record<string, string> }>('/token', async (req, reply) => {
      const form = req.body ?? {};
      const clientId = form.client_id ?? '';

      // Cliente desconhecido ou segredo errado: 401 `invalid_client`, como o Google.
      if (clientId !== EXPECTED_CLIENT_ID || (form.client_secret ?? '') !== EXPECTED_CLIENT_SECRET) {
        return oauthError(reply, 401, 'invalid_client', 'Unauthorized');
      }

      if (form.grant_type === 'authorization_code') {
        // A troca do código do popup exige o literal `postmessage`; outro valor é 400.
        if ((form.redirect_uri ?? '') !== EXPECTED_REDIRECT_URI) {
          return oauthError(reply, 400, 'redirect_uri_mismatch', 'Bad Request');
        }
        const pending = state.getCode(form.code ?? '');
        if (!pending || pending.used) {
          return oauthError(reply, 400, 'invalid_grant', 'Malformed auth code.');
        }
        const failure = state.takeFailure(pending.sub, 'token');
        if (failure === '500') return oauthError(reply, 500, 'internal_failure', 'Backend Error');
        if (failure === 'invalid_grant') return oauthError(reply, 400, 'invalid_grant', 'Bad Request');

        pending.used = true;
        const { grant, accessToken } = state.createGrant({
          sub: pending.sub,
          clientId,
          scope: pending.scope,
          withRefreshToken: !pending.omitRefreshToken,
        });
        const body: Json = {
          access_token: accessToken,
          expires_in: 3599,
          scope: grant.scope,
          token_type: 'Bearer',
        };
        if (grant.refreshToken) body.refresh_token = grant.refreshToken;
        if (!pending.omitIdToken) {
          body.id_token = signIdToken({
            sub: pending.sub,
            email: pending.email,
            audience: pending.idTokenAudience ?? clientId,
            clientId,
          });
        }
        return body;
      }

      if (form.grant_type === 'refresh_token') {
        const grant = state.grantByRefreshToken(form.refresh_token ?? '');
        if (!grant || grant.revoked) {
          return oauthError(reply, 400, 'invalid_grant', 'Token has been expired or revoked.');
        }
        const failure = state.takeFailure(grant.sub, 'token');
        if (failure === '500') return oauthError(reply, 500, 'internal_failure', 'Backend Error');
        if (failure === 'invalid_grant') {
          return oauthError(reply, 400, 'invalid_grant', 'Token has been expired or revoked.');
        }
        return {
          access_token: state.issueAccessToken(grant),
          expires_in: 3599,
          scope: grant.scope,
          token_type: 'Bearer',
        };
      }

      return oauthError(reply, 400, 'unsupported_grant_type', `grant_type ${form.grant_type ?? '(vazio)'}`);
    });

    app.post<{ Body: Record<string, string> }>('/revoke', async (req, reply) => {
      const value = req.body?.token ?? '';
      if (!state.revokeByToken(value)) {
        return oauthError(reply, 400, 'invalid_token', 'Token expired or revoked');
      }
      return {};
    });

    // ─── Agendas ───────────────────────────────────────────────────────────

    app.post<{ Body: Json }>('/calendar/v3/calendars', async (req, reply) => {
      const auth = authenticate(req, reply);
      if (!auth.ok) return auth.body;
      const body = req.body ?? {};
      if (typeof body.summary !== 'string' || body.summary.trim() === '') {
        return apiError(reply, 400, 'Missing summary.', 'required');
      }
      const calendar = state.createCalendar({
        sub: auth.sub,
        summary: body.summary,
        timeZone: typeof body.timeZone === 'string' ? body.timeZone : 'UTC',
        description: typeof body.description === 'string' ? body.description : null,
      });
      return { kind: 'calendar#calendar', id: calendar.id, summary: calendar.summary, timeZone: calendar.timeZone };
    });

    app.get<{ Params: { cid: string } }>('/calendar/v3/calendars/:cid', async (req, reply) => {
      const auth = authenticate(req, reply);
      if (!auth.ok) return auth.body;
      const calendar = ownedCalendar(auth.sub, req.params.cid);
      if (!calendar) return apiError(reply, 404, 'Not Found', 'notFound');
      return { kind: 'calendar#calendar', id: calendar.id, summary: calendar.summary, timeZone: calendar.timeZone };
    });

    app.delete<{ Params: { cid: string } }>('/calendar/v3/calendars/:cid', async (req, reply) => {
      const auth = authenticate(req, reply);
      if (!auth.ok) return auth.body;
      const calendar = ownedCalendar(auth.sub, req.params.cid);
      if (!calendar) return apiError(reply, 404, 'Not Found', 'notFound');
      state.deleteCalendar(calendar.id);
      return reply.code(204).send();
    });

    // ─── Eventos ───────────────────────────────────────────────────────────

    app.post<{ Params: { cid: string }; Body: Json }>('/calendar/v3/calendars/:cid/events', async (req, reply) => {
      const auth = authenticate(req, reply);
      if (!auth.ok) return auth.body;
      const calendar = ownedCalendar(auth.sub, req.params.cid);
      if (!calendar) return apiError(reply, 404, 'Not Found', 'notFound');

      const body = req.body ?? {};
      // Id já usado, inclusive na lixeira: 409, como o Google (plano §8.1 item 13).
      if (typeof body.id === 'string' && state.getEvent(calendar.id, body.id)) {
        return apiError(reply, 409, 'The requested identifier already exists.', 'duplicate');
      }
      return eventResponse(state.insertEvent(calendar.id, body, 'api'));
    });

    app.patch<{ Params: { cid: string; eid: string }; Body: Json }>(
      '/calendar/v3/calendars/:cid/events/:eid',
      async (req, reply) => {
        const auth = authenticate(req, reply);
        if (!auth.ok) return auth.body;
        const calendar = ownedCalendar(auth.sub, req.params.cid);
        if (!calendar) return apiError(reply, 404, 'Not Found', 'notFound');
        const ev = state.getEvent(calendar.id, req.params.eid);
        if (!ev) return apiError(reply, 404, 'Not Found', 'notFound');
        return eventResponse(state.patchEvent(ev, req.body ?? {}));
      },
    );

    app.delete<{ Params: { cid: string; eid: string } }>(
      '/calendar/v3/calendars/:cid/events/:eid',
      async (req, reply) => {
        const auth = authenticate(req, reply);
        if (!auth.ok) return auth.body;
        const calendar = ownedCalendar(auth.sub, req.params.cid);
        if (!calendar) return apiError(reply, 404, 'Not Found', 'notFound');
        const ev = state.getEvent(calendar.id, req.params.eid);
        if (!ev) return apiError(reply, 404, 'Not Found', 'notFound');
        if (ev.status === 'cancelled') return apiError(reply, 410, 'Resource has been deleted', 'deleted');
        state.deleteEvent(ev, false);
        return reply.code(204).send();
      },
    );

    app.get<{
      Params: { cid: string };
      Querystring: { timeMin?: string; timeMax?: string; pageToken?: string; maxResults?: string; showDeleted?: string };
    }>('/calendar/v3/calendars/:cid/events', async (req, reply) => {
      const auth = authenticate(req, reply);
      if (!auth.ok) return auth.body;
      const calendar = ownedCalendar(auth.sub, req.params.cid);
      if (!calendar) return apiError(reply, 404, 'Not Found', 'notFound');

      const min = req.query.timeMin ? Date.parse(req.query.timeMin) : Number.NEGATIVE_INFINITY;
      const max = req.query.timeMax ? Date.parse(req.query.timeMax) : Number.POSITIVE_INFINITY;
      const showDeleted = req.query.showDeleted === 'true';

      const all = state
        .eventsOf(calendar.id)
        .filter((e) => showDeleted || e.status !== 'cancelled')
        .filter((e) => {
          // Sobreposição com a janela, como o Google: termina depois de timeMin e começa antes de timeMax.
          const start = state.toUtcMs(e.start) ?? 0;
          const end = state.toUtcMs(e.end) ?? start;
          return end > min && start < max;
        })
        .sort((a, b) => (state.toUtcMs(a.start) ?? 0) - (state.toUtcMs(b.start) ?? 0));

      const size = Math.max(1, Math.min(2500, Number(req.query.maxResults ?? 250) || 250));
      const offset = Number(req.query.pageToken ?? 0) || 0;
      const page = all.slice(offset, offset + size);
      const body: Json = {
        kind: 'calendar#events',
        // `status`: com `showDeleted=true` o back separa a lixeira (o apagado à mão,
        // que ele restaura) do que está vivo (o órfão, que ele remove).
        items: page.map((e) => ({ id: e.id, status: e.status, extendedProperties: e.extendedProperties ?? undefined })),
      };
      if (offset + size < all.length) body.nextPageToken = String(offset + size);
      return body;
    });

    // ─── Controle (specs) ──────────────────────────────────────────────────

    app.delete('/_control/state', async () => {
      state.reset();
      return { reset: true };
    });

    // O "popup" do GIS: devolve um código de autorização de uso único para a conta.
    app.post<{
      Body: {
        sub?: string;
        email?: string;
        scope?: string;
        omitRefreshToken?: boolean;
        omitIdToken?: boolean;
        idTokenAudience?: string;
      };
    }>('/_control/authorize', async (req) => {
      const b = req.body ?? {};
      const sub = b.sub ?? `fake-sub-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const email = b.email ?? `${sub}@example.com`;
      const pending = state.createCode({
        sub,
        email,
        scope: b.scope ?? DEFAULT_SCOPE,
        omitRefreshToken: b.omitRefreshToken === true,
        omitIdToken: b.omitIdToken === true,
        idTokenAudience: b.idTokenAudience ?? null,
      });
      return { code: pending.code, sub, email, scope: pending.scope };
    });

    // Tudo da conta: grants, modo de falha, agendas e eventos (inclusive os da lixeira).
    app.get<{ Params: { sub: string } }>('/_control/accounts/:sub', async (req, reply) => {
      const account = state.getAccount(req.params.sub);
      if (!account) {
        reply.status(404);
        return { error: 'conta desconhecida no fake', sub: req.params.sub };
      }
      return {
        sub: account.sub,
        email: account.email,
        failure: account.failure,
        grants: state.grantsOf(account.sub).map((g) => ({
          id: g.id,
          scope: g.scope,
          revoked: g.revoked,
          hasRefreshToken: g.refreshToken !== null,
          createdAt: g.createdAt,
        })),
        calendars: state.calendarsOf(account.sub).map((c) => ({ ...c, events: state.eventsOf(c.id) })),
      };
    });

    // "Remover acesso" em myaccount.google.com: revoga todos os grants da conta.
    app.post<{ Params: { sub: string } }>('/_control/accounts/:sub/revoke', async (req) => ({
      revoked: state.revokeAccount(req.params.sub),
    }));

    app.put<{ Params: { sub: string }; Body: { mode?: state.FailureMode; times?: number | null } }>(
      '/_control/accounts/:sub/failure',
      async (req, reply) => {
        const mode = req.body?.mode;
        const valid: state.FailureMode[] = ['500', '429', 'invalid_grant', '401', '404calendar'];
        if (!mode || !valid.includes(mode)) {
          reply.status(400);
          return { error: `mode deve ser um de ${valid.join(', ')}` };
        }
        const times = typeof req.body?.times === 'number' ? req.body.times : null;
        return { failure: state.setFailure(req.params.sub, mode, times) };
      },
    );

    app.delete<{ Params: { sub: string } }>('/_control/accounts/:sub/failure', async (req) => {
      state.clearFailure(req.params.sub);
      return { cleared: true };
    });

    app.get<{ Params: { cid: string } }>('/_control/calendars/:cid', async (req, reply) => {
      const calendar = state.getCalendar(req.params.cid);
      if (!calendar) {
        reply.status(404);
        return { error: 'agenda desconhecida no fake', id: req.params.cid };
      }
      return { ...calendar, events: state.eventsOf(calendar.id) };
    });

    // O gestor apaga a agenda dedicada à mão no Google.
    app.delete<{ Params: { cid: string } }>('/_control/calendars/:cid', async (req) => ({
      deleted: state.deleteCalendar(req.params.cid),
    }));

    // Evento criado à mão na agenda (sem marcador, a menos que o spec mande `extendedProperties`).
    app.post<{ Params: { cid: string }; Body: Json }>('/_control/calendars/:cid/events', async (req, reply) => {
      const calendar = state.getCalendar(req.params.cid);
      if (!calendar) {
        reply.status(404);
        return { error: 'agenda desconhecida no fake', id: req.params.cid };
      }
      return state.insertEvent(calendar.id, req.body ?? {}, 'manual');
    });

    // Evento apagado à mão: vai para a lixeira (`cancelled`), ou some de vez com `?purge=true`.
    app.delete<{ Params: { cid: string; eid: string }; Querystring: { purge?: string } }>(
      '/_control/calendars/:cid/events/:eid',
      async (req, reply) => {
        const ev = state.getEvent(req.params.cid, req.params.eid);
        if (!ev) {
          reply.status(404);
          return { error: 'evento desconhecido no fake' };
        }
        state.deleteEvent(ev, req.query.purge === 'true');
        return { deleted: true, purged: req.query.purge === 'true' };
      },
    );
  },
});
