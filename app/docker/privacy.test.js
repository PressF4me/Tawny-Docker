// node --test app/docker/privacy.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate, toEnv, redact, lockedDownEnv, DEFAULTS } from './privacy.js';

const HERE = dirname(fileURLToPath(import.meta.url));

test('defaults validate, and blank STUN stays blank', () => {
  const r = validate({ ...DEFAULTS, enabled: true });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.deepEqual(r.value.stun, []);
  const env = toEnv(r.value);
  assert.equal(env.STUN_URLS, 'off', 'no STUN means off, never the public list');
  assert.equal(env.TS_NO_LOGS, 'on');
  assert.equal(env.TAWNY_PRIVACY, 'on');
});

test('tailscale serve without tailscale is refused', () => {
  const r = validate({ enabled: true, tailscale: 'off', tls: 'tailscale' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.tls);
});

test('own certificate: paths and port are checked, env carries them', () => {
  const bad = validate({ enabled: true, tailscale: 'off', tls: 'files', tlsCert: 'relative.pem', httpsPort: 0 });
  assert.ok(bad.errors.tlsCert);
  assert.ok(bad.errors.httpsPort);
  const good = validate({ enabled: true, tailscale: 'off', tls: 'files', tlsCert: '/data/tls/a.pem', tlsKey: '/data/tls/k.pem', httpsPort: 8443 });
  assert.equal(good.ok, true, JSON.stringify(good.errors));
  const env = toEnv(good.value);
  assert.equal(env.TAWNY_TLS_CERT, '/data/tls/a.pem');
  assert.equal(env.TAWNY_HTTPS_PORT, '8443');
  assert.equal(env.TS_SERVE, 'off');
  assert.equal(env.TS_DISABLE, 'on');
});

test('ports cannot collide', () => {
  const r = validate({ enabled: true, tailscale: 'off', tls: 'files', tlsCert: '/a', tlsKey: '/b', httpsPort: 3478, turnPort: 3478 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.turnPort || r.errors.httpsPort);
});

test('always-relay needs a relay', () => {
  const r = validate({ enabled: true, tailscale: 'off', tls: 'none', turnMode: 'always', turnEmbedded: false });
  assert.ok(r.errors.turnMode);
});

test('external TURN needs its secret, and a blank secret keeps the stored one', () => {
  const r = validate({ enabled: true, tailscale: 'off', tls: 'none', turnUrls: ['turns:turn.example.net:5349'] });
  assert.ok(r.errors.turnSecret);
  const kept = validate({ enabled: true, tailscale: 'off', tls: 'none', turnUrls: 'turns:turn.example.net:5349', turnSecret: '' },
    { turnSecret: 'stored-secret-123' });
  assert.equal(kept.ok, true, JSON.stringify(kept.errors));
  assert.equal(kept.value.turnSecret, 'stored-secret-123');
  assert.equal(redact(kept.value).turnSecret, undefined);
  assert.equal(redact(kept.value).turnSecretSet, true);
});

test('shell metacharacters never validate', () => {
  for (const [k, v] of [
    ['loginServer', "https://x.example'; rm -rf /"],
    ['rendezvous', 'wss://x.example/$(id)'],
    ['stun', ['stun:x.example:3478;id']],
    ['tlsCert', '/data/$(id).pem'],
    ['publicIp', '1.2.3.4 && id']
  ]) {
    const r = validate({ enabled: true, tailscale: 'own', tls: 'files', tlsCert: '/a', tlsKey: '/b', [k]: v });
    assert.ok(r.errors[k], `${k} should be refused: ${v}`);
  }
});

test('Headscale login server is carried to the environment', () => {
  const r = validate({ enabled: true, tailscale: 'own', tls: 'files', tlsCert: '/a', tlsKey: '/b', loginServer: 'https://hs.example.net/' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(toEnv(r.value).TS_LOGIN_SERVER, 'https://hs.example.net');
});

test('--env: absent file prints nothing; broken or invalid file locks down', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tawny-priv-'));
  const run = (file) => execFileSync(process.execPath, [join(HERE, 'privacy.js'), '--env'], {
    env: { ...process.env, TAWNY_PRIVACY_FILE: file }, stdio: ['ignore', 'pipe', 'ignore']
  }).toString();
  assert.equal(run(join(dir, 'none.json')), '');

  const off = join(dir, 'off.json');
  writeFileSync(off, JSON.stringify({ ...DEFAULTS, enabled: false }));
  assert.equal(run(off), '');

  const broken = join(dir, 'broken.json');
  writeFileSync(broken, '{nope');
  const b = run(broken);
  for (const [k, v] of Object.entries(lockedDownEnv())) assert.ok(b.includes(`export ${k}='${v}'`), `${k} in ${b}`);

  const invalid = join(dir, 'invalid.json');
  writeFileSync(invalid, JSON.stringify({ enabled: true, tailscale: 'off', tls: 'tailscale' }));
  assert.ok(run(invalid).includes("export TS_DISABLE='on'"));
  assert.ok(run(invalid).includes("export STUN_URLS='off'"));

  const ok = join(dir, 'ok.json');
  writeFileSync(ok, JSON.stringify({ enabled: true, tailscale: 'off', tls: 'none', stun: ['stun:stun.example.net:3478'] }));
  const out = run(ok);
  assert.ok(out.includes("export STUN_URLS='stun:stun.example.net:3478'"));
  // Everything it prints must be safe to eval in sh.
  execFileSync('sh', ['-ec', `${out}\n[ "$STUN_URLS" = stun:stun.example.net:3478 ]`]);
});
