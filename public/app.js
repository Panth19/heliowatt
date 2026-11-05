(function(){
'use strict';
const R = window.Rules;
const COUNTRIES = R.COUNTRIES, CARRIERS = R.CARRIERS, REASONS = R.REASONS, FREE_SHIP = R.FREE_SHIP, LOW_STOCK = R.LOW_STOCK, WIDERRUF_DAYS = R.WIDERRUF_DAYS;
const H = 36e5, D_MS = 24*H;
const OPS = ['orders','packing','returns','outbox'];

/* ---------- helpers ---------- */
const $ = (s,r=document)=>r.querySelector(s);
const $$ = (s,r=document)=>Array.from(r.querySelectorAll(s));
const esc = s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const eurFmt = new Intl.NumberFormat('de-DE',{style:'currency',currency:'EUR'});
const eur = cents=>eurFmt.format(cents/100);
const dtFmt = new Intl.DateTimeFormat('de-DE',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});
const dFmt = new Intl.DateTimeFormat('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'});
function ago(t){
  const m=Math.max(0,Math.round((Date.now()-t)/6e4));
  if(m<60) return m+' min ago';
  if(m<48*60) return Math.round(m/60)+' h ago';
  return Math.round(m/1440)+' days ago';
}

/* ---------- API ---------- */
async function api(method,url,body){
  const opt={method,credentials:'same-origin',headers:{}};
  if(method!=='GET'){ opt.headers['Content-Type']='application/json'; opt.body=JSON.stringify(body||{}); }
  let r;
  try{ r=await fetch(url,opt); }catch(e){ const err=new Error('Cannot reach the server. Check your connection and try again.'); err.network=true; throw err; }
  let j=null; try{ j=await r.json(); }catch(e){}
  if(!r.ok){
    const err=new Error((j&&j.error)||'Request failed ('+r.status+').');
    err.status=r.status; err.fields=j&&j.fields;
    if(r.status===401&&url.startsWith('/api/admin')&&url!=='/api/admin/login') auth=false;
    throw err;
  }
  return j;
}

/* ---------- state ---------- */
let P=[], PM={};            // public catalogue (prices in cents)
let DATA=null, AM={};       // back-office data and product map with warehouse fields
let auth=false, renderSeq=0;
let cart=[];
try{ cart=JSON.parse(localStorage.getItem('hw-cart')||'[]').filter(c=>c&&typeof c.sku==='string'&&Number.isInteger(c.qty)&&c.qty>0); }catch(e){ cart=[]; }
const saveCart=()=>{ try{ localStorage.setItem('hw-cart',JSON.stringify(cart)); }catch(e){} };
const ui={orderSel:null,filter:'all',q:'',confirm:'',cartStep:'cart',cartCountry:'DE',lastOrder:null,variant:'DIV3-DIN',pack:{},tracked:null,trackErr:'',trackForm:{id:'',email:''},loginErr:'',busy:false,shopError:''};

async function loadProducts(){
  try{ P=await api('GET','/api/products'); PM=Object.fromEntries(P.map(p=>[p.sku,p])); ui.shopError=''; }
  catch(e){ ui.shopError=e.message; }
  cart=cart.filter(c=>PM[c.sku]); cart.forEach(c=>{ if(c.qty>PM[c.sku].stock) c.qty=Math.max(0,PM[c.sku].stock); }); cart=cart.filter(c=>c.qty>0); saveCart();
}
async function loadAdmin(){
  DATA=await api('GET','/api/admin/data');
  AM=Object.fromEntries(DATA.products.map(p=>[p.sku,p]));
}
const orderById=id=>DATA&&DATA.orders.find(o=>o.id===id);
const toPack=()=>DATA?DATA.orders.filter(o=>o.status==='new').sort((a,b)=>a.created-b.created):[];
const openReturns=()=>DATA?DATA.returns.filter(r=>r.status==='requested'||r.status==='received'):[];
const lowStock=()=>DATA?DATA.products.filter(p=>p.stock<=LOW_STOCK):[];
function stockLabel(sku){
  const p=PM[sku]; if(!p) return '';
  if(p.stock<=0) return '<span class="stock-out">Sold out</span>';
  if(p.stock<=LOW_STOCK) return '<span class="stock-low">Only '+p.stock+' left</span>';
  return '<span class="stock-ok">In stock</span>';
}
const cartQty=sku=>{ const l=cart.find(c=>c.sku===sku); return l?l.qty:0; };
function addToCart(sku){
  const p=PM[sku]; if(!p||cartQty(sku)>=Math.min(p.stock,R.MAX_QTY)) return false;
  const l=cart.find(c=>c.sku===sku); if(l) l.qty++; else cart.push({sku,qty:1});
  saveCart(); return true;
}
const cartItems=()=>cart.filter(c=>PM[c.sku]).map(c=>({sku:c.sku,qty:c.qty,price:PM[c.sku].price}));
function returnableQty(o,sku){
  const ordered=o.items.filter(i=>i.sku===sku).reduce((a,i)=>a+i.qty,0);
  const used=DATA.returns.filter(r=>r.orderId===o.id&&r.status!=='rejected').flatMap(r=>r.items).filter(i=>i.sku===sku).reduce((a,i)=>a+i.qty,0);
  return ordered-used;
}
function returnValue(r){ const o=orderById(r.orderId); return r.items.reduce((a,i)=>a+i.qty*((o.items.find(x=>x.sku===i.sku)||{price:0}).price),0); }
const windowOf=o=>R.windowInfo(o.status,o.deliveredAt,Date.now());

/* ---------- solar-day model (physics: 1 kWh heats 1 litre of water by about 860 K) ---------- */
const KWH_PER_L_K = 0.001163, T_START=35, T_MAX=75, HEATER_KW=3.0;
function gauss(h,m,s){ const x=(h-m)/s; return Math.exp(-x*x/2); }
function simulate(kwp,litres){
  const n=144, pv=[],load=[],tank=[],temp=[]; let E=0,T=T_START;
  for(let i=0;i<n;i++){
    const h=i/6;
    const x=(h-5.5)/15;
    const p=(x>0&&x<1)?kwp*0.8*Math.pow(Math.sin(Math.PI*x),1.6):0;
    const l=0.35+0.9*gauss(h,7.5,0.8)+1.3*gauss(h,19,1.4)+0.3*gauss(h,12.5,1);
    let d=0;
    if(T<T_MAX){
      d=Math.min(Math.max(0,p-l),HEATER_KW);
      const room=(T_MAX-T)*litres*KWH_PER_L_K*6;
      d=Math.min(d,room);
    }
    E+=d/6; T=T_START+E/(litres*KWH_PER_L_K);
    pv.push(p); load.push(l); tank.push(d); temp.push(T);
  }
  const sum=a=>a.reduce((x,y)=>x+y,0)/6;
  const pvK=sum(pv), tankK=sum(tank);
  const surplus=sum(pv.map((p,i)=>Math.max(0,p-load[i])));
  return {pv,load,tank,temp,pvK,tankK,exportK:surplus-tankK,litres60:tankK/(KWH_PER_L_K*50)};
}
function hhmm(i){ const m=i*10; return String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0'); }
function drawSim(sim,kwp,idx){
  const W=720,Ht=270,ml=40,mr=12,mt=14,mb=30;
  const ymax=Math.ceil(kwp*0.8)+1;
  const X=h=>ml+h/24*(W-ml-mr), Y=k=>Ht-mb-k/ymax*(Ht-mt-mb);
  const pts=a=>a.map((v,i)=>X(i/6).toFixed(1)+','+Y(v).toFixed(1));
  const band=(top,bot)=>pts(top).concat(pts(bot).reverse()).join(' ');
  const tankTop=sim.load.map((l,i)=>l+sim.tank[i]);
  const pvTop=sim.pv.map((p,i)=>Math.max(p,tankTop[i]));
  let g='';
  for(let k=0;k<=ymax;k+=2) g+='<line class="ax" x1="'+ml+'" x2="'+(W-mr)+'" y1="'+Y(k)+'" y2="'+Y(k)+'"/><text class="tx" x="'+(ml-6)+'" y="'+(Y(k)+4)+'" text-anchor="end">'+k+' kW</text>';
  for(let h=0;h<=24;h+=3) g+='<text class="tx" x="'+X(h)+'" y="'+(Ht-8)+'" text-anchor="'+(h===24?'end':'middle')+'">'+String(h).padStart(2,'0')+':00</text>';
  const cx=X(idx/6);
  return '<svg viewBox="0 0 '+W+' '+Ht+'" role="img" aria-label="Solar day: roof output, house use and power sent to the tank over 24 hours">'+g+
    '<polygon points="'+band(pvTop,tankTop)+'" fill="var(--water)" opacity=".28"/>'+
    '<polygon points="'+band(tankTop,sim.load)+'" fill="var(--sun)"/>'+
    '<polyline points="'+pts(sim.pv).join(' ')+'" fill="none" stroke="var(--water)" stroke-width="2.5" stroke-linejoin="round"/>'+
    '<polyline points="'+pts(sim.load).join(' ')+'" fill="none" stroke="var(--ink)" stroke-width="2" stroke-dasharray="5 4" stroke-linejoin="round"/>'+
    '<line x1="'+cx+'" x2="'+cx+'" y1="'+mt+'" y2="'+(Ht-mb)+'" stroke="var(--ink)" stroke-width="1.5"/>'+
    '<circle cx="'+cx+'" cy="'+Y(sim.pv[idx])+'" r="6" fill="var(--sun)" stroke="var(--ink)" stroke-width="2"/></svg>';
}



/* ---------- views: shop ---------- */
function deviceSvg(){
  return '<svg viewBox="0 0 340 260" role="img" aria-label="Illustration of the Diverter 3 module">'+
  '<rect x="30" y="40" width="280" height="150" rx="14" fill="var(--surface)" stroke="var(--ink)" stroke-width="3"/>'+
  '<rect x="52" y="62" width="140" height="44" rx="6" fill="var(--water)"/>'+
  '<text x="64" y="90" font-family="Archivo,Arial" font-weight="800" font-size="17" fill="var(--on-water)">DIVERTER 3</text>'+
  '<circle cx="226" cy="84" r="9" fill="var(--sun)" stroke="var(--ink)" stroke-width="2"/><circle cx="256" cy="84" r="9" fill="var(--bg)" stroke="var(--ink)" stroke-width="2"/><circle cx="286" cy="84" r="9" fill="var(--bg)" stroke="var(--ink)" stroke-width="2"/>'+
  '<g fill="var(--ink)">'+[52,84,116,148,214,246,278].map(x=>'<rect x="'+x+'" y="140" width="22" height="30" rx="3"/>').join('')+'</g>'+
  '<rect x="10" y="205" width="320" height="10" rx="3" fill="var(--line-strong)"/>'+
  '<text x="30" y="240" font-family="Public Sans,Arial" font-size="13" fill="var(--muted)">3.0 kW · 230 V · proportional control</text></svg>';
}
function partsHtml(){
  return ['EL3','TS2','CT1'].map(sku=>{
    const p=SKUS[sku], blurb={
      EL3:'1½″ screw-in element with a safety thermostat. Replaces the standard tank heater.',
      TS2:'PT1000 probe on a 2 m cable. Tells the diverter when the tank is hot.',
      CT1:'Clamp-on sensor for the meter cable. Shows the diverter how much power goes to the grid.'}[sku];
    return '<article class="part"><h3>'+esc(p.name)+'</h3><p class="muted small">'+blurb+'</p><div class="row"><b>'+eur(p.price)+'</b>'+stockLabel(sku)+'</div>'+
      '<button class="btn sm" type="button" data-act="add" data-sku="'+sku+'"'+(S.stock[sku]<=0?' disabled':'')+'>Add to cart</button></article>';
  }).join('');
}

function partsHtml(){
  return ['EL3','TS2','CT1'].filter(s=>PM[s]).map(sku=>{
    const p=PM[sku];
    return '<article class="part"><h3>'+esc(p.name)+'</h3><p class="muted small">'+esc(p.blurb)+'</p><div class="row"><b>'+eur(p.price)+'</b>'+stockLabel(sku)+'</div>'+
      '<button class="btn sm" type="button" data-act="add" data-sku="'+sku+'"'+(p.stock<=0?' disabled':'')+'>Add to cart</button></article>';
  }).join('');
}
function viewShop(){
  if(!P.length) return '<div class="panel empty"><b>The shop could not load</b>'+esc(ui.shopError||'No products yet.')+' <button class="link" type="button" data-act="retry">Try again</button></div>';
  const v=PM[ui.variant]||PM['DIV3-DIN'];
  return '<section class="hero"><h1>Send midday solar surplus to your hot water tank.</h1>'+
    '<p>The Heliowatt Diverter 3 switches your roof&rsquo;s spare power into the tank&rsquo;s heating element, in step with what the panels produce. Drag the time slider to see one summer day.</p></section>'+
    '<section class="sim" aria-label="Solar day model">'+
      '<div class="sim-controls">'+
        '<label class="f" for="kwp">Roof size: <span id="kwp-v"></span></label>'+
        '<label class="f" for="litres">Tank</label>'+
        '<label class="f" for="time">Time of day: <span id="time-v"></span></label>'+
      '</div>'+
      '<div class="sim-controls">'+
        '<input id="kwp" type="range" min="3" max="15" step="0.5" value="8">'+
        '<select id="litres"><option value="150">150 litres</option><option value="200" selected>200 litres</option><option value="300">300 litres</option></select>'+
        '<input id="time" type="range" min="0" max="143" step="1" value="78">'+
      '</div>'+
      '<div id="chart"></div>'+
      '<div class="legend"><span><i style="background:var(--water)"></i>Roof output</span><span><i style="background:var(--ink)"></i>House use</span><span><i style="background:var(--sun)"></i>Into the tank</span><span><i style="background:var(--water);opacity:.3"></i>Exported to grid</span></div>'+
      '<div class="read" id="read"></div>'+
      '<p class="day" id="day"></p>'+
      '<p class="muted small">Model: clear summer day, 3 kW heating element, tank starts at 35 °C and stops at 75 °C, no standby loss. An estimate, not a quote.</p>'+
    '</section>'+
    '<section class="product" id="product" aria-labelledby="p-h">'+
      '<div class="photo">'+deviceSvg()+'</div>'+
      '<div class="buy"><div><h2 id="p-h">Heliowatt Diverter 3</h2><p class="muted" style="margin-top:.4rem">Controller that sends surplus PV power to a resistive tank heater. Works with any roof inverter, because it reads the grid connection instead of talking to the inverter.</p></div>'+
        '<div class="price" id="p-price">'+eur(v.price)+'</div><p class="muted small">Prices include VAT. Shipping from '+eur(COUNTRIES.DE.ship)+', free from '+eur(FREE_SHIP)+'.</p>'+
        '<fieldset><legend>Mounting</legend>'+
          ['DIV3-DIN','DIV3-WALL'].filter(s=>PM[s]).map(sku=>'<label class="opt"><input type="radio" name="variant" value="'+sku+'"'+(ui.variant===sku?' checked':'')+'><span class="grow">'+(sku==='DIV3-DIN'?'DIN-rail kit':'Wall housing')+'</span><span>'+eur(PM[sku].price)+'</span></label>').join('')+
        '</fieldset>'+
        '<div id="p-stock">'+stockLabel(v.sku)+'</div>'+
        '<div class="actions"><button class="btn" type="button" id="p-add" data-act="add" data-sku="'+v.sku+'"'+(v.stock<=0?' disabled':'')+'>Add to cart</button><span class="muted" id="p-msg" role="status"></span></div>'+
        '<dl class="specs"><dt>Switching</dt><dd>Up to 3.0 kW at 230 V, proportional</dd><dt>Needs</dt><dd>Clamp sensor at the meter (CT1) and a tank sensor (TS2)</dd><dt>Heater</dt><dd>Any resistive element up to 3 kW, for example EL3</dd><dt>Ships with</dt><dd>Quick-start guide in German or English</dd></dl>'+
      '</div></section>'+
    '<section aria-labelledby="pt-h"><h2 id="pt-h" style="margin-bottom:1rem">Sensors and heating element</h2><div class="parts">'+partsHtml()+'</div></section>';
}
function initShop(){
  const kwp=$('#kwp'); if(!kwp) return;
  const lit=$('#litres'), tm=$('#time');
  let sim;
  const f=n=>n.toFixed(1).replace('.',',');
  function recompute(){ sim=simulate(+kwp.value,+lit.value); paint(); }
  function paint(){
    const i=+tm.value, k=+kwp.value;
    $('#kwp-v').textContent=f(k)+' kWp';
    $('#time-v').textContent=hhmm(i);
    $('#chart').innerHTML=drawSim(sim,k,i);
    const sur=Math.max(0,sim.pv[i]-sim.load[i]), tk=sim.tank[i];
    $('#read').innerHTML=
      '<div><b>'+f(sim.pv[i])+' kW</b><span>Roof output</span></div>'+
      '<div><b>'+f(sim.load[i])+' kW</b><span>House use</span></div>'+
      '<div><b>'+f(tk)+' kW</b><span>Into the tank</span></div>'+
      '<div><b>'+f(Math.max(0,sur-tk))+' kW</b><span>Exported</span></div>'+
      '<div><b>'+Math.round(sim.temp[i])+' °C</b><span>Tank temperature</span></div>';
    $('#day').textContent='Over the whole day: '+f(sim.pvK)+' kWh from the roof, '+f(sim.tankK)+' kWh stored as heat, '+f(sim.exportK)+' kWh exported. The stored heat equals about '+Math.round(sim.litres60)+' litres of water at 60 °C.';
  }
  kwp.addEventListener('input',recompute); lit.addEventListener('change',recompute); tm.addEventListener('input',paint);
  recompute();
  $$('input[name=variant]').forEach(r=>r.addEventListener('change',()=>{
    ui.variant=r.value; const p=PM[ui.variant];
    $('#p-price').textContent=eur(p.price); $('#p-stock').innerHTML=stockLabel(ui.variant);
    const b=$('#p-add'); b.dataset.sku=ui.variant; b.disabled=p.stock<=0; $('#p-msg').textContent='';
  }));
}

/* ---------- views: customer order tracking ---------- */
const STATUS = {new:['Being packed','p-warn'],shipped:['Shipped','p-info'],delivered:['Delivered','p-ok'],cancelled:['Cancelled','p-mute'],
  requested:['Requested','p-warn'],received:['Received','p-info'],refunded:['Refunded','p-ok'],rejected:['Rejected','p-mute']};
const OPS_STATUS = Object.assign({},STATUS,{new:['To pack','p-warn']});
const pill=(s,ops)=>{ const m=(ops?OPS_STATUS:STATUS)[s]; return '<span class="pill '+m[1]+'">'+m[0]+'</span>'; };
function viewTrack(){
  const t=ui.tracked;
  let out='<div class="trackbox"><div><h1 style="font-size:clamp(1.7rem,3.4vw,2.4rem)">Track your order</h1><p class="muted" style="margin-top:.5rem">Enter the order number from your confirmation email and the email address you ordered with.</p></div>'+
    '<form id="track-form" novalidate class="row2"><label class="f" for="t-id">Order number<input id="t-id" type="text" placeholder="HW-1044" value="'+esc(ui.trackForm.id)+'" autocomplete="off"></label>'+
    '<label class="f" for="t-email">Email<input id="t-email" type="email" value="'+esc(ui.trackForm.email)+'" autocomplete="email"></label><button class="btn" type="submit">Show order</button></form>'+
    '<div class="err" id="track-err" role="alert">'+esc(ui.trackErr)+'</div>';
  if(t){
    const st=t.status;
    out+='<section class="panel" style="display:grid;gap:1rem"><div style="display:flex;justify-content:space-between;gap:1rem;align-items:center;flex-wrap:wrap"><div><h2>'+esc(t.id)+'</h2><p class="muted small">Placed '+dFmt.format(t.created)+' · '+esc(t.payment)+'</p></div>'+pill(st)+'</div>'+
      (st==='cancelled'?'<p>This order was cancelled before it shipped. Nothing was charged.</p>':
      '<ol class="steps"><li class="done">Placed</li><li class="'+(st==='shipped'||st==='delivered'?'done':'')+'">Shipped</li><li class="'+(st==='delivered'?'done':'')+'">Delivered</li></ol>')+
      (t.tracking?'<p><b>'+esc(t.tracking.carrier)+'</b>, tracking number <b>'+esc(t.tracking.no)+'</b></p>':st==='new'?'<p class="muted">We are packing your order. You will get an email with the tracking number when it ships.</p>':'')+
      '<table class="lines"><tbody>'+t.items.map(i=>'<tr><td>'+i.qty+' × '+esc(i.name)+'</td><td class="num">'+eur(i.qty*i.price)+'</td></tr>').join('')+'</tbody></table>'+
      '<table class="lines tot"><tbody><tr><td>Shipping</td><td class="num">'+(t.totals.ship?eur(t.totals.ship):'Free')+'</td></tr><tr class="big"><td>Total</td><td class="num">'+eur(t.totals.total)+'</td></tr><tr><td class="muted small">incl. '+Math.round(t.totals.rate*100)+'% VAT</td><td class="num muted small">'+eur(t.totals.vat)+'</td></tr></tbody></table>'+
      '<p class="muted small">Delivery to '+esc(t.customer.name)+', '+esc(t.customer.street)+', '+esc(t.customer.zip)+' '+esc(t.customer.city)+'</p></section>';
    if(t.returns.length) out+='<section class="panel"><h2 style="margin-bottom:.6rem">Your returns</h2>'+t.returns.map(r=>'<div style="display:flex;justify-content:space-between;gap:1rem;padding:.4rem 0;border-bottom:1px solid var(--line)"><span><b>'+esc(r.id)+'</b> · '+r.items.map(i=>i.qty+' × '+esc(i.sku)).join(', ')+' <span class="muted small">('+esc(r.reason)+')</span></span><span>'+pill(r.status)+(r.refund!=null?' '+eur(r.refund):'')+'</span></div>').join('')+'</section>';
    if(st==='shipped'||st==='delivered'){
      const any=t.items.some(i=>i.returnable>0);
      out+='<section class="panel" style="display:grid;gap:.9rem"><h2>Return items</h2><p class="small">Withdrawal period: <span class="pill '+(t.withdrawal.open?'p-ok':'p-bad')+'">'+esc(t.withdrawal.text)+'</span></p>'+
        (any?'<form id="track-return" novalidate style="display:grid;gap:.8rem">'+t.items.filter(i=>i.returnable>0).map(i=>'<label class="f" style="grid-template-columns:minmax(0,1fr) 5rem;align-items:center" for="tr-'+esc(i.sku)+'"><span>'+esc(i.name)+' <span class="muted small">(up to '+i.returnable+')</span></span><input id="tr-'+esc(i.sku)+'" data-trq="'+esc(i.sku)+'" type="number" min="0" max="'+i.returnable+'" value="0"></label>').join('')+
          '<label class="f" for="tr-reason">Reason<select id="tr-reason">'+REASONS.map(x=>'<option>'+esc(x)+'</option>').join('')+'</select></label><div class="err" id="tr-err" role="alert"></div><div><button class="btn" type="submit">Request return</button></div></form>':'<p class="muted">Every item of this order is already part of a return.</p>')+'</section>';
    }
  }
  return out+'</div>';
}
async function lookupOrder(id,email){
  ui.trackForm={id,email};
  try{ ui.tracked=await api('POST','/api/track',{id,email}); ui.trackErr=''; }
  catch(e){ ui.tracked=null; ui.trackErr=e.message; }
}
function bindTrack(){
  const f=$('#track-form'); if(!f) return;
  f.addEventListener('submit',async e=>{
    e.preventDefault();
    const id=$('#t-id').value.trim(), email=$('#t-email').value.trim();
    if(!id||!email){ ui.trackErr='Enter the order number and the email address.'; return render(); }
    await lookupOrder(id,email); render();
  });
  const rf=$('#track-return');
  if(rf) rf.addEventListener('submit',async e=>{
    e.preventDefault();
    const items=$$('[data-trq]',rf).map(i=>({sku:i.dataset.trq,qty:parseInt(i.value,10)||0})).filter(i=>i.qty>0);
    if(!items.length){ $('#tr-err').textContent='Set a quantity of at least 1 for one item.'; return; }
    try{
      const r=await api('POST','/api/track/return',{id:ui.tracked.id,email:ui.trackForm.email,items,reason:$('#tr-reason').value});
      await lookupOrder(ui.trackForm.id,ui.trackForm.email); flash(r.id+' registered. Instructions are in your email.'); render();
    }catch(err){ $('#tr-err').textContent=err.message; }
  });
}

/* ---------- views: back office ---------- */
function viewLogin(){
  const local=['localhost','127.0.0.1'].includes(location.hostname);
  return '<section class="loginbox"><h1 style="font-size:clamp(1.7rem,3.4vw,2.4rem)">Back office</h1><p class="muted">Log in to see orders, pack parcels and handle returns.</p>'+
    '<form id="login-form" novalidate><label class="f" for="pw">Password<input id="pw" type="password" autocomplete="current-password"></label><div class="err" id="login-err" role="alert">'+esc(ui.loginErr)+'</div><div><button class="btn" type="submit">Log in</button></div></form>'+
    (local?'<p class="muted small">Local demo password: <b>heliowatt-demo</b>. Set ADMIN_PASSWORD to change it.</p>':'')+'</section>';
}
function bindLogin(){
  const f=$('#login-form'); if(!f) return;
  $('#pw').focus();
  f.addEventListener('submit',async e=>{
    e.preventDefault();
    try{ await api('POST','/api/admin/login',{password:$('#pw').value}); auth=true; ui.loginErr=''; DATA=null; await go(); flash('Logged in'); }
    catch(err){ ui.loginErr=err.message; $('#login-err').textContent=err.message; $('#pw').select(); }
  });
}

function orderRows(){
  const q=ui.q.trim().toLowerCase();
  return DATA.orders.filter(o=>(ui.filter==='all'||o.status===ui.filter)&&(!q||(o.id+' '+o.customer.name+' '+o.customer.email+' '+o.customer.country).toLowerCase().includes(q)))
    .sort((a,b)=>b.created-a.created);
}
function orderTable(){
  const rows=orderRows();
  if(!rows.length) return '<div class="empty"><b>No orders match</b>Clear the search or pick another status.</div>';
  return '<div class="tablewrap"><table><thead><tr><th>Order</th><th>Customer</th><th class="num">Total</th><th>Placed</th><th>Status</th></tr></thead><tbody>'+
    rows.map(o=>'<tr data-row="'+esc(o.id)+'"'+(ui.orderSel===o.id?' class="sel"':'')+'><td><button class="link" type="button" data-act="sel-order" data-id="'+esc(o.id)+'">'+esc(o.id)+'</button></td><td>'+esc(o.customer.name)+' <span class="muted">'+esc(o.customer.country)+'</span></td><td class="num">'+eur(o.totals.total)+'</td><td class="muted">'+ago(o.created)+'</td><td>'+pill(o.status,true)+'</td></tr>').join('')+'</tbody></table></div>';
}
function orderDetail(){
  const o=orderById(ui.orderSel);
  if(!o) return '<div class="panel empty"><b>Select an order</b>Its items, address, totals and history appear here.</div>';
  const c=o.customer, t=o.totals, w=windowOf(o);
  let act='';
  if(o.status==='new') act='<a class="btn sm" href="#packing">Go to packing</a><button class="btn danger sm" type="button" data-act="cancel" data-id="'+esc(o.id)+'">'+(ui.confirm==='cancel:'+o.id?'Confirm cancel':'Cancel order')+'</button>';
  if(o.status==='shipped') act='<button class="btn sm" type="button" data-act="deliver" data-id="'+esc(o.id)+'">Mark delivered</button><button class="btn ghost sm" type="button" data-act="new-return" data-id="'+esc(o.id)+'">Start return</button>';
  if(o.status==='delivered') act='<button class="btn ghost sm" type="button" data-act="new-return" data-id="'+esc(o.id)+'">Start return</button><span class="pill '+(w.open?'p-ok':'p-bad')+'">'+esc(w.text)+'</span>';
  return '<div class="panel detail"><div><div style="display:flex;justify-content:space-between;gap:.6rem;align-items:center"><h2>'+esc(o.id)+'</h2>'+pill(o.status,true)+'</div><p class="muted small">'+dFmt.format(o.created)+' · '+esc(o.payment)+'</p></div>'+
    '<dl class="kv"><dt>Ship to</dt><dd>'+esc(c.name)+'<br>'+esc(c.street)+'<br>'+esc(c.zip)+' '+esc(c.city)+', '+esc(COUNTRIES[c.country].name)+'</dd><dt>Email</dt><dd>'+esc(c.email)+'</dd>'+
      (o.tracking?'<dt>Tracking</dt><dd>'+esc(o.tracking.carrier)+', '+esc(o.tracking.no)+'</dd>':'')+'</dl>'+
    '<table class="lines"><tbody>'+o.items.map(i=>'<tr><td>'+i.qty+' × '+esc(AM[i.sku]?AM[i.sku].name:i.sku)+'</td><td class="num">'+eur(i.qty*i.price)+'</td></tr>').join('')+'</tbody></table>'+
    '<table class="lines tot"><tbody><tr><td>Items</td><td class="num">'+eur(t.sub)+'</td></tr><tr><td>Shipping</td><td class="num">'+(t.ship?eur(t.ship):'Free')+'</td></tr><tr class="big"><td>Total</td><td class="num">'+eur(t.total)+'</td></tr><tr><td class="muted small">incl. '+Math.round(t.rate*100)+'% VAT</td><td class="num muted small">'+eur(t.vat)+'</td></tr></tbody></table>'+
    '<div class="actions">'+act+'<a class="btn ghost sm" href="/admin/orders/'+encodeURIComponent(o.id)+'/slip" target="_blank" rel="noopener">Packing slip</a></div>'+
    '<ul class="timeline">'+o.log.slice().reverse().map(l=>'<li><time>'+dtFmt.format(l.t)+'</time><span>'+esc(l.m)+'</span></li>').join('')+'</ul></div>';
}
function stockTable(){
  return '<div class="tablewrap"><table><thead><tr><th>SKU</th><th>Item</th><th>Bin</th><th class="num">On hand</th><th>Status</th><th></th></tr></thead><tbody>'+
    DATA.products.map(p=>{const n=p.stock;return '<tr><td>'+esc(p.sku)+'</td><td>'+esc(p.name)+'</td><td>'+esc(p.bin)+'</td><td class="num">'+n+'</td><td>'+(n<=0?'<span class="pill p-bad">Sold out</span>':n<=LOW_STOCK?'<span class="pill p-warn">Reorder</span>':'<span class="pill p-ok">OK</span>')+'</td>'+
      '<td><div class="rcv"><label class="sr" for="rcv-'+esc(p.sku)+'">Units received for '+esc(p.sku)+'</label><input id="rcv-'+esc(p.sku)+'" type="number" min="1" max="1000" value="10"><button class="btn ghost sm" type="button" data-act="restock" data-sku="'+esc(p.sku)+'">Receive</button></div></td></tr>';}).join('')+'</tbody></table></div>';
}
function viewOrders(){
  const f=[['all','All'],['new','To pack'],['shipped','Shipped'],['delivered','Delivered'],['cancelled','Cancelled']];
  return '<div><div class="pagehead"><h1 style="font-size:clamp(1.7rem,3.4vw,2.4rem)">Orders</h1>'+
    '<dl class="kpis"><div><dt>To pack</dt><dd>'+toPack().length+'</dd></div><div><dt>In transit</dt><dd>'+DATA.orders.filter(o=>o.status==='shipped').length+'</dd></div><div><dt>Open returns</dt><dd>'+openReturns().length+'</dd></div><div><dt>Low stock</dt><dd>'+lowStock().length+'</dd></div></dl></div>'+
    '<div class="ops"><div class="panel"><div class="filters">'+f.map(([k,l])=>'<button class="chip" type="button" data-act="filter" data-f="'+k+'" aria-pressed="'+(ui.filter===k)+'">'+l+'</button>').join('')+
      '<label class="sr" for="q">Search orders</label><input id="q" type="text" placeholder="Search name, order, country" value="'+esc(ui.q)+'"></div><div id="otable">'+orderTable()+'</div>'+
      '<p style="margin-top:.8rem"><a class="btn ghost sm" href="/api/admin/orders.csv">Export all orders as CSV</a></p></div>'+
    '<div id="odetail">'+orderDetail()+'</div></div></div>'+
    '<section><h2 style="margin-bottom:.8rem">Stock</h2><div class="panel" id="stock">'+stockTable()+'</div></section>';
}

function packState(o){ return ui.pack[o.id]||(ui.pack[o.id]={carrier:(o.tracking&&o.tracking.carrier)||COUNTRIES[o.customer.country].carrier,no:''}); }
function packKeys(o){ return R.packKeys(o.items,sku=>!!(AM[sku]&&AM[sku].diverter)); }
const packDone=o=>packKeys(o).filter(k=>o.pack[k]).length;
function packCard(o){
  const c=o.customer, keys=packKeys(o), kg=R.weightKg(o.items,s=>AM[s].grams), done=packDone(o), age=Date.now()-o.created, ps=packState(o);
  const lang=COUNTRIES[c.country].lang;
  const text={test:'Bench test: self-test LED sequence finishes and the relay clicks on the 1 s pulse',doc:'Quick-start guide in '+lang+' added',label:'Parcel label stuck on ('+kg.toFixed(1).replace('.',',')+' kg, '+R.tier(kg)+')'};
  const items=keys.map(k=>{
    let label,bin='';
    if(k.startsWith('pick:')){ const sku=k.slice(5), it=o.items.find(i=>i.sku===sku); label=it.qty+' × '+esc(AM[sku].name); bin='<span class="bin">Bin '+esc(AM[sku].bin)+'</span>'; }
    else label=esc(text[k]);
    return '<li><label><input type="checkbox" data-pack="'+esc(o.id)+'" data-key="'+esc(k)+'"'+(o.pack[k]?' checked':'')+'><span class="t">'+label+'</span>'+bin+'</label></li>';
  }).join('');
  return '<article class="card" id="pk-'+esc(o.id)+'" data-total="'+keys.length+'"><header><div><h2 style="font-size:1.3rem">'+esc(o.id)+'</h2><p class="meta">'+esc(c.name)+', '+esc(c.city)+', '+esc(COUNTRIES[c.country].name)+'</p></div>'+
    '<div style="display:grid;gap:.4rem;justify-items:end">'+(age>24*H?'<span class="pill p-warn">Waiting '+Math.round(age/H)+' h</span>':'<span class="pill p-info">Placed '+ago(o.created)+'</span>')+
    '<div class="prog"><div class="bar"><i data-bar style="width:'+(done/keys.length*100)+'%"></i></div><span data-prog>'+done+' of '+keys.length+' done</span></div></div></header>'+
    '<ul class="checks">'+items+'</ul>'+
    '<div class="shipform"><label class="f">Carrier<select data-carrier="'+esc(o.id)+'">'+CARRIERS.map(x=>'<option'+(x===ps.carrier?' selected':'')+'>'+esc(x)+'</option>').join('')+'</select></label>'+
    '<label class="f">Tracking number<input type="text" data-track="'+esc(o.id)+'" autocomplete="off" placeholder="8 to 24 letters or digits" value="'+esc(ps.no)+'"></label>'+
    '<button class="btn" type="button" data-act="ship" data-id="'+esc(o.id)+'" disabled>Mark as shipped</button></div>'+
    '<p><a class="small" href="/admin/orders/'+encodeURIComponent(o.id)+'/slip" target="_blank" rel="noopener">Open packing slip</a></p></article>';
}
function viewPacking(){
  const q=toPack();
  return '<div><div class="pagehead"><h1 style="font-size:clamp(1.7rem,3.4vw,2.4rem)">Packing</h1><p class="muted">Oldest order first. Tick every step and add the tracking number to ship.</p></div>'+
    (q.length?'<div class="pack">'+q.map(packCard).join('')+'</div>':'<div class="panel empty"><b>Nothing to pack</b>New orders from the shop show up here. Place one in the shop to try it.</div>')+'</div>';
}
function refreshPackCard(id){
  const card=$('#pk-'+id), o=orderById(id); if(!card||!o) return;
  const total=+card.dataset.total, done=packDone(o);
  $('[data-prog]',card).textContent=done+' of '+total+' done';
  $('[data-bar]',card).style.width=(done/total*100)+'%';
  $('[data-act=ship]',card).disabled=!(done===total&&R.trackingOk($('[data-track]',card).value));
}

const itemsText=r=>r.items.map(i=>i.qty+' × '+esc(AM[i.sku]?AM[i.sku].name:i.sku)).join(', ');
function rmaCard(r){
  const o=orderById(r.orderId), w=windowOf(o), val=returnValue(r), c=o.customer;
  const wid=r.reason===REASONS[0]&&!w.open?'<span class="pill p-bad">Outside withdrawal window</span>':'<span class="pill '+(w.open?'p-ok':'p-mute')+'">'+esc(w.text)+'</span>';
  let body='';
  if(r.status==='requested') body='<div class="actions"><button class="btn sm" type="button" data-act="rma-received" data-id="'+esc(r.id)+'">Mark parcel received</button><button class="btn danger sm" type="button" data-act="rma-reject" data-id="'+esc(r.id)+'">'+(ui.confirm==='rej:'+r.id?'Confirm reject':'Reject return')+'</button></div>';
  if(r.status==='received') body='<div class="inspect"><b>Inspection</b><fieldset><legend class="sr">Condition</legend>'+
    '<label class="opt"><input type="radio" name="cond-'+esc(r.id)+'" value="resellable" checked><span class="grow">Resellable, goes back to stock</span></label>'+
    '<label class="opt"><input type="radio" name="cond-'+esc(r.id)+'" value="scrap"><span class="grow">Not resellable, scrap</span></label></fieldset>'+
    '<div class="row"><label class="f">Refund in EUR (max '+eur(val)+')<input type="number" id="ref-'+esc(r.id)+'" min="0" max="'+(val/100)+'" step="0.01" value="'+(val/100).toFixed(2)+'"></label><div></div></div>'+
    '<div class="err" id="ref-err-'+esc(r.id)+'" role="alert"></div>'+
    '<div class="actions"><button class="btn sm" type="button" data-act="rma-refund" data-id="'+esc(r.id)+'">Refund and close</button><button class="btn danger sm" type="button" data-act="rma-reject" data-id="'+esc(r.id)+'">'+(ui.confirm==='rej:'+r.id?'Confirm reject':'Reject return')+'</button></div></div>';
  if(r.status==='refunded') body='<p class="small">'+(r.condition==='resellable'?'Restocked':'Scrapped')+'. Refunded '+eur(r.refund)+'.</p>';
  return '<article class="card rma"><header><div><h2 style="font-size:1.2rem">'+esc(r.id)+'</h2><p class="meta">Order '+esc(o.id)+' · '+esc(c.name)+' · '+ago(r.created)+'</p></div>'+pill(r.status)+'</header>'+
    '<p>'+itemsText(r)+'</p><div class="actions"><span class="pill p-mute">'+esc(r.reason)+'</span>'+wid+(r.source==='customer'?'<span class="pill p-info">Requested by customer</span>':'')+'</div>'+body+
    '<ul class="timeline">'+r.log.slice().reverse().map(l=>'<li><time>'+dtFmt.format(l.t)+'</time><span>'+esc(l.m)+'</span></li>').join('')+'</ul></article>';
}
function viewReturns(){
  const open=openReturns().sort((a,b)=>a.created-b.created), closed=DATA.returns.filter(r=>r.status==='refunded'||r.status==='rejected').sort((a,b)=>b.created-a.created);
  return '<div><div class="pagehead"><h1 style="font-size:clamp(1.7rem,3.4vw,2.4rem)">Returns</h1><button class="btn" type="button" data-act="new-return" data-id="">New return</button></div>'+
    '<h2 style="margin-bottom:.8rem">Needs action</h2>'+
    (open.length?'<div class="cols">'+open.map(rmaCard).join('')+'</div>':'<div class="panel empty"><b>No open returns</b>Customers can start one on the Track order page, or you can start one from an order.</div>')+
    (closed.length?'<h2 style="margin:2rem 0 .8rem">Closed</h2><div class="cols">'+closed.map(rmaCard).join('')+'</div>':'')+'</div>';
}
function viewOutbox(){
  const m=DATA.outbox;
  return '<div><div class="pagehead"><h1 style="font-size:clamp(1.7rem,3.4vw,2.4rem)">Emails</h1><p class="muted">Customer emails are written here instead of being sent. Open one to read it.</p></div>'+
    (m.length?'<div class="panel">'+m.map(x=>'<details class="mail"><summary><time class="muted small">'+dtFmt.format(x.t)+'</time><span><b>'+esc(x.subject)+'</b> <span class="muted small">to '+esc(x.to)+'</span></span></summary><pre>'+esc(x.body)+'</pre></details>').join('')+'</div>':'<div class="panel empty"><b>No emails yet</b>Order confirmations, shipping notices and refund notices appear here.</div>')+'</div>';
}

/* ---------- dialogs ---------- */
function sumHtml(country){
  const t=R.totals(cartItems(),country);
  return '<div><span>Items</span><span>'+eur(t.sub)+'</span></div><div><span>Shipping to '+esc(COUNTRIES[country].name)+'</span><span>'+(t.ship?eur(t.ship):'Free')+'</span></div><div class="big"><span>Total</span><span>'+eur(t.total)+'</span></div><div class="muted small"><span>incl. '+Math.round(t.rate*100)+'% VAT</span><span>'+eur(t.vat)+'</span></div>';
}
function cartHtml(){
  const head='<header><h2 id="cart-h">'+(ui.cartStep==='done'?'Order placed':ui.cartStep==='details'?'Delivery and payment':'Your cart')+'</h2><button class="btn ghost sm" type="button" data-act="cart-close" aria-label="Close cart">Close</button></header>';
  if(ui.cartStep==='done'){
    const o=ui.lastOrder;
    return '<div class="dlg">'+head+'<p><b>'+esc(o.id)+'</b> is in the packing queue. We sent a confirmation to '+esc(o.email)+' (see the Emails page).</p><p class="muted small">Demo only: no payment was taken.</p><div class="actions"><button class="btn" type="button" data-act="track-order">Track this order</button><button class="btn ghost" type="button" data-act="cart-close">Keep shopping</button></div></div>';
  }
  const items=cartItems();
  if(!items.length) return '<div class="dlg">'+head+'<div class="empty" style="padding:.4rem 0"><b>Your cart is empty</b>Add the Diverter 3 and a sensor to get started.</div><div class="actions"><button class="btn" type="button" data-act="cart-close">Back to shop</button></div></div>';
  if(ui.cartStep==='details'){
    const c=ui.cartCountry;
    return '<div class="dlg">'+head+'<form id="co" novalidate><div class="grid2">'+
      '<label class="f wide" for="f-name">Full name<input id="f-name" type="text" autocomplete="name" maxlength="80"><span class="err" id="e-name"></span></label>'+
      '<label class="f wide" for="f-email">Email<input id="f-email" type="email" autocomplete="email" maxlength="120"><span class="err" id="e-email"></span></label>'+
      '<label class="f wide" for="f-street">Street and number<input id="f-street" type="text" autocomplete="address-line1" maxlength="100"><span class="err" id="e-street"></span></label>'+
      '<label class="f" for="f-country">Country<select id="f-country">'+Object.keys(COUNTRIES).map(k=>'<option value="'+k+'"'+(k===c?' selected':'')+'>'+esc(COUNTRIES[k].name)+'</option>').join('')+'</select></label>'+
      '<label class="f" for="f-zip">Postcode<input id="f-zip" type="text" autocomplete="postal-code" maxlength="10"><span class="err" id="e-zip"></span></label>'+
      '<label class="f wide" for="f-city">City<input id="f-city" type="text" autocomplete="address-level2" maxlength="60"><span class="err" id="e-city"></span></label>'+
      '<label class="f wide" for="f-pay">Payment<select id="f-pay">'+R.PAYMENTS.map(x=>'<option>'+esc(x)+'</option>').join('')+'</select></label>'+
      '<div class="wide"><label class="opt" for="f-terms"><input id="f-terms" type="checkbox"><span class="grow small">I have read the cancellation policy (Widerrufsbelehrung). I can withdraw within '+WIDERRUF_DAYS+' days of delivery.</span></label><span class="err" id="e-terms"></span></div>'+
      '</div><div class="sum" id="sum" style="margin:1rem 0">'+sumHtml(c)+'</div><div class="err" id="e-form" role="alert"></div>'+
      '<div class="actions"><button class="btn" type="submit" id="place">Place order (demo)</button><button class="btn ghost" type="button" data-act="cart-back">Back to cart</button></div></form></div>';
  }
  const lines=items.map(l=>{const p=PM[l.sku];return '<div class="cartline"><div><b>'+esc(p.name)+'</b><div class="muted small">'+eur(p.price)+' each</div></div>'+
    '<div class="qty"><button type="button" data-act="qty" data-sku="'+l.sku+'" data-d="-1" aria-label="One fewer">−</button><span>'+l.qty+'</span><button type="button" data-act="qty" data-sku="'+l.sku+'" data-d="1" aria-label="One more"'+(l.qty>=Math.min(p.stock,R.MAX_QTY)?' disabled':'')+'>+</button></div>'+
    '<b>'+eur(p.price*l.qty)+'</b></div>';}).join('');
  return '<div class="dlg">'+head+'<div>'+lines+'</div><div class="sum">'+sumHtml(ui.cartCountry)+'</div><p class="muted small">Shipping and VAT are recalculated for your country at the next step.</p><div class="actions"><button class="btn" type="button" data-act="checkout">Continue to checkout</button><button class="btn ghost" type="button" data-act="cart-close">Keep shopping</button></div></div>';
}
async function openCart(step){
  if(step) ui.cartStep=step;
  if(ui.cartStep!=='done') await loadProducts();
  $('#cart').innerHTML=cartHtml();
  const d=$('#cart'); if(!d.open) d.showModal();
  bindCheckout(); updateChrome();
}
const FIELDS=['name','email','street','zip','city','terms'];
function showErrors(errs){
  FIELDS.forEach(k=>{ const e=$('#e-'+k); if(e) e.textContent=errs[k]||''; });
  const first=FIELDS.find(k=>errs[k]); const el=first&&$('#f-'+first); if(el) el.focus();
}
function bindCheckout(){
  const f=$('#co'); if(!f) return;
  $('#f-country').addEventListener('change',e=>{ ui.cartCountry=e.target.value; $('#sum').innerHTML=sumHtml(ui.cartCountry); });
  f.addEventListener('submit',async e=>{
    e.preventDefault();
    if(ui.busy) return;
    const cust={name:$('#f-name').value,email:$('#f-email').value,street:$('#f-street').value,zip:$('#f-zip').value,city:$('#f-city').value,country:$('#f-country').value};
    const v=R.validateCustomer(cust), errs=Object.assign({},v.errors);
    if(!$('#f-terms').checked) errs.terms='Confirm that you have read the cancellation policy.';
    showErrors(errs); $('#e-form').textContent='';
    if(Object.keys(errs).length) return;
    ui.busy=true; $('#place').disabled=true;
    try{
      const res=await api('POST','/api/orders',{items:cart.map(c=>({sku:c.sku,qty:c.qty})),customer:v.value,payment:$('#f-pay').value,terms:true});
      cart=[]; saveCart(); ui.lastOrder=res; ui.trackForm={id:res.id,email:res.email}; ui.tracked=null; ui.trackErr='';
      ui.cartStep='done'; await loadProducts(); updateChrome(); await openCart();
    }catch(err){
      if(err.fields) showErrors(err.fields);
      $('#e-form').textContent=err.message+(err.status===409?' Go back to the cart and adjust it.':'');
      if(err.status===409) await loadProducts();
    }finally{ ui.busy=false; const b=$('#place'); if(b) b.disabled=false; }
  });
}
function openRma(orderId){
  const eligible=DATA.orders.filter(o=>o.status==='shipped'||o.status==='delivered');
  const d=$('#rma-dlg');
  if(!eligible.length){ d.innerHTML='<div class="dlg"><header><h2 id="rma-h">New return</h2><button class="btn ghost sm" type="button" data-act="rma-close">Close</button></header><div class="empty" style="padding:0"><b>No shipped orders yet</b>Ship an order first, then start a return from it.</div></div>'; d.showModal(); return; }
  const sel=orderId&&eligible.find(o=>o.id===orderId)?orderId:eligible[0].id;
  d.innerHTML='<div class="dlg"><header><h2 id="rma-h">New return</h2><button class="btn ghost sm" type="button" data-act="rma-close">Close</button></header>'+
    '<form id="rma-form" novalidate><label class="f" for="rma-order">Order<select id="rma-order">'+eligible.map(o=>'<option value="'+esc(o.id)+'"'+(o.id===sel?' selected':'')+'>'+esc(o.id)+' · '+esc(o.customer.name)+'</option>').join('')+'</select></label>'+
    '<div id="rma-items" style="margin:1rem 0"></div>'+
    '<label class="f" for="rma-reason">Reason<select id="rma-reason">'+REASONS.map(r=>'<option>'+esc(r)+'</option>').join('')+'</select></label>'+
    '<p class="small" id="rma-w" style="margin-top:.8rem"></p><div class="err" id="rma-err" role="alert"></div>'+
    '<div class="actions" style="margin-top:.6rem"><button class="btn" type="submit">Create return</button><button class="btn ghost" type="button" data-act="rma-close">Cancel</button></div></form></div>';
  function fill(){
    const o=orderById($('#rma-order',d).value), w=windowOf(o);
    $('#rma-items',d).innerHTML='<b class="small">Items to return</b>'+o.items.map(i=>{ const max=returnableQty(o,i.sku); return '<label class="f" style="grid-template-columns:minmax(0,1fr) 5rem;align-items:center;margin-top:.4rem" for="rq-'+esc(i.sku)+'"><span>'+esc(AM[i.sku].name)+' <span class="muted small">(up to '+max+')</span></span><input id="rq-'+esc(i.sku)+'" data-rq="'+esc(i.sku)+'" type="number" min="0" max="'+max+'" value="0"'+(max<=0?' disabled':'')+'></label>'; }).join('');
    $('#rma-w',d).innerHTML='Withdrawal window: <b>'+esc(w.text)+'</b>';
  }
  $('#rma-order',d).addEventListener('change',fill); fill();
  $('#rma-form',d).addEventListener('submit',async e=>{
    e.preventDefault();
    const o=orderById($('#rma-order',d).value);
    const items=$$('[data-rq]',d).map(i=>({sku:i.dataset.rq,qty:parseInt(i.value,10)||0})).filter(i=>i.qty>0);
    if(!items.length){ $('#rma-err',d).textContent='Set a quantity of at least 1 for one item.'; return; }
    for(const it of items){ const max=returnableQty(o,it.sku); if(it.qty>max){ $('#rma-err',d).textContent='You can return at most '+max+' of '+AM[it.sku].name+'.'; return; } }
    try{ const r=await api('POST','/api/admin/returns',{orderId:o.id,items,reason:$('#rma-reason',d).value}); d.close(); flash(r.id+' created'); location.hash='#returns'; await go(); }
    catch(err){ $('#rma-err',d).textContent=err.message; }
  });
  if(!d.open) d.showModal();
}

/* ---------- chrome, render, events ---------- */
let toastT;
function flash(msg){ const t=$('#toast'); t.textContent=msg; t.hidden=false; clearTimeout(toastT); toastT=setTimeout(()=>{t.hidden=true;},3200); }
function route(){ const h=location.hash.slice(1); return ['shop','track'].concat(OPS).includes(h)?h:'shop'; }
function updateChrome(){
  const r=route();
  $$('[data-nav]').forEach(a=>{ if(a.dataset.nav===r) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current'); });
  const set=(id,n)=>{ const e=$(id); e.textContent=n; e.hidden=!n; };
  set('#n-pack',auth&&DATA?toPack().length:0); set('#n-ret',auth&&DATA?openReturns().length:0);
  $('#n-cart').textContent=cart.reduce((a,c)=>a+c.qty,0);
  $('#logout').hidden=!auth;
}
async function render(){
  const r=route(), app=$('#app'), seq=++renderSeq;
  if(OPS.includes(r)){
    if(!auth){ app.innerHTML=viewLogin(); bindLogin(); updateChrome(); return; }
    if(!DATA){ app.innerHTML='<p class="muted">Loading…</p>'; try{ await loadAdmin(); }catch(e){ if(!auth) return render(); app.innerHTML='<div class="panel empty"><b>Could not load the back office</b>'+esc(e.message)+'</div>'; return; } if(seq!==renderSeq) return; }
  }
  app.innerHTML=r==='shop'?viewShop():r==='track'?viewTrack():r==='orders'?viewOrders():r==='packing'?viewPacking():r==='returns'?viewReturns():viewOutbox();
  updateChrome();
  if(r==='shop') initShop();
  if(r==='track') bindTrack();
  if(r==='orders'){ const q=$('#q'); q.addEventListener('input',()=>{ ui.q=q.value; $('#otable').innerHTML=orderTable(); }); }
  if(r==='packing') toPack().forEach(o=>refreshPackCard(o.id));
}
function handleErr(e){
  if(e.status===401){ auth=false; DATA=null; flash('Your session ended. Log in again.'); }
  else flash(e.message);
}
// Reload what the current route needs, then draw it.
async function go(){
  const r=route();
  if(r==='shop') await loadProducts();
  if(OPS.includes(r)&&auth){ try{ await loadAdmin(); }catch(e){ handleErr(e); } }
  await render();
}
async function act(fn,okMsg){
  try{ await fn(); if(okMsg) flash(okMsg); }catch(e){ handleErr(e); }
  await go();
}
const post=(url,body)=>api('POST',url,body||{});

document.addEventListener('click',async e=>{
  if(e.target.tagName==='DIALOG'&&(e.target.id==='cart'||e.target.id==='rma-dlg')){ e.target.close(); return; }
  const rowEl=e.target.closest('tr[data-row]');
  const el=e.target.closest('[data-act]');
  if(!el){ if(rowEl&&!e.target.closest('button')){ ui.orderSel=rowEl.dataset.row; $('#otable').innerHTML=orderTable(); $('#odetail').innerHTML=orderDetail(); } return; }
  const a=el.dataset.act, id=el.dataset.id, sku=el.dataset.sku;
  const keep=ui.confirm; ui.confirm='';
  switch(a){
    case 'add':
      if(addToCart(sku)){ updateChrome(); const m=$('#p-msg'); if(m&&el.id==='p-add') m.textContent='Added to cart'; flash(PM[sku].name+' added to cart'); }
      else flash('No more '+(PM[sku]?PM[sku].name:'of this item')+' in stock'); break;
    case 'retry': await go(); break;
    case 'cart-open': ui.cartStep='cart'; await openCart(); break;
    case 'cart-close': $('#cart').close(); break;
    case 'checkout': await openCart('details'); break;
    case 'cart-back': await openCart('cart'); break;
    case 'track-order': $('#cart').close(); location.hash='#track'; await lookupOrder(ui.trackForm.id,ui.trackForm.email); await render(); break;
    case 'qty': { const l=cart.find(c=>c.sku===sku); if(l){ l.qty+=+el.dataset.d; if(l.qty<=0) cart=cart.filter(c=>c!==l); saveCart(); await openCart(); } break; }
    case 'logout': auth=false; DATA=null; ui.orderSel=null; await post('/api/admin/logout').catch(()=>{}); flash('Logged out'); if(location.hash==='#shop') await render(); else location.hash='#shop'; break;
    case 'sel-order': ui.orderSel=id; $('#otable').innerHTML=orderTable(); $('#odetail').innerHTML=orderDetail(); break;
    case 'filter': ui.filter=el.dataset.f; await render(); break;
    case 'cancel': if(keep==='cancel:'+id) await act(()=>post('/api/admin/orders/'+id+'/cancel'),id+' cancelled, stock released'); else { ui.confirm='cancel:'+id; $('#odetail').innerHTML=orderDetail(); } break;
    case 'deliver': await act(()=>post('/api/admin/orders/'+id+'/deliver'),id+' marked delivered'); break;
    case 'restock': { const n=parseInt($('#rcv-'+sku).value,10); await act(()=>post('/api/admin/stock/'+encodeURIComponent(sku)+'/receive',{qty:n}),'Received '+n+' × '+sku); break; }
    case 'ship': { const st=ui.pack[id]; await act(async()=>{ await post('/api/admin/orders/'+id+'/ship',{carrier:st.carrier,tracking:st.no}); delete ui.pack[id]; },id+' shipped'); break; }
    case 'new-return': openRma(id); break;
    case 'rma-close': $('#rma-dlg').close(); break;
    case 'rma-received': await act(()=>post('/api/admin/returns/'+id+'/receive')); break;
    case 'rma-refund': {
      const inp=$('#ref-'+id), err=$('#ref-err-'+id), eurVal=parseFloat(inp.value);
      if(!(eurVal>=0)){ err.textContent='Enter the refund amount in EUR.'; inp.focus(); break; }
      const cond=$('input[name="cond-'+id+'"]:checked').value;
      try{ await post('/api/admin/returns/'+id+'/refund',{resellable:cond==='resellable',amount:Math.round(eurVal*100)}); flash(id+' refunded'); await go(); }
      catch(ex){ if(ex.status===401){ handleErr(ex); await go(); } else { err.textContent=ex.message; inp.focus(); } }
      break; }
    case 'rma-reject':
      if(keep==='rej:'+id) await act(()=>post('/api/admin/returns/'+id+'/reject'),id+' rejected');
      else { ui.confirm='rej:'+id; await render(); } break;
  }
});
document.addEventListener('change',async e=>{
  const t=e.target;
  if(t.matches('[data-pack]')){
    const o=orderById(t.dataset.pack), key=t.dataset.key, on=t.checked;
    if(on) o.pack[key]=true; else delete o.pack[key];
    refreshPackCard(o.id);
    try{ await post('/api/admin/orders/'+o.id+'/pack',{key,checked:on}); }catch(err){ handleErr(err); await go(); }
  }
  if(t.matches('[data-carrier]')){ packState(orderById(t.dataset.carrier)).carrier=t.value; }
});
document.addEventListener('input',e=>{
  if(e.target.matches('[data-track]')){ const id=e.target.dataset.track; packState(orderById(id)).no=e.target.value; refreshPackCard(id); }
});
window.addEventListener('hashchange',()=>{ ui.confirm=''; go(); });
$('#cart').addEventListener('close',async()=>{
  if(ui.cartStep==='done') ui.cartStep='cart';
  if(route()==='shop'){ await loadProducts(); if($('#p-stock')){ $('#p-stock').innerHTML=stockLabel(ui.variant); const b=$('#p-add'); if(b) b.disabled=PM[ui.variant].stock<=0; const pp=$('.parts'); if(pp) pp.innerHTML=partsHtml(); } }
  updateChrome();
});

// Back office stays fresh: poll every 20 s while the tab is visible and nobody is typing.
let sig='';
const signature=()=>JSON.stringify([DATA.orders.map(o=>o.id+o.status),DATA.returns.map(r=>r.id+r.status),DATA.products.map(p=>p.stock)]);
setInterval(async()=>{
  if(!auth||document.hidden||!OPS.includes(route())||!DATA) return;
  const had=new Set(DATA.orders.map(o=>o.id));
  try{ await loadAdmin(); }catch(e){ if(e.status===401){ handleErr(e); await render(); } return; }
  const s=signature(); updateChrome();
  const fresh=DATA.orders.filter(o=>!had.has(o.id));
  if(fresh.length) flash('New order '+fresh[0].id+(fresh.length>1?' and '+(fresh.length-1)+' more':''));
  const a=document.activeElement, typing=a&&/^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName);
  if(s!==sig&&!typing&&!$('dialog[open]')){ sig=s; await render(); } else sig=s;
},20000);

(async function start(){
  try{ auth=(await api('GET','/api/admin/me')).admin; }catch(e){ auth=false; }
  await loadProducts();
  if(auth&&OPS.includes(route())){ try{ await loadAdmin(); }catch(e){} }
  await render();
  if(DATA) sig=signature();
})();
})();
