import { requireInput } from './errors.js';

const MAX_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const UTM_KEYS = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term']);

function object(value, name) {
  requireInput(value !== null && typeof value === 'object' && !Array.isArray(value), 'invalid_payload', `${name} deve ser um objeto JSON.`);
}

function onlyKeys(value, keys) {
  requireInput(Object.keys(value).every((key) => keys.includes(key)), 'unknown_field', 'O payload contém um campo não previsto no contrato.');
}

export function identifier(value, name) {
  requireInput(typeof value === 'string' && ID_PATTERN.test(value), 'invalid_id', `${name} deve ter 1–128 caracteres alfanuméricos, ponto, hífen, dois-pontos ou sublinhado, começando por letra ou número.`);
  return value;
}

function cents(value, name, positive) {
  requireInput(Number.isSafeInteger(value) && value >= (positive ? 1 : 0), 'invalid_amount', `${name} deve ser inteiro seguro em centavos ${positive ? 'positivo' : 'não negativo'}.`);
  return value;
}

function decimal(value, name, positive) {
  requireInput(typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)), 'invalid_amount', `${name} deve ser um decimal em reais; prefira string.`);
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(String(value));
  requireInput(Boolean(match), 'invalid_amount', `${name} aceita reais sem sinal e com até duas casas decimais.`);
  const result = BigInt(match[1]) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'));
  requireInput(result <= MAX_CENTS && result >= (positive ? 1n : 0n), 'invalid_amount', `${name} fora do intervalo de centavos seguros.`);
  return Number(result);
}

function amount(payload, decimalKey, centsKey, positive) {
  const hasDecimal = Object.hasOwn(payload, decimalKey);
  const hasCents = Object.hasOwn(payload, centsKey);
  requireInput(hasDecimal !== hasCents, 'invalid_amount', `Informe exatamente um dos campos ${decimalKey} ou ${centsKey}.`);
  return hasCents ? cents(payload[centsKey], centsKey, positive) : decimal(payload[decimalKey], decimalKey, positive);
}

function currency(value = 'BRL') {
  requireInput(value === 'BRL', 'unsupported_currency', 'Esta entrega trabalha somente com BRL; não soma moedas diferentes.');
  return value;
}

export function normalizeOrder(payload) {
  object(payload, 'Pedido');
  onlyKeys(payload, ['id', 'total', 'total_cents', 'currency', 'coupon', 'utms', 'status']);
  const id = identifier(payload.id, 'id');
  const total_cents = amount(payload, 'total', 'total_cents', false);
  const orderCurrency = currency(payload.currency);
  requireInput(['paid', 'pending', 'cancelled'].includes(payload.status), 'invalid_status', 'status deve ser paid, pending ou cancelled.');
  requireInput(payload.coupon === undefined || payload.coupon === null || typeof payload.coupon === 'string', 'invalid_coupon', 'coupon deve ser string ou null.');
  const coupon = payload.coupon?.trim().toUpperCase() || null;
  requireInput(coupon === null || coupon.length <= 64, 'invalid_coupon', 'coupon aceita até 64 caracteres.');
  const rawUtms = payload.utms ?? {};
  object(rawUtms, 'utms');
  requireInput(Object.keys(rawUtms).every((key) => UTM_KEYS.has(key)), 'invalid_utms', 'utms aceita somente parâmetros UTM conhecidos.');
  const utms = {};
  for (const key of [...UTM_KEYS].sort()) {
    if (!Object.hasOwn(rawUtms, key)) continue;
    requireInput(typeof rawUtms[key] === 'string' && rawUtms[key].length <= 256, 'invalid_utms', 'Cada UTM deve ser string de até 256 caracteres.');
    utms[key] = rawUtms[key].trim();
  }
  return { id, total_cents, currency: orderCurrency, coupon, utms, status: payload.status };
}

export function normalizeRefund(payload) {
  object(payload, 'Estorno');
  onlyKeys(payload, ['id', 'order_id', 'type', 'amount', 'amount_cents', 'currency']);
  const id = identifier(payload.id, 'id');
  const order_id = identifier(payload.order_id, 'order_id');
  const type = payload.type ?? 'partial';
  requireInput(type === 'partial' || type === 'full', 'invalid_refund_type', 'type deve ser partial ou full.');
  const refundCurrency = currency(payload.currency);
  if (type === 'full') {
    requireInput(!Object.hasOwn(payload, 'amount') && !Object.hasOwn(payload, 'amount_cents'), 'invalid_amount', 'Estorno full não recebe valor: reverte o saldo restante quando aplicado.');
    return { id, order_id, type, currency: refundCurrency, amount_cents: null };
  }
  return { id, order_id, type, currency: refundCurrency, amount_cents: amount(payload, 'amount', 'amount_cents', true) };
}
