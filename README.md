# Heliowatt Shop and Ops

A working shop and back office for a fictional solar hot-water startup. Customers browse, order and track
their parcel. Staff log in to pack, ship, cancel, deliver and handle returns. Everything is stored in a
SQLite database, so the shop and the back office share one source of truth.

The brand, products and customers are invented. No real payment is taken and no real email is sent.

## Run it

Needs Node 22.13 or newer. There are no runtime dependencies to install.

```
npm start
```

Open http://localhost:3000. The back office login on a local machine is `heliowatt-demo`.
The first start creates `data/heliowatt.db` with a few demo orders. `npm run reset` deletes it.

## What it does

**Customers (no login)**
- Shop with a product page, stock levels from the database, and an interactive model of one solar day.
- Cart and checkout for DE, AT, NL and FR. The server checks the address and postcode, reads the prices
  from the database, works out shipping and VAT, and reserves stock inside one transaction.
- Track order: order number plus the email address shows status, tracking number and the 14-day
  withdrawal window, and lets the customer request a return.

**Staff (password)**
- Orders: filters, search, details, cancel (releases stock), mark delivered, stock list with "receive stock",
  CSV export, printable packing slip.
- Packing: checklist per order with bin locations, bench test for controllers, guide language by country,
  parcel weight. The server refuses to ship until every step is ticked and a tracking number is valid.
- Returns: customer or staff requests, receive, inspect, refund up to the item value, restock or scrap.
- Emails: every customer message (confirmation, shipping notice, return, refund, cancellation) is written
  to an outbox table and shown here.

## Rules the server enforces

- Prices and totals are never taken from the browser.
- Stock cannot go below zero. Parallel orders for the last units: exactly as many succeed as there are units.
- Shipping needs the full checklist and a tracking number of 8 to 24 letters or digits.
- A return can only contain items that were ordered and not already returned. A refund cannot exceed the
  value of the returned items and needs the parcel to be marked received first.
- Customer returns for "changed my mind" need the 14-day withdrawal window. Other reasons are accepted for
  30 days after delivery. Staff can still create a return as a goodwill gesture.
- The customer lookup needs the matching email address, so order numbers cannot be guessed to read data.

## Security notes

- Back office login: one shared password (`ADMIN_PASSWORD`), compared in constant time, 8 failed attempts
  per 10 minutes per address, then blocked. The session is a signed cookie (HttpOnly, SameSite=Strict).
- All SQL is parameterised. Text from customers is escaped when shown. The CSV export prefixes cells that
  start with `=`, `+`, `-` or `@` so spreadsheets do not run them as formulas.
- Responses carry a Content-Security-Policy. POST routes only accept JSON.
- In production the server refuses to start without `ADMIN_PASSWORD`.

## Test it

```
npm test            # 20 API tests against the real server and a temporary database
npm i -D playwright && npx playwright install chromium
npm run test:e2e    # 59 browser checks: shop, checkout, login, packing, shipping, tracking, returns, layout
```

## Deploy

```
docker build -t heliowatt .
docker run -p 3000:3000 -e ADMIN_PASSWORD='a long password' -e COOKIE_SECURE=1 -e SEED=0 -v hw-data:/app/data heliowatt
```

Put it behind an HTTPS reverse proxy (Caddy, nginx) and keep the `/app/data` volume: it holds the database.
Back it up by copying the `.db` file while the app is stopped, or with `sqlite3 heliowatt.db ".backup out.db"`.

## Layout

```
server.js        HTTP server, routing, login, limits, packing slip
lib/store.js     SQLite schema and every business operation
lib/rules.js     VAT, shipping, validation, withdrawal rules (also loaded by the browser)
public/          the single-page front end (no framework, no build step)
tests/           API tests and the browser test
```

## Known limits

- One shared staff password, no user accounts or audit of who did what.
- Payments, real email, carrier label APIs and PDF invoices are not connected.
- One process with SQLite fits a small shop. More traffic or several servers needs a different database.
- Login attempt limits and order limits are kept in memory and reset when the server restarts.
