// Tawny rendezvous — Cloudflare Worker entry point.
//
// Serves a handful of small endpoints and forwards signaling WebSockets to a per-room
// Durable Object. Devices only ever dial *out* to this (wss:443); nothing here
// listens on the devices themselves, so no inbound ports are opened anywhere.
//
//   GET /healthz              liveness
//   GET /config.json          { stun, turnMode, authRequired:false }  (CORS *)
//   GET /privacy              the privacy policy, as a static HTML page
//   GET /turn?room=&t=        short-lived TURN credentials             (CORS *)
//   POST /report              a diagnostics report from the app       (reports.js)
//   GET /report/pull          drain/read stored reports, key-gated    (reports.js)
//   GET /ws?room=&role=       signaling relay  ->  Room Durable Object
//                             (the ticket rides the first frame, never the URL)
//
// Secrets (wrangler secret put ...):
//   TURN_KEY_ID / TURN_API_TOKEN   Cloudflare Realtime TURN (preferred), OR
//   TURN_STATIC_SECRET / TURN_URLS coturn REST (self-hosted fallback)
//   ANALYTICS_TOKEN                "Account Analytics: Read" only, for the TURN cap
// Vars (wrangler.toml [vars]):
//   STUN_URLS, TURN_MODE, ALLOWED_ORIGINS, ACCOUNT_ID, TURN_CAP_GB (see turnbudget.js)

export { Room } from './room.js';
import { privacyResponse } from './privacy.js';
import { postReport, pullReports } from './reports.js';
import { turnPaused } from './turnbudget.js';

const ROOM_RE = /^[a-f0-9]{32}$/;
const TICKET_RE = /^[A-Za-z0-9_-]{8,64}$/;

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

function cors(extra = {}) {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    ...extra
  };
}

const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
  });

// A WebView page is served from http://127.0.0.1:<random-port>; some WebViews
// send `Origin: null`. This is a coarse gate — the admission ticket and the
// hashed room id carry the real weight.
function originOk(request, env) {
  const o = request.headers.get('Origin');
  if (!o || o === 'null') return true;
  let h;
  try { h = new URL(o); } catch { return false; }
  if (h.hostname === '127.0.0.1' || h.hostname === 'localhost') return true;
  if (h.host === new URL(request.url).host) return true;
  return list(env.ALLOWED_ORIGINS).includes(o) || list(env.ALLOWED_ORIGINS).includes(h.host);
}

/**
 * Per-IP throttle.
 *
 * This used to be a read-modify-write against Workers KV, which is eventually
 * consistent with cache propagation measured in tens of seconds — a burst from
 * one address read a stale counter near zero and walked straight through. The
 * native rate-limiting binding is atomic and is the right tool; the KV path is
 * kept only as a fallback so a deployment without the binding still degrades to
 * the old, weak behaviour rather than to no limit at all.
 *
 * Note this is a coarse outer gate. The limit that actually protects a channel
 * is the per-room failure counter inside the Durable Object, which is strongly
 * consistent and cannot be sidestepped by rotating source addresses.
 */
async function rateLimited(env, ip) {
  if (!ip) return false;
  if (env.LIMITER?.limit) {
    try {
      const { success } = await env.LIMITER.limit({ key: ip });
      return !success;
    } catch { /* fall through to KV */ }
  }
  if (!env.RL) return false;
  const key = `rl:${ip}:${Math.floor(Date.now() / 600_000)}`;   // 10-min bucket
  const n = Number((await env.RL.get(key)) || 0) + 1;
  await env.RL.put(key, String(n), { expirationTtl: 900 });
  return n > 40;
}

async function turnCreds(env) {
  const ttl = 3600;
  // Preferred: Cloudflare Realtime TURN.
  if (env.TURN_KEY_ID && env.TURN_API_TOKEN) {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.TURN_API_TOKEN}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ ttl })
      }
    );
    if (!r.ok) return null;
    const j = await r.json();
    // Normalise to a flat iceServers array.
    const s = j.iceServers || {};
    return { iceServers: [{ urls: s.urls, username: s.username, credential: s.credential }], ttl };
  }
  // Fallback: coturn with use-auth-secret (RFC 5766 REST).
  if (env.TURN_STATIC_SECRET && env.TURN_URLS) {
    const username = `${Math.floor(Date.now() / 1000) + ttl}`;
    const mac = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(env.TURN_STATIC_SECRET),
      { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', mac, new TextEncoder().encode(username));
    const credential = btoa(String.fromCharCode(...new Uint8Array(sig)));
    return { iceServers: [{ urls: list(env.TURN_URLS), username, credential }], ttl };
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });

    if (url.pathname === '/healthz') return json({ ok: true });

    if (url.pathname === '/config.json') {
      return json(
        { stun: list(env.STUN_URLS), turnMode: env.TURN_MODE || 'auto', authRequired: false },
        200, cors()
      );
    }

    // Play requires a publicly reachable HTTPS privacy policy before it will
    // accept a submission. This service is already public, already on HTTPS,
    // and already has to stay up for the app to work off-Wi-Fi — so it serves
    // the page itself rather than adding a GitHub Pages account to the list of
    // things that must not rot. Static, subresource-free and cacheable; see
    // privacy.js. `/privacy/` too, because that is what people type.
    if (url.pathname === '/privacy' || url.pathname === '/privacy/') {
      return privacyResponse();
    }

    if (url.pathname === '/turn') {
      const room = url.searchParams.get('room') || '';
      const ticket = url.searchParams.get('t') || '';
      if (!ROOM_RE.test(room) || (ticket && !TICKET_RE.test(ticket))) {
        return json({ error: 'bad request' }, 400, cors());
      }
      if (!originOk(request, env)) return json({ error: 'forbidden' }, 403, cors());
      const ip = request.headers.get('CF-Connecting-IP') || '';
      if (await rateLimited(env, ip)) return json({ error: 'slow down' }, 429, cors());

      // Must present a ticket valid for this room — no free credential farming.
      const stub = env.ROOM.get(env.ROOM.idFromName(room));
      const vr = await stub.fetch(`https://do/verify?t=${encodeURIComponent(ticket)}`);
      if (vr.status !== 200) return json({ error: 'not paired' }, 403, cors());

      // Past the month's cap no new credentials: phones connect directly or not
      // at all until the 1st, and the card on the account is never charged.
      const budget = await turnPaused(env);
      if (budget.paused) return json({ error: 'turn paused for this month' }, 503, cors());

      const creds = await turnCreds(env);
      if (!creds) return json({ error: 'no turn configured' }, 404, cors());
      return json(creds, 200, cors());
    }

    // Diagnostic reports from the in-app "Send to Tawny" button. Intake is
    // rate-limited and origin-checked like the rest; the read side is gated by
    // a shared key. Both 404 cleanly if the REPORTS KV namespace is unbound.
    if (url.pathname === '/report' && request.method === 'POST') {
      if (!originOk(request, env)) return json({ error: 'forbidden' }, 403, cors());
      const ip = request.headers.get('CF-Connecting-IP') || '';
      if (await rateLimited(env, ip)) return json({ error: 'slow down' }, 429, cors());
      return postReport(request, env, ctx);
    }
    if (url.pathname === '/report/pull') {
      return pullReports(request, env, url);
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }
      if (!originOk(request, env)) return new Response('forbidden', { status: 403 });

      // The admission ticket rides in the DO's {type:'hello'} first frame, not
      // the URL — nothing sensitive in the query string / access logs.
      const room = url.searchParams.get('room') || '';
      if (!ROOM_RE.test(room)) return new Response('bad room', { status: 400 });

      const ip = request.headers.get('CF-Connecting-IP') || '';
      if (await rateLimited(env, ip)) return new Response('slow down', { status: 429 });

      const stub = env.ROOM.get(env.ROOM.idFromName(room));
      return stub.fetch(request);
    }

    return new Response('not found', { status: 404 });
  }
};
