const base = process.env.API_URL ?? 'http://127.0.0.1:3005';
const operations = [
  ['POST', '/refunds', { id: 'demo-refund-parcial', order_id: 'demo-order', amount: '30.10' }],
  ['GET', '/refunds/demo-refund-parcial'],
  ['POST', '/orders', { id: 'demo-order', total: '150.00', currency: 'BRL', status: 'paid', coupon: 'ANA10', utms: { utm_content: 'bruno' } }],
  ['POST', '/orders', { id: 'demo-order', total: '150.00', currency: 'BRL', status: 'paid', coupon: 'ANA10', utms: { utm_content: 'bruno' } }],
  ['POST', '/refunds', { id: 'demo-refund-parcial', order_id: 'demo-order', amount: '30.10' }],
  ['POST', '/refunds', { id: 'demo-refund-full', order_id: 'demo-order', type: 'full' }],
  ['GET', '/orders/demo-order'],
  ['GET', '/creators/creator-ana/sales'],
];

for (const [method, path, body] of operations) {
  const response = await fetch(base + path, { method,
    ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  console.log(JSON.stringify({ method, path, status: response.status, response: result }));
  if (!response.ok) process.exitCode = 1;
}
