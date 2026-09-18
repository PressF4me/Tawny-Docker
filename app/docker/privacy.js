// Harder privacy — the operator's own networking, every inch of it, set from
// /setup and kept in the data volume.
//
// The normal container is built to be forgiving: public STUN when nothing else
// is set, the host's tailscaled if one happens to be mounted, Tailscale's own
// coordination server, `tailscale serve` for TLS, tailscaled's diagnostic logs
// going to Tailscale. Every one of those is a sensible default and a party the
// operator did not pick. With this file enabled, none of them is assumed: the
// container uses exactly what is written here, blank means none, and a setting
// that is wrong fails rather than being papered over by a default.
//
// One file, three readers:
//   - docker/entrypoint.sh runs `node privacy.js --env` at boot and evals the
//     exports, so tailscaled, coturn and server.js all start from it;
//   - server.js serves it to /setup, validates edits and writes them back;
//   - the tests in tools/ exercise validate() and toEnv() directly.
//
// Fail closed. A file that says `enabled` and cannot be read or validated
// starts the container with every networked piece OFF (no Tailscale, no TURN,
// no STUN) and /setup still answering, so the operator can fix it. Falling back
// to the ordinary defaults would be exactly the silent fallback this mode
// exists to remove.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRIVACY_FILE = process.env.TAWNY_PRIVACY_FILE || '/data/privacy.json';

export const DEFAULTS = Object.freeze({
  enabled: false,
  // 'own'  — this container runs its own tailscaled (needs an auth key)
  // 'host' — drive the host's tailscaled through the mounted socket
  // 'off'  — no Tailscale at all: the operator brings their own network
  tailscale: 'own',
  // A self-hosted control server (Headscale). Blank = Tailscale's own.
  loginServer: '',
  // tailscaled's diagnostic log upload to Tailscale. Off = --no-logs-no-support.
  tsLogs: false,
  // 'tailscale' — `tailscale serve` with a ts.net certificate
  // 'files'     — server.js terminates TLS itself with the operator's cert
  // 'proxy'     — the operator's own reverse proxy terminates TLS in front
  // 'none'      — plain http only (browsers will not start a session)
  tls: 'tailscale',
  tlsCert: '/data/tls/fullchain.pem',
  tlsKey: '/data/tls/privkey.pem',
  httpsPort: 8443,
  // Blank = no STUN at all. Never the public list.
  stun: [],
  // The coturn inside this image.
  turnEmbedded: true,
  turnPort: 3478,
  turnMinPort: 49160,
  turnMaxPort: 49200,
  // coturn over TLS (turns:) with the same certificate; tls 'files' only.
  turnTls: false,
  turnTlsPort: 5349,
  // An external TURN the operator runs, with its use-auth-secret secret.
  turnUrls: [],
  turnSecret: '',
  // Public address for relay candidates, behind a port forward.
  publicIp: '',
  // 'auto' (relay only if nothing direct works), 'always', 'never'.
  turnMode: 'auto',
  // External signalling relay handed to browsers. Blank = this server.
  rendezvous: '',
  // The /lan/<ip>/<port>/ws bridge to an Android Monitor's own relay.
  lanBridge: true,
  // Hostnames this server answers on. Blank = keep whatever the environment says.
  allowedHosts: [],
  // Believe X-Forwarded-* from private addresses (a reverse proxy).
  trustProxy: true
});

const TS_MODES = ['own', 'host', 'off'];
const TLS_MODES = ['tailscale', 'files', 'proxy', 'none'];
const TURN_MODES = ['auto', 'always', 'never'];

// Everything that reaches a shell export is held to a character set that
// cannot break out of single quotes even before toEnv() quotes it.
const HOSTNAME = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*';
const HOST_RE = new RegExp(`^${HOSTNAME}$`);
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_RE = /^[0-9A-Fa-f:]{2,39}$/;
const LOGIN_RE = new RegExp(`^https?://${HOSTNAME}(?::\\d{1,5})?(?:/[A-Za-z0-9._~/-]*)?$`);
const RELAY_RE = new RegExp(`^wss?://${HOSTNAME}(?::\\d{1,5})?(?:/[A-Za-z0-9._~/-]*)?$`);
const STUN_RE = /^stuns?:[A-Za-z0-9.\-[\]:]+(?:\?transport=(?:udp|tcp))?$/;
const TURN_RE = /^turns?:[A-Za-z0-9.\-[\]:]+(?:\?transport=(?:udp|tcp))?$/;
const PATH_RE = /^\/[A-Za-z0-9._/-]{1,255}$/;
const SECRET_RE = /^[A-Za-z0-9!#$%&()*+,\-./:;<=>?@[\]^_{|}~]{8,256}$/;

function isIPv4(s) {
  const m = IPV4_RE.exec(s);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

function asList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return String(v || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
}

function asPort(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
}

const bool = (v, d) => (v === undefined || v === null ? d : v === true || v === 'on' || v === 'true');

/**
 * Normalise and check a config. Returns { ok, value, errors, warnings } where
 * errors are keyed by field (for the form to point at) and warnings are the
 * consequences the operator should read before choosing them — never a reason
 * to refuse, because the choice is theirs.
 *
 * `prev` supplies the stored TURN secret when the form leaves it blank: /setup
 * never sends a secret back to a browser, so blank on save means "keep it".
 */
export function validate(input, prev = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const v = {
    enabled: bool(src.enabled, false),
    tailscale: String(src.tailscale ?? DEFAULTS.tailscale),
    loginServer: String(src.loginServer ?? '').trim().replace(/\/+$/, ''),
    tsLogs: bool(src.tsLogs, DEFAULTS.tsLogs),
    tls: String(src.tls ?? DEFAULTS.tls),
    tlsCert: String(src.tlsCert ?? DEFAULTS.tlsCert).trim(),
    tlsKey: String(src.tlsKey ?? DEFAULTS.tlsKey).trim(),
    httpsPort: asPort(src.httpsPort ?? DEFAULTS.httpsPort),
    stun: asList(src.stun),
    turnEmbedded: bool(src.turnEmbedded, DEFAULTS.turnEmbedded),
    turnPort: asPort(src.turnPort ?? DEFAULTS.turnPort),
    turnMinPort: asPort(src.turnMinPort ?? DEFAULTS.turnMinPort),
    turnMaxPort: asPort(src.turnMaxPort ?? DEFAULTS.turnMaxPort),
    turnTls: bool(src.turnTls, DEFAULTS.turnTls),
    turnTlsPort: asPort(src.turnTlsPort ?? DEFAULTS.turnTlsPort),
    turnUrls: asList(src.turnUrls),
    turnSecret: String(src.turnSecret ?? '').trim() || String(prev.turnSecret || ''),
    publicIp: String(src.publicIp ?? '').trim(),
    turnMode: String(src.turnMode ?? DEFAULTS.turnMode),
    rendezvous: String(src.rendezvous ?? '').trim().replace(/\/+$/, ''),
    lanBridge: bool(src.lanBridge, DEFAULTS.lanBridge),
    allowedHosts: asList(src.allowedHosts).map((h) => h.toLowerCase()),
    trustProxy: bool(src.trustProxy, DEFAULTS.trustProxy)
  };
  const errors = {};
  const warnings = [];
  const err = (k, m) => { if (!errors[k]) errors[k] = m; };
  const port = (k) => {
    if (!(v[k] >= 1 && v[k] <= 65535)) err(k, 'A port number from 1 to 65535.');
  };

  if (!TS_MODES.includes(v.tailscale)) err('tailscale', 'Pick one of the three.');
  if (!TLS_MODES.includes(v.tls)) err('tls', 'Pick one of the four.');
  if (!TURN_MODES.includes(v.turnMode)) err('turnMode', 'Pick one of the three.');

  if (v.loginServer && !LOGIN_RE.test(v.loginServer)) {
    err('loginServer', 'A URL like https://headscale.example.net — or blank for Tailscale’s own.');
  }
  if (v.tls === 'tailscale' && v.tailscale === 'off') {
    err('tls', 'HTTPS through Tailscale needs Tailscale. Pick your own certificate, a proxy, or none.');
  }
  if (v.tls === 'files') {
    if (!PATH_RE.test(v.tlsCert)) err('tlsCert', 'An absolute path inside the container, e.g. /data/tls/fullchain.pem.');
    if (!PATH_RE.test(v.tlsKey)) err('tlsKey', 'An absolute path inside the container, e.g. /data/tls/privkey.pem.');
    port('httpsPort');
  }
  for (const u of v.stun) if (!STUN_RE.test(u)) { err('stun', `Not a STUN address: ${u.slice(0, 80)}`); break; }
  for (const u of v.turnUrls) if (!TURN_RE.test(u)) { err('turnUrls', `Not a TURN address: ${u.slice(0, 80)}`); break; }
  if (v.turnUrls.length && !SECRET_RE.test(v.turnSecret)) {
    err('turnSecret', 'Your TURN server’s static-auth-secret (8–256 characters, no spaces or quotes).');
  }
  if (v.turnEmbedded) {
    port('turnPort'); port('turnMinPort'); port('turnMaxPort');
    if (v.turnMinPort > v.turnMaxPort) err('turnMaxPort', 'Must not be below the first relay port.');
  }
  if (v.turnTls) {
    if (v.tls !== 'files') err('turnTls', 'TURN over TLS reuses your certificate files, so HTTPS must be “my own certificate”.');
    else if (!v.turnEmbedded) err('turnTls', 'Only applies to the built-in relay.');
    port('turnTlsPort');
  }
  if (v.publicIp && !isIPv4(v.publicIp) && !IPV6_RE.test(v.publicIp)) {
    err('publicIp', 'An IP address (coturn’s external-ip), or blank.');
  }
  if (v.rendezvous && !RELAY_RE.test(v.rendezvous)) {
    err('rendezvous', 'A wss:// URL, or blank to use this server.');
  }
  for (const h of v.allowedHosts) {
    const bare = h.replace(/:\d{1,5}$/, '');
    if (!HOST_RE.test(bare) && !isIPv4(bare)) { err('allowedHosts', `Not a hostname: ${h.slice(0, 80)}`); break; }
  }
  const noTurn = !v.turnEmbedded && !v.turnUrls.length;
  if (v.turnMode === 'always' && noTurn) {
    err('turnMode', '“Always relay” needs a TURN server: the built-in one, or yours.');
  }
  const ports = [
    ['httpsPort', v.tls === 'files'], ['turnPort', v.turnEmbedded], ['turnTlsPort', v.turnTls]
  ].filter(([, on]) => on).map(([k]) => k);
  const httpPort = Number(process.env.PORT || 8099);
  for (const k of ports) if (v[k] === httpPort) err(k, `Port ${httpPort} is already the plain-http port.`);
  for (let i = 0; i < ports.length; i++) {
    for (let j = i + 1; j < ports.length; j++) {
      if (v[ports[i]] === v[ports[j]]) err(ports[j], 'Two services cannot share a port.');
    }
  }

  // What each choice gives up, in words. Shown, never enforced.
  if (v.tailscale !== 'off' && !v.loginServer) {
    warnings.push('Tailscale’s coordination server will know this machine, its devices and when they connect (never the video). Point it at your own Headscale to avoid that.');
  }
  if (v.tailscale !== 'off' && v.tsLogs) {
    warnings.push('tailscaled will upload its diagnostic logs to Tailscale.');
  }
  if (v.tailscale === 'off') {
    warnings.push('No Tailscale: nothing here gets a viewer outside the house into this network. That is your VPN, WireGuard, port forward or other tool now, and Tawny cannot check it.');
  }
  if (v.tls === 'none') {
    warnings.push('No HTTPS: a browser refuses to start a session on a plain http:// address (camera and microphone need a secure page). Only the Android app on this Wi-Fi will work.');
  }
  if (v.tls === 'proxy') {
    warnings.push('Your reverse proxy must terminate TLS, forward WebSockets, and set X-Forwarded-Proto/Host. Tawny cannot see or check it.');
  }
  if (v.tls === 'files') {
    warnings.push('The Android app only trusts certificates from public certificate authorities (for example Let’s Encrypt). A certificate from your own CA works in browsers once that CA is installed on each device, but the app will refuse it.');
  }
  if (!v.stun.length) {
    warnings.push('No STUN: devices cannot learn their public address, so two different networks only connect through a VPN or TURN.');
  }
  if (v.turnMode === 'never') {
    warnings.push('No TURN relay ever: networks that block direct connections (carrier NAT on both ends, strict office Wi-Fi) will not connect.');
  }
  if (noTurn && v.turnMode !== 'never') {
    warnings.push('No TURN server is configured, so there is no relay when a direct path fails.');
  }
  if (v.rendezvous.startsWith('ws://')) {
    warnings.push('Your rendezvous is ws://, which is not encrypted, and an https page will not open it. Use wss://.');
  }
  if (!v.lanBridge) {
    warnings.push('LAN bridge off: a browser cannot pair with an Android Monitor’s own Wi-Fi relay through this server. Browser-to-browser pairing, and the app’s rendezvous, are unaffected.');
  }
  if (v.turnEmbedded && !v.publicIp && v.tailscale === 'off') {
    warnings.push('With no public IP set, the built-in relay only hands out addresses on this network. Behind a port forward, set the public IP.');
  }
  return { ok: Object.keys(errors).length === 0, value: v, errors, warnings };
}

/** The stored config, or null (no file / unreadable). Never throws. */
export function readPrivacy(file = PRIVACY_FILE) {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return { enabled: true, _broken: true };
  }
}

/** Atomic write, 0600 (it can hold a TURN secret). */
export function writePrivacy(value, file = PRIVACY_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

/** A copy with the TURN secret replaced by whether one is set — for browsers. */
export function redact(value) {
  if (!value || typeof value !== 'object') return value;
  const { turnSecret, ...rest } = value;
  return { ...rest, turnSecretSet: !!turnSecret };
}

/**
 * The environment the rest of the container runs on, for an enabled config.
 * Keys are the same variables docker-compose.yml documents, so server.js and
 * the entrypoint read one set of names whichever way they were set.
 */
export function toEnv(v) {
  const on = (b) => (b ? 'on' : 'off');
  const env = {
    TAWNY_PRIVACY: 'on',
    TS_DISABLE: on(v.tailscale === 'off'),
    TS_MODE_WANTED: v.tailscale,
    TS_LOGIN_SERVER: v.tailscale === 'off' ? '' : v.loginServer,
    TS_NO_LOGS: on(!v.tsLogs),
    TS_SERVE: on(v.tls === 'tailscale' && v.tailscale !== 'off'),
    TAWNY_TLS_CERT: v.tls === 'files' ? v.tlsCert : '',
    TAWNY_TLS_KEY: v.tls === 'files' ? v.tlsKey : '',
    TAWNY_HTTPS_PORT: v.tls === 'files' ? String(v.httpsPort) : '',
    STUN_URLS: v.stun.length ? v.stun.join(',') : 'off',
    TURN_EMBEDDED: on(v.turnEmbedded),
    TURN_PORT: String(v.turnPort),
    TURN_MIN_PORT: String(v.turnMinPort),
    TURN_MAX_PORT: String(v.turnMaxPort),
    TAWNY_TURN_TLS_PORT: v.turnTls ? String(v.turnTlsPort) : '',
    TAWNY_TURN_URLS: v.turnUrls.join(','),
    TAWNY_TURN_SECRET: v.turnUrls.length ? v.turnSecret : '',
    TAWNY_PUBLIC_IP: v.publicIp,
    TURN_MODE: v.turnMode,
    RENDEZVOUS_URL: v.rendezvous,
    TAWNY_LAN_BRIDGE: on(v.lanBridge),
    TRUST_PROXY: on(v.trustProxy)
  };
  if (v.allowedHosts.length) env.ALLOWED_HOSTS = v.allowedHosts.join(',');
  return env;
}

/** Everything networked off — what a broken enabled file starts as. */
export function lockedDownEnv() {
  return {
    TAWNY_PRIVACY: 'on', TAWNY_PRIVACY_BROKEN: 'on',
    TS_DISABLE: 'on', TS_SERVE: 'off', STUN_URLS: 'off', TURN_EMBEDDED: 'off',
    TAWNY_TURN_URLS: '', TAWNY_TURN_SECRET: '', TURN_MODE: 'never',
    RENDEZVOUS_URL: '', TAWNY_LAN_BRIDGE: 'off', TAWNY_TLS_CERT: '', TAWNY_TLS_KEY: ''
  };
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// `node privacy.js --env`: shell exports for docker/entrypoint.sh to eval.
// Prints nothing for an absent or disabled file, so the ordinary environment
// stands untouched.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === '--env') {
  const raw = readPrivacy();
  let env = null;
  if (raw && raw._broken) {
    process.stderr.write(`${PRIVACY_FILE} is not valid JSON — starting with every network service off\n`);
    env = lockedDownEnv();
  } else if (raw && raw.enabled) {
    const r = validate(raw);
    if (r.ok) env = toEnv(r.value);
    else {
      process.stderr.write(`${PRIVACY_FILE} has errors (${Object.entries(r.errors)
        .map(([k, m]) => `${k}: ${m}`).join('; ')}) — starting with every network service off\n`);
      env = lockedDownEnv();
    }
  }
  if (env) {
    for (const [k, val] of Object.entries(env)) process.stdout.write(`export ${k}=${shq(val)}\n`);
  }
}
