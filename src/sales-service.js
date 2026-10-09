import { AttributionPolicy } from './attribution.js';
import { DomainError } from './errors.js';
import { normalizeOrder, normalizeRefund } from './validation.js';

function samePayload(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

export class SalesService {
  constructor({ repository, attribution = new AttributionPolicy(), clock = () => new Date() }) {
    this.repository = repository;
    this.attribution = attribution;
    this.clock = clock;
  }

  timestamp() { return this.clock().toISOString(); }

  record(state, orderId, event, detail, at) {
    state.history.push({ sequence: state.next_sequence++, order_id: orderId, event, at, detail });
  }

  ingestOrder(payload) {
    const input = normalizeOrder(payload);
    const state = this.repository.read();
    const existing = state.orders.find((order) => order.input.id === input.id);
    if (existing) {
      if (!samePayload(existing.input, input)) throw new DomainError('idempotency_conflict', 'Este ID de pedido já existe com outro payload.', 409);
      return { duplicate: true, order: this.orderView(state, existing) };
    }
    const at = this.timestamp();
    const order = { input, attribution: this.attribution.decide(input), received_at: at, refunded_cents: 0 };
    state.orders.push(order);
    this.record(state, input.id, 'order_received', { order: input, attribution: order.attribution }, at);
    // A ordem de chegada (sequence) evita depender do relógio ou de sorting instável.
    for (const refund of state.refunds.filter((entry) => entry.input.order_id === input.id && entry.state === 'pending').sort((a, b) => a.sequence - b.sequence)) {
      this.applyRefund(state, order, refund, at);
    }
    this.repository.replace(state);
    return { duplicate: false, order: this.orderView(state, order) };
  }

  ingestRefund(payload) {
    const input = normalizeRefund(payload);
    const state = this.repository.read();
    const existing = state.refunds.find((refund) => refund.input.id === input.id);
    if (existing) {
      if (!samePayload(existing.input, input)) throw new DomainError('idempotency_conflict', 'Este ID de estorno já existe com outro payload.', 409);
      return { duplicate: true, refund: this.refundView(existing) };
    }
    const at = this.timestamp();
    const refund = {
      input, sequence: state.next_sequence, received_at: at, applied_at: null,
      state: 'pending', requested_cents: input.amount_cents, applied_cents: 0, unapplied_cents: null,
      reason: 'Pedido ainda não recebido; estorno preservado para aplicação posterior.',
    };
    state.refunds.push(refund);
    this.record(state, input.order_id, 'refund_received', { refund: input }, at);
    const order = state.orders.find((entry) => entry.input.id === input.order_id);
    if (order) this.applyRefund(state, order, refund, at);
    this.repository.replace(state);
    return { duplicate: false, refund: this.refundView(refund) };
  }

  applyRefund(state, order, refund, at) {
    const remaining = order.input.total_cents - order.refunded_cents;
    const requested = refund.input.type === 'full' ? remaining : refund.input.amount_cents;
    const applied = Math.min(requested, remaining);
    order.refunded_cents += applied;
    refund.requested_cents = requested;
    refund.applied_cents = applied;
    refund.unapplied_cents = requested - applied;
    refund.applied_at = at;
    refund.state = refund.unapplied_cents > 0 ? 'capped' : 'applied';
    refund.reason = refund.unapplied_cents > 0
      ? 'Valor limitado ao saldo da venda; excedente registrado sem gerar receita negativa.'
      : 'Estorno aplicado ao saldo disponível da venda.';
    this.record(state, order.input.id, 'refund_applied', {
      refund_id: refund.input.id, requested_cents: requested, applied_cents: applied,
      unapplied_cents: refund.unapplied_cents, remaining_cents: order.input.total_cents - order.refunded_cents,
    }, at);
  }

  refundView(refund) {
    return { ...structuredClone(refund.input), sequence: refund.sequence, received_at: refund.received_at,
      applied_at: refund.applied_at, state: refund.state, requested_cents: refund.requested_cents,
      applied_cents: refund.applied_cents, unapplied_cents: refund.unapplied_cents, reason: refund.reason };
  }

  orderView(state, order) {
    const attributed = order.input.status === 'paid' && order.attribution.creator_id !== null;
    return { ...structuredClone(order.input), received_at: order.received_at,
      attribution: structuredClone(order.attribution), refunded_cents: order.refunded_cents,
      remaining_cents: order.input.total_cents - order.refunded_cents,
      gross_attributed_cents: attributed ? order.input.total_cents : 0,
      net_attributed_cents: attributed ? order.input.total_cents - order.refunded_cents : 0,
      refunds: state.refunds.filter((refund) => refund.input.order_id === order.input.id).map((refund) => this.refundView(refund)),
      history: structuredClone(state.history.filter((event) => event.order_id === order.input.id)) };
  }

  getOrder(id) {
    const state = this.repository.read();
    const order = state.orders.find((entry) => entry.input.id === id);
    if (!order) throw new DomainError('order_not_found', 'Pedido não encontrado.', 404);
    return this.orderView(state, order);
  }

  getRefund(id) {
    const refund = this.repository.read().refunds.find((entry) => entry.input.id === id);
    if (!refund) throw new DomainError('refund_not_found', 'Estorno não encontrado.', 404);
    return this.refundView(refund);
  }

  getCreatorSales(creatorId) {
    const state = this.repository.read();
    const orders = state.orders.filter((order) => order.attribution.creator_id === creatorId && order.input.status === 'paid');
    // BigInt também na agregação: várias vendas seguras podem exceder MAX_SAFE_INTEGER.
    const gross = orders.reduce((sum, order) => sum + BigInt(order.input.total_cents), 0n);
    const refunded = orders.reduce((sum, order) => sum + BigInt(order.refunded_cents), 0n);
    return { creator_id: creatorId, currency: 'BRL', order_count: orders.length,
      gross_cents: gross.toString(), refunded_cents: refunded.toString(), net_cents: (gross - refunded).toString(),
      orders: orders.map((order) => ({ id: order.input.id, total_cents: order.input.total_cents,
        refunded_cents: order.refunded_cents, net_cents: order.input.total_cents - order.refunded_cents })) };
  }
}
