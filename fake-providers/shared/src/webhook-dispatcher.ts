import { request as httpRequest } from 'node:https';
import { request as httpReq } from 'node:http';
import { URL } from 'node:url';

export interface WebhookOptions {
  /** URL completa (https://localhost:1501/api/...) */
  url: string;
  /** Body que será serializado como JSON */
  payload: unknown;
  /** Headers extras (Content-Type já é setado pra application/json) */
  headers?: Record<string, string>;
  /** Aceitar self-signed (back roda em https://localhost com cert dev) */
  rejectUnauthorized?: boolean;
}

export interface WebhookResult {
  status: number;
  body: string;
}

/**
 * Dispara webhook HTTP real contra o back. Usado por `/_control/trigger-webhook`
 * de cada fake server pra simular callback externo passando pelo controller
 * real (HMAC, middleware de tenant, etc.). Self-signed cert é aceito porque
 * o back roda com cert dev em E2E.
 */
export class WebhookDispatcher {
  async send(options: WebhookOptions): Promise<WebhookResult> {
    const url = new URL(options.url);
    const body = JSON.stringify(options.payload);
    const isHttps = url.protocol === 'https:';
    const reqFn = isHttps ? httpRequest : httpReq;
    return await new Promise((resolve, reject) => {
      const req = reqFn(
        {
          method: 'POST',
          host: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body).toString(),
            ...(options.headers ?? {}),
          },
          rejectUnauthorized: options.rejectUnauthorized ?? false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}
