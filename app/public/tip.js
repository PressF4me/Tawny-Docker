// Support Tawny. The sheet opens on a small hub — a coffee on Ko-fi, or a tip
// in Bitcoin — the same shape as Nudge's Support box, in Tawny's own clothes.
//
// Tip in Bitcoin, over Lightning. The Lightning page offers $2 / $5 / $10 or a typed
// amount; Tawny asks the Lightning Address's LNURL-pay service (Strike) for an
// invoice of exactly that, so any wallet can pay it — scanned from a phone, or
// opened in a wallet on this device. No wallet at all? strike.me takes it in
// the browser. Tawny never holds a key, a balance or a satoshi.
//
// Knowing the tip landed: the invoice is requested as a Nostr "zap" (NIP-57)
// under a throwaway key made for this one tip. Once it's paid, Strike publishes
// a receipt signed with its own key to the relays named in the request; the
// sheet listens for a receipt carrying exactly this invoice, checks the id and
// the signature, and turns into a thank-you. Nothing is sent anywhere but the
// tip service, the price API and those relays.

import qrcode from './vendor/qrcode.mjs';
import { schnorr, hashes, utils } from './vendor/secp256k1.mjs';
import { sha256 } from './sha256.js';

hashes.sha256 = sha256;

export const LN_ADDRESS = 'loustrikes@strike.me';
export const LN_WEB = 'https://strike.me/@loustrikes';
const LNURLP = 'https://strike.me/.well-known/lnurlp/loustrikes';
const PRICE = 'https://api.coinbase.com/v2/prices/BTC-USD/spot';
// Also listed in each platform's connect-src (LocalWeb.kt, config.rs, server.js).
export const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.snort.social'];
const LISTEN_MS = 20 * 60 * 1000;
const USD = [2, 5, 10];
const SATS_IF_OFFLINE = [2000, 5000, 10000];

const $ = (s) => document.querySelector(s);
const t = (k, ...a) => (window.TawnyT ? window.TawnyT.t(k, ...a) : k);
const enc = new TextEncoder();
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s) => Uint8Array.from(s.match(/../g) || [], (h) => parseInt(h, 16));

// ---- nostr -------------------------------------------------------------------------------

function eventId(ev) {
  return sha256(enc.encode(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content])));
}

function signed(priv, kind, tags, content) {
  const ev = { pubkey: hex(schnorr.getPublicKey(priv)), created_at: Math.floor(Date.now() / 1000), kind, tags, content };
  const id = eventId(ev);
  return { ...ev, id: hex(id), sig: hex(schnorr.sign(id, priv, crypto.getRandomValues(new Uint8Array(32)))) };
}

/** The paid receipt for this invoice: right kind, right signer, our tag, our invoice, valid id + signature. */
export function isReceipt(ev, watch) {
  try {
    const tag = (n) => (ev.tags || []).find((x) => Array.isArray(x) && x[0] === n)?.[1];
    if (ev.kind !== 9735 || String(ev.pubkey).toLowerCase() !== watch.signer) return false;
    if (tag('p') !== watch.tag || String(tag('bolt11') || '').toLowerCase() !== watch.invoice.toLowerCase()) return false;
    const id = eventId(ev);
    return hex(id) === ev.id && schnorr.verify(unhex(ev.sig), id, unhex(ev.pubkey));
  } catch { return false; }
}

// ---- the tip service ---------------------------------------------------------------------

let price = null; // dollars per bitcoin

async function getJson(url) {
  const r = await fetch(url, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

/** An invoice for `sats`, asked for as a zap when the service takes them. */
export async function invoiceFor(sats) {
  const pay = await getJson(LNURLP);
  const msats = sats * 1000;
  if (!String(pay.callback || '').startsWith('https://')) throw new Error('callback');
  if (msats < (pay.minSendable ?? 1000) || msats > (pay.maxSendable ?? Infinity)) throw new Error('range');
  const base = pay.callback + (pay.callback.includes('?') ? '&' : '?') + 'amount=' + msats;
  if (pay.allowsNostr && /^[0-9a-f]{64}$/i.test(pay.nostrPubkey || '')) {
    const priv = utils.randomSecretKey();
    const tag = hex(schnorr.getPublicKey(priv));
    // The zap note Strike sees, not UI.  taste-skill-ignore
    const zap = signed(priv, 9734, [['relays', ...RELAYS], ['amount', String(msats)], ['p', tag]], 'A tip for Tawny ⚡'); // taste-skill-ignore
    try {
      const inv = await getJson(base + '&nostr=' + encodeURIComponent(JSON.stringify(zap)));
      if (/^lnbc/i.test(inv.pr || '')) return { pr: inv.pr, watch: { invoice: inv.pr, tag, signer: pay.nostrPubkey.toLowerCase() } };
    } catch { /* fall back to a plain invoice */ }
  }
  const inv = await getJson(base);
  if (!/^lnbc/i.test(inv.pr || '')) throw new Error(inv.reason || 'no invoice');
  return { pr: inv.pr, watch: null };
}

/** Resolve when the receipt for `watch` shows up on any relay; `stop()` ends it quietly. */
function listen(watch) {
  let done = false, sockets = [], timer, resolveIt;
  const finish = (paid) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    sockets.forEach((s) => { try { s.close(); } catch {} });
    resolveIt(paid);
  };
  const since = Math.floor(Date.now() / 1000) - 120;
  const drops = {};
  const open = (url) => {
    if (done) return;
    let ws;
    try { ws = new WebSocket(url); } catch { return; }
    sockets.push(ws);
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'tip', { kinds: [9735], '#p': [watch.tag], since }]));
    ws.onmessage = (m) => {
      try {
        const v = JSON.parse(m.data);
        if (v[0] === 'EVENT' && isReceipt(v[2], watch)) finish(true);
      } catch {}
    };
    // relays drop idle sockets; back off on one that keeps dropping (5s … 60s)
    ws.onclose = () => {
      if (done) return;
      drops[url] = (drops[url] || 0) + 1;
      setTimeout(() => open(url), Math.min(60000, 5000 * 2 ** Math.min(drops[url] - 1, 4)));
    };
  };
  const promise = new Promise((r) => { resolveIt = r; });
  RELAYS.forEach(open);
  timer = setTimeout(() => finish(false), LISTEN_MS);
  return { promise, stop: () => finish(false) };
}

// ---- the sheet ---------------------------------------------------------------------------

const S = { pick: 0, ticket: 0, invoice: '', listener: null, open: null, close: null, noWallet: false, made: null, toast: null, mode: 'web' };

// ---- where invoices come from -------------------------------------------------------------
//
// 'web'     this page asks Strike and the relays itself (Desktop, Docker, browsers);
// 'native'  the Android app does, through window.TawnySupport (TipZap.kt): the WebView's
//           CSP stays as narrow as the live view's;
// 'handoff' the Play build: the address only — Open wallet, a QR of the address,
//           strike.me. No amounts, no invoice, nothing fetched (Play Payments policy).

export function setTipMode(mode) { S.mode = mode; }

const native = () => window.TawnySupport;
let nativeSeq = 0;
const nativeWait = new Map();
const nativeCall = (fn, ...args) => new Promise((resolve, reject) => {
  const id = ++nativeSeq;
  nativeWait.set(id, { resolve, reject });
  setTimeout(() => { if (nativeWait.delete(id)) reject(new Error('timeout')); }, 20000);
  native()[fn](id, ...args);
});
window.tawnyTipPrice = (id, usd) => { nativeWait.get(id)?.resolve(usd); nativeWait.delete(id); };
window.tawnyTipInvoice = (id, pr, err) => {
  const w = nativeWait.get(id); nativeWait.delete(id);
  if (!w) return;
  pr ? w.resolve(pr) : w.reject(new Error(err || 'no invoice'));
};
const nativePaid = new Map();
window.tawnyTipPaid = (id) => { nativePaid.get(id)?.(true); nativePaid.delete(id); };

async function fetchPrice() {
  if (S.mode === 'native') return nativeCall('price').then((p) => (p > 0 ? p : null)).catch(() => null);
  try { const p = parseFloat((await getJson(PRICE)).data.amount); return p > 0 ? p : null; } catch { return null; }
}

/** An invoice and, when it is a zap, a way to hear it paid: { pr, listener|null }. */
async function makeInvoice(sats) {
  if (S.mode === 'native') {
    const id = nativeSeq + 1;
    const pr = await nativeCall('invoice', sats);
    let done;
    const promise = new Promise((r) => { done = r; nativePaid.set(id, r); });
    return { pr, listener: { promise, stop: () => { nativePaid.delete(id); done(false); try { native().stop(); } catch {} } } };
  }
  const { pr, watch } = await invoiceFor(sats);
  return { pr, listener: watch ? listen(watch) : null };
}
const toSats = (usd) => Math.max(1, Math.round((usd / price) * 1e8));
const amountAt = (i) => (price ? { usd: USD[i], sats: toSats(USD[i]) } : { usd: null, sats: SATS_IF_OFFLINE[i] });
const fmtSats = (n) => t('w_tip_sats', n.toLocaleString());
const fmtUsd = (u) => '$' + (Number.isInteger(u) ? u : u.toFixed(2));

function otherAmount() {
  const v = Math.round(parseFloat(String($('#tip-other-input').value).replace(',', '.')) * 100) / 100;
  if (!(v > 0)) return null;
  return price ? { usd: v, sats: toSats(v) } : { usd: null, sats: Math.round(v) };
}

function stopListening() {
  S.ticket++;
  S.listener?.stop();
  S.listener = null;
}

/**
 * The invoice as a QR that looks like it belongs to Tawny: round-cornered dots
 * in warm ink on cream, the three finder eyes as soft rounded squares in berry
 * and sky, and a small patch in the middle left clear for the bolt badge.
 * Level M, like the plain code before it: Q's denser grid read worse from a
 * distance than M with this patch missing. Dots fill 92% of their cell — at
 * 84% the code stopped reading below ~160px in testing; at 92% it reads as
 * far down as the plain square code did.
 * The dots are wrapped in one group the stylesheet reveals from the centre.
 */
function qrSvg(text) {
  const qr = qrcode(0, 'M');
  // Invoices fit QR's compact alphanumeric set; an address has an '@', which doesn't.
  qr.addData(text, /^[0-9A-Z $%*+\-./:]*$/.test(text) ? 'Alphanumeric' : 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const q = 4;                                   // quiet zone, in modules: the standard's four, so the
                                                 // code still reads on a dark-theme screen
  const eyes = [[0, 0], [0, n - 7], [n - 7, 0]];
  const inEye = (r, c) => eyes.some(([er, ec]) => r >= er && r < er + 7 && c >= ec && c < ec + 7);
  const hole = Math.ceil(n * 0.16) | 1, h0 = (n - hole) / 2;   // the badge's patch
  const inHole = (r, c) => r >= h0 && r < h0 + hole && c >= h0 && c < h0 + hole;
  let dots = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c) || inEye(r, c) || inHole(r, c)) continue;
      dots += `<rect x="${c + q + 0.04}" y="${r + q + 0.04}" width=".92" height=".92" rx=".28"/>`;
    }
  }
  // No style="" here: the page's CSP (style-src 'self') drops inline styles;
  // the stylesheet centres each eye with transform-box instead.
  const eye = ([r, c], cls) => `<g class="qr-eye ${cls}">`
    + `<rect x="${c + q + 0.5}" y="${r + q + 0.5}" width="6" height="6" rx="1.9" fill="none" stroke-width="1"/>`
    + `<rect x="${c + q + 2}" y="${r + q + 2}" width="3" height="3" rx=".95"/></g>`;
  const size = n + q * 2;
  return `<svg viewBox="0 0 ${size} ${size}" role="img" aria-label="${t('w_tip_qr_label')}" shape-rendering="geometricPrecision">`
    + `<rect width="${size}" height="${size}" rx="2.4" class="qr-paper"/>`
    + `<g class="qr-dots">${dots}</g>`
    + eye(eyes[0], 'eye-a') + eye(eyes[1], 'eye-b') + eye(eyes[2], 'eye-c')
    + '</svg>';
}

function view(name) {
  for (const v of ['hub', 'pick', 'thanks']) {
    const node = $('#tip-' + v);
    node.hidden = v !== name;
    // Replays the page's entrance each time it comes up.
    if (v === name) { node.classList.remove('enter'); void node.offsetWidth; node.classList.add('enter'); }
  }
  // The dialog is named by whatever page is up.
  $('#tip .sheet-card').setAttribute('aria-labelledby', name === 'hub' ? 'hub-title' : 'tip-title');
}

// "Open wallet" hands the invoice to whatever app claims lightning:. A page
// can't ask whether one exists, but it can tell when nothing took it: the
// page never lost focus. Then the button goes, and strike.me says why it's
// the way left.
function drawWallet() {
  const coarse = matchMedia('(pointer: coarse)').matches;
  $('#tip-wallet').hidden = S.noWallet || !coarse;
  $('#tip-strike').textContent = t(S.noWallet || !coarse ? 'w_tip_no_wallet' : 'w_tip_strike');
}

function drawAmounts() {
  document.querySelectorAll('#tip-amounts .tip-amt').forEach((b) => {
    const i = Number(b.dataset.i);
    b.setAttribute('aria-checked', String(S.pick === i));
    if (i < USD.length) {
      const a = amountAt(i);
      b.querySelector('b').textContent = a.usd != null ? fmtUsd(a.usd) : fmtSats(a.sats);
      b.querySelector('small').textContent = a.usd != null ? fmtSats(a.sats) : '';
    } else {
      // "Other" shows what was typed once its code exists.
      const m = S.pick === i && S.made;
      b.querySelector('small').textContent = m ? (m.usd != null ? fmtUsd(m.usd) : fmtSats(m.sats)) : t('w_tip_any');
    }
  });
  $('#tip-other').hidden = S.pick !== USD.length;
  $('#tip-other-cur').textContent = price ? '$' : 'sats';
  $('#tip-other-input').placeholder = price ? '3.50' : '5000';
}

function setState(state, msg) {
  // state: 'loading' | 'qr' | 'error' | 'empty'
  const card = $('#tip-qr');
  card.dataset.state = state;
  $('#tip-qr-msg').textContent = msg || '';
  $('#tip-retry').hidden = state !== 'error';
  $('#tip-waiting').classList.toggle('on', state === 'qr' && !!S.listener);
  card.classList.toggle('is-waiting', state === 'qr' && !!S.listener);
  $('#tip-wallet').toggleAttribute('aria-disabled', state !== 'qr');
  $('#tip-copy').disabled = state !== 'qr';
  if (state !== 'qr') $('#tip-code').textContent = '—';
}

async function choose(i) {
  S.pick = i;
  S.made = null;
  // The owlet on the frame answers the amount: one hop for $2, two for $5,
  // three for $10 (and for whatever you type).
  window.tawnyScene?.flutter($('.tip-owl'), i + 1);
  stopListening();
  drawAmounts();
  const amount = i === USD.length ? otherAmount() : amountAt(i);
  if (!amount) { setState('empty', t('w_tip_type_amount')); if (i === USD.length) $('#tip-other-input').focus(); return; }
  const mine = S.ticket;
  setState('loading', t('w_tip_making'));
  try {
    const { pr, listener } = await makeInvoice(amount.sats);
    if (mine !== S.ticket) { listener?.stop(); return; }
    S.invoice = pr;
    $('#tip-qr-img').innerHTML = qrSvg(('lightning:' + pr).toUpperCase());
    $('#tip-code').textContent = pr.slice(0, 20) + '…' + pr.slice(-8);
    $('#tip-wallet').href = 'lightning:' + pr;
    S.made = amount;
    drawAmounts();
    if (listener) {
      S.listener = listener;
      S.listener.promise.then((paid) => { if (paid && mine === S.ticket) landed(amount); });
    }
    setState('qr');
  } catch (e) {
    try { console.warn('[tip] invoice failed:', e && e.message ? e.message : e); } catch {}
    if (mine !== S.ticket) return;
    setState('error', navigator.onLine === false ? t('w_tip_offline') : t('w_tip_error'));
  }
}

function landed(amount) {
  S.listener = null;
  $('#tip-got').textContent = amount.usd != null ? t('w_tip_got', fmtUsd(amount.usd), fmtSats(amount.sats)) : t('w_tip_got_sats', fmtSats(amount.sats));
  // The sheet's one loud number: what you gave.
  $('#tip-big-amt').textContent = amount.usd != null ? fmtUsd(amount.usd) : fmtSats(amount.sats);
  $('#tip-big-sats').textContent = amount.usd != null ? fmtSats(amount.sats) : '';
  view('thanks');
  // The cat, the owlet and the dog all go off at once.
  requestAnimationFrame(() => requestAnimationFrame(() => window.tawnyScene?.celebrate($('#tip-party-scene'))));
  // A soft bell as it lands — the Monitor's own chime, kept quiet.
  try { const a = new Audio('sounds/bell.ogg'); a.volume = 0.45; a.play().catch(() => {}); } catch {}
  const box = $('#tip-hearts');
  box.textContent = '';
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    for (let i = 0; i < 7; i++) {
      const h = document.createElement('span');
      h.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.3C6.2 16.1 3 12.9 3 9.3 3 6.6 5.1 4.6 7.6 4.6c1.8 0 3.3 1 4.4 2.5 1.1-1.5 2.6-2.5 4.4-2.5 2.5 0 4.6 2 4.6 4.7 0 3.6-3.2 6.8-9 11z"/></svg>';
      h.style.left = 18 + Math.random() * 64 + '%';
      h.style.animationDelay = (Math.random() * 0.9).toFixed(2) + 's';
      h.style.setProperty('--s', (0.8 + Math.random() * 0.5).toFixed(2));
      box.append(h);
    }
  }
  $('#tip-done').focus({ focusVisible: false });
}

/** Open the sheet on its hub. `openSheet`/`closeSheet` are app.js's, so it slides like the others. */
export function openSupport() {
  stopListening();
  view('hub');
  S.open();
}

/** The Lightning page, from the hub. */
/** The Play build's Lightning page: the address, no amounts, no invoice. */
function showHandoff() {
  view('pick');
  $('#tip-pick').classList.add('handoff');
  $('#tip-sub').textContent = t('w_tip_handoff_sub');
  $('#tip-qr-img').innerHTML = qrSvg('lightning:' + LN_ADDRESS);
  $('#tip-code').textContent = LN_ADDRESS;
  $('#tip-copy').textContent = t('w_tip_copy_address');
  $('#tip-wallet').href = 'lightning:' + LN_ADDRESS;
  S.invoice = LN_ADDRESS;
  drawWallet();
  setState('qr');
  $('#tip-back').focus({ focusVisible: false });
}

async function showLightning() {
  if (S.mode === 'handoff') { showHandoff(); return; }
  view('pick');
  S.pick = 0;
  S.made = null;
  $('#tip-other-input').value = '';
  drawAmounts();
  drawWallet();
  setState('loading', t('w_tip_making'));
  $('#tip-back').focus({ focusVisible: false });
  if (price === null) price = await fetchPrice();
  choose(S.pick);
}

export function closeTip() {
  stopListening();
  S.close();
  // The Android app's Support screen is nothing but this sheet: closing it goes back.
  if (document.documentElement.classList.contains('support-shell')) {
    setTimeout(() => { try { native()?.close(); } catch {} }, 280);
  }
}

export function setupTip(openSheet, closeSheet, toast) {
  S.toast = toast;
  const sheet = $('#tip');
  if (!sheet) return;
  S.open = () => openSheet(sheet);
  S.close = () => closeSheet(sheet);
  // A wallet app on this device is only likely on a phone; a desktop gets the QR.
  drawWallet();
  $('#hub-lightning').addEventListener('click', showLightning);
  $('#hub-close').addEventListener('click', closeTip);
  $('#tip-back').addEventListener('click', () => {
    stopListening();
    view('hub');
    $('#hub-lightning').focus({ focusVisible: false });
  });
  document.querySelectorAll('#tip-amounts .tip-amt').forEach((b) =>
    b.addEventListener('click', () => {
      const i = Number(b.dataset.i);
      if (i === USD.length) {
        S.pick = i; stopListening(); drawAmounts(); setState('empty', t('w_tip_type_amount'));
        $('#tip-other-input').focus();
      } else choose(i);
    }));
  $('#tip-other').addEventListener('submit', (e) => { e.preventDefault(); choose(USD.length); });
  $('#tip-retry').addEventListener('click', () => choose(S.pick));
  $('#tip-copy').addEventListener('click', async () => {
    const label = S.mode === 'handoff' ? 'w_tip_copy_address' : 'w_tip_copy';
    try {
      if (native()) native().copy(S.invoice); else await navigator.clipboard.writeText(S.invoice);
      $('#tip-copy').textContent = t('w_tip_copied');
    } catch { $('#tip-copy').textContent = t('w_tip_copy_failed'); }
    setTimeout(() => ($('#tip-copy').textContent = t(label)), 1800);
  });
  $('#tip-wallet').addEventListener('click', (e) => {
    if ($('#tip-wallet').hasAttribute('aria-disabled')) { e.preventDefault(); return; }
    let left = false;
    const away = () => { left = true; };
    addEventListener('blur', away, { once: true });
    document.addEventListener('visibilitychange', away, { once: true });
    setTimeout(() => {
      removeEventListener('blur', away);
      document.removeEventListener('visibilitychange', away);
      if (left || $('#tip').hidden) return;
      S.noWallet = true;
      drawWallet();
      S.toast?.(t('w_tip_no_wallet_toast'));
    }, 1600);
  });
  $('#tip-close').addEventListener('click', closeTip);
  $('#tip-done').addEventListener('click', closeTip);
  // The Android app found nothing to open lightning: with.
  window.tawnyNoWallet = () => {
    S.noWallet = true;
    drawWallet();
    S.toast?.(t('w_tip_no_wallet_toast'));
  };
  // A link straight to the hub (docs, a website): …/#support
  if (location.hash === '#support') openSupport();
  // Every Support button (app bar heart, channels card, update board) opens the hub.
  document.querySelectorAll('[data-support]').forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); openSupport(); }));
}
