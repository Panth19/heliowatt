'use strict';
// API tests against the real HTTP server and a throw-away SQLite file. Run: npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server');

const PASSWORD = 'test-password-1';
let app, base, cookie = '', dir;

const customer = (o = {}) => ({ name: 'Test Kunde', email: 'kunde@example.com', street: 'Teststraße 5', zip: '03046', city: 'Cottbus', country: 'DE', ...o });
const order = (items, o = {}) => ({ items, customer: customer(o.customer), payment: 'Invoice', terms: true, ...o, ...(o.customer ? { customer: customer(o.customer) } : {}) });

async function call(method, url, body, opts = {}) {
  const headers = {};
  if (method === 'POST' && body === undefined) body = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.cookie !== false && cookie) headers.Cookie = cookie;
  const r = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, text, headers: r.headers };
}
const admin = (m, u, b) => call(m, u, b);
const anon = (m, u, b) => call(m, u, b, { cookie: false });
async function stockOf(sku) { return (await anon('GET', '/api/products')).json.find(p => p.sku === sku).stock; }
async function login() {
  const r = await anon('POST', '/api/admin/login', { password: PASSWORD });
  cookie = r.headers.get('set-cookie').split(';')[0];
}
async function packAll(id) {
  const data = (await admin('GET', '/api/admin/data')).json;
  const o = data.orders.find(x => x.id === id);
  const pm = Object.fromEntries(data.products.map(p => [p.sku, p]));
  const keys = o.items.map(i => 'pick:' + i.sku).concat(o.items.some(i => pm[i.sku].diverter) ? ['test'] : [], ['doc', 'label']);
  for (const key of keys) assert.equal((await admin('POST', '/api/admin/orders/' + id + '/pack', { key, checked: true })).status, 200);
}

test.before(async () => {
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'hw-'));
  app = createApp({ dbFile: path.join(dir, 'test.db'), adminPassword: PASSWORD, seed: true, loginMax: 6 });
  await new Promise(r => app.server.listen(0, r));
  base = 'http://127.0.0.1:' + app.server.address().port;
});
test.after(async () => { await new Promise(r => app.server.close(r)); fs.rmSync(dir, { recursive: true, force: true }); });

test('serves the shop, shared rules and products without logging in', async () => {
  assert.equal((await anon('GET', '/')).status, 200);
  const rules = await anon('GET', '/rules.js');
  assert.match(rules.text, /root\.Rules/);
  const p = (await anon('GET', '/api/products')).json;
  assert.equal(p.length, 5);
  assert.ok(!('bin' in p[0]) && !('grams' in p[0]), 'public catalogue hides warehouse fields');
  assert.equal((await anon('GET', '/../server.js')).status, 404);
  assert.equal((await anon('GET', '/%2e%2e/server.js')).status, 404);
});

test('back office endpoints need a login', async () => {
  for (const [m, u] of [['GET', '/api/admin/data'], ['GET', '/api/admin/orders.csv'], ['POST', '/api/admin/orders/HW-1041/cancel'], ['POST', '/api/admin/stock/CT1/receive']])
    assert.equal((await anon(m, u, m === 'POST' ? {} : undefined)).status, 401, m + ' ' + u);
  assert.equal((await anon('GET', '/admin/orders/HW-1041/slip')).status, 302);
  assert.equal((await anon('GET', '/api/admin/me')).json.admin, false);
});

test('login rejects a wrong password, accepts the right one, and sets a hardened cookie', async () => {
  const bad = await anon('POST', '/api/admin/login', { password: 'nope' });
  assert.equal(bad.status, 401);
  const good = await anon('POST', '/api/admin/login', { password: PASSWORD });
  assert.equal(good.status, 200);
  const sc = good.headers.get('set-cookie');
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
  cookie = sc.split(';')[0];
  assert.equal((await admin('GET', '/api/admin/me')).json.admin, true);
  const forged = await call('GET', '/api/admin/data', undefined, { cookie: false });
  assert.equal(forged.status, 401);
  const r = await fetch(base + '/api/admin/data', { headers: { Cookie: 'hw_admin=' + (Date.now() + 1e7) + '.' + 'a'.repeat(64) } });
  assert.equal(r.status, 401, 'a forged cookie is rejected');
});

test('POST endpoints only accept JSON', async () => {
  const r = await fetch(base + '/api/orders', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(r.status, 415);
  const r2 = await fetch(base + '/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
  assert.equal(r2.status, 400);
});

test('order validation returns field errors and never charges stock', async () => {
  const before = await stockOf('TS2');
  const bad = await anon('POST', '/api/orders', order([{ sku: 'TS2', qty: 1 }], { customer: { zip: '123', email: 'x' } }));
  assert.equal(bad.status, 400);
  assert.ok(bad.json.fields.zip && bad.json.fields.email);
  assert.equal((await anon('POST', '/api/orders', { ...order([{ sku: 'TS2', qty: 1 }]), terms: false })).status, 400);
  assert.equal((await anon('POST', '/api/orders', order([]))).status, 400);
  assert.equal((await anon('POST', '/api/orders', order([{ sku: 'NOPE', qty: 1 }]))).status, 400);
  assert.equal((await anon('POST', '/api/orders', order([{ sku: 'TS2', qty: 0 }]))).status, 400);
  assert.equal((await anon('POST', '/api/orders', order([{ sku: 'TS2', qty: 1.5 }]))).status, 400);
  assert.equal((await anon('POST', '/api/orders', order([{ sku: 'TS2', qty: 99 }]))).status, 400);
  assert.equal(await stockOf('TS2'), before);
});

test('prices and totals come from the server, not the client', async () => {
  const r = await anon('POST', '/api/orders', { ...order([{ sku: 'TS2', qty: 2, price: 1 }]), total: 1, totals: { total: 1 } });
  assert.equal(r.status, 200);
  assert.equal(r.json.total, 2 * 1850 + 490, '2 × 18,50 + 4,90 shipping');
  const o = (await admin('GET', '/api/admin/data')).json.orders.find(x => x.id === r.json.id);
  assert.equal(o.totals.vat, Math.round(o.totals.total * 0.19 / 1.19));
  assert.equal(o.items[0].price, 1850);
});

test('free shipping above 150 EUR and per-country VAT', async () => {
  const a = await anon('POST', '/api/orders', order([{ sku: 'DIV3-DIN', qty: 1 }]));
  assert.equal(a.json.total, 21900, 'free shipping');
  const b = await anon('POST', '/api/orders', order([{ sku: 'TS2', qty: 1 }], { customer: { country: 'NL', zip: '3511 AB' } }));
  const o = (await admin('GET', '/api/admin/data')).json.orders.find(x => x.id === b.json.id);
  assert.equal(o.totals.rate, 0.21);
  assert.equal(o.totals.ship, 990);
});

test('placing an order reserves stock, logs it, and queues a confirmation email', async () => {
  const before = await stockOf('EL3');
  const r = await anon('POST', '/api/orders', order([{ sku: 'EL3', qty: 2 }, { sku: 'EL3', qty: 1 }]));
  assert.equal(r.status, 200);
  assert.equal(await stockOf('EL3'), before - 3, 'duplicate lines are merged');
  const data = (await admin('GET', '/api/admin/data')).json;
  const mail = data.outbox.find(m => m.ref === r.json.id);
  assert.match(mail.subject, /received/);
  assert.equal(mail.to, 'kunde@example.com');
  assert.equal(data.orders.find(o => o.id === r.json.id).log[0].m, 'Order placed, Invoice');
});

test('overselling is impossible, even with parallel orders for the last units', async () => {
  const start = await stockOf('CT1');
  assert.ok(start >= 1 && start <= 6);
  const results = await Promise.all(Array.from({ length: start + 4 }, () => anon('POST', '/api/orders', order([{ sku: 'CT1', qty: 1 }]))));
  const okCount = results.filter(r => r.status === 200).length;
  assert.equal(okCount, start, 'exactly as many orders succeed as there were units');
  assert.ok(results.filter(r => r.status !== 200).every(r => r.status === 409 && /sold out/.test(r.json.error)));
  assert.equal(await stockOf('CT1'), 0);
  await admin('POST', '/api/admin/stock/CT1/receive', { qty: 10 });
  assert.equal(await stockOf('CT1'), 10);
});

test('shipping needs the full checklist and a valid tracking number', async () => {
  const id = (await anon('POST', '/api/orders', order([{ sku: 'DIV3-DIN', qty: 1 }, { sku: 'TS2', qty: 1 }]))).json.id;
  let r = await admin('POST', '/api/admin/orders/' + id + '/ship', { carrier: 'DHL Paket', tracking: 'JJD149909998877' });
  assert.equal(r.status, 409, 'checklist incomplete');
  assert.equal((await admin('POST', '/api/admin/orders/' + id + '/pack', { key: 'pick:EL3', checked: true })).status, 400, 'unknown step');
  await packAll(id);
  assert.equal((await admin('POST', '/api/admin/orders/' + id + '/ship', { carrier: 'DHL Paket', tracking: 'abc' })).status, 400);
  assert.equal((await admin('POST', '/api/admin/orders/' + id + '/ship', { carrier: 'Pigeon', tracking: 'JJD149909998877' })).status, 400);
  r = await admin('POST', '/api/admin/orders/' + id + '/ship', { carrier: 'DHL Paket', tracking: 'JJD 1499 09998877' });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'shipped');
  assert.equal(r.json.tracking.no, 'JJD149909998877', 'spaces are stripped');
  assert.equal((await admin('POST', '/api/admin/orders/' + id + '/ship', { carrier: 'DHL Paket', tracking: 'JJD149909998877' })).status, 409, 'cannot ship twice');
  assert.equal((await admin('POST', '/api/admin/orders/' + id + '/cancel')).status, 409, 'cannot cancel after shipping');
  const mail = (await admin('GET', '/api/admin/data')).json.outbox.find(m => m.ref === id && /shipped/.test(m.subject));
  assert.match(mail.body, /JJD149909998877/);
});

test('cancelling releases stock', async () => {
  const before = await stockOf('TS2');
  const id = (await anon('POST', '/api/orders', order([{ sku: 'TS2', qty: 3 }]))).json.id;
  assert.equal(await stockOf('TS2'), before - 3);
  assert.equal((await admin('POST', '/api/admin/orders/' + id + '/cancel')).json.status, 'cancelled');
  assert.equal(await stockOf('TS2'), before);
  assert.equal((await admin('POST', '/api/admin/orders/' + id + '/cancel')).status, 409);
});

test('customers can track only with the matching email, and see tracking after shipping', async () => {
  const placed = await anon('POST', '/api/orders', order([{ sku: 'EL3', qty: 1 }], { customer: { email: 'Track.Me@Example.com' } }));
  const id = placed.json.id;
  assert.equal((await anon('POST', '/api/track', { id, email: 'someone@else.com' })).status, 404);
  assert.equal((await anon('POST', '/api/track', { id: 'HW-1', email: 'track.me@example.com' })).status, 404);
  const t = await anon('POST', '/api/track', { id: id.toLowerCase(), email: 'track.me@example.com' });
  assert.equal(t.status, 200);
  assert.equal(t.json.status, 'new');
  assert.ok(!('pack' in t.json) && !('email' in t.json.customer), 'no internal or contact fields leak');
  assert.equal(t.json.items[0].returnable, 1);
  const early = await anon('POST', '/api/track/return', { id, email: 'track.me@example.com', items: [{ sku: 'EL3', qty: 1 }], reason: 'Arrived damaged' });
  assert.equal(early.status, 409, 'nothing to return before shipping');
});

test('return flow: customer request, receive, refund with restock, limits enforced', async () => {
  const email = 'return@example.com';
  const id = (await anon('POST', '/api/orders', order([{ sku: 'EL3', qty: 2 }], { customer: { email } }))).json.id;
  await packAll(id);
  await admin('POST', '/api/admin/orders/' + id + '/ship', { carrier: 'DHL Paket', tracking: 'JJD000111222333' });
  await admin('POST', '/api/admin/orders/' + id + '/deliver');
  const t = (await anon('POST', '/api/track', { id, email })).json;
  assert.equal(t.withdrawal.open, true);
  assert.equal(t.withdrawal.daysLeft, 14);
  const tooMany = await anon('POST', '/api/track/return', { id, email, items: [{ sku: 'EL3', qty: 3 }], reason: 'Does not fit my setup' });
  assert.equal(tooMany.status, 409);
  assert.equal((await anon('POST', '/api/track/return', { id, email, items: [{ sku: 'EL3', qty: 0 }], reason: 'Does not fit my setup' })).status, 400);
  assert.equal((await anon('POST', '/api/track/return', { id, email, items: [{ sku: 'EL3', qty: 1 }], reason: 'Because' })).status, 400);
  const made = await anon('POST', '/api/track/return', { id, email, items: [{ sku: 'EL3', qty: 1 }], reason: 'Changed my mind (Widerruf)' });
  assert.equal(made.status, 200);
  const rid = made.json.id;
  const two = await anon('POST', '/api/track/return', { id, email, items: [{ sku: 'EL3', qty: 2 }], reason: 'Arrived damaged' });
  assert.equal(two.status, 409, 'only one unit is still returnable');
  assert.equal((await admin('POST', '/api/admin/returns/' + rid + '/refund', { resellable: true, amount: 5400 })).status, 409, 'must be received first');
  assert.equal((await admin('POST', '/api/admin/returns/' + rid + '/receive')).json.status, 'received');
  assert.equal((await admin('POST', '/api/admin/returns/' + rid + '/refund', { resellable: true, amount: 5401 })).status, 400, 'refund above item value');
  assert.equal((await admin('POST', '/api/admin/returns/' + rid + '/refund', { resellable: true, amount: -1 })).status, 400);
  const before = await stockOf('EL3');
  const done = await admin('POST', '/api/admin/returns/' + rid + '/refund', { resellable: true, amount: 5400 });
  assert.equal(done.json.status, 'refunded');
  assert.equal(await stockOf('EL3'), before + 1, 'resellable unit goes back to stock');
  assert.equal((await admin('POST', '/api/admin/returns/' + rid + '/refund', { resellable: true, amount: 5400 })).status, 409, 'cannot refund twice');
  const mails = (await admin('GET', '/api/admin/data')).json.outbox.filter(m => m.ref === rid).map(m => m.subject);
  assert.ok(mails.some(s => /registered/.test(s)) && mails.some(s => /Refund/.test(s)));
});

test('scrapped returns do not restock; rejected returns free the quantity', async () => {
  const email = 'scrap@example.com';
  const id = (await anon('POST', '/api/orders', order([{ sku: 'TS2', qty: 1 }], { customer: { email } }))).json.id;
  await packAll(id);
  await admin('POST', '/api/admin/orders/' + id + '/ship', { carrier: 'DPD', tracking: 'DPD12345678' });
  const r1 = (await admin('POST', '/api/admin/returns', { orderId: id, items: [{ sku: 'TS2', qty: 1 }], reason: 'Arrived damaged' })).json;
  await admin('POST', '/api/admin/returns/' + r1.id + '/receive');
  const before = await stockOf('TS2');
  await admin('POST', '/api/admin/returns/' + r1.id + '/refund', { resellable: false, amount: 1850 });
  assert.equal(await stockOf('TS2'), before);
  const r2 = await admin('POST', '/api/admin/returns', { orderId: id, items: [{ sku: 'TS2', qty: 1 }], reason: 'Wrong item received' });
  assert.equal(r2.status, 409, 'already refunded');
  const id2 = (await anon('POST', '/api/orders', order([{ sku: 'TS2', qty: 1 }], { customer: { email } }))).json.id;
  await packAll(id2); await admin('POST', '/api/admin/orders/' + id2 + '/ship', { carrier: 'DPD', tracking: 'DPD12345679' });
  const a = (await admin('POST', '/api/admin/returns', { orderId: id2, items: [{ sku: 'TS2', qty: 1 }], reason: 'Wrong item received' })).json;
  assert.equal((await admin('POST', '/api/admin/returns/' + a.id + '/reject')).json.status, 'rejected');
  assert.equal((await admin('POST', '/api/admin/returns', { orderId: id2, items: [{ sku: 'TS2', qty: 1 }], reason: 'Wrong item received' })).status, 200, 'rejected return no longer blocks a new one');
});

test('seeded Widerruf rules: window closed for old delivered orders', async () => {
  const t = (await anon('POST', '/api/track', { id: 'HW-1039', email: 'j.weber@example.com' })).json;
  assert.equal(t.withdrawal.open, false);
  const r = await anon('POST', '/api/track/return', { id: 'HW-1039', email: 'j.weber@example.com', items: [{ sku: 'EL3', qty: 1 }], reason: 'Changed my mind (Widerruf)' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /14-day/);
  const ok = await anon('POST', '/api/track/return', { id: 'HW-1039', email: 'j.weber@example.com', items: [{ sku: 'EL3', qty: 1 }], reason: 'Arrived damaged' });
  assert.equal(ok.status, 200, 'damage claims are accepted for 30 days after delivery');
});

test('stock receiving validates input', async () => {
  assert.equal((await admin('POST', '/api/admin/stock/EL3/receive', { qty: 0 })).status, 400);
  assert.equal((await admin('POST', '/api/admin/stock/EL3/receive', { qty: 'ten' })).status, 400);
  assert.equal((await admin('POST', '/api/admin/stock/NOPE/receive', { qty: 5 })).status, 404);
});

test('hostile input is stored as text and escaped in the packing slip; CSV neutralises formulas', async () => {
  const r = await anon('POST', '/api/orders', order([{ sku: 'TS2', qty: 1 }], { customer: { name: '=HYPERLINK("http://x")<script>alert(1)</script>', street: "Weg 1 ' OR 1=1 --" } }));
  assert.equal(r.status, 200);
  const slip = await admin('GET', '/admin/orders/' + r.json.id + '/slip');
  assert.equal(slip.status, 200);
  assert.ok(!slip.text.includes('<script>alert(1)'), 'slip escapes HTML');
  assert.match(slip.text, /&lt;script&gt;/);
  const csv = await admin('GET', '/api/admin/orders.csv');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.ok(csv.text.includes("\"'=HYPERLINK"), 'leading = is neutralised');
  assert.ok(csv.text.split('\r\n')[0].startsWith('order,placed,status'));
});

test('login is rate limited', async () => {
  let last;
  for (let i = 0; i < 8; i++) last = await anon('POST', '/api/admin/login', { password: 'wrong-' + i });
  assert.equal(last.status, 429);
});

test('logout clears the session', async () => {
  await login().catch(() => {});
  const out = await admin('POST', '/api/admin/logout', {});
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
});

test('data survives restarting the server', async () => {
  const file = path.join(dir, 'persist.db');
  const a = createApp({ dbFile: file, adminPassword: PASSWORD, seed: false });
  await new Promise(r => a.server.listen(0, r));
  const b1 = 'http://127.0.0.1:' + a.server.address().port;
  const r = await (await fetch(b1 + '/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(order([{ sku: 'TS2', qty: 1 }])) })).json();
  assert.equal(r.id, 'HW-1001', 'fresh database without demo data starts at 1001');
  await new Promise(r => a.server.close(r));
  const b = createApp({ dbFile: file, adminPassword: PASSWORD, seed: false });
  assert.equal(b.store.getOrder('HW-1001').customer.name, 'Test Kunde');
  assert.equal(b.store.productMap()['TS2'].stock, 30);
  b.store.close();
});
