// Who may use the /setup/* actions.
//
// Those POSTs change real things: which tailnet this container is on, whether
// it routes the home network into it, and (tighter privacy) which rendezvous
// and TURN server every client is sent to. They carry no password — setup is
// meant to work from a browser on the home network with nothing to type — so
// the request itself has to show it came from the setup page, opened by someone
// on that network. Three checks, each closing a different way round that:
//
//   1. Own network, the whole way. The peer address must be private, and so
//      must every hop a proxy recorded in X-Forwarded-For. The peer alone is
//      not enough: behind a reverse proxy (or `tailscale serve`, which is one)
//      the peer is always the proxy, so every client on the internet looked
//      local. A proxy appends the address it saw, so a client cannot talk its
//      way in by sending a private X-Forwarded-For of its own — the proxy adds
//      the real one after it and the chain fails.
//
//   2. Same site. A page on any website can make a browser on the home network
//      send a POST here (a form post needs no permission, and the body used to
//      be parsed whatever its type). A browser says where such a request came
//      from: Origin must be this server's own address, and Sec-Fetch-Site, when
//      sent, must be same-origin. No Origin at all is a non-browser client
//      (curl on the LAN), which check 1 has already placed on the network.
//
//   3. A name that is this server's. DNS rebinding points a name the attacker
//      owns at this box, which makes their page same-site and defeats check 2.
//      So setup answers only on an address that cannot be rebound: an IP, a
//      single-label or home-network name, a tailnet name, or one the operator
//      listed (ALLOWED_HOSTS, the public host, the node's own tailnet name).
//
// Pure functions, no I/O: `node --test app/docker/setup-guard.test.js`.

import net from 'node:net';

const HOME_SUFFIXES = ['.ts.net', '.local', '.lan', '.home.arpa', '.internal', '.localhost'];

function stripMapped(ip) {
  return String(ip || '').trim().replace(/^::ffff:/i, '');
}

/** Loopback, RFC1918, link-local, CGNAT (a tailnet address), or IPv6 ULA / link-local. */
export function isLocalAddr(input) {
  const ip = stripMapped(input).replace(/^\[|\]$/g, '');
  const v = net.isIP(ip);
  if (v === 4) {
    const o = ip.split('.').map(Number);
    if (o[0] === 127) return true;
    if (o[0] === 10) return true;
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
    if (o[0] === 192 && o[1] === 168) return true;
    if (o[0] === 169 && o[1] === 254) return true;
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;
    return false;
  }
  if (v === 6) {
    const l = ip.toLowerCase();
    if (l === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(l)) return true;        // fc00::/7 (tailnet IPv6 is in here)
    if (/^fe[89ab][0-9a-f]:/.test(l)) return true;        // fe80::/10
    return false;
  }
  return false;
}

/** `Host`-style value -> lower-case name without the port; IPv6 keeps its brackets. */
function bareHost(h) {
  const host = String(h || '').split(',')[0].trim().toLowerCase();
  const m = /^\[[^\]]+\]/.exec(host);
  return m ? m[0] : host.replace(/:\d+$/, '');
}

function fullHost(h) {
  return String(h || '').split(',')[0].trim().toLowerCase();
}

/** May setup be driven through this name? (check 3) */
export function setupNameOk(host, { allowedHosts = [], ownNames = [] } = {}) {
  const full = fullHost(host);
  const bare = bareHost(host);
  if (!bare) return false;
  if (net.isIP(bare.replace(/^\[|\]$/g, ''))) return true;
  if (!/^[a-z0-9.-]+$/.test(bare)) return false;
  if (!bare.includes('.')) return true;                   // `localhost`, `nas`, `cachy`
  if (HOME_SUFFIXES.some((s) => bare.endsWith(s))) return true;
  const listed = [...allowedHosts, ...ownNames].map((n) => String(n || '').toLowerCase()).filter(Boolean);
  return listed.includes(bare) || listed.includes(full);
}

/**
 * null when the request may act on /setup, otherwise `{ code, error }`.
 *
 * `req` needs only `socket.remoteAddress` and `headers`.
 */
export function setupGuard(req, opts = {}) {
  const h = req.headers || {};
  const offNetwork = { code: 403, error: 'Setup can only be completed from your own network.' };

  // 1. own network, every hop
  if (!isLocalAddr(req.socket && req.socket.remoteAddress)) return offNetwork;
  const xff = h['x-forwarded-for'];
  if (xff !== undefined) {
    const hops = String(Array.isArray(xff) ? xff.join(',') : xff).split(',').map((s) => s.trim());
    if (!hops.length || !hops.every((hop) => isLocalAddr(hop))) return offNetwork;
  }

  // 3. a name that is ours (before 2, so the message names the real problem)
  const names = [h.host, h['x-forwarded-host']].filter((v) => v !== undefined && v !== '');
  if (!names.length) return { code: 400, error: 'No Host header.' };
  for (const n of names) {
    if (!setupNameOk(n, opts)) {
      const shown = bareHost(n).replace(/[^a-z0-9.\-\[\]:]/g, '').slice(0, 80);
      return {
        code: 403,
        error: `Setup is not available at the name "${shown}". Open this page by IP address or by its ` +
          '.ts.net name, or add the name to TAWNY_ALLOWED_HOSTS.'
      };
    }
  }

  // 2. same site
  const crossSite = { code: 403, error: 'Setup actions are only accepted from the setup page itself.' };
  const sfs = h['sec-fetch-site'];
  if (sfs !== undefined && sfs !== 'same-origin' && sfs !== 'none') return crossSite;
  const origin = h.origin;
  if (origin !== undefined) {
    let parsed;
    try { parsed = new URL(String(origin)); } catch { return crossSite; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return crossSite;
    const oh = parsed.host.toLowerCase();
    // The page's origin must be the address this request was sent to, port
    // included — another service on this box is another origin. One allowance:
    // a browser leaves a default port out of Origin, and some proxies spell it
    // out in the Host they forward.
    const same = names.some((n) => {
      const full = fullHost(n);
      if (oh === full) return true;
      const port = (/:(\d+)$/.exec(full.replace(/^\[[^\]]+\]/, '')) || [])[1];
      return parsed.port === '' && (port === '443' || port === '80') && parsed.hostname.toLowerCase() === bareHost(n);
    });
    if (!same) return crossSite;
  }
  return null;
}
