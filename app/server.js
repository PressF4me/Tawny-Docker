// Tawny — WebRTC signaling + static file server.
// Media is peer-to-peer. This process brokers the handshake and nothing else.
//
// Channels are identified to the server only by an opaque id derived client
// side from a secret the server never receives. See SECURITY.md.

import http from 'node:http';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, extname, normalize, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash, createHmac } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { PRIVACY_HTML, PRIVACY_HEADERS } from './rendezvous/privacy.js';
import {
  findRouteConflicts, findRouteCoverage, mergeRoutes, withoutRoute
} from './docker/route-conflict.js';

const PORT = Number(process.env.PORT || 8099);
const HOST = process.env.HOST || '0.0.0.0';
// One plain HTTP listener, and that is all.
//
// A browser grants getUserMedia on a secure origin only, so talk-back needs
// https — but this process does not terminate it. `tailscale serve` does, with
// a Let's Encrypt certificate for <node>.<tailnet>.ts.net, and proxies to this
// listener on loopback. That is the only TLS in this deployment.
//
// It used to be otherwise: the container generated a certificate authority in
// its volume, signed its own LAN address, and asked the operator to import the
// CA on every device they wanted to watch from. That is gone. Nobody should
// have to manage certificates to watch their cat, and a CA the operator
// installs is a far bigger thing to hand someone than the problem it solved.
// Public STUN by default. A container that is never told anything at all should
// still gather server-reflexive candidates, which is what makes a plain
// `docker run` work across two different networks. STUN_URLS=off disables it
// for an air-gapped LAN deployment.
const STUN = process.env.STUN_URLS === 'off'
  ? []
  : list(process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478');
const ALLOWED_HOSTS = list(process.env.ALLOWED_HOSTS).map((h) => h.toLowerCase());
const TRUST_PROXY = process.env.TRUST_PROXY !== 'off';

// Remote relay (all optional). RENDEZVOUS_URL is only echoed for a browser
// client that fetches /config.json from this origin; left empty, /config.json
// echoes back the origin the request actually arrived on, so a client always
// gets an address it has already proved it can reach. TURN is coturn with
// use-auth-secret (static-auth-secret === TURN_SECRET).
const RENDEZVOUS_URL = process.env.RENDEZVOUS_URL || '';
const TURN_MODE = process.env.TURN_MODE || 'auto';

// TURN. Two flavours, tried in this order by turnCreds():
//
//  1. An explicit relay        — TAWNY_TURN_URLS + TAWNY_TURN_SECRET.
//  2. The relay in this image  — TURN_PORT, with the URL host derived per
//     request from the Host header, and the secret generated at container start
//     (docker/entrypoint.sh writes TURN_SECRET_FILE, which coturn reads too).
//     Nothing for the operator to set, and nothing shared between deployments.
//
// There is deliberately no hosted-TURN option. The supported topology does not
// need a relay at all — see DESIGN.md: the Tailscale subnet route puts every
// Viewer, near or far, in the phone's own /24, and ICE pairs there directly.
// coturn stays in the image as an unattended safety net for the network that
// blocks direct UDP between two hosts on it, and for the phone that fell back
// to the cloud rendezvous. It is not a thing to sign up for.
const TURN_URLS = list(process.env.TAWNY_TURN_URLS);
const TURN_PORT = Number(process.env.TURN_PORT || 3478);
// The one address that genuinely cannot be inferred: the public name/IP of a
// box behind NAT, when the client reached this server through some other route
// (a tunnel, a reverse proxy on another host). Everything else comes from Host.
const PUBLIC_HOST = (process.env.TAWNY_PUBLIC_HOST || '').trim().toLowerCase();
const TURN_EMBEDDED = process.env.TURN_EMBEDDED === 'on';
const TURN_SECRET_FILE = process.env.TURN_SECRET_FILE || '';
const TURN_SECRET = (() => {
  if (process.env.TAWNY_TURN_SECRET) return process.env.TAWNY_TURN_SECRET;
  if (!TURN_SECRET_FILE) return '';
  // Written by the entrypoint before node starts. Read once: it never rotates
  // within the life of a container, and a missing file simply means "no TURN".
  try { return readFileSync(TURN_SECRET_FILE, 'utf8').trim(); } catch { return ''; }
})();

// --------------------------------------------------------------- /setup
//
// docker/entrypoint.sh exports these once, at container start; a missing
// value (no Tailscale configured at all) is the normal case for the plain
// LAN topology, not an error — see setupStatus() below.
const TAWNY_TS_SOCKET = process.env.TAWNY_TS_SOCKET || '';
// Where the host's own tailscaled would be, if the operator mounted it. When
// it is there, this machine is already on a tailnet and asking for an auth key
// is asking for something nobody needs.
const TS_HOST_SOCKET = process.env.TS_HOST_SOCKET || '/var/run/tailscale/tailscaled.sock';
const TAWNY_LAN_IP = process.env.TAWNY_LAN_IP || '';
const TAWNY_LAN_CIDR = process.env.TAWNY_LAN_CIDR || '';
const TAWNY_TS_ROUTES = process.env.TAWNY_TS_ROUTES || '';
// 'own' | 'host' | 'none' — whose tailscaled the socket above belongs to.
// docker/entrypoint.sh decides it; the socket comparison below is the fallback
// for a container started some other way. On the host's daemon every write is
// additive (see advertiseRoute) and `up` is refused outright: that machine was
// on a tailnet for its own reasons before Tawny existed.
const TAWNY_TS_MODE = process.env.TAWNY_TS_MODE ||
  (TAWNY_TS_SOCKET ? (TAWNY_TS_SOCKET === TS_HOST_SOCKET ? 'host' : 'own') : 'none');
const TAWNY_SETUP_STATE = process.env.TAWNY_SETUP_STATE || '';
// Runtime scratch dir (docker/entrypoint.sh's RUN_DIR). A stale-identity join
// failure is queued here for the supervisor loop to clear — this process
// cannot restart tailscaled itself. See joinTailnet() and entrypoint.sh.
const RUN_DIR = TAWNY_SETUP_STATE ? dirname(TAWNY_SETUP_STATE) : '/tmp/tawny';
const TS_RECOVER_REQ = join(RUN_DIR, 'ts-recover.req');
// Where the operator's answer to "do you want to watch from outside the
// house?" is kept. TS_ROUTES now defaults to `off`, so without this the
// feature would be a setting nobody finds; with it, /setup can turn routing on
// live and the choice outlives the container. See docker/entrypoint.sh.
const ROUTE_CHOICE_FILE = process.env.TAWNY_ROUTE_CHOICE_FILE || '/data/route-choice';

const MAX_PER_ROOM = 4;      // one Watcher + up to three Handhelds
const MAX_STATIONS = 1;
const MAX_PER_IP = 6;
const MAX_TOTAL = 64;
const MAX_MSG = 64 * 1024;   // enforced by the ws maxPayload below, too
const AUTH_FAILS = 8;        // per IP before lockout
const AUTH_WINDOW = 10 * 60_000;
// Distinct room ids this process will track at once. LocalWeb.kt has always had
// this cap; here the room map could grow without bound (see the empty-room leak
// fixed in admit()), so an unauthenticated caller could walk it up until the
// process died.
const MAX_ROOMS = 256;
// A socket that opens and never sends {type:'hello'} used to sit there forever.
// The 30 s heartbeat only reaps sockets that stop answering pings, so a client
// that pongs politely and never speaks held a slot indefinitely — eleven hosts
// at MAX_PER_IP would wedge MAX_TOTAL and take the whole relay down. The LAN
// relay sweeps these after 5 s and the Durable Object after 10 s; this had no
// sweep at all.
const ADMIT_TIMEOUT_MS = 10_000;

const ROOM_RE = /^[a-f0-9]{32}$/;
const PUBLIC = join(fileURLToPath(new URL('.', import.meta.url)), 'public');

function list(v) {
  return (v || '').split(',').map((s) => s.trim()).filter(Boolean);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

/**
 * `connect-src` for the page this server hands out.
 *
 * It used to be `'self' https: wss: ws:`, which is three scheme-wide sources —
 * i.e. no restriction at all. Any script that got into the page could POST the
 * channel key out of localStorage to any host on the internet, which is the one
 * thing a CSP on this page exists to prevent.
 *
 * Same-origin covers the signaling socket, because `'self'` matches ws/wss on
 * the document's own host and port. Beyond that the page dials exactly one
 * other host: the rendezvous named in RENDEZVOUS_URL, over wss for signaling
 * and https for /turn and /config.json. If none is configured, it dials nothing
 * else and the policy says so.
 */
const CONNECT_SRC_TOKEN = '__TAWNY_CONNECT_SRC__';
const CONNECT_SRC = (() => {
  const out = ["'self'"];
  // A host with whitespace or a semicolon would truncate the policy. If a value
  // does not look like a hostname[:port], it does not go in.
  const HOST_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;
  const bareHost = (u) => u.replace(/^[a-z]+:(\/\/)?/i, '').split(/[/?]/)[0];

  const rv = RENDEZVOUS_URL ? bareHost(RENDEZVOUS_URL) : '';
  if (HOST_RE.test(rv)) out.push(`wss://${rv}`, `https://${rv}`);

  // STUN/TURN hosts, listed scheme-and-host so `stun:`/`turn:`/`turns:` match.
  //
  // Belt and braces only: `connect-src` does NOT in fact gate ICE server URLs
  // in Chromium. Measured 2026-09 — the Android WebView's CSP (LocalWeb.kt
  // connectSrc()) names no stun:/turn: source at all, and that WebView still
  // gathered a server-reflexive candidate, so STUN ran with nothing in the
  // policy permitting it. A CSP violation was never why media failed to flow;
  // these entries cost nothing and are kept in case a future engine tightens
  // this, but do not go looking here when ICE fails.
  for (const u of [...STUN, ...TURN_URLS]) {
    const h = bareHost(u);
    if (!HOST_RE.test(h)) continue;
    out.push(`stun://${h}`, `turn://${h}`, `turns://${h}`);
  }
  return [...new Set(out)].join(' ');
})();

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  `connect-src ${CONNECT_SRC}`,
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ');

function secureHeaders(extra = {}) {
  return {
    'content-security-policy': CSP,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'permissions-policy': 'camera=(self), microphone=(self), geolocation=()',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    ...extra
  };
}

// ------------------------------------------------------------------ util

/**
 * May this peer's `X-Forwarded-*` headers be believed?
 *
 * Loopback alone was too narrow. The reverse proxy in docker-compose.yml is a
 * separate container, so it reaches this one across a bridge network and
 * arrives as 172.x — never 127.0.0.1 — and every forwarded header was silently
 * dropped, which meant a TLS deployment served itself `ws://` URLs for its own
 * `https://` origin. Private ranges are the right boundary here: nothing on
 * them can be a client from the internet, because a public deployment reaches
 * this process only through the proxy that is itself on one.
 *
 * TRUST_PROXY=off for the unusual case of exposing this port to a network
 * where an untrusted host could reach it directly.
 */
function fromTrustedProxy(req) {
  if (!TRUST_PROXY) return false;
  const raw = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (raw === '127.0.0.1' || raw === '::1') return true;
  if (/^10\./.test(raw)) return true;
  if (/^192\.168\./.test(raw)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(raw)) return true;
  if (/^f[cd]/i.test(raw)) return true;                   // fc00::/7 ULA
  return false;
}

function clientIP(req) {
  const raw = req.socket.remoteAddress || '';
  if (fromTrustedProxy(req)) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return raw;
}

function hostAllowed(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!host) return false;
  if (!ALLOWED_HOSTS.length) return true;
  const bare = host.replace(/:\d+$/, '');
  return ALLOWED_HOSTS.includes(host) || ALLOWED_HOSTS.includes(bare);
}

/**
 * The address the client actually reached this server on.
 *
 * Zero-config rests on this. The operator knows their own URL; the container
 * does not, and every way of guessing it from inside (hostname, the first
 * non-loopback interface) is wrong in the common cases — behind a reverse
 * proxy, on a tailnet, in bridge networking. The Host header, by contrast, is
 * the one address the client has already proved it can resolve and reach.
 *
 * `X-Forwarded-Host`/`-Proto` are honoured only from a loopback peer, i.e. a
 * proxy on this host (the same rule clientIP() uses); a remote client cannot
 * forge them. hostAllowed() has already vetted the result against
 * ALLOWED_HOSTS when the operator set one.
 */
function reqOrigin(req) {
  const proxied = fromTrustedProxy(req);
  const fwdHost = proxied ? req.headers['x-forwarded-host'] : null;
  const fwdProto = proxied ? req.headers['x-forwarded-proto'] : null;
  let host = String(fwdHost || req.headers.host || '').split(',')[0].trim();
  // hostAllowed() vets the Host header; a forwarded name has not been through
  // it, so when the operator pinned a list, hold the forwarded value to it too
  // rather than echoing an arbitrary name back as this deployment's address.
  if (fwdHost && ALLOWED_HOSTS.length) {
    const bare = host.toLowerCase().replace(/:\d+$/, '');
    if (!ALLOWED_HOSTS.includes(bare) && !ALLOWED_HOSTS.includes(host.toLowerCase())) {
      host = String(req.headers.host || '').split(',')[0].trim();
    }
  }
  const proto = String(fwdProto || (req.socket.encrypted ? 'https' : 'http'))
    .split(',')[0].trim();
  return { host, proto: proto === 'https' ? 'https' : 'http' };
}

/** Just the hostname the client used — no port — for building a TURN URL. */
function reqHostname(req) {
  const { host } = reqOrigin(req);
  // IPv6 literals arrive bracketed; keep the brackets, drop only a :port.
  const m = /^\[[^\]]+\]/.exec(host);
  return (m ? m[0] : host.replace(/:\d+$/, '')).toLowerCase();
}

/**
 * TURN servers for a paired client.
 *
 * A relay we can name: the operator's explicit URL, or the one inside this
 * image addressed at whatever hostname the client used to get here — which is
 * the point, since that address is known to work from where the client sits.
 */
async function turnCreds(req) {
  const ttl = 3600;
  if (!TURN_SECRET) return null;

  let urls = TURN_URLS;
  if (!urls.length && TURN_EMBEDDED) {
    // PUBLIC_HOST wins when set — the case where the client reached us through
    // something that is not the address the relay listens on. Otherwise the
    // Host header, which is right for LAN, tailnet and a plain public host.
    const h = PUBLIC_HOST || reqHostname(req);
    if (!/^[a-z0-9.\-\[\]:]+$/.test(h)) return null;
    // Both transports: UDP is what actually relays media, TCP is the fallback
    // for a network that blocks UDP outright (some corporate wifi, some hotels).
    urls = [`turn:${h}:${TURN_PORT}`, `turn:${h}:${TURN_PORT}?transport=tcp`];
  }
  if (!urls.length) return null;

  // RFC 5766 REST: username is an expiry timestamp, credential is
  // HMAC-SHA1(secret, username) base64 — what coturn --use-auth-secret expects.
  const username = String(Math.floor(Date.now() / 1000) + ttl);
  const credential = createHmac('sha1', TURN_SECRET).update(username).digest('base64');
  return { iceServers: [{ urls, username, credential }], ttl };
}

// Blocks cross-site WebSocket hijacking: a page on evil.example cannot open a
// socket here, because its Origin will not match the Host it was served from.
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client (native app)
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  const host = String(req.headers.host || '').toLowerCase();
  if (parsed.host.toLowerCase() === host) return true;
  const bare = parsed.hostname.toLowerCase();
  return ALLOWED_HOSTS.includes(bare) || ALLOWED_HOSTS.includes(parsed.host.toLowerCase());
}

const fails = new Map(); // ip -> { n, until }

function lockedOut(ip) {
  const rec = fails.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.until) { fails.delete(ip); return false; }
  return rec.n >= AUTH_FAILS;
}

function noteFail(ip) {
  const rec = fails.get(ip) || { n: 0, until: 0 };
  rec.n += 1;
  rec.until = Date.now() + AUTH_WINDOW;
  fails.set(ip, rec);
}

// ------------------------------------------------------------------ /setup
//
// Everything a Docker/Portainer operator currently has to infer from `docker
// logs` or probe.sh, composed into one JSON document. Every shell-out here
// is wrapped so a missing `tailscale` binary or an unconfigured socket
// degrades to "not on a tailnet" — this must never 500 and never throw.

/**
 * Strip a Tailscale auth key from a string. `tailscale up`'s own error output
 * and Node's execFile "Command failed: <argv>" message both echo the full
 * --authkey=… — and that text is served on /setup over plain HTTP.
 */
function redactKey(s) {
  return String(s == null ? '' : s)
    .replace(/--authkey=\S+/g, '--authkey=<redacted>')
    .replace(/tskey-[A-Za-z0-9._~-]{6,}/g, 'tskey-<redacted>');
}

/**
 * Why did `tailscale up` fail? Classified from its output plus `status`.
 *   stale   — a persisted node key control will not take back (volume outlived
 *             a tailnet, node deleted, a half-registration). A fresh node key
 *             fixes it; the operator's auth key is fine.
 *   badkey  — the auth key: expired, single-use spent, tags not permitted.
 *   network — never reached the coordination server.
 *   unknown — anything else.
 */
function classifyUp(text) {
  // Strip our own command line before matching. Node's execFile error message
  // is "Command failed: <full argv>", so the text handed here routinely
  // contains the flags we passed — and `--authkey=<redacted>` matches the
  // badkey rule below while `--timeout=60s` matches the network one. Any
  // failure whose stderr was empty therefore landed on "that key was refused",
  // which is precisely the misdiagnosis this function exists to end.
  const t = String(text || '').toLowerCase().replace(/--[a-z][\w-]*=\S*/g, ' ');
  // Order matters, and so does what is NOT a signal. `stale` archives the node
  // identity, so a household whose internet is down at boot would otherwise
  // come back needing a fresh auth key and a fresh route approval — observed
  // doing exactly that once the daemon's health was actually being read.
  //   - "last login error" is not a stale signal: it is the wrapper Tailscale
  //     puts round *every* failed login, DNS outages included.
  //   - "register request: http 4" is not one on its own either — a refused
  //     auth key returns 401 through the same path — so it is consulted only
  //     after badkey and network.
  //   - NoState alone is too noisy (brief on any fresh start).
  // The first rule is unambiguous: control holds this node key and will not
  // re-register it. `up`'s output always carries "timeout waiting for …" once
  // --timeout fires, which is why network cannot be tested first.
  // Kept in lockstep with ts_fail_kind() in docker/entrypoint.sh.
  if (/already exists|wrong nodekey|duplicate node key|node key has been used/.test(t)) return 'stale';
  if (/invalid key|bad authkey|authkey|expired|is not valid|requires an auth key|unauthorized|not permitted|http 401|http 403/.test(t)) return 'badkey';
  if (/timeout|deadline|dial tcp|no route to host|lookup |failed to resolve|no dns|network is unreachable|i\/o timeout|connection refused|tls handshake/.test(t)) return 'network';
  if (/register request: http 4/.test(t)) return 'stale';
  return 'unknown';
}

/** Runs a command, never throwing and never rejecting. Auth keys are redacted. */
function run(cmd, args, timeoutMs = 2500) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
        // `tailscale up` says why it refused a key on stderr, so a caller that
        // wants to show the operator the real reason needs it kept.
        if (err) return resolve({ ok: false, stdout: '', stderr: redactKey(stderr || ''), error: redactKey(err.message) });
        resolve({ ok: true, stdout: stdout || '', stderr: redactKey(stderr || ''), error: null });
      });
    } catch (e) {
      resolve({ ok: false, stdout: '', stderr: '', error: redactKey(String(e && e.message || e)) });
    }
  });
}

/** A short-lived TCP probe — is something listening on host:port? */
function tcpAlive(host, port, timeoutMs = 500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      resolve(ok);
    };
    let sock;
    try {
      sock = net.connect({ host, port });
    } catch {
      return resolve(false);
    }
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/**
 * The CIDR Tawny would advertise if asked: an explicit TS_ROUTES when it names
 * one, otherwise the LAN this container sits on. Used everywhere instead of
 * TAWNY_TS_ROUTES directly, because with routing off by default that variable
 * reads 'off' while there is still a perfectly good route to offer.
 */
function ourRoute() {
  if (TAWNY_TS_ROUTES && TAWNY_TS_ROUTES !== 'off') return TAWNY_TS_ROUTES;
  return TAWNY_LAN_CIDR || '';
}

/** Is this container actually set to advertise right now? */
const routesEnabled = () => !!(TAWNY_TS_ROUTES && TAWNY_TS_ROUTES !== 'off');

/** 'advertise' | 'lan-only' | 'unset' — the operator's recorded answer. */
function routeChoice() {
  if (routesEnabled()) return 'advertise';   // already on; nothing to ask
  try {
    const v = readFileSync(ROUTE_CHOICE_FILE, 'utf8').trim();
    return v === 'advertise' || v === 'lan-only' ? v : 'unset';
  } catch { return 'unset'; }
}

function setRouteChoice(v) {
  try { writeFileSync(ROUTE_CHOICE_FILE, v); return true; } catch { return false; }
}

/** The startup-time record from docker/entrypoint.sh's step() helper. */
function readStartupState() {
  if (!TAWNY_SETUP_STATE) return [];
  try {
    const arr = JSON.parse(readFileSync(TAWNY_SETUP_STATE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

/**
 * Live Tailscale state, queried against the socket entrypoint.sh exported —
 * the container's own tailscaled (or, on the host-socket path, the host's).
 * probe.sh runs the same AdvertiseRoutes/AllowedIPs comparison against the
 * *host's* tailscale, which is a false negative under the TS_AUTHKEY path;
 * this runs it against the socket that is actually true for this container.
 */
async function tailscaleInfo() {
  if (!TAWNY_TS_SOCKET) {
    return {
      configured: false,
      mode: 'none',
      hostSocketAvailable: existsSync(TS_HOST_SOCKET),
      reason: 'no TS_AUTHKEY and no host tailscaled socket mounted — this deployment is LAN-only'
    };
  }

  const [statusRes, prefsRes, serveRes] = await Promise.all([
    run('tailscale', [`--socket=${TAWNY_TS_SOCKET}`, 'status', '--json']),
    run('tailscale', [`--socket=${TAWNY_TS_SOCKET}`, 'debug', 'prefs']),
    run('tailscale', [`--socket=${TAWNY_TS_SOCKET}`, 'serve', 'status', '--json'])
  ]);

  // Is `tailscale serve` actually fronting *our* port right now? MagicDNS can
  // hand out a DNSName while HTTPS certs are still off and serve is failing, so
  // dnsName alone must never be read as "the address works". null = the CLI is
  // too old for `serve status --json` and we cannot tell (fall back to the
  // recorded step).
  let serving = null;
  if (serveRes.ok) {
    try {
      const j = JSON.parse(serveRes.stdout || '{}');
      // Match on host and port, not on the exact string we passed in. The CLI
      // stores a normalised form of the target, and a trailing slash or a
      // `localhost` / `[::1]` spelling would read a perfectly good mount as
      // broken — which now blocks completion outright *and* makes setupStatus
      // re-run `tailscale serve` on every single poll.
      const isMine = (u) => {
        try {
          const p = new URL(String(u || ''));
          return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(p.hostname)
            && p.port === String(PORT);
        } catch { return false; }
      };
      serving = false;
      for (const host of Object.values(j.Web || {})) {
        for (const h of Object.values((host && host.Handlers) || {})) {
          if (h && isMine(h.Proxy)) serving = true;
        }
      }
    } catch { serving = null; }
  }

  let self = null;
  let peers = [];
  let rawPeers = [];
  let backendState = '';
  if (statusRes.ok) {
    try {
      const j = JSON.parse(statusRes.stdout);
      backendState = String(j.BackendState || '');
      self = j.Self || null;
      rawPeers = Object.values(j.Peer || {});
      peers = rawPeers.map((p) => ({
        name: p.HostName || (p.DNSName || '').replace(/\.$/, '') || '',
        online: !!p.Online
      }));
    } catch { /* malformed/empty output — leave self/peers empty */ }
  }

  let advertised = [];
  if (prefsRes.ok) {
    try {
      const j = JSON.parse(prefsRes.stdout);
      if (Array.isArray(j.AdvertiseRoutes)) advertised = j.AdvertiseRoutes;
    } catch { /* debug prefs isn't guaranteed JSON on every tailscale build */ }
  }

  const allowedIPs = Array.isArray(self && self.AllowedIPs) ? self.AllowedIPs : [];
  // Only the route Tawny asked for is Tawny's business. On the host-socket
  // path the daemon may advertise several, and one of the operator's own —
  // pending approval since long before this container existed — used to sit in
  // pendingRoutes for ever, which held setupReady() false and bounced every
  // visit to "/" back to /setup with a step nobody could close from here.
  const mine = ourRoute();
  const ours = mine ? advertised.filter((r) => r === mine) : advertised;
  const approvedRoutes = ours.filter((r) => allowedIPs.includes(r));
  const pendingRoutes = ours.filter((r) => !allowedIPs.includes(r));

  // Checked live, not only at the moment we decide whether to advertise: a
  // peer can start carrying the same range at any time, and the operator
  // deserves to see that as the likely cause of "the internet is looping"
  // rather than have it sit invisible in a log from container start. Checked
  // against TAWNY_TS_ROUTES (what we *would* advertise) rather than only
  // `advertised`, so a conflict we correctly declined to advertise still shows.
  const wantedRoutes = mine ? [mine] : [];
  const routeConflicts = findRouteConflicts(rawPeers, wantedRoutes);
  // ...and which of them a peer already carries in full. A conflict says "do
  // not advertise this twice"; coverage says "the path already exists". They
  // are usually the same peer, and conflating them is what made a working
  // deployment report itself unfinished for ever.
  const routeCoveredBy = findRouteCoverage(rawPeers, wantedRoutes);

  return {
    configured: true,
    // 'host'  — driving the machine's own tailscaled; no key was ever needed.
    // 'own'   — this container's tailscaled; a key joins it.
    mode: TAWNY_TS_MODE === 'none' ? 'own' : TAWNY_TS_MODE,
    hostSocketAvailable: existsSync(TS_HOST_SOCKET),
    reachable: statusRes.ok,
    // The daemon runs from boot whether or not a key was ever supplied, so
    // "there is a socket" no longer means "joined". Only BackendState does.
    backendState,
    loggedIn: backendState === 'Running',
    dnsName: self ? String(self.DNSName || '').replace(/\.$/, '') : '',
    online: !!(self && self.Online),
    // Whether `tailscale serve` is fronting our port (true/false), or null if
    // the CLI could not say. serveWanted is false only when the operator turned
    // it off (TS_SERVE=off) for a deployment behind its own TLS proxy — then the
    // https address is not this container's job and completion does not wait on it.
    serving,
    serveWanted: process.env.TS_SERVE !== 'off',
    peers,
    advertisedRoutes: advertised,
    approvedRoutes,
    pendingRoutes,
    routeConflicts,
    routeCoveredBy,
    // Off by default, so /setup has to say so rather than let a deployment
    // look finished while nothing outside the house can reach it.
    routesEnabled: routesEnabled(),
    routeChoice: routeChoice(),
    lanRoute: mine,
    statusError: statusRes.ok ? null : statusRes.error,
    prefsError: prefsRes.ok ? null : prefsRes.error
  };
}

async function coturnInfo() {
  const secretExists = !!TURN_SECRET_FILE && existsSync(TURN_SECRET_FILE);
  const listening = TURN_EMBEDDED ? await tcpAlive('127.0.0.1', TURN_PORT) : false;
  return { embedded: TURN_EMBEDDED, port: TURN_PORT, secretExists, listening };
}

function lanInfo() {
  // Docker's default bridge is 172.17.0.0/16, but a compose or Portainer stack
  // gets its own network from the 172.16/12 pool — 172.19, 172.22, 172.28, at
  // Docker's discretion. Testing only 172.16-19 therefore missed most bridged
  // deployments, which then advertised a container network into the tailnet as
  // if it were the house: the phone is not on it, so nothing could ever
  // connect, and nothing said why.
  //
  // The whole of 172.16/12 is legitimate private space, so the mask is the
  // second signal: every Docker-allocated network is a /16, and a home router
  // handing out a /16 is not a thing. TS_ROUTES overrides either way.
  const looksLikeDockerBridge =
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(TAWNY_LAN_IP) && /\/16$/.test(TAWNY_LAN_CIDR);
  return { ip: TAWNY_LAN_IP || null, cidr: TAWNY_LAN_CIDR || null, looksLikeDockerBridge };
}

async function setupStatus() {
  let [startup, tailscale, coturn] = await Promise.all([
    Promise.resolve(readStartupState()),
    tailscaleInfo().catch((e) => ({ configured: false, reason: String(e && e.message || e) })),
    coturnInfo().catch(() => ({ embedded: false, port: null, secretExists: false, listening: false }))
  ]);
  // Zero-restart HTTPS: if we are joined but `serve` has not succeeded, retry it
  // here. The operator flips MagicDNS + HTTPS certificates once in the admin
  // console and the next poll (≤4 s) publishes the address — no `docker restart`.
  if (tailscale.loggedIn && TAWNY_TS_MODE === 'own' && process.env.TS_SERVE !== 'off') {
    const serveStep = [...startup].reverse().find((s) => s.step === 'tailscale_serve');
    // The live reading outranks the record. A stale-identity recovery archives
    // the state dir, and `tailscale serve`'s configuration lives *in* that
    // directory — so a successful self-heal silently takes the published
    // address with it and leaves a "tailscale_serve ok" step behind describing
    // a mount that no longer exists. (`tailscale serve reset` run on the box
    // does the same.) Without this the address never came back.
    if (!serveStep || serveStep.ok === false || tailscale.serving === false) {
      const r = await tryServe();
      if (r.kind !== 'debounced' && r.kind !== 'skip') startup = readStartupState();
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    startup,
    tailscale,
    lan: lanInfo(),
    coturn
  };
}

// Both /setup.json and the "/" redirect read this. Without a cache, every
// visit to the app would shell out to tailscale twice and open a TCP probe
// just to decide whether to redirect — and the setup page polls besides.
let setupCache = { at: 0, value: null };
async function setupStatusCached(maxAgeMs = 3000) {
  const now = Date.now();
  if (setupCache.value && now - setupCache.at < maxAgeMs) return setupCache.value;
  const value = await setupStatus();
  setupCache = { at: now, value };
  return value;
}

// "This deployment is deliberately LAN-only — stop showing me setup." That is
// a fact about the deployment, not a preference of whoever's browser happened
// to dismiss it, so it lives in the data volume and applies to every device.
const SKIP_FILE = process.env.TAWNY_SKIP_FILE || '/data/setup-skipped';

function setupSkipped() {
  try { return existsSync(SKIP_FILE); } catch { return false; }
}

// Tailscale's own key prefix. Checked before the key reaches a command line so
// a typo produces a sentence rather than a 30-second timeout against nothing.
const AUTHKEY_RE = /^tskey-[A-Za-z0-9._~-]{8,256}$/;

/**
 * Only a machine on the operator's own network may complete first-run setup.
 * Under `network_mode: host` that is already everyone who can reach the port,
 * so this is a backstop against an unexpected exposure rather than the primary
 * control — the primary control is that joining is refused once joined.
 */
function fromLocalNetwork(req) {
  const raw = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (raw === '127.0.0.1' || raw === '::1') return true;
  if (/^f[cd]/i.test(raw)) return true;
  return isLanTarget(raw);
}

function readJsonBody(req, limit = 8192) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); return resolve(null); }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

/** Append to the same file docker/entrypoint.sh writes, in the same shape. */
function recordStep(step, ok, detail, kind = '') {
  if (!TAWNY_SETUP_STATE) return;
  try {
    let arr = [];
    try {
      const parsed = JSON.parse(readFileSync(TAWNY_SETUP_STATE, 'utf8'));
      if (Array.isArray(parsed)) arr = parsed;
    } catch { /* first write, or a truncated file — start clean */ }
    arr.push({ step, ok, detail, kind, at: new Date().toISOString() });
    writeFileSync(TAWNY_SETUP_STATE, JSON.stringify(arr));
  } catch { /* state file is a convenience; never fail a request over it */ }
}

/**
 * Join the tailnet with a key pasted into /setup, so the common first run
 * needs no file editing and no restart. The daemon is already running
 * (docker/entrypoint.sh starts it with or without a key); this is the `up`.
 */
async function joinTailnet(key) {
  const args = [
    `--socket=${TAWNY_TS_SOCKET}`, 'up',
    `--authkey=${key}`,
    `--hostname=${process.env.TAWNY_TS_HOSTNAME || 'tawny'}`,
    // --timeout so a control-plane stall returns a classifiable error instead
    // of blocking until our execFile SIGTERM (whose message leaks the argv).
    '--accept-dns=false', '--accept-routes=false', '--timeout=60s'
  ];
  // --advertise-routes is not passed here — see advertiseRoute() below. Joining
  // first is what lets us check for a conflicting subnet router before
  // announcing anything, exactly as docker/entrypoint.sh now does at boot.

  const up = await run('tailscale', args, 90000);
  if (!up.ok) {
    const detail = (up.stderr || up.error || '').trim().slice(0, 2000);
    // `status --json`, not plain `status`: in the states being classified here
    // the plain output is the single line "Logged out." and nothing more,
    // while the JSON `Health` array reliably carries "the last login error
    // was: register request: http 400: node nodekey:… already exists" — the
    // only string that separates a stale identity from a wrong key. Reading
    // the plain output was letting `stale` go undetected. (Verified against
    // the CLI in the image: plain status omits it, Health has it.)
    const health = await run('tailscale', [`--socket=${TAWNY_TS_SOCKET}`, 'status', '--json'], 4000);
    let healthText = `${health.stdout || ''}${health.stderr || ''}`;
    try {
      const hj = JSON.parse(health.stdout || '{}');
      // Health is an array in current releases, a map in older ones.
      const hs = Array.isArray(hj.Health) ? hj.Health : Object.values(hj.Health || {});
      healthText = [hj.BackendState || '', ...hs.map(String)].join('\n');
    } catch { /* not JSON — the raw output is still worth classifying on */ }
    const kind = classifyUp(`${detail}\n${healthText}`);

    // A leftover node key control won't take back: no key the operator pastes
    // will ever fix this. Queue the archive-and-rejoin for the supervisor loop
    // (this process can't restart tailscaled) and tell the page to keep
    // polling rather than blaming the key.
    if (kind === 'stale') {
      try {
        writeFileSync(TS_RECOVER_REQ, key, { mode: 0o600 });
        recordStep('tailscale_up', false,
          'A Tailscale identity from an earlier run is stuck in the data volume. Tawny is clearing it and will rejoin — this can take a few seconds.',
          'stale');
        return {
          ok: false, kind: 'stale', recovering: true,
          error: 'A leftover Tailscale identity is being cleared. This page will retry on its own.'
        };
      } catch { /* couldn't queue it — fall through to the manual warning */ }
    }

    const outKind = kind === 'stale' ? 'stale_unrecovered' : kind;
    recordStep('tailscale_up', false, detail || 'tailscale up failed', outKind);
    return { ok: false, kind: outKind, error: detail || 'tailscale up failed' };
  }
  recordStep('tailscale_up', true, 'joined the tailnet from the setup page');

  await tryServe();

  const route = await advertiseRoute();
  return { ok: true, route };
}

/**
 * Publish Tawny over `tailscale serve` — idempotent, safe to call on every
 * poll. Only ever on our own node (the operator's is theirs). Enabling the
 * tailnet's MagicDNS + HTTPS-certificate switches cannot be done from a node
 * auth key (no CLI, no public API for the HTTPS one), so this cannot turn them
 * on for you — but it retries the moment you do, with no container restart.
 * `tls_off` is the recorded kind when those switches are the reason.
 */
let lastServeTry = 0;
async function tryServe() {
  if (process.env.TS_SERVE === 'off' || TAWNY_TS_MODE !== 'own' || !TAWNY_TS_SOCKET) return { ok: false, kind: 'skip' };
  const now = Date.now();
  if (now - lastServeTry < 4000) return { ok: false, kind: 'debounced' };
  lastServeTry = now;
  const srv = await run('tailscale',
    [`--socket=${TAWNY_TS_SOCKET}`, 'serve', '--bg', `http://127.0.0.1:${PORT}`], 30000);
  if (srv.ok) { recordStep('tailscale_serve', true, 'published over tailscale serve'); return { ok: true }; }
  const detail = (srv.stderr || srv.error || '').trim().slice(0, 2000);
  const kind = /https|magicdns|cert|admin\/dns|enabling-https/i.test(detail) ? 'tls_off' : 'unknown';
  recordStep('tailscale_serve', false, detail, kind);
  return { ok: false, kind, detail };
}

/**
 * Advertise TAWNY_TS_ROUTES on the container's own tailscaled socket, unless
 * another peer already carries an overlapping range — see
 * docker/route-conflict.js for why that combination is the "internet goes in
 * a loop" report. `force` is the operator overriding that check from /setup
 * after seeing the warning, e.g. because the other router is being retired.
 */
async function advertiseRoute(force = false) {
  const routes = ourRoute();
  if (!routes) {
    return { advertised: false, error: 'No home network was detected, so there is no route to offer.' };
  }

  const status = await run('tailscale', [`--socket=${TAWNY_TS_SOCKET}`, 'status', '--json']);
  let peers = [];
  try { peers = Object.values(JSON.parse(status.stdout).Peer || {}); } catch { /* treat as no peers */ }
  const conflicts = findRouteConflicts(peers, [routes]);

  if (conflicts.length && !force) {
    recordStep('route_conflict', false, JSON.stringify(conflicts));
    return { advertised: false, conflicts };
  }

  // --advertise-routes replaces the list; union ours in rather than writing
  // over whatever this daemon already carries. See mergeRoutes().
  const want = mergeRoutes(await advertisedRoutes(), [routes]);
  const set = await run('tailscale',
    [`--socket=${TAWNY_TS_SOCKET}`, 'set', `--advertise-routes=${want.join(',')}`]);
  if (!set.ok) {
    const detail = (set.stderr || set.error || '').trim().slice(0, 2000);
    recordStep('tailscale_routes', false, detail);
    return { advertised: false, error: detail };
  }
  // Remember it, so a restart does not silently drop back to `off`.
  setRouteChoice('advertise');
  recordStep('tailscale_routes', true, conflicts.length
    ? `advertising ${routes} (forced past a conflict: ${JSON.stringify(conflicts)})`
    : `advertising ${routes} into the tailnet`);
  return { advertised: true, forced: conflicts.length > 0 };
}

/** What this node advertises right now, straight from its prefs. */
async function advertisedRoutes() {
  const prefs = await run('tailscale', [`--socket=${TAWNY_TS_SOCKET}`, 'debug', 'prefs']);
  if (!prefs.ok) return [];
  try {
    const j = JSON.parse(prefs.stdout);
    return Array.isArray(j.AdvertiseRoutes) ? j.AdvertiseRoutes : [];
  } catch { return []; }
}

/**
 * Take Tawny's route back off this node — and only Tawny's.
 *
 * The obvious spelling, `set --advertise-routes=` with nothing after the `=`,
 * withdraws *every* route the node carries. On the host-socket path that is
 * the operator's own daemon, so the "Stop advertising this route" button would
 * have quietly taken their NAS's subnet down with it — while the UI promised
 * "nothing that works today should stop working".
 */
async function withdrawRoutes() {
  // Doubles as the "no, this Wi-Fi only" answer: recorded either way, so the
  // question is asked once and never again.
  setRouteChoice('lan-only');
  const keep = withoutRoute(await advertisedRoutes(), ourRoute());
  const r = await run('tailscale',
    [`--socket=${TAWNY_TS_SOCKET}`, 'set', `--advertise-routes=${keep.join(',')}`]);
  if (r.ok) {
    recordStep('tailscale_routes', true, keep.length
      ? `stopped advertising ${TAWNY_TS_ROUTES}; this device still carries ${keep.join(', ')}`
      : 'withdrew this device\'s advertised route(s) from the setup page');
  }
  return r.ok;
}

/**
 * Did anything fail, as things stand *now*?
 *
 * The state file is an append-only log, so a step can appear several times —
 * a rejected auth key followed by a good one leaves both records behind.
 * Asking "did any record ever fail" therefore condemns a working deployment
 * for a failure it has already recovered from, forever. Only the last record
 * for each step describes the present.
 */
function anyStepFailing(startup, ts) {
  const latest = new Map();
  for (const s of startup || []) if (s && s.step) latest.set(s.step, s);

  for (const [name, s] of latest) {
    if (s.ok !== false) continue;
    // coturn is a fallback for networks that block direct connections. Its
    // absence degrades nothing that most homes will ever notice, so it does
    // not hold the setup open.
    if (name === 'coturn') continue;
    // Declining to advertise a conflicting route is the correct outcome, not
    // a failure — recorded as ok:false only so it is impossible to miss in
    // the raw log. anyStepFailing() must not read it as broken.
    if (name === 'route_conflict') continue;
    // Live state beats the log. A container using the host's daemon never runs
    // `tailscale up` at all, so a stale failure from an earlier configuration
    // can sit in the log for ever with nothing to supersede it — while the
    // node is, right now, plainly joined.
    if ((name === 'tailscale_up' || name === 'tailscale_routes') && ts && ts.loggedIn) continue;
    return true;
  }
  return false;
}

/**
 * Is this deployment finished? Deliberately strict: an unapproved subnet route
 * counts as unfinished, because that is precisely the state where the app
 * appears to work on the LAN and then fails for the person watching from the
 * office. Mirrors the same test in public/setup.js.
 */
function setupReady(s) {
  const ts = s.tailscale || {};
  const lan = s.lan || {};
  if (anyStepFailing(s.startup, ts)) return false;
  if (!lan.cidr || lan.looksLikeDockerBridge) return false;
  if (!ts.configured || !ts.reachable || !ts.loggedIn || !ts.dnsName) return false;
  // A MagicDNS name exists the moment MagicDNS is switched on; the https://
  // address only *works* once `tailscale serve` is fronting our port.
  // renderVerdict() in public/setup.js waits for exactly this, and the two
  // have to agree — a "/" that redirects into the app while the only address
  // a browser will run it on is still 404ing is the disagreement this closes.
  if (ts.serveWanted && ts.serving === false) return false;
  if ((ts.pendingRoutes || []).length) return false;
  // Somebody has to carry a route to the phone's LAN — but it does not have to
  // be us. This used to read any conflict with no route of *our own* as
  // unfinished, which is exactly backwards: the common case is a NAS or an
  // earlier box already routing that range, approved, with Tawny correctly
  // declining to advertise a second time. That deployment works, and marking
  // it unfinished redirected every visit to /setup for ever with a step the
  // operator could not close from here.
  const carried = (ts.approvedRoutes || []).length || (ts.routeCoveredBy || []).length;
  if ((ts.routeConflicts || []).length && !carried) return false;
  // Remote access is off until asked for, and "off" is a legitimate finished
  // state — but only once somebody has actually chosen it. Left as a silent
  // default it would ship a deployment nobody can watch from outside the
  // house, which is the thing people install this for. Unanswered = unfinished.
  if (!carried && ts.routeChoice === 'unset') return false;
  return true;
}

// ------------------------------------------------------------------ http

const handler = async (req, res) => {
  // The app is otherwise read-only over HTTP — signalling is the WebSocket,
  // not POSTs. The /setup/* actions below are the exception: each guards
  // itself (own network only) so the setup page can act without a file edit
  // and a restart.
  const setupPost = req.method === 'POST' && req.url &&
    ['/setup/join', '/setup/skip', '/setup/ts-reset', '/setup/route/advertise', '/setup/route/withdraw']
      .includes(req.url.split('?')[0]);
  if (req.method !== 'GET' && req.method !== 'HEAD' && !setupPost) {
    res.writeHead(405, secureHeaders({ allow: 'GET, HEAD' }));
    return res.end();
  }
  if (!hostAllowed(req)) {
    res.writeHead(421, secureHeaders());
    return res.end();
  }

  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/config.json') {
    // With no RENDEZVOUS_URL set, hand back the origin this request came in on.
    // A phone that scanned a QR for `https://box.example` is then told to sign
    // with `wss://box.example` — an address it has just demonstrably reached —
    // instead of whatever the operator did or did not type into a .env file.
    const { host, proto } = reqOrigin(req);
    const rendezvous = RENDEZVOUS_URL ||
      (host ? `${proto === 'https' ? 'wss' : 'ws'}://${host}` : '');
    return json(res, 200, {
      stun: STUN, turnMode: TURN_MODE, rendezvous, authRequired: false
    });
  }
  if (url.pathname === '/healthz') {
    return json(res, 200, { ok: true, channels: rooms.size, clients: wss.clients.size });
  }
  // Truthful startup/Tailscale/coturn state for an operator who cannot yet
  // reach the ts.net URL — see docker/entrypoint.sh (step()) and setupStatus()
  // above. Reachable over plain HTTP on purpose: hostAllowed() above already
  // gates it the same as every other route, and it is never handed to
  // `tailscale funnel` (see Tawny Docker/DESIGN.md).
  if (url.pathname === '/setup.json') {
    const status = await setupStatusCached();
    return json(res, 200, status);
  }
  // "Use it on this Wi-Fi only." Recorded for the whole deployment rather than
  // in the cookie jar of whichever browser happened to dismiss it — otherwise
  // every new phone in the house meets the setup flow again and has to
  // dismiss it for itself. /setup stays reachable directly, always.
  if (url.pathname === '/setup/skip') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    if (!fromLocalNetwork(req)) {
      return json(res, 403, { error: 'Only from your own network.' });
    }
    try {
      writeFileSync(SKIP_FILE, new Date().toISOString());
      return json(res, 200, { ok: true });
    } catch (e) {
      // No writable volume — the caller falls back to its own cookie, which
      // at least stops nagging the person who asked.
      return json(res, 200, { ok: false, error: String(e && e.message || e) });
    }
  }
  // Paste an auth key into the setup page instead of editing a file. Refused
  // once the node is joined, so this is a first-run window and not a standing
  // "move this container to another tailnet" button.
  if (url.pathname === '/setup/join') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    if (!fromLocalNetwork(req)) {
      return json(res, 403, { error: 'Setup can only be completed from your own network.' });
    }
    if (!TAWNY_TS_SOCKET) {
      return json(res, 503, {
        error: 'Tailscale is not available in this container, so a key cannot be applied here. Set TS_AUTHKEY and restart.'
      });
    }
    // The host-socket path drives the machine's own tailscaled. `tailscale up`
    // there would re-authenticate the operator's actual computer — renaming it
    // to "tawny", possibly onto a different tailnet, and flipping its
    // accept-routes/accept-dns prefs on the way past. A logged-out host daemon
    // is theirs to log in, not ours.
    if (TAWNY_TS_MODE === 'host') {
      return json(res, 409, {
        error: 'This container uses the Tailscale already installed on this machine, so a key here would sign that machine in rather than Tawny. Run `tailscale up` on the machine itself, or set TS_AUTHKEY to give Tawny its own separate node.'
      });
    }
    const before = await setupStatusCached(0);
    if (before.tailscale.loggedIn) {
      return json(res, 409, {
        error: 'This container is already on a tailnet. Run `tailscale logout` in it if you meant to move it.'
      });
    }
    const body = await readJsonBody(req);
    const key = String((body && body.authkey) || '').trim();
    if (!AUTHKEY_RE.test(key)) {
      return json(res, 400, {
        error: 'That does not look like a Tailscale auth key. They begin with tskey- and come from the auth keys page.'
      });
    }
    const result = await joinTailnet(key);
    setupCache = { at: 0, value: null };
    return json(res, result.ok ? 200 : (result.recovering ? 202 : 502), result);
  }
  // Manual "Reset Tailscale identity" — for when the automatic clear at boot or
  // after a paste could not run, or the operator wants to force it. Archives
  // the stuck state dir and rejoins with the key (from the body, or the one
  // joinTailnet() already queued). The supervisor loop does the actual work
  // because it owns the tailscaled process.
  if (url.pathname === '/setup/ts-reset') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    if (!fromLocalNetwork(req)) {
      return json(res, 403, { error: 'Setup can only be completed from your own network.' });
    }
    if (!TAWNY_TS_SOCKET || TAWNY_TS_MODE === 'host') {
      return json(res, 409, { error: 'Only applies to a container running its own tailscaled.' });
    }
    const body = await readJsonBody(req);
    let key = String((body && body.authkey) || '').trim();
    if (!key) { try { key = readFileSync(TS_RECOVER_REQ, 'utf8').trim(); } catch { /* none queued */ } }
    if (!AUTHKEY_RE.test(key)) {
      return json(res, 400, { error: 'Paste the auth key again so Tawny can rejoin after the reset.' });
    }
    try {
      writeFileSync(TS_RECOVER_REQ, key, { mode: 0o600 });
      recordStep('tailscale_up', false, 'Resetting the Tailscale identity and rejoining…', 'stale');
      setupCache = { at: 0, value: null };
      return json(res, 202, { ok: false, recovering: true });
    } catch (e) {
      return json(res, 500, { error: 'Could not queue the reset: ' + String(e && e.message || e) });
    }
  }
  // The operator's answer to a detected route conflict, once they have read
  // the warning: try anyway (they know the other router is retired, or they
  // accept the risk), or give the route up entirely (they hit the loop and
  // want it to stop *now*, without editing .env and restarting).
  if (url.pathname === '/setup/route/advertise') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    if (!fromLocalNetwork(req)) {
      return json(res, 403, { error: 'Setup can only be completed from your own network.' });
    }
    if (!TAWNY_TS_SOCKET) return json(res, 503, { error: 'No Tailscale socket in this container.' });
    const before = await setupStatusCached(0);
    if (!before.tailscale.loggedIn) return json(res, 409, { error: 'Not on a tailnet yet.' });
    const body = await readJsonBody(req);
    const result = await advertiseRoute(!!(body && body.force));
    setupCache = { at: 0, value: null };
    if (result.conflicts && !result.advertised) {
      return json(res, 409, {
        error: 'Another device on your tailnet already carries this range. Advertising it too is what causes a routing loop — pass force to do it anyway.',
        conflicts: result.conflicts
      });
    }
    return json(res, result.advertised || !result.error ? 200 : 502, result);
  }
  if (url.pathname === '/setup/route/withdraw') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    if (!fromLocalNetwork(req)) {
      return json(res, 403, { error: 'Setup can only be completed from your own network.' });
    }
    if (!TAWNY_TS_SOCKET) return json(res, 503, { error: 'No Tailscale socket in this container.' });
    const ok = await withdrawRoutes();
    setupCache = { at: 0, value: null };
    return json(res, ok ? 200 : 502, { ok });
  }
  if (url.pathname === '/setup') {
    try {
      const body = await readFile(join(PUBLIC, 'setup.html'));
      res.writeHead(200, secureHeaders({
        'content-type': MIME['.html'],
        'content-length': body.length,
        'cache-control': 'no-cache'
      }));
      return res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      return json(res, 404, { error: 'not found' });
    }
  }
  // An unfinished deployment opens the setup flow instead of the app. The
  // operator's first visit is the one that needs the instructions, and the
  // failure this avoids is silent: the app loads fine on the LAN, so nothing
  // suggests anything is wrong until someone tries to watch from elsewhere.
  //
  // Escapable, and permanently: the setup page offers a link that sets this
  // cookie, so a deliberately LAN-only deployment is not nagged forever.
  if ((req.method === 'GET' || req.method === 'HEAD') &&
      (url.pathname === '/' || url.pathname === '/index.html') &&
      !setupSkipped() &&
      !/(?:^|;\s*)tawny_setup_done=1(?:;|$)/.test(req.headers.cookie || '')) {
    const status = await setupStatusCached();
    if (!setupReady(status)) {
      res.writeHead(302, secureHeaders({ location: '/setup', 'cache-control': 'no-store' }));
      return res.end();
    }
  }
  // Parity with the rendezvous Worker, so a self-hoster has the same URL to
  // point at. It carries its own headers rather than secureHeaders(): the page
  // is a single body with an inline <style> and no subresources, which the
  // app's `default-src 'none'; style-src 'self'` CSP would block.
  if (url.pathname === '/privacy' || url.pathname === '/privacy/') {
    const body = Buffer.from(PRIVACY_HTML);
    res.writeHead(200, { ...PRIVACY_HEADERS, 'content-length': body.length });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  if (url.pathname === '/turn') {
    const room = String(url.searchParams.get('room') || '');
    if (!ROOM_RE.test(room)) return json(res, 400, { error: 'bad room' });
    const haveTurn = TURN_SECRET && (TURN_URLS.length || TURN_EMBEDDED);
    if (!haveTurn) return json(res, 404, { error: 'no turn configured' });
    // Must present a ticket valid for this room — no free credential farming.
    // Checked before minting anything, so an unpaired caller cannot get a
    // credential for a relay it was never let into a channel on.
    const rec = tickets.get(room);
    if (!ticketLive(rec) ||
        sha256hex(url.searchParams.get('t') || '') !== rec.hashT) {
      return json(res, 403, { error: 'not paired' });
    }
    const creds = await turnCreds(req);
    if (!creds) return json(res, 404, { error: 'no turn configured' });
    return json(res, 200, creds);
  }

  let rel;
  try { rel = decodeURIComponent(url.pathname); }
  catch { return json(res, 400, { error: 'bad path' }); }
  if (rel.includes('\0')) return json(res, 400, { error: 'bad path' });
  if (rel.endsWith('/')) rel += 'index.html';

  const file = normalize(join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + sep) && file !== PUBLIC) {
    res.writeHead(403, secureHeaders());
    return res.end();
  }

  try {
    let body = await readFile(file);
    // The page carries a <meta> CSP too, as defence in depth for anyone serving
    // these files from something other than this process. A static file cannot
    // know the rendezvous host, so that copy used to fall back to the blanket
    // `ws: wss: https:` this header just stopped emitting. Substitute the real
    // source list so there is one definition rather than two that drift.
    if (extname(file) === '.html') {
      body = Buffer.from(
        body.toString('utf8').split(CONNECT_SRC_TOKEN).join(CONNECT_SRC), 'utf8'
      );
    }
    res.writeHead(200, secureHeaders({
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache'
    }));
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    json(res, 404, { error: 'not found' });
  }
};

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, secureHeaders({
    'content-type': MIME['.json'],
    'content-length': body.length,
    'cache-control': 'no-store'
  }));
  res.end(body);
}

// ------------------------------------------------------------- signaling

/** @type {Map<string, Map<string, import('ws').WebSocket>>} */
const rooms = new Map();
const perIP = new Map();
// room -> { hashT, auth, exp }. Zero-secret admission: the Watcher's
// {type:'hello'} carries sha256(ticket); a Handheld's hello must carry the
// matching ticket. `auth` is sha256("tawny-auth-v1|" + channel key) when the
// Watcher offered it — proof of the key, which this server stores but can never
// derive, and the only thing that lets a Watcher reclaim its own room.
// Set REQUIRE_TICKET=off for a bare LAN-style deployment with no tickets.
const tickets = new Map();
const sha256hex = (s) => createHash('sha256').update(String(s)).digest('hex');
const HEX64 = /^[a-f0-9]{64}$/;
const TICKET_TTL = 24 * 60 * 60_000;
// Absolute ceiling on a ticket's life, mirroring rendezvous/room.js. A Monitor
// re-registers the same stored ticket every time it reconnects, which would
// otherwise push the idle TTL out indefinitely and leave a leaked pairing link
// valid forever. Re-registering the same hashT keeps the original issue time;
// only a re-paired channel (a different hashT) starts a new lifetime.
const TICKET_MAX_LIFETIME = 30 * 24 * 60 * 60_000;
const issuedAt = (rec) => rec.iss ?? (rec.exp - TICKET_TTL);
const ticketLive = (rec) =>
  !!rec && Date.now() <= rec.exp && Date.now() - issuedAt(rec) < TICKET_MAX_LIFETIME;
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MSG });

// Every relayed type is addressed. Peer ids come from the server, so a client
// cannot blind-broadcast into a channel it has joined.
//
// Must list every addressed `type` public/app.js sends through sig(): a type
// missing here is dropped in silence and its feature simply never happens on
// this transport. This list had fallen four types behind the client — the lens
// picker, remote zoom, pet-name sync and the Light key were all being discarded
// here. Keep it in step with LocalWeb.kt and rendezvous/room.js.
const RELAY = new Set([
  'offer', 'answer', 'ice', 'bye', 'chime', 'chime-ack', 'talking',
  'cameras', 'meta', 'camera-control', 'torch', 'battery'
]);

// ------------------------------------------------------- the LAN bridge
//
// Why this exists, in one paragraph.
//
// The Monitor is the Android app. On a home network it hosts its own signalling
// relay on `ws://<phone-ip>:8820` and advertises it in the pairing QR as `h=`.
// A browser Viewer cannot dial that: it has to be served over https to be given
// a microphone for talk-back, and an https page may not open a cleartext ws://
// — mixed content, no exception for private addresses. Nor can the phone come
// to us instead: the shipped app (v0.3.1) can only reach a rendezvous over
// wss://, its WebView trusts system CAs only, and no home LAN address can hold
// a publicly-trusted certificate.
//
// So this process stands in the middle. The browser opens
// `wss://<node>.<tailnet>.ts.net/lan/<phone-ip>/<port>/ws?…` — same origin, so
// the page's own CSP allows it and Tailscale's TLS covers the whole path the
// browser can see — and we hand the handshake through to the phone over the LAN
// in cleartext, byte for byte. Nothing is re-framed, nothing is parsed: the
// relay's HMAC challenge, the room ids and the SDP all pass through untouched,
// and this process learns no more than a switch does.
//
// This works from anywhere, not just from the sofa, because the container is on
// the phone's LAN by definition — it is the box in the house. The Viewer's
// distance from the phone is Tailscale's problem, not the bridge's.
//
// Media never comes near this process. It is peer-to-peer between the browser
// and the phone, on 192.168.1.0/24 — which the remote Viewer is also in, via
// the subnet route this container advertises. See DESIGN.md.
//
// Only private space is dialable. A bridge that would open a socket to any host
// the query string named is a server-side request forgery hole, so the target
// must be an address that can only be a device on the operator's own network.
const LAN_BRIDGE_RE = /^\/lan\/(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,5})\/ws$/;
const MAX_BRIDGES = 16;
let bridges = 0;

function isLanTarget(ip) {
  const o = ip.split('.').map(Number);
  if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (o[0] === 10) return true;                                   // 10/8
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;      // 172.16/12
  if (o[0] === 192 && o[1] === 168) return true;                  // 192.168/16
  if (o[0] === 169 && o[1] === 254) return true;                  // link-local
  if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return true;     // 100.64/10 — a tailnet phone
  return false;
}

function lanBridge(req, socket, head, ip, port, search) {
  const fail = (code, why) => {
    try { socket.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`); } catch {}
    socket.destroy();
  };
  if (bridges >= MAX_BRIDGES) return fail(503, 'Service Unavailable');
  const key = String(req.headers['sec-websocket-key'] || '');
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) return fail(400, 'Bad Request');
  const ver = String(req.headers['sec-websocket-version'] || '13');
  if (!/^\d{1,3}$/.test(ver)) return fail(400, 'Bad Request');

  bridges += 1;
  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    bridges -= 1;
    try { up.destroy(); } catch {}
    try { socket.destroy(); } catch {}
  };

  const up = net.connect({ host: ip, port });
  up.setTimeout(6000);
  up.on('timeout', () => { if (!done) fail(504, 'Gateway Timeout'); close(); });
  up.on('error', () => { if (!done) fail(502, 'Bad Gateway'); close(); });
  socket.on('error', close);
  up.on('close', close);
  socket.on('close', close);

  up.on('connect', () => {
    up.setTimeout(0);
    // Built by hand rather than forwarded. The client's Origin, Cookie and
    // Sec-WebSocket-Extensions have no business on the LAN leg — the relay on
    // the phone checks none of them, and permessage-deflate negotiated end to
    // end through an opaque byte pipe is the one thing that could not survive
    // this. Sec-WebSocket-Key is passed through so the 101 the phone sends back
    // carries an Accept the browser will verify against its own key.
    up.write(
      `GET /ws${search} HTTP/1.1\r\n` +
      `Host: ${ip}:${port}\r\n` +
      'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
      `Sec-WebSocket-Version: ${ver}\r\nSec-WebSocket-Key: ${key}\r\n\r\n`
    );
    if (head && head.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
    log(`~ bridge -> ${ip}:${port} (${bridges})`);
  });
}

const onUpgrade = (req, socket, head) => {
  const ip = clientIP(req);
  const deny = (code, why) => {
    socket.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return socket.destroy(); }

  const lan = LAN_BRIDGE_RE.exec(url.pathname);
  if (lan) {
    if (!hostAllowed(req)) return deny(421, 'Misdirected Request');
    if (!originAllowed(req)) { noteFail(ip); return deny(403, 'Forbidden'); }
    if (lockedOut(ip)) return deny(429, 'Too Many Requests');
    const port = Number(lan[2]);
    if (!isLanTarget(lan[1]) || !(port >= 1024 && port <= 65535)) {
      return deny(403, 'Forbidden');
    }
    return lanBridge(req, socket, head, lan[1], port, url.search);
  }

  if (!/(^|\/)ws$/.test(url.pathname)) return socket.destroy();
  if (!hostAllowed(req)) return deny(421, 'Misdirected Request');
  if (!originAllowed(req)) { noteFail(ip); return deny(403, 'Forbidden'); }
  if (lockedOut(ip)) return deny(429, 'Too Many Requests');
  if (wss.clients.size >= MAX_TOTAL) return deny(503, 'Service Unavailable');
  if ((perIP.get(ip) || 0) >= MAX_PER_IP) return deny(429, 'Too Many Requests');

  const room = String(url.searchParams.get('room') || '');
  if (!ROOM_RE.test(room)) return deny(400, 'Bad Request');

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, { room, ip, url }));
};

// A device must send {type:'hello'} first and pass admission before it is joined
// to the room or told about anyone. A Handheld's hello carries the pairing
// ticket `t`; the Watcher's carries `hashT = sha256(t)` to register it.
const REQUIRE_TICKET = process.env.REQUIRE_TICKET !== 'off';

wss.on('connection', (ws, req, ctx) => {
  const { room, ip, url } = ctx;
  const role = url.searchParams.get('role') === 'station' ? 'station' : 'viewer';
  const id = randomUUID().slice(0, 8);

  ws.meta = { id, room, role, ip, pending: true };
  ws.isAlive = true;
  // Counted from the moment the socket exists, not from admission, so an
  // unadmitted socket cannot be used to sidestep the per-IP cap.
  perIP.set(ip, (perIP.get(ip) || 0) + 1);
  ws.on('pong', () => { ws.isAlive = true; });

  // Say hello or go away. Cleared on admission and on close.
  ws.admitTimer = setTimeout(() => {
    if (ws.meta.pending) { noteFail(ip); try { ws.close(4008, 'no hello'); } catch {} }
  }, ADMIT_TIMEOUT_MS);
  ws.admitTimer.unref?.();

  const admit = (msg) => {
    let rec = tickets.get(room);
    if (rec && !ticketLive(rec)) { tickets.delete(room); rec = null; }

    // Deliberately do NOT create the room entry here. It used to be an
    // unconditional `rooms.set(room, new Map())` above every rejection path,
    // and `ws.on('close')` bails out early for a socket that never joined — so
    // each refused admission left a permanent empty Map behind and the map grew
    // without bound. Same bug LocalWeb.kt calls out; it was only ever fixed
    // there. The entry is created on success, in the one place below.
    const peers = rooms.get(room) || new Map();
    const proof = typeof msg.a === 'string' && HEX64.test(msg.a) ? msg.a : null;

    // Capacity first: nothing that gets rejected may change stored state. See
    // rendezvous/room.js — registering the ticket for a socket that is then
    // turned away let a caller who knew only the room id re-key the channel on
    // its way out, locking every paired Handheld to 4008 until the TTL expired.
    if (peers.size >= MAX_PER_ROOM) return ws.close(4003, 'channel full');
    if (!rooms.has(room) && rooms.size >= MAX_ROOMS) return ws.close(4005, 'busy');
    let evict = [];
    if (role === 'station') {
      const stations = [...peers.values()].filter((p) => p.meta.role === 'station');
      if (stations.length >= MAX_STATIONS) {
        // A Watcher whose network dropped is still on the books until the
        // heartbeat notices. Only the holder of the channel key may take the
        // room back from it; everyone else keeps getting 4004.
        if (!(rec?.auth && proof === rec.auth)) return ws.close(4004, 'monitor already running');
        evict = stations;
      }
    }

    let register = null;
    if (role === 'viewer') {
      if (REQUIRE_TICKET && (!rec || sha256hex(msg.t) !== rec.hashT)) return ws.close(4008, 'pairing expired');
    } else { // station
      if (rec?.auth && proof && proof !== rec.auth) return ws.close(4008, 'wrong channel key');
      const mayRekey = proof !== null || !rec?.auth;
      const hashT = typeof msg.hashT === 'string' && HEX64.test(msg.hashT) ? msg.hashT : null;
      if (hashT && mayRekey) {
        register = {
          hashT, auth: proof || rec?.auth || null,
          iss: rec && rec.hashT === hashT ? issuedAt(rec) : Date.now(),
          exp: Date.now() + TICKET_TTL
        };
      } else if (rec) {
        if (sha256hex(msg.t) !== rec.hashT) return ws.close(4008, 'pairing expired');
      } else if (REQUIRE_TICKET) {
        return ws.close(4008, 'no pairing ticket');
      }
    }

    // Admitted. Only now may the ticket move, or a sitting Watcher be hung up
    // on — and the evicted peer leaves the map here rather than whenever its
    // close event lands, so it is not in the welcome we are about to send.
    if (register) tickets.set(room, register);
    // First admission into this room is what creates it.
    if (!rooms.has(room)) rooms.set(room, peers);
    for (const p of evict) {
      peers.delete(p.meta.id);
      for (const peer of peers.values()) send(peer, { type: 'peer-left', id: p.meta.id });
      p.close(4005, 'replaced by owner');
    }

    ws.meta.pending = false;
    clearTimeout(ws.admitTimer);
    peers.set(id, ws);
    send(ws, {
      type: 'welcome', id, role,
      peers: [...peers.values()].filter((p) => p !== ws)
        .map((p) => ({ id: p.meta.id, role: p.meta.role }))
    });
    for (const peer of peers.values()) {
      if (peer !== ws) send(peer, { type: 'peer-joined', id, role });
    }
    log(`+ ${role} ${id} -> ${room.slice(0, 8)} (${peers.size})`);
  };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (ws.meta.pending) {
      if (msg.type !== 'hello') return ws.close(4000, 'expected hello');
      return admit(msg);
    }
    if (!RELAY.has(msg.type) || typeof msg.to !== 'string') return;
    const peers = rooms.get(room);
    const target = peers?.get(msg.to);
    if (!target || target === ws) return;
    msg.from = id;
    send(target, msg);
  });

  ws.on('close', () => {
    clearTimeout(ws.admitTimer);
    const n = (perIP.get(ip) || 1) - 1;
    if (n <= 0) perIP.delete(ip); else perIP.set(ip, n);
    const peers = rooms.get(room);
    if (!peers || !peers.has(id)) {
      // A socket that never joined. It owns nothing, but it may have been the
      // reason an empty room is sitting there if anything ever creates one
      // early again — so sweep the room if it is empty rather than trusting it.
      if (peers && peers.size === 0) rooms.delete(room);
      return;
    }
    peers.delete(id);
    log(`- ${role} ${id} <- ${room.slice(0, 8)} (${peers.size})`);
    if (peers.size === 0) rooms.delete(room);
    else for (const peer of peers.values()) send(peer, { type: 'peer-left', id });
  });

  ws.on('error', () => ws.terminate());
});

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
  const now = Date.now();
  for (const [ip, rec] of fails) if (now > rec.until) fails.delete(ip);
  for (const [room, rec] of tickets) if (!ticketLive(rec)) tickets.delete(room);
}, 30_000);
heartbeat.unref?.();

// Channel ids and tokens are secrets; request URLs never reach the log.
function log(line) {
  console.log(`${new Date().toISOString()} ${line}`);
}

// ------------------------------------------------------------- listener
//
// One, plain HTTP. `tailscale serve` sits in front of it and is what a browser
// actually talks to — https://<node>.<tailnet>.ts.net, Let's Encrypt, no
// warning and nothing for anyone to import. The X-Forwarded-* headers it sets
// are how /config.json still hands a client the address it really arrived on;
// see reqOrigin().

const servers = [];
const httpServer = http.createServer(handler);
httpServer.on('upgrade', onUpgrade);
servers.push({ s: httpServer, port: PORT, scheme: 'http' });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.close(1001, 'server shutting down');
    let left = servers.length;
    for (const { s } of servers) s.close(() => { if (--left === 0) process.exit(0); });
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

let pending = servers.length;
for (const { s, port, scheme } of servers) {
  s.listen(port, HOST, () => {
    log(`tawny listening on ${scheme}://${HOST}:${port}`);
    if (--pending) return;
    log(`allowed hosts: ${ALLOWED_HOSTS.length ? ALLOWED_HOSTS.join(', ') : 'any (set ALLOWED_HOSTS to pin)'}`);
    log(`stun: ${STUN.length ? STUN.join(', ') : 'none (LAN / tailnet only)'}`);
    log(`rendezvous: ${RENDEZVOUS_URL || 'derived from each request Host header'}`);
    log(`lan bridge: /lan/<private-ipv4>/<port>/ws -> the app's own relay`);
    log(`turn: ${
      TURN_URLS.length ? `${TURN_URLS.join(', ')}${TURN_SECRET ? '' : ' (NO SECRET — /turn will 404)'}`
        : TURN_EMBEDDED && TURN_SECRET ? `embedded coturn on :${TURN_PORT}, host from each request${PUBLIC_HOST ? ` (pinned to ${PUBLIC_HOST})` : ''}`
        : 'none — peer-to-peer only'
    }`);
  });
}
