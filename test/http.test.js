import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApi } from '../src/http.js';
import { MemoryRepository } from '../src/repository.js';
import { SalesService } from '../src/sales-service.js';

async function server(t, options = {}) {
  const repository = new MemoryRepository();
  const service = new SalesService({ repository });
  const errors = [];
  const api = createApi(service, { onError: (error) => errors.push(error), ...options });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  t.after(async () => {
    api.closeAllConnections();
    await new Promise((resolve) => api.close(resolve));
  });
  const url = `http://127.0.0.1:${api.address().port}`;
  async function request(path, method = 'GET', body) {
    const response = await fetch(url + path, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  return { url, request, repository, errors };
}

test('fluxo HTTP real: pendência, pedido, duplicados, estorno full e consulta auditável', async (t) => {
  const { request } = await server(t);
  const refund = { id: 'r-1', order_id: 'o-1', amount_cents: 3010 };
  const order = { id: 'o-1', total: '150.00', status: 'paid', coupon: 'ANA10', utms: { utm_content: 'bruno' } };
  assert.equal((await request('/health')).status, 200);
  const before = await request('/refunds', 'POST', refund);
  assert.equal(before.status, 201);
  assert.equal(before.body.refund.state, 'pending');
  assert.equal((await request('/refunds/r-1')).body.applied_cents, 0);
  assert.equal((await request('/orders', 'POST', order)).body.order.net_attributed_cents, 11990);
  assert.equal((await request('/orders', 'POST', order)).status, 200);
  assert.equal((await request('/refunds', 'POST', refund)).body.duplicate, true);
  assert.equal((await request('/refunds', 'POST', { id: 'r-2', order_id: 'o-1', type: 'full' })).status, 201);
  const view = await request('/orders/o-1');
  assert.equal(view.status, 200);
  assert.equal(view.body.history.length, 5);
  assert.equal(view.body.refunded_cents, 15000);
  assert.equal(view.body.net_attributed_cents, 0);
  assert.equal((await request('/creators/creator-ana/sales')).body.net_cents, '0');
  assert.equal((await request('/creators/creator-bruno/sales')).body.gross_cents, '0');
  assert.match(view.headers.get('content-type'), /application\/json/);
});

test('HTTP erros de contrato, conflitos, método e rotas são explícitos', async (t) => {
  const { request } = await server(t);
  assert.equal((await request('/orders', 'POST', { id: 'x', total: '1.00', status: 'garbage' })).status, 400);
  assert.equal((await request('/orders/absent')).status, 404);
  assert.equal((await request('/refunds/absent')).status, 404);
  assert.equal((await request('/unknown')).status, 404);
  const method = await request('/orders', 'GET');
  assert.equal(method.status, 405);
  assert.equal(method.headers.get('allow'), 'POST');
  assert.equal((await request('/health', 'POST', {})).status, 405);
  assert.equal((await request('/orders/%E0%A4%A')).status, 400);
  const original = { id: 'x', total_cents: 100, status: 'paid' };
  await request('/orders', 'POST', original);
  assert.equal((await request('/orders', 'POST', { ...original, total_cents: 101 })).status, 409);
  assert.equal((await request('/orders/x')).body.total_cents, 100);
});

test('HTTP rejeita JSON inválido, media type e corpo acima do limite', async (t) => {
  const { url } = await server(t);
  const wrongType = await fetch(url + '/orders', { method: 'POST', body: '{}' });
  assert.equal(wrongType.status, 415);
  const invalid = await fetch(url + '/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(invalid.status, 400);
  const huge = await fetch(url + '/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: 'x'.repeat(66000) }) });
  assert.equal(huge.status, 413);
});

test('requisições concorrentes com mesmo ID mantêm uma única venda e único estorno', async (t) => {
  const { request } = await server(t);
  const order = { id: 'concurrent', total_cents: 1000, status: 'paid', coupon: 'ANA10' };
  const results = await Promise.all(Array.from({ length: 20 }, () => request('/orders', 'POST', order)));
  assert.equal(results.filter((result) => result.status === 201).length, 1);
  assert.equal(results.filter((result) => result.status === 200).length, 19);
  const refund = { id: 'same-refund', order_id: 'concurrent', amount_cents: 250 };
  const refunds = await Promise.all(Array.from({ length: 20 }, () => request('/refunds', 'POST', refund)));
  assert.equal(refunds.filter((result) => result.status === 201).length, 1);
  assert.equal((await request('/orders/concurrent')).body.net_attributed_cents, 750);
});

test('HTTP falha de persistência responde 500 sem creditar pedido', async (t) => {
  const { request, repository, errors } = await server(t);
  repository.replace = () => { throw new Error('storage failed'); };
  const result = await request('/orders', 'POST', { id: 'x', total: '10.00', status: 'paid', coupon: 'ANA10' });
  assert.equal(result.status, 500);
  assert.equal(result.body.error.code, 'internal_error');
  assert.equal((await request('/orders/x')).status, 404);
  assert.equal(errors.length, 1);
});
