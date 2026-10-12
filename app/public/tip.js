// Tip in Bitcoin, over Lightning. The sheet offers $2 / $5 / $10 or a typed
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
    const zap = signed(priv, 9734, [['relays', ...RELAYS], ['amount', String(msats)], ['p', tag]], 'A tip for Tawny ⚡');
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

const S = { pick: 0, ticket: 0, invoice: '', listener: null, open: null, close: null };
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

function view(name) {
  for (const v of ['pick', 'thanks']) $('#tip-' + v).hidden = v !== name;
}

function drawAmounts() {
  document.querySelectorAll('#tip-amounts .tip-amt').forEach((b) => {
    const i = Number(b.dataset.i);
    b.setAttribute('aria-checked', String(S.pick === i));
    if (i < USD.length) {
      const a = amountAt(i);
      b.querySelector('b').textContent = a.usd != null ? fmtUsd(a.usd) : fmtSats(a.sats);
      b.querySelector('small').textContent = a.usd != null ? fmtSats(a.sats) : '';
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
  $('#tip-wallet').toggleAttribute('aria-disabled', state !== 'qr');
  $('#tip-copy').disabled = state !== 'qr';
  if (state !== 'qr') $('#tip-code').textContent = '—';
}

async function choose(i) {
  S.pick = i;
  stopListening();
  drawAmounts();
  const amount = i === USD.length ? otherAmount() : amountAt(i);
  if (!amount) { setState('empty', t('w_tip_type_amount')); if (i === USD.length) $('#tip-other-input').focus(); return; }
  const mine = S.ticket;
  setState('loading', t('w_tip_making'));
  try {
    const { pr, watch } = await invoiceFor(amount.sats);
    if (mine !== S.ticket) return;
    S.invoice = pr;
    const qr = qrcode(0, 'M');
    qr.addData(('lightning:' + pr).toUpperCase(), 'Alphanumeric');
    qr.make();
    $('#tip-qr-img').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    $('#tip-code').textContent = pr.slice(0, 20) + '…' + pr.slice(-8);
    $('#tip-wallet').href = 'lightning:' + pr;
    if (watch) {
      S.listener = listen(watch);
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
  view('thanks');
  const box = $('#tip-hearts');
  box.textContent = '';
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    for (let i = 0; i < 7; i++) {
      const h = document.createElement('span');
      h.textContent = '♥';
      h.style.left = 18 + Math.random() * 64 + '%';
      h.style.animationDelay = (Math.random() * 0.9).toFixed(2) + 's';
      h.style.setProperty('--s', (0.8 + Math.random() * 0.5).toFixed(2));
      box.append(h);
    }
  }
  $('#tip-done').focus({ focusVisible: false });
}

/** Open the sheet. `openSheet`/`closeSheet` are app.js's, so it slides like the others. */
export async function openTip() {
  view('pick');
  S.pick = 0;
  $('#tip-other-input').value = '';
  drawAmounts();
  setState('loading', t('w_tip_making'));
  S.open();
  if (price === null) {
    try { const p = parseFloat((await getJson(PRICE)).data.amount); if (p > 0) price = p; } catch {}
  }
  choose(S.pick);
}

export function closeTip() {
  stopListening();
  S.close();
}

export function setupTip(openSheet, closeSheet) {
  const sheet = $('#tip');
  if (!sheet) return;
  S.open = () => openSheet(sheet);
  S.close = () => closeSheet(sheet);
  // A wallet app on this device is only likely on a phone; a desktop gets the QR.
  $('#tip-wallet').hidden = !matchMedia('(pointer: coarse)').matches;
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
    try { await navigator.clipboard.writeText(S.invoice); $('#tip-copy').textContent = t('w_tip_copied'); }
    catch { $('#tip-copy').textContent = t('w_tip_copy_failed'); }
    setTimeout(() => ($('#tip-copy').textContent = t('w_tip_copy')), 1800);
  });
  $('#tip-wallet').addEventListener('click', (e) => { if ($('#tip-wallet').hasAttribute('aria-disabled')) e.preventDefault(); });
  $('#tip-close').addEventListener('click', closeTip);
  $('#tip-done').addEventListener('click', closeTip);
  // every "Tip in Bitcoin" button (footer, update board) opens the sheet
  document.querySelectorAll('a.tip-bolt').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openTip(); }));
}
