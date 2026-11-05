// Business rules shared by the server (authoritative) and the browser (display only).
// All money is in integer cents. Loaded in the browser as window.Rules via /rules.js.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Rules = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DAY = 24 * 3600 * 1000;

  const COUNTRIES = {
    DE: { name: 'Germany', vat: 0.19, ship: 490, zip: /^\d{5}$/, hint: '5 digits, for example 04109', carrier: 'DHL Paket', lang: 'German' },
    AT: { name: 'Austria', vat: 0.20, ship: 990, zip: /^\d{4}$/, hint: '4 digits, for example 8010', carrier: 'Österreichische Post', lang: 'German' },
    NL: { name: 'Netherlands', vat: 0.21, ship: 990, zip: /^\d{4}\s?[A-Za-z]{2}$/, hint: '4 digits and 2 letters, for example 3511 AB', carrier: 'DHL Paket International', lang: 'English' },
    FR: { name: 'France', vat: 0.20, ship: 990, zip: /^\d{5}$/, hint: '5 digits, for example 69003', carrier: 'DHL Paket International', lang: 'English' }
  };
  const CARRIERS = ['DHL Paket', 'DHL Paket International', 'Österreichische Post', 'DPD', 'GLS'];
  const PAYMENTS = ['Invoice', 'SEPA debit', 'PayPal'];
  const REASONS = ['Changed my mind (Widerruf)', 'Does not fit my setup', 'Arrived damaged', 'Wrong item received'];
  const FREE_SHIP = 15000, LOW_STOCK = 5, WIDERRUF_DAYS = 14, OTHER_RETURN_DAYS = 30, PACKAGING_G = 150, MAX_QTY = 20;

  // items: [{qty, price}] with price in cents
  function totals(items, country) {
    const c = COUNTRIES[country] || COUNTRIES.DE;
    const sub = items.reduce((a, i) => a + i.qty * i.price, 0);
    const ship = sub >= FREE_SHIP ? 0 : c.ship;
    const total = sub + ship;
    return { sub, ship, total, vat: Math.round(total * c.vat / (1 + c.vat)), rate: c.vat };
  }

  const clean = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

  // Returns {errors:{field:msg}, value:{...cleaned}}
  function validateCustomer(c) {
    c = c || {};
    const v = { name: clean(c.name), email: clean(c.email).toLowerCase(), street: clean(c.street), zip: clean(c.zip), city: clean(c.city), country: clean(c.country).toUpperCase() };
    const e = {};
    if (v.name.length < 2 || v.name.length > 80) e.name = 'Enter your full name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.email) || v.email.length > 120) e.email = 'Enter a valid email address, like name@example.com.';
    if (v.street.length < 4 || v.street.length > 100 || !/\d/.test(v.street)) e.street = 'Enter the street and house number.';
    if (!COUNTRIES[v.country]) e.country = 'Choose one of the countries we ship to.';
    else if (!COUNTRIES[v.country].zip.test(v.zip)) e.zip = 'Postcode format: ' + COUNTRIES[v.country].hint + '.';
    if (v.city.length < 2 || v.city.length > 60) e.city = 'Enter your city.';
    return { errors: e, value: v };
  }

  const trackingOk = v => /^[A-Za-z0-9]{8,24}$/.test(String(v || '').replace(/\s+/g, ''));

  // items: [{sku}], isDiverter(sku) -> bool. Keys of the packing checklist for an order.
  function packKeys(items, isDiverter) {
    const k = items.map(i => 'pick:' + i.sku);
    if (items.some(i => isDiverter(i.sku))) k.push('test');
    k.push('doc', 'label');
    return k;
  }
  function weightKg(items, gramsOf) {
    return (items.reduce((a, i) => a + i.qty * gramsOf(i.sku), 0) + PACKAGING_G) / 1000;
  }
  const tier = kg => (kg <= 2 ? 'up to 2 kg' : kg <= 5 ? 'up to 5 kg' : 'up to 10 kg');

  // 14-day withdrawal window, counted from delivery. Before delivery it has not started.
  function windowInfo(status, deliveredAt, now) {
    if (status === 'shipped') return { open: true, text: 'Starts at delivery', daysLeft: WIDERRUF_DAYS };
    if (status !== 'delivered') return { open: false, text: 'Not delivered', daysLeft: 0 };
    const left = WIDERRUF_DAYS - Math.floor((now - deliveredAt) / DAY);
    return left >= 0
      ? { open: true, text: left + ' of ' + WIDERRUF_DAYS + ' days left', daysLeft: left }
      : { open: false, text: 'Withdrawal window closed', daysLeft: 0 };
  }
  // Customer self-service rule: Widerruf needs the 14-day window; other reasons are accepted for 30 days.
  function customerMayReturn(status, deliveredAt, reason, now) {
    if (status === 'shipped') return true;
    if (status !== 'delivered') return false;
    if (reason === REASONS[0]) return windowInfo(status, deliveredAt, now).open;
    return now - deliveredAt <= OTHER_RETURN_DAYS * DAY;
  }

  return { COUNTRIES, CARRIERS, PAYMENTS, REASONS, FREE_SHIP, LOW_STOCK, WIDERRUF_DAYS, OTHER_RETURN_DAYS, PACKAGING_G, MAX_QTY,
    totals, validateCustomer, trackingOk, packKeys, weightKg, tier, windowInfo, customerMayReturn, clean };
});
