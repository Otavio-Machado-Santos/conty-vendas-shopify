import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttributionPolicy } from '../src/attribution.js';
import { MemoryRepository, FileRepository } from '../src/repository.js';
import { SalesService } from '../src/sales-service.js';

const fixedClock = () => new Date('2026-10-09T20:00:00.000Z');
const order = (overrides = {}) => ({ id: 'order-1', total: '150.00', currency: 'BRL', status: 'paid', coupon: 'ANA10', utms: { utm_content: 'bruno' }, ...overrides });
const partial = (overrides = {}) => ({ id: 'refund-1', order_id: 'order-1', amount: '30.10', ...overrides });
const makeService = (repository = new MemoryRepository()) => new SalesService({ repository, clock: fixedClock });

test('cupom reconhecido vence UTM diferente, com ambos os candidatos auditáveis', () => {
  const service = makeService();
  const result = service.ingestOrder(order()).order;
  assert.equal(result.attribution.creator_id, 'creator-ana');
  assert.equal(result.attribution.utm_candidate, 'creator-bruno');
  assert.equal(result.attribution.rule, 'coupon');
  assert.match(result.attribution.reason, /outro criador/);
  assert.equal(service.getCreatorSales('creator-ana').net_cents, '15000');
  assert.equal(service.getCreatorSales('creator-bruno').net_cents, '0');
});

test('a política de atribuição isolada permite mappings substituíveis', () => {
  const policy = new AttributionPolicy({ coupons: { NOVO: 'creator-z' }, utmContent: { outro: 'creator-y' } });
  assert.equal(policy.decide({ coupon: 'NOVO', utms: { utm_content: 'outro' } }).creator_id, 'creator-z');
  assert.equal(policy.decide({ coupon: 'INVALIDO', utms: { utm_content: 'outro' } }).creator_id, 'creator-y');
});

test('UTM conhecido atribui quando cupom ausente ou desconhecido; sem ambos é orgânico', () => {
  for (const coupon of [null, 'nao-cadastrado']) {
    const service = makeService();
    const result = service.ingestOrder(order({ coupon })).order;
    assert.equal(result.attribution.creator_id, 'creator-bruno');
    assert.equal(result.attribution.rule, 'utm_content');
  }
  const organic = makeService().ingestOrder(order({ coupon: null, utms: { utm_content: 'inexistente' } })).order;
  assert.equal(organic.attribution.creator_id, null);
  assert.equal(organic.net_attributed_cents, 0);
  assert.equal(organic.attribution.rule, 'organic');
});

test('repetir pedido não duplica receita nem histórico; equivalência usa payload normalizado', () => {
  const service = makeService();
  service.ingestOrder(order({ utms: { utm_source: 'feed', utm_content: 'bruno' } }));
  const duplicate = service.ingestOrder(order({ total: 150, coupon: ' ana10 ', utms: { utm_content: 'bruno', utm_source: 'feed' } }));
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.order.history.length, 1);
  const sales = service.getCreatorSales('creator-ana');
  assert.equal(sales.order_count, 1);
  assert.equal(sales.gross_cents, '15000');
});

test('pedido com mesmo ID e outro total, status ou atribuição é conflito e não altera original', () => {
  const service = makeService();
  service.ingestOrder(order());
  for (const changes of [{ total: '151.00' }, { status: 'cancelled' }, { coupon: 'BRUNO10' }]) {
    assert.throws(() => service.ingestOrder(order(changes)), (error) => error.status === 409 && error.code === 'idempotency_conflict');
  }
  assert.equal(service.getOrder('order-1').total_cents, 15000);
  assert.equal(service.getOrder('order-1').history.length, 1);
});

test('estorno parcial reverte somente seu valor; repetição não estorna novamente', () => {
  const service = makeService();
  service.ingestOrder(order());
  const first = service.ingestRefund(partial());
  const again = service.ingestRefund(partial({ amount: 30.1 }));
  assert.equal(first.refund.applied_cents, 3010);
  assert.equal(again.duplicate, true);
  const result = service.getOrder('order-1');
  assert.equal(result.net_attributed_cents, 11990);
  assert.equal(result.refunds.length, 1);
  assert.equal(result.history.length, 3);
  assert.equal(service.getCreatorSales('creator-ana').refunded_cents, '3010');
});

test('estorno completo após parcial zera atribuição sem apagar eventos anteriores', () => {
  const service = makeService();
  service.ingestOrder(order());
  service.ingestRefund(partial());
  const full = { id: 'refund-2', order_id: 'order-1', type: 'full' };
  assert.equal(service.ingestRefund(full).refund.applied_cents, 11990);
  assert.equal(service.ingestRefund(full).duplicate, true);
  const result = service.getOrder('order-1');
  assert.equal(result.refunded_cents, 15000);
  assert.equal(result.net_attributed_cents, 0);
  assert.equal(result.attribution.creator_id, 'creator-ana');
  assert.deepEqual(result.history.map((event) => event.event), ['order_received', 'refund_received', 'refund_applied', 'refund_received', 'refund_applied']);
});

test('estorno anterior ao pedido fica pendente e é aplicado sem perder recebimento original', () => {
  const service = makeService();
  const before = service.ingestRefund(partial());
  assert.equal(before.refund.state, 'pending');
  assert.equal(before.refund.applied_at, null);
  assert.equal(service.getRefund('refund-1').requested_cents, 3010);
  assert.equal(service.ingestRefund(partial()).duplicate, true);
  const after = service.ingestOrder(order()).order;
  assert.equal(after.net_attributed_cents, 11990);
  assert.equal(after.refunds[0].state, 'applied');
  assert.deepEqual(after.history.map((event) => event.event), ['refund_received', 'order_received', 'refund_applied']);
});

test('estorno full antes do pedido consome o saldo quando pedido é conhecido', () => {
  const service = makeService();
  const refund = service.ingestRefund({ id: 'refund-1', order_id: 'order-1', type: 'full' }).refund;
  assert.equal(refund.requested_cents, null);
  const result = service.ingestOrder(order()).order;
  assert.equal(result.refunds[0].requested_cents, 15000);
  assert.equal(result.net_attributed_cents, 0);
});

test('múltiplos estornos pendentes são aplicados na ordem de chegada, mesmo com relógio empatado', () => {
  const service = makeService();
  service.ingestRefund(partial({ id: 'z-primeiro', amount: '100.00' }));
  service.ingestRefund(partial({ id: 'a-segundo', amount: '100.00' }));
  const result = service.ingestOrder(order()).order;
  assert.equal(result.refunded_cents, 15000);
  assert.deepEqual(result.refunds.map((refund) => refund.applied_cents), [10000, 5000]);
  assert.equal(result.refunds[1].unapplied_cents, 5000);
  assert.equal(result.refunds[1].state, 'capped');
});

test('estorno excedente é limitado; novo estorno sobre saldo zerado registra aplicação zero', () => {
  const service = makeService();
  service.ingestOrder(order());
  const over = service.ingestRefund(partial({ amount: '200.00' })).refund;
  assert.equal(over.applied_cents, 15000);
  assert.equal(over.unapplied_cents, 5000);
  assert.equal(over.state, 'capped');
  const late = service.ingestRefund(partial({ id: 'refund-2', amount: '10.00' })).refund;
  assert.equal(late.applied_cents, 0);
  assert.equal(late.unapplied_cents, 1000);
  assert.equal(service.getOrder('order-1').history.length, 5);
  assert.equal(service.getCreatorSales('creator-ana').net_cents, '0');
});

test('ID de estorno não pode mudar pedido, valor ou tipo', () => {
  const service = makeService();
  service.ingestRefund(partial());
  for (const payload of [partial({ amount: '31.00' }), partial({ order_id: 'other' }), { id: 'refund-1', order_id: 'order-1', type: 'full' }]) {
    assert.throws(() => service.ingestRefund(payload), (error) => error.code === 'idempotency_conflict' && error.status === 409);
  }
  assert.equal(service.getRefund('refund-1').state, 'pending');
});

test('centavos são exatos, incluindo 0.29, limite seguro e somas que ultrapassam Number.MAX_SAFE_INTEGER', () => {
  const service = makeService();
  assert.equal(service.ingestOrder(order({ total: 0.29 })).order.total_cents, 29);
  service.ingestRefund(partial({ amount: '0.10' }));
  assert.equal(service.getOrder('order-1').remaining_cents, 19);
  service.ingestOrder({ ...order({ id: 'big-1' }), total: '90071992547409.91' });
  service.ingestOrder({ ...order({ id: 'big-2' }), total: '90071992547409.91' });
  assert.equal(service.getCreatorSales('creator-ana').gross_cents, (2n * BigInt(Number.MAX_SAFE_INTEGER) + 29n).toString());
});

test('pagamento pending/cancelled não gera receita, mesmo com atribuição conhecida', () => {
  const service = makeService();
  for (const status of ['pending', 'cancelled']) {
    const result = service.ingestOrder(order({ id: status, status })).order;
    assert.equal(result.gross_attributed_cents, 0);
    assert.equal(result.net_attributed_cents, 0);
  }
  assert.equal(service.getCreatorSales('creator-ana').order_count, 0);
});

test('pedidos de dois criadores e orgânico preservam isolamento dos totais', () => {
  const service = makeService();
  service.ingestOrder(order());
  service.ingestOrder(order({ id: 'order-2', coupon: 'BRUNO10', total: '20.00' }));
  service.ingestOrder(order({ id: 'order-3', coupon: null, utms: {}, total: '500.00' }));
  service.ingestRefund(partial({ order_id: 'order-2', amount: '5.00' }));
  assert.equal(service.getCreatorSales('creator-ana').net_cents, '15000');
  assert.equal(service.getCreatorSales('creator-bruno').net_cents, '1500');
});

test('validações rejeitam dinheiro ambíguo, inválido, moeda/status/UTM/IDs inesperados sem mutação', () => {
  const service = makeService();
  for (const payload of [null, [], {}, order({ total: '-1.00' }), order({ total: '1.001' }),
    order({ total: '90071992547409.92' }), order({ total_cents: 123 }), order({ total: null }),
    order({ currency: 'USD' }), order({ status: 'garbage' }), order({ coupon: 1 }),
    order({ utms: [] }), order({ utms: { creator: 'creator-ana' } }), order({ utms: { utm_content: 42 } }),
    order({ id: '__proto__' }), order({ ignored: true })]) {
    assert.throws(() => service.ingestOrder(payload), (error) => error.status === 400);
  }
  assert.equal(service.getCreatorSales('creator-ana').order_count, 0);
  for (const payload of [partial({ amount: 0 }), partial({ amount: '-0.01' }), partial({ amount: '1.001' }),
    partial({ amount_cents: 100 }), partial({ type: 'unknown' }),
    { id: 'r', order_id: 'o', type: 'full', amount: '1.00' }]) {
    assert.throws(() => service.ingestRefund(payload), (error) => error.status === 400);
  }
});

test('contrato total_cents e amount_cents dispensa decimal sem alterar cálculos', () => {
  const service = makeService();
  service.ingestOrder({ id: 'order-1', total_cents: 123, status: 'paid', coupon: 'ANA10' });
  service.ingestRefund({ id: 'refund-1', order_id: 'order-1', amount_cents: 23 });
  assert.equal(service.getOrder('order-1').net_attributed_cents, 100);
});

test('arquivo persistente conserva pendências, idempotência e histórico após reinício', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'conty-sales-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  makeService(new FileRepository(path)).ingestRefund(partial());
  let service = makeService(new FileRepository(path));
  assert.equal(service.getRefund('refund-1').state, 'pending');
  service.ingestOrder(order());
  service = makeService(new FileRepository(path));
  assert.equal(service.ingestOrder(order()).duplicate, true);
  assert.equal(service.ingestRefund(partial()).duplicate, true);
  assert.equal(service.getOrder('order-1').net_attributed_cents, 11990);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).history.length, 3);
});

test('arquivo corrompido falha fechado e nunca é substituído automaticamente', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'conty-sales-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  writeFileSync(path, '{corrompido');
  assert.throws(() => new FileRepository(path));
  assert.equal(readFileSync(path, 'utf8'), '{corrompido');
});

test('falha ao persistir não publica estado parcialmente aplicado', () => {
  const repository = new MemoryRepository();
  const service = makeService(repository);
  service.ingestRefund(partial());
  repository.replace = () => { throw new Error('disk unavailable'); };
  assert.throws(() => service.ingestOrder(order()), /disk unavailable/);
  assert.equal(service.getRefund('refund-1').state, 'pending');
  assert.throws(() => service.getOrder('order-1'), (error) => error.status === 404);
});

test('sequência determinística de muitos estornos sempre mantém 0 <= soma <= venda', () => {
  const service = makeService();
  service.ingestOrder(order({ total: '7.23' }));
  let applied = 0;
  for (let index = 0; index < 120; index++) {
    const input = partial({ id: `r-${index}`, amount: `${(index * 31 % 9) + 1}.01` });
    const refund = service.ingestRefund(input).refund;
    applied += refund.applied_cents;
    assert.equal(service.ingestRefund(input).duplicate, true);
    const state = service.getOrder('order-1');
    assert.equal(state.refunded_cents, applied);
    assert.ok(applied >= 0 && applied <= 723);
    assert.ok(state.net_attributed_cents >= 0);
  }
  assert.equal(service.getOrder('order-1').refunded_cents, 723);
});
