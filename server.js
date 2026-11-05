'use strict';
// Heliowatt shop + back office. Zero dependencies: node:http and node:sqlite (Node 22.13 or newer).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Store, HttpError } = require('./lib/store');
const R = require('./lib/rules');

const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const eur = c => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

/** Small fixed-window limiter, keyed by client address. */
function limiter(max, windowMs) {
  const hits = new Map();
  return key => {
    const now = Date.now(), h = hits.get(key);
    if (!h || now > h.reset) { hits.set(key, { n: 1, reset: now + windowMs }); if (hits.size > 5000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k); return true; }
    h.n++; return h.n <= max;
  };
}

function createApp(opts = {}) {
  const dbFile = opts.dbFile || process.env.DB_PATH || path.join(__dirname, 'data', 'heliowatt.db');
  const production = (opts.production != null ? opts.production : process.env.NODE_ENV === 'production');
  const adminPassword = opts.adminPassword || process.env.ADMIN_PASSWORD || (production ? '' : 'heliowatt-demo');
  if (!adminPassword || adminPassword.length < 8) throw new Error('Set ADMIN_PASSWORD (at least 8 characters) before starting in production.');
  const store = new Store(dbFile, { seed: opts.seed != null ? opts.seed : process.env.SEED !== '0' });
  const secret = process.env.SESSION_SECRET || store.meta('session_secret', () => crypto.randomBytes(32).toString('hex'));
  const secureCookie = opts.secureCookie != null ? opts.secureCookie : process.env.COOKIE_SECURE === '1';
  const loginLimit = limiter(opts.loginMax || 8, 10 * 60 * 1000);
  const orderLimit = limiter(opts.orderMax || 30, 60 * 60 * 1000);
  const trackLimit = limiter(opts.trackMax || 60, 10 * 60 * 1000);
  const SESSION_MS = 8 * 3600 * 1000;

  /* ----- admin session: signed cookie "<expiry>.<hmac>" ----- */
  const sign = exp => crypto.createHmac('sha256', secret).update('admin.' + exp).digest('hex');
  const makeToken = () => { const exp = Date.now() + SESSION_MS; return exp + '.' + sign(exp); };
  function isAdmin(req) {
    const m = /(?:^|;\s*)hw_admin=(\d+)\.([0-9a-f]{64})/.exec(req.headers.cookie || '');
    if (!m || Number(m[1]) < Date.now()) return false;
    const a = Buffer.from(m[2], 'hex'), b = Buffer.from(sign(m[1]), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const cookie = (val, maxAge) => 'hw_admin=' + val + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + (secureCookie ? '; Secure' : '');
  function passwordOk(pw) {
    const a = crypto.createHash('sha256').update(String(pw || '')).digest(), b = crypto.createHash('sha256').update(adminPassword).digest();
    return crypto.timingSafeEqual(a, b);
  }

  /* ----- routes ----- */
  const routes = [];
  const route = (method, pattern, handler, admin = false) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, admin });
  const ip = req => req.socket.remoteAddress || 'x';

  route('GET', '/healthz', () => ({ ok: true }));
  route('GET', '/api/products', () => store.publicProducts());

  route('POST', '/api/orders', (req, ctx) => {
    if (!orderLimit(ip(req))) throw new HttpError(429, 'Too many orders from this address. Try again later.');
    const o = store.createOrder(ctx.body);
    return { id: o.id, total: o.totals.total, email: o.customer.email };
  });
  route('POST', '/api/track', (req, ctx) => {
    if (!trackLimit(ip(req))) throw new HttpError(429, 'Too many lookups. Try again in a few minutes.');
    const t = store.trackOrder(ctx.body.id, ctx.body.email);
    if (!t) throw new HttpError(404, 'We could not find an order with that number and email address.');
    return t;
  });
  route('POST', '/api/track/return', (req, ctx) => {
    if (!trackLimit(ip(req))) throw new HttpError(429, 'Too many requests. Try again in a few minutes.');
    const t = store.trackOrder(ctx.body.id, ctx.body.email);
    if (!t) throw new HttpError(404, 'We could not find an order with that number and email address.');
    const r = store.createReturn(t.id, ctx.body.items, ctx.body.reason, 'customer');
    return { id: r.id };
  });

  route('POST', '/api/admin/login', (req, ctx, res) => {
    if (!loginLimit(ip(req))) throw new HttpError(429, 'Too many attempts. Wait ten minutes and try again.');
    if (!passwordOk(ctx.body.password)) throw new HttpError(401, 'Wrong password.');
    res.setHeader('Set-Cookie', cookie(makeToken(), SESSION_MS / 1000));
    return { ok: true };
  });
  route('POST', '/api/admin/logout', (req, ctx, res) => { res.setHeader('Set-Cookie', cookie('', 0)); return { ok: true }; });
  route('GET', '/api/admin/me', req => ({ admin: isAdmin(req) }));

  route('GET', '/api/admin/data', () => ({
    orders: store.listOrders(), returns: store.listReturns(), products: store.products(), outbox: store.outbox(60), now: Date.now()
  }), true);
  route('POST', '/api/admin/orders/:id/pack', (req, ctx) => store.setPack(ctx.params.id, ctx.body.key, ctx.body.checked === true), true);
  route('POST', '/api/admin/orders/:id/ship', (req, ctx) => store.ship(ctx.params.id, ctx.body.carrier, ctx.body.tracking), true);
  route('POST', '/api/admin/orders/:id/cancel', (req, ctx) => store.cancel(ctx.params.id), true);
  route('POST', '/api/admin/orders/:id/deliver', (req, ctx) => store.deliver(ctx.params.id), true);
  route('POST', '/api/admin/returns', (req, ctx) => store.createReturn(ctx.body.orderId, ctx.body.items, ctx.body.reason, 'staff'), true);
  route('POST', '/api/admin/returns/:id/receive', (req, ctx) => store.receiveReturn(ctx.params.id), true);
  route('POST', '/api/admin/returns/:id/refund', (req, ctx) => {
    const cents = Number(ctx.body.amount);
    return store.refundReturn(ctx.params.id, ctx.body.resellable === true, Number.isInteger(cents) ? cents : NaN);
  }, true);
  route('POST', '/api/admin/returns/:id/reject', (req, ctx) => store.rejectReturn(ctx.params.id), true);
  route('POST', '/api/admin/stock/:sku/receive', (req, ctx) => store.receiveStock(ctx.params.sku, ctx.body.qty), true);
  route('GET', '/api/admin/orders.csv', (req, ctx, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="heliowatt-orders.csv"');
    return { raw: store.ordersCsv(), type: 'text/csv; charset=utf-8' };
  }, true);
  route('GET', '/admin/orders/:id/slip', (req, ctx) => {
    const o = store.getOrder(decodeURIComponent(ctx.params.id));
    if (!o) throw new HttpError(404, 'Order not found');
    return { raw: slipHtml(o, store.productMap()), type: 'text/html; charset=utf-8' };
  }, true);

  function slipHtml(o, pm) {
    const c = o.customer, t = o.totals, kg = R.weightKg(o.items, s => pm[s].grams);
    const rows = o.items.map(i => '<tr><td>' + i.qty + ' ×</td><td>' + esc(pm[i.sku].name) + '<br><small>' + esc(i.sku) + ' · bin ' + esc(pm[i.sku].bin) + '</small></td><td class="n">' + eur(i.price) + '</td><td class="n">' + eur(i.price * i.qty) + '</td></tr>').join('');
    return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Packing slip ' + esc(o.id) + '</title><link rel="stylesheet" href="/slip.css"></head><body>' +
      '<p class="noprint"><button id="print" type="button">Print</button> <a href="/#orders">Back to back office</a></p>' +
      '<h1>Heliowatt</h1><p class="muted">Packing slip and invoice summary (demo)</p>' +
      '<div class="two"><div><h2>Ship to</h2><p>' + esc(c.name) + '<br>' + esc(c.street) + '<br>' + esc(c.zip) + ' ' + esc(c.city) + '<br>' + esc(R.COUNTRIES[c.country].name) + '</p></div>' +
      '<div><h2>Order ' + esc(o.id) + '</h2><p>Placed ' + esc(new Date(o.created).toLocaleDateString('de-DE')) + '<br>Payment: ' + esc(o.payment) + '<br>Parcel about ' + kg.toFixed(1).replace('.', ',') + ' kg (' + R.tier(kg) + ')<br>Guide language: ' + R.COUNTRIES[c.country].lang + '</p></div></div>' +
      '<table><thead><tr><th></th><th>Item</th><th class="n">Each</th><th class="n">Total</th></tr></thead><tbody>' + rows + '</tbody><tfoot>' +
      '<tr><td colspan="3">Items</td><td class="n">' + eur(t.sub) + '</td></tr><tr><td colspan="3">Shipping</td><td class="n">' + (t.ship ? eur(t.ship) : 'free') + '</td></tr>' +
      '<tr class="b"><td colspan="3">Total</td><td class="n">' + eur(t.total) + '</td></tr><tr><td colspan="3">of which ' + Math.round(t.rate * 100) + '% VAT</td><td class="n">' + eur(t.vat) + '</td></tr></tfoot></table>' +
      '<p class="muted">You can withdraw from the purchase within 14 days of delivery without giving a reason.</p><script src="/slip.js"></script></body></html>';
  }

  /* ----- request handling ----- */
  function send(res, status, body, type) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length });
    res.end(buf);
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', c => { size += c.length; if (size > 64 * 1024) { reject(new HttpError(413, 'Request too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); }
        catch (e) { reject(new HttpError(400, 'Request body must be valid JSON.')); }
      });
      req.on('error', reject);
    });
  }
  function serveStatic(url, res) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    if (rel === '/rules.js') return send(res, 200, fs.readFileSync(path.join(__dirname, 'lib', 'rules.js')), MIME['.js']);
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    const json = (status, data) => send(res, status, JSON.stringify(data), 'application/json; charset=utf-8');
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' || req.method === 'HEAD') {
        const r = routes.find(r => r.method === 'GET' && r.re.test(url.pathname));
        if (!r) return serveStatic(url, res);
        if (r.admin && !isAdmin(req)) {
          if (url.pathname.startsWith('/admin/')) { res.writeHead(302, { Location: '/#orders' }); return res.end(); }
          return json(401, { error: 'Log in to the back office first.' });
        }
        const out = r.handler(req, { params: r.re.exec(url.pathname).groups || {}, url }, res);
        return out && out.raw != null ? send(res, 200, out.raw, out.type) : json(200, out);
      }
      if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
      const r = routes.find(r => r.method === 'POST' && r.re.test(url.pathname));
      if (!r) return json(404, { error: 'Not found' });
      if (!/^application\/json/i.test(req.headers['content-type'] || '')) return json(415, { error: 'Send JSON.' });
      if (r.admin && !isAdmin(req)) return json(401, { error: 'Log in to the back office first.' });
      const body = await readBody(req);
      json(200, r.handler(req, { params: r.re.exec(url.pathname).groups || {}, body }, res));
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message, fields: e.fields });
      console.error(e);
      json(500, { error: 'Something went wrong on our side. Try again.' });
    }
  });
  server.on('close', () => { try { store.close(); } catch (_) {} });
  return { server, store, adminPassword };
}

module.exports = { createApp };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { server, adminPassword } = createApp();
  server.listen(port, () => {
    console.log('Heliowatt running at http://localhost:' + port);
    if (!process.env.ADMIN_PASSWORD) console.log('Back office password (demo default): ' + adminPassword + '   Set ADMIN_PASSWORD to change it.');
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.on('SIGINT', () => server.close(() => process.exit(0)));
}
