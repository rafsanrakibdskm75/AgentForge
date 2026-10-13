// HTTP routes for the "needs you" alerts (see server/alerts/service.ts). Wired into the API by the
// parent agent (another task edits server/index.ts): `createApiHandler` should call the returned
// handler before its catch-all. Reads are open; the POSTs that change config or trigger a send are
// local-only (Host loopback), like /api/rooms/rename.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendJson, HttpError } from '../http/app';
import { isLoopbackHost } from '../http/guard';
import { tr } from '../../shared/i18n';
import type { AlertService } from './service';

export function createAlertsRoutes(service: AlertService): (req: IncomingMessage, res: ServerResponse, path: string) => boolean {
  // Local-only gate (same shape as /api/rooms/rename in server/http/app.ts).
  const trusted = (req: IncomingMessage): boolean => isLoopbackHost(req.headers.host);
  const denied = (_req: IncomingMessage, localMessage: string): string => localMessage;
  const methodNotAllowed = (res: ServerResponse, allow: string) => {
    res.setHeader('Allow', allow);
    sendJson(res, 405, { error: tr('método não permitido') });
  };
  const fail = (res: ServerResponse, err: unknown) => {
    if (res.headersSent) return void res.destroy();
    if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
    else sendJson(res, 500, { error: tr('erro interno') });
  };

  return (req, res, path) => {
    const method = req.method ?? 'GET';
    if (path === '/api/alerts/config') {
      if (method !== 'GET' && method !== 'POST') methodNotAllowed(res, 'GET, POST');
      else if (method === 'GET') sendJson(res, 200, service.getConfig());
      else if (!trusted(req)) sendJson(res, 403, { error: denied(req, tr('alertas só pelo próprio computador (http://localhost)')) });
      else
        readJson(req)
          .then((body) => {
            const b = body as { enabled?: unknown; topic?: unknown; server?: unknown };
            sendJson(res, 200, { ok: true, config: service.setConfig(b ?? {}) });
          })
          .catch((err) => fail(res, err));
      return true;
    }
    if (path === '/api/alerts/test') {
      if (method !== 'POST') methodNotAllowed(res, 'POST');
      else if (!trusted(req)) sendJson(res, 403, { error: denied(req, tr('alertas só pelo próprio computador (http://localhost)')) });
      else service.sendTest().then((r) => sendJson(res, 200, r)).catch((err) => fail(res, err));
      return true;
    }
    return false;
  };
}
