import { createServer } from 'node:http';
import { DomainError } from './errors.js';
import { identifier } from './validation.js';

function json(response, status, body, extraHeaders = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
    throw new DomainError('unsupported_media_type', 'Envie Content-Type: application/json.', 415);
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 65536) throw new DomainError('payload_too_large', 'Limite do corpo JSON: 64 KiB.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new DomainError('invalid_json', 'Corpo JSON inválido.', 400); }
}

export function createApi(service, { onError = (error) => console.error(error) } = {}) {
  return createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/health') {
        if (request.method !== 'GET') return json(response, 405, { error: { code: 'method_not_allowed' } }, { allow: 'GET' });
        return json(response, 200, { status: 'ok', service: 'conty-vendas-shopify' });
      }
      if (pathname === '/orders' || pathname === '/refunds') {
        if (request.method !== 'POST') return json(response, 405, { error: { code: 'method_not_allowed' } }, { allow: 'POST' });
        const payload = await readBody(request);
        const result = pathname === '/orders' ? service.ingestOrder(payload) : service.ingestRefund(payload);
        return json(response, result.duplicate ? 200 : 201, result);
      }
      const match = /^\/(orders|refunds)\/([^/]+)$/.exec(pathname);
      const creator = /^\/creators\/([^/]+)\/sales$/.exec(pathname);
      if (match || creator) {
        if (request.method !== 'GET') return json(response, 405, { error: { code: 'method_not_allowed' } }, { allow: 'GET' });
        let id;
        try { id = decodeURIComponent((match ?? creator)[2] ?? creator[1]); }
        catch { throw new DomainError('invalid_id', 'ID contém escape inválido.', 400); }
        identifier(id, 'id');
        const result = creator ? service.getCreatorSales(id)
          : match[1] === 'orders' ? service.getOrder(id) : service.getRefund(id);
        return json(response, 200, result);
      }
      return json(response, 404, { error: { code: 'route_not_found', message: 'Rota não encontrada.' } });
    } catch (error) {
      if (error instanceof DomainError) return json(response, error.status, { error: { code: error.code, message: error.message } });
      onError(error);
      if (!response.headersSent) return json(response, 500, { error: { code: 'internal_error', message: 'Falha ao processar e persistir o evento.' } });
      response.end();
    }
  });
}
