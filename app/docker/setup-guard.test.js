// node --test app/docker/setup-guard.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupGuard, setupNameOk, isLocalAddr } from './setup-guard.js';

const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
const ok = (r, opts) => assert.equal(setupGuard(r, opts), null);
const refused = (r, code, opts) => {
  const d = setupGuard(r, opts);
  assert.ok(d, 'expected a refusal');
  assert.equal(d.code, code);
  return d;
};

test('local addresses', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:192.168.1.20', '10.1.2.3', '172.16.0.1', '172.31.255.1',
    '169.254.3.4', '100.68.31.105', 'fd7a:115c:a1e0::1', 'fe80::1']) assert.ok(isLocalAddr(a), a);
  for (const a of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:db8::1', '', 'fdevil', 'fd', '10.0.0',
    '192.168.1.1, 8.8.8.8', undefined]) assert.ok(!isLocalAddr(a), String(a));
});

test('the setup page itself, on the LAN, by IP', () => {
  ok(req('192.168.1.30', {
    host: '192.168.1.248:8099', origin: 'http://192.168.1.248:8099', 'sec-fetch-site': 'same-origin',
    'content-type': 'application/json'
  }));
});

test('curl on the LAN: no Origin, still allowed', () => {
  ok(req('192.168.1.30', { host: '192.168.1.248:8099' }));
  ok(req('127.0.0.1', { host: 'localhost:8099' }));
});

test('a client from the internet is refused', () => {
  refused(req('203.0.113.9', { host: '198.51.100.7:8099' }), 403);
});

test('through tailscale serve: loopback peer, tailnet client, ts.net name', () => {
  ok(req('127.0.0.1', {
    host: 'tawny.tail1234.ts.net', 'x-forwarded-for': '100.68.31.105', 'x-forwarded-proto': 'https',
    origin: 'https://tawny.tail1234.ts.net', 'sec-fetch-site': 'same-origin'
  }));
  ok(req('127.0.0.1', {
    host: '127.0.0.1:8099', 'x-forwarded-host': 'tawny.tail1234.ts.net', 'x-forwarded-for': 'fd7a:115c:a1e0::9',
    origin: 'https://tawny.tail1234.ts.net'
  }));
});

test('behind a public reverse proxy the real client decides, not the proxy', () => {
  refused(req('172.18.0.2', { host: 'pets.example.net', 'x-forwarded-for': '203.0.113.9' }),
    403, { allowedHosts: ['pets.example.net'] });
  // A forged private hop does not help: the proxy appends what it saw.
  refused(req('172.18.0.2', { host: 'pets.example.net', 'x-forwarded-for': '10.0.0.1, 203.0.113.9' }),
    403, { allowedHosts: ['pets.example.net'] });
  refused(req('172.18.0.2', { host: 'pets.example.net', 'x-forwarded-for': '' }),
    403, { allowedHosts: ['pets.example.net'] });
  // The operator at home, through their own proxy.
  ok(req('172.18.0.2', {
    host: 'pets.example.net', 'x-forwarded-for': '192.168.1.30', origin: 'https://pets.example.net'
  }), { allowedHosts: ['pets.example.net'] });
  // A proxy that spells the default port out in the Host it forwards.
  ok(req('172.18.0.2', {
    host: 'pets.example.net:443', 'x-forwarded-for': '192.168.1.30', origin: 'https://pets.example.net'
  }), { allowedHosts: ['pets.example.net'] });
});

test('a page on another site cannot post here', () => {
  const d = refused(req('192.168.1.30', {
    host: '192.168.1.248:8099', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site',
    'content-type': 'text/plain'
  }), 403);
  assert.match(d.error, /setup page itself/);
  // Old browser: no Sec-Fetch-Site, Origin alone is enough.
  refused(req('192.168.1.30', { host: '192.168.1.248:8099', origin: 'https://evil.example' }), 403);
  refused(req('192.168.1.30', { host: '192.168.1.248:8099', origin: 'null' }), 403);
  // Same host, different port is a different origin (another service on the box).
  refused(req('192.168.1.30', { host: '192.168.1.248:8099', origin: 'http://192.168.1.248:3000' }), 403);
  refused(req('192.168.1.30', { host: '192.168.1.248:8099', 'sec-fetch-site': 'same-site' }), 403);
});

test('DNS rebinding: a foreign name pointed at this box is refused', () => {
  const d = refused(req('192.168.1.30', {
    host: 'rebind.evil.example:8099', origin: 'http://rebind.evil.example:8099', 'sec-fetch-site': 'same-origin'
  }), 403);
  assert.match(d.error, /TAWNY_ALLOWED_HOSTS/);
  refused(req('127.0.0.1', { host: '127.0.0.1:8099', 'x-forwarded-host': 'rebind.evil.example' }), 403);
});

test('names setup answers on', () => {
  for (const n of ['192.168.1.248:8099', '[fd7a:115c:a1e0::1]:8099', 'localhost:8099', 'cachy', 'nas.local',
    'box.lan', 'tawny.tail1234.ts.net', 'TAWNY.Tail1234.TS.NET:443']) assert.ok(setupNameOk(n), n);
  for (const n of ['evil.example', 'ts.net.evil.example', 'a.ts.net.', 'x y', '', 'evil.example:8099']) {
    assert.ok(!setupNameOk(n), n);
  }
  assert.ok(setupNameOk('hs.example.org', { ownNames: ['hs.example.org'] }));
  assert.ok(setupNameOk('pets.example.net:8443', { allowedHosts: ['pets.example.net:8443'] }));
});

test('no Host header', () => {
  refused(req('192.168.1.30', {}), 400);
});
