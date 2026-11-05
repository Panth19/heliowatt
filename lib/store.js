'use strict';
// SQLite-backed data layer and business operations. Every state change runs in one transaction.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const R = require('./rules');

class HttpError extends Error {
  constructor(status, message, fields) { super(message); this.status = status; this.fields = fields; }
}
const bad = (m, f) => new HttpError(400, m, f);
const conflict = m => new HttpError(409, m);
const notFound = m => new HttpError(404, m || 'Not found');

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS products(
  sku TEXT PRIMARY KEY, name TEXT NOT NULL, blurb TEXT NOT NULL DEFAULT '', price INTEGER NOT NULL CHECK(price>0),
  grams INTEGER NOT NULL, bin TEXT NOT NULL, diverter INTEGER NOT NULL DEFAULT 0, stock INTEGER NOT NULL DEFAULT 0 CHECK(stock>=0));
CREATE TABLE IF NOT EXISTS orders(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, created INTEGER NOT NULL,
  name TEXT NOT NULL, email TEXT NOT NULL, street TEXT NOT NULL, zip TEXT NOT NULL, city TEXT NOT NULL, country TEXT NOT NULL,
  payment TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN('new','shipped','delivered','cancelled')),
  sub INTEGER NOT NULL, ship INTEGER NOT NULL, total INTEGER NOT NULL, vat INTEGER NOT NULL, rate REAL NOT NULL,
  carrier TEXT, tracking TEXT, shipped_at INTEGER, delivered_at INTEGER, pack TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS order_items(
  order_id TEXT NOT NULL REFERENCES orders(id), sku TEXT NOT NULL REFERENCES products(sku),
  qty INTEGER NOT NULL CHECK(qty>0), price INTEGER NOT NULL, PRIMARY KEY(order_id,sku));
CREATE TABLE IF NOT EXISTS order_log(id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, t INTEGER NOT NULL, msg TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS returns(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, order_id TEXT NOT NULL REFERENCES orders(id), reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN('requested','received','refunded','rejected')), created INTEGER NOT NULL,
  condition TEXT, refund INTEGER, source TEXT NOT NULL DEFAULT 'staff');
CREATE TABLE IF NOT EXISTS return_items(
  return_id TEXT NOT NULL REFERENCES returns(id), sku TEXT NOT NULL, qty INTEGER NOT NULL CHECK(qty>0), PRIMARY KEY(return_id,sku));
CREATE TABLE IF NOT EXISTS return_log(id INTEGER PRIMARY KEY AUTOINCREMENT, return_id TEXT NOT NULL, t INTEGER NOT NULL, msg TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, to_email TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, ref TEXT);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_log_order ON order_log(order_id);
`;

const PRODUCTS = [
  ['DIV3-DIN', 'Diverter 3, DIN-rail kit', 'Controller that sends surplus PV power to a resistive tank heater. DIN-rail mounting.', 21900, 340, 'A-03', 1, 12],
  ['DIV3-WALL', 'Diverter 3, wall housing', 'Controller that sends surplus PV power to a resistive tank heater. Wall housing.', 23100, 520, 'A-04', 1, 6],
  ['EL3', 'Screw-in heating element, 3 kW', '1½″ screw-in element with a safety thermostat. Replaces the standard tank heater.', 5400, 410, 'B-12', 0, 9],
  ['TS2', 'Tank temperature sensor, 2 m', 'PT1000 probe on a 2 m cable. Tells the diverter when the tank is hot.', 1850, 90, 'C-07', 0, 31],
  ['CT1', 'Clamp-on current sensor', 'Clamp-on sensor for the meter cable. Shows the diverter how much power goes to the grid.', 2900, 70, 'C-09', 0, 4]
];
const eur = c => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

class Store {
  constructor(file, { seed = true } = {}) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    this.q = {};
    this.pm = null;
    const n = this.db.prepare('SELECT COUNT(*) c FROM products').get().c;
    if (n === 0) {
      this.tx(() => {
        const ins = this.db.prepare('INSERT INTO products(sku,name,blurb,price,grams,bin,diverter,stock) VALUES(?,?,?,?,?,?,?,?)');
        PRODUCTS.forEach(p => ins.run(...p));
        if (seed) this._seedDemo();
      });
    }
  }
  close() { this.db.close(); }
  prep(sql) { return this.q[sql] || (this.q[sql] = this.db.prepare(sql)); }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch (_) {} throw e; }
  }
  meta(key, make) {
    const r = this.prep('SELECT value FROM meta WHERE key=?').get(key);
    if (r) return r.value;
    const v = make(); this.prep('INSERT INTO meta(key,value) VALUES(?,?)').run(key, v); return v;
  }

  /* ---------- products ---------- */
  products() { return this.prep('SELECT sku,name,blurb,price,grams,bin,diverter,stock FROM products ORDER BY rowid').all().map(p => ({ ...p, diverter: !!p.diverter })); }
  productMap() { return Object.fromEntries(this.products().map(p => [p.sku, p])); }
  publicProducts() { return this.products().map(({ sku, name, blurb, price, stock, diverter }) => ({ sku, name, blurb, price, stock, diverter })); }
  receiveStock(sku, qty) {
    qty = Number(qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 1000) throw bad('Quantity must be a whole number from 1 to 1000.');
    const r = this.prep('UPDATE products SET stock=stock+? WHERE sku=?').run(qty, sku);
    if (!r.changes) throw notFound('Unknown SKU');
    return this.productMap()[sku];
  }

  /* ---------- helpers ---------- */
  log(orderId, msg, t = Date.now()) { this.prep('INSERT INTO order_log(order_id,t,msg) VALUES(?,?,?)').run(orderId, t, msg); }
  rlog(retId, msg, t = Date.now()) { this.prep('INSERT INTO return_log(return_id,t,msg) VALUES(?,?,?)').run(retId, t, msg); }
  mail(to, subject, body, ref) { this.prep('INSERT INTO outbox(t,to_email,subject,body,ref) VALUES(?,?,?,?,?)').run(Date.now(), to, subject, body, ref || null); }

  _order(row) {
    if (!row) return null;
    const items = this.prep('SELECT sku,qty,price FROM order_items WHERE order_id=? ORDER BY rowid').all(row.id);
    const log = this.prep('SELECT t,msg AS m FROM order_log WHERE order_id=? ORDER BY id').all(row.id);
    return {
      id: row.id, created: row.created, payment: row.payment, status: row.status,
      customer: { name: row.name, email: row.email, street: row.street, zip: row.zip, city: row.city, country: row.country },
      items, totals: { sub: row.sub, ship: row.ship, total: row.total, vat: row.vat, rate: row.rate },
      tracking: row.tracking ? { carrier: row.carrier, no: row.tracking } : null,
      shippedAt: row.shipped_at, deliveredAt: row.delivered_at, pack: JSON.parse(row.pack), log
    };
  }
  getOrder(id) { return this._order(this.prep('SELECT * FROM orders WHERE id=?').get(id)); }
  mustOrder(id) { const o = this.getOrder(id); if (!o) throw notFound('Order not found'); return o; }
  listOrders() { return this.prep('SELECT * FROM orders ORDER BY seq DESC').all().map(r => this._order(r)); }

  /* ---------- placing an order (prices and totals always computed here, never taken from the client) ---------- */
  createOrder(input) {
    input = input || {};
    const { errors, value: cust } = R.validateCustomer(input.customer);
    if (Object.keys(errors).length) throw bad('Please check the highlighted fields.', errors);
    if (!R.PAYMENTS.includes(input.payment)) throw bad('Choose a payment method.', { payment: 'Choose a payment method.' });
    if (input.terms !== true) throw bad('Confirm that you have read the cancellation policy.', { terms: 'Confirm that you have read the cancellation policy.' });
    if (!Array.isArray(input.items) || !input.items.length) throw bad('Your cart is empty.');
    const merged = new Map();
    for (const it of input.items) {
      const qty = Number(it && it.qty), sku = it && it.sku;
      if (!Number.isInteger(qty) || qty < 1 || qty > R.MAX_QTY) throw bad('Quantity must be a whole number from 1 to ' + R.MAX_QTY + '.');
      merged.set(sku, (merged.get(sku) || 0) + qty);
    }
    return this.tx(() => {
      const lines = [];
      for (const [sku, qty] of merged) {
        const p = this.prep('SELECT sku,name,price,stock FROM products WHERE sku=?').get(sku);
        if (!p) throw bad('Unknown product: ' + String(sku).slice(0, 40));
        if (qty > R.MAX_QTY) throw bad('At most ' + R.MAX_QTY + ' of one item per order.');
        if (p.stock < qty) throw conflict(p.stock > 0 ? 'Only ' + p.stock + ' × ' + p.name + ' left. Lower the quantity and try again.' : p.name + ' is sold out.');
        lines.push({ sku, qty, price: p.price, name: p.name });
      }
      const t = R.totals(lines, cust.country);
      const now = Date.now();
      const r = this.prep(`INSERT INTO orders(created,name,email,street,zip,city,country,payment,status,sub,ship,total,vat,rate)
        VALUES(?,?,?,?,?,?,?,?, 'new',?,?,?,?,?)`).run(now, cust.name, cust.email, cust.street, cust.zip, cust.city, cust.country, input.payment, t.sub, t.ship, t.total, t.vat, t.rate);
      const id = 'HW-' + (1000 + Number(r.lastInsertRowid));
      this.prep('UPDATE orders SET id=? WHERE seq=?').run(id, r.lastInsertRowid);
      for (const l of lines) {
        this.prep('INSERT INTO order_items(order_id,sku,qty,price) VALUES(?,?,?,?)').run(id, l.sku, l.qty, l.price);
        const u = this.prep('UPDATE products SET stock=stock-? WHERE sku=? AND stock>=?').run(l.qty, l.sku, l.qty);
        if (!u.changes) throw conflict(l.name + ' just sold out.');
      }
      this.log(id, 'Order placed, ' + input.payment, now);
      this.mail(cust.email, 'Order ' + id + ' received',
        'Hello ' + cust.name + ',\n\nthank you for your order ' + id + '.\n\n' + lines.map(l => l.qty + ' × ' + l.name + '  ' + eur(l.qty * l.price)).join('\n') +
        '\n\nShipping: ' + (t.ship ? eur(t.ship) : 'free') + '\nTotal: ' + eur(t.total) + ' (incl. ' + Math.round(t.rate * 100) + '% VAT ' + eur(t.vat) + ')\n\n' +
        'You can follow your order and start a return on the "Track order" page with this order number and your email address.', id);
      return this.getOrder(id);
    });
  }

  /* ---------- fulfilment ---------- */
  _packKeys(o, pm) { return R.packKeys(o.items, sku => !!(pm[sku] && pm[sku].diverter)); }
  setPack(id, key, checked) {
    return this.tx(() => {
      const o = this.mustOrder(id);
      if (o.status !== 'new') throw conflict('Only orders waiting to be packed have a checklist.');
      if (!this._packKeys(o, this.productMap()).includes(key)) throw bad('Unknown checklist step.');
      if (checked) o.pack[key] = true; else delete o.pack[key];
      this.prep('UPDATE orders SET pack=? WHERE id=?').run(JSON.stringify(o.pack), id);
      return this.getOrder(id);
    });
  }
  ship(id, carrier, tracking) {
    return this.tx(() => {
      const o = this.mustOrder(id);
      if (o.status !== 'new') throw conflict('This order is already ' + o.status + '.');
      if (!R.CARRIERS.includes(carrier)) throw bad('Choose a carrier.');
      if (!R.trackingOk(tracking)) throw bad('Tracking number must be 8 to 24 letters or digits.');
      const keys = this._packKeys(o, this.productMap());
      if (!keys.every(k => o.pack[k])) throw conflict('Finish every packing step before shipping.');
      const no = String(tracking).replace(/\s+/g, ''), now = Date.now();
      this.prep("UPDATE orders SET status='shipped',carrier=?,tracking=?,shipped_at=? WHERE id=?").run(carrier, no, now, id);
      this.log(id, 'Shipped with ' + carrier + ', ' + no, now);
      this.mail(o.customer.email, 'Your order ' + id + ' has shipped',
        'Hello ' + o.customer.name + ',\n\nyour order ' + id + ' is on its way with ' + carrier + '.\nTracking number: ' + no + '\n\nThe 14-day withdrawal period starts when the parcel is delivered.', id);
      return this.getOrder(id);
    });
  }
  cancel(id) {
    return this.tx(() => {
      const o = this.mustOrder(id);
      if (o.status !== 'new') throw conflict('Only orders that are not shipped yet can be cancelled.');
      this.prep("UPDATE orders SET status='cancelled' WHERE id=?").run(id);
      for (const i of o.items) this.prep('UPDATE products SET stock=stock+? WHERE sku=?').run(i.qty, i.sku);
      this.log(id, 'Cancelled, stock released');
      this.mail(o.customer.email, 'Order ' + id + ' cancelled', 'Hello ' + o.customer.name + ',\n\nyour order ' + id + ' was cancelled before shipping. Nothing has been charged.', id);
      return this.getOrder(id);
    });
  }
  deliver(id) {
    return this.tx(() => {
      const o = this.mustOrder(id);
      if (o.status !== 'shipped') throw conflict('Only shipped orders can be marked delivered.');
      const now = Date.now();
      this.prep("UPDATE orders SET status='delivered',delivered_at=? WHERE id=?").run(now, id);
      this.log(id, 'Delivered', now);
      return this.getOrder(id);
    });
  }

  /* ---------- returns ---------- */
  _return(row) {
    if (!row) return null;
    return {
      id: row.id, orderId: row.order_id, reason: row.reason, status: row.status, created: row.created,
      condition: row.condition, refund: row.refund, source: row.source,
      items: this.prep('SELECT sku,qty FROM return_items WHERE return_id=? ORDER BY rowid').all(row.id),
      log: this.prep('SELECT t,msg AS m FROM return_log WHERE return_id=? ORDER BY id').all(row.id)
    };
  }
  getReturn(id) { return this._return(this.prep('SELECT * FROM returns WHERE id=?').get(id)); }
  mustReturn(id) { const r = this.getReturn(id); if (!r) throw notFound('Return not found'); return r; }
  listReturns(orderId) {
    const rows = orderId ? this.prep('SELECT * FROM returns WHERE order_id=? ORDER BY seq DESC').all(orderId) : this.prep('SELECT * FROM returns ORDER BY seq DESC').all();
    return rows.map(r => this._return(r));
  }
  returnableQty(order, sku) {
    const ordered = order.items.filter(i => i.sku === sku).reduce((a, i) => a + i.qty, 0);
    const used = this.prep(`SELECT COALESCE(SUM(ri.qty),0) q FROM return_items ri JOIN returns r ON r.id=ri.return_id
      WHERE r.order_id=? AND ri.sku=? AND r.status!='rejected'`).get(order.id, sku).q;
    return ordered - used;
  }
  returnValue(ret) {
    const o = this.mustOrder(ret.orderId);
    return ret.items.reduce((a, i) => a + i.qty * ((o.items.find(x => x.sku === i.sku) || { price: 0 }).price), 0);
  }
  createReturn(orderId, items, reason, source) {
    if (!R.REASONS.includes(reason)) throw bad('Choose a reason.');
    if (!Array.isArray(items)) throw bad('Choose at least one item to return.');
    return this.tx(() => {
      const o = this.mustOrder(orderId);
      if (o.status !== 'shipped' && o.status !== 'delivered') throw conflict('Only shipped or delivered orders can be returned.');
      if (source === 'customer' && !R.customerMayReturn(o.status, o.deliveredAt, reason, Date.now()))
        throw conflict(reason === R.REASONS[0] ? 'The 14-day withdrawal period for this order has ended. Please contact us.' : 'Returns for this reason are accepted for ' + R.OTHER_RETURN_DAYS + ' days after delivery. Please contact us.');
      const merged = new Map();
      for (const it of items) {
        const qty = Number(it && it.qty);
        if (!Number.isInteger(qty) || qty < 0) throw bad('Quantities must be whole numbers.');
        if (qty > 0) merged.set(it.sku, (merged.get(it.sku) || 0) + qty);
      }
      if (!merged.size) throw bad('Choose at least one item to return.');
      for (const [sku, qty] of merged) {
        if (!o.items.some(i => i.sku === sku)) throw bad('That item is not part of this order.');
        const max = this.returnableQty(o, sku);
        if (qty > max) throw conflict(max > 0 ? 'You can return at most ' + max + ' of ' + sku + '.' : sku + ' was already returned.');
      }
      const now = Date.now();
      const r = this.prep("INSERT INTO returns(order_id,reason,status,created,source) VALUES(?,?, 'requested',?,?)").run(orderId, reason, now, source === 'customer' ? 'customer' : 'staff');
      const id = 'RMA-' + r.lastInsertRowid;
      this.prep('UPDATE returns SET id=? WHERE seq=?').run(id, r.lastInsertRowid);
      for (const [sku, qty] of merged) this.prep('INSERT INTO return_items(return_id,sku,qty) VALUES(?,?,?)').run(id, sku, qty);
      this.rlog(id, 'Return requested' + (source === 'customer' ? ' by customer' : ' by staff'), now);
      this.log(orderId, id + ' opened', now);
      this.mail(o.customer.email, 'Return ' + id + ' registered',
        'Hello ' + o.customer.name + ',\n\nwe registered return ' + id + ' for order ' + orderId + ' (' + reason + ').\nPlease send the items back in their original packaging and write ' + id + ' on the parcel. We refund after we have inspected them.', id);
      return this.getReturn(id);
    });
  }
  receiveReturn(id) {
    return this.tx(() => {
      const r = this.mustReturn(id);
      if (r.status !== 'requested') throw conflict('This return is already ' + r.status + '.');
      this.prep("UPDATE returns SET status='received' WHERE id=?").run(id);
      this.rlog(id, 'Parcel received, waiting for inspection');
      return this.getReturn(id);
    });
  }
  refundReturn(id, resellable, amountCents) {
    return this.tx(() => {
      const r = this.mustReturn(id);
      if (r.status !== 'received') throw conflict('Mark the parcel as received before refunding.');
      const value = this.returnValue(r);
      if (!Number.isInteger(amountCents) || amountCents < 0 || amountCents > value) throw bad('Refund must be between ' + eur(0) + ' and ' + eur(value) + '.');
      if (resellable) for (const i of r.items) this.prep('UPDATE products SET stock=stock+? WHERE sku=?').run(i.qty, i.sku);
      const n = r.items.reduce((a, i) => a + i.qty, 0);
      this.prep("UPDATE returns SET status='refunded',condition=?,refund=? WHERE id=?").run(resellable ? 'resellable' : 'scrap', amountCents, id);
      this.rlog(id, 'Refunded ' + eur(amountCents) + ', ' + n + ' item' + (n > 1 ? 's' : '') + (resellable ? ' restocked' : ' scrapped'));
      const o = this.mustOrder(r.orderId);
      this.mail(o.customer.email, 'Refund for ' + id, 'Hello ' + o.customer.name + ',\n\nwe refunded ' + eur(amountCents) + ' for return ' + id + ' to your original payment method.', id);
      return this.getReturn(id);
    });
  }
  rejectReturn(id) {
    return this.tx(() => {
      const r = this.mustReturn(id);
      if (r.status !== 'requested' && r.status !== 'received') throw conflict('This return is already ' + r.status + '.');
      this.prep("UPDATE returns SET status='rejected' WHERE id=?").run(id);
      this.rlog(id, 'Return rejected');
      const o = this.mustOrder(r.orderId);
      this.mail(o.customer.email, 'Return ' + id + ' not accepted', 'Hello ' + o.customer.name + ',\n\nwe could not accept return ' + id + '. Please reply to this email if you have questions.', id);
      return this.getReturn(id);
    });
  }

  /* ---------- customer view ---------- */
  trackOrder(id, email) {
    const row = this.prep('SELECT * FROM orders WHERE id=? AND lower(email)=lower(?)').get(String(id || '').trim().toUpperCase(), String(email || '').trim());
    if (!row) return null;
    const o = this._order(row), pm = this.productMap();
    const w = R.windowInfo(o.status, o.deliveredAt, Date.now());
    return {
      id: o.id, created: o.created, status: o.status, payment: o.payment, totals: o.totals, tracking: o.tracking,
      shippedAt: o.shippedAt, deliveredAt: o.deliveredAt,
      customer: { name: o.customer.name, street: o.customer.street, zip: o.customer.zip, city: o.customer.city, country: o.customer.country },
      items: o.items.map(i => ({ ...i, name: pm[i.sku].name, returnable: this.returnableQty(o, i.sku) })),
      withdrawal: w,
      returns: this.listReturns(o.id).map(r => ({ id: r.id, status: r.status, reason: r.reason, created: r.created, items: r.items, refund: r.refund }))
    };
  }

  /* ---------- exports ---------- */
  outbox(limit = 100) { return this.prep('SELECT id,t,to_email AS "to",subject,body,ref FROM outbox ORDER BY id DESC LIMIT ?').all(limit); }
  ordersCsv() {
    const cell = v => {
      let s = String(v == null ? '' : v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
      return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const head = ['order', 'placed', 'status', 'name', 'email', 'country', 'items', 'items_eur', 'shipping_eur', 'total_eur', 'vat_eur', 'carrier', 'tracking'];
    const rows = this.listOrders().map(o => [o.id, new Date(o.created).toISOString(), o.status, o.customer.name, o.customer.email, o.customer.country,
      o.items.map(i => i.qty + 'x ' + i.sku).join(' '), (o.totals.sub / 100).toFixed(2), (o.totals.ship / 100).toFixed(2), (o.totals.total / 100).toFixed(2), (o.totals.vat / 100).toFixed(2),
      o.tracking ? o.tracking.carrier : '', o.tracking ? o.tracking.no : '']);
    return [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
  }

  /* ---------- demo data (only on a fresh database, disable with SEED=0) ---------- */
  _seedDemo() {
    const now = Date.now(), H = 36e5, D = 24 * H;
    const P = {
      anna: ['Anna Keller', 'anna.keller@example.com', 'Lindenallee 14', '04109', 'Leipzig', 'DE'],
      jonas: ['Jonas Weber', 'j.weber@example.com', 'Annenstraße 31', '8010', 'Graz', 'AT'],
      mira: ['Mira de Vries', 'mira.devries@example.com', 'Oudegracht 120', '3511 AB', 'Utrecht', 'NL'],
      luc: ['Luc Moreau', 'luc.moreau@example.com', 'Rue Garibaldi 48', '69003', 'Lyon', 'FR'],
      tobias: ['Tobias Brandt', 't.brandt@example.com', 'Schulstraße 7', '14467', 'Potsdam', 'DE'],
      sofia: ['Sofia Hartmann', 'sofia.hartmann@example.com', 'Osterdeich 19', '28203', 'Bremen', 'DE']
    };
    const price = Object.fromEntries(PRODUCTS.map(p => [p[0], p[3]]));
    const ord = (seq, age, who, lines, status, o = {}) => {
      const id = 'HW-' + (1000 + seq), c = P[who], created = now - age;
      const items = lines.map(([sku, qty]) => ({ sku, qty, price: price[sku] }));
      const t = R.totals(items, c[5]);
      this.prep(`INSERT INTO orders(seq,id,created,name,email,street,zip,city,country,payment,status,sub,ship,total,vat,rate,carrier,tracking,shipped_at,delivered_at,pack)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(seq, id, created, ...c, o.pay || 'Invoice', status, t.sub, t.ship, t.total, t.vat, t.rate,
        o.carrier || null, o.no || null, o.shipAfter != null ? created + o.shipAfter : null, o.deliveredAt || null, JSON.stringify(o.pack || {}));
      items.forEach(i => this.prep('INSERT INTO order_items(order_id,sku,qty,price) VALUES(?,?,?,?)').run(id, i.sku, i.qty, i.price));
      this.log(id, 'Order placed, ' + (o.pay || 'Invoice'), created);
      if (o.shipAfter != null) this.log(id, 'Shipped with ' + o.carrier + ', ' + o.no, created + o.shipAfter);
      if (o.deliveredAt) this.log(id, 'Delivered', o.deliveredAt);
    };
    ord(36, 32 * D, 'sofia', [['CT1', 1], ['TS2', 1]], 'delivered', { pay: 'SEPA debit', shipAfter: D, carrier: 'DHL Paket', no: 'JJD149901234567', deliveredAt: now - 29 * D });
    ord(37, 12 * D, 'tobias', [['DIV3-WALL', 1], ['EL3', 1]], 'delivered', { pay: 'PayPal', shipAfter: 20 * H, carrier: 'DHL Paket', no: 'JJD149907654321', deliveredAt: now - 10 * D });
    ord(38, 7 * D, 'anna', [['DIV3-DIN', 1], ['TS2', 1]], 'delivered', { shipAfter: 22 * H, carrier: 'DHL Paket', no: 'JJD149905550001', deliveredAt: now - 5 * D });
    ord(39, 21 * D, 'jonas', [['DIV3-DIN', 1], ['EL3', 1], ['CT1', 1]], 'delivered', { pay: 'SEPA debit', shipAfter: 30 * H, carrier: 'Österreichische Post', no: '1060998877665544', deliveredAt: now - 17 * D });
    ord(40, 30 * H, 'mira', [['DIV3-DIN', 1], ['TS2', 1]], 'shipped', { pay: 'PayPal', shipAfter: 5 * H, carrier: 'DHL Paket International', no: 'JJD149903331122' });
    ord(41, 26 * H, 'luc', [['DIV3-WALL', 1], ['CT1', 1], ['EL3', 1]], 'new', { pay: 'PayPal', pack: { 'pick:DIV3-WALL': true } });
    ord(42, 3 * H, 'anna', [['EL3', 2]], 'new');
    ord(43, 40 * 6e4, 'jonas', [['DIV3-DIN', 1]], 'new', { pay: 'SEPA debit' });
    const ret = (seq, orderId, items, reason, status, age, extra, logs) => {
      const id = 'RMA-' + seq;
      this.prep('INSERT INTO returns(seq,id,order_id,reason,status,created,condition,refund,source) VALUES(?,?,?,?,?,?,?,?,?)').run(seq, id, orderId, reason, status, now - age, extra.condition || null, extra.refund == null ? null : extra.refund, 'staff');
      items.forEach(([sku, qty]) => this.prep('INSERT INTO return_items(return_id,sku,qty) VALUES(?,?,?)').run(id, sku, qty));
      logs.forEach(([a, m]) => this.rlog(id, m, now - a));
    };
    ret(199, 'HW-1036', [['CT1', 1]], R.REASONS[0], 'refunded', 24 * D, { condition: 'resellable', refund: 2900 }, [[24 * D, 'Return requested'], [22 * D, 'Parcel received'], [21 * D, 'Refunded ' + eur(2900) + ', 1 item restocked']]);
    ret(200, 'HW-1037', [['EL3', 1]], R.REASONS[2], 'received', 3 * D, {}, [[3 * D, 'Return requested'], [20 * H, 'Parcel received, waiting for inspection']]);
    ret(201, 'HW-1038', [['TS2', 1]], R.REASONS[1], 'requested', 4 * H, {}, [[4 * H, 'Return requested']]);
  }
}

module.exports = { Store, HttpError };
