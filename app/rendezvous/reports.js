// Tawny rendezvous — diagnostic report intake.
//
//   POST /report            store one report (from the app's "Send to Tawny")
//   GET  /report/pull?key=  read them back (protected); &drain=1 deletes them
//                           (REPORT_KEY only — REPORT_READ_KEY can read, never delete)
//
// Reports are the flight-recorder log from the in-app diagnostics hatch plus a
// few device facts (app version, device model, Android release, coarse country
// — no IP, no account, no id). The log already only holds hashed room ids —
// never keys, tickets, or anything that identifies a person. Stored in Workers
// KV with a 30-day TTL so old ones clean themselves up.
//
// Set up:
//   wrangler kv namespace create REPORTS        # paste id into wrangler.toml
//   wrangler secret put REPORT_KEY              # long random string, for /pull
//   wrangler secret put REPORT_READ_KEY         # optional: a second key that can
//                                               #   read but not drain — for an
//                                               #   assistant that triages them
//   wrangler secret put REPORT_NOTIFY_URL       # optional: ntfy.sh topic or a
//                                               #   Discord/Slack webhook
// With REPORTS unbound, POST /report just 404s and the app falls back to its
// share sheet — nothing breaks. REPORT_NOTIFY_URL is best-effort: if it is
// unset or the push fails, the report is still stored and /pull still works.

const MAX_BODY = 96 * 1024;        // a fat diag log is a few KB; this is slack
const TTL_SECONDS = 30 * 24 * 3600;
const HEX = (n) => [...crypto.getRandomValues(new Uint8Array(n))]
  .map((b) => b.toString(16).padStart(2, '0')).join('');

const j = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

function clip(v, max) {
  return (typeof v === 'string' ? v : String(v ?? '')).slice(0, max);
}

export async function postReport(request, env, ctx) {
  if (!env.REPORTS) return j({ error: 'reports not configured' }, 404);

  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_BODY) return j({ error: 'too large' }, 413);

  let body;
  try { body = await request.json(); } catch { return j({ error: 'bad json' }, 400); }
  if (!body || typeof body !== 'object') return j({ error: 'bad json' }, 400);

  const log = clip(body.log, MAX_BODY);
  if (!log.trim()) return j({ error: 'empty' }, 400);

  const rec = {
    ts: new Date().toISOString(),
    v: clip(body.v, 32),                 // app versionName
    c: clip(body.c, 16),                 // app versionCode
    model: clip(body.model, 64),         // device model
    android: clip(body.android, 16),     // Android release
    id: clip(body.id, 32) || HEX(6),     // client-side report id (dedupe aid)
    log,
  };
  // Sent only by Google Play's pre-launch test phones (Firebase Test Lab), never
  // by a user's, so a robot's reports can be kept apart from real ones.
  if (body.lab === true) rec.lab = true;
  // Deliberately no IP and no country: the privacy policy enumerates exactly
  // what a report holds (log + model + Android + app version), and that is all
  // this stores. Keep it that way.

  const key = `report:${Date.now()}:${HEX(4)}`;
  await env.REPORTS.put(key, JSON.stringify(rec), { expirationTtl: TTL_SECONDS });

  notify(env, ctx, rec);
  return j({ ok: true });
}

// Best-effort push so a person hears about a report without polling KV. Points
// at either an ntfy.sh topic (plain-text body) or a Discord/Slack-style webhook
// (JSON {content}) — told apart by hostname. Never blocks the response and
// never throws: a failed or unset notifier leaves the stored report untouched.
function notify(env, ctx, rec) {
  if (!env.REPORT_NOTIFY_URL) return;
  let host;
  try { host = new URL(env.REPORT_NOTIFY_URL).hostname; } catch { return; }

  const first = rec.log.split('\n').find((l) => l.trim()) || '(empty log)';
  const text =
    `Tawny report ${rec.id}${rec.lab ? ' [test lab]' : ''} — v${rec.v} (${rec.c}) · ${rec.model} · ` +
    `Android ${rec.android}\n${first.slice(0, 200)}`;

  const isNtfy = /(^|\.)ntfy\.sh$/i.test(host);
  const req = isNtfy
    ? { method: 'POST', headers: { Title: 'Tawny diagnostic report' }, body: text }
    : { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: text }) };

  const p = fetch(env.REPORT_NOTIFY_URL, req).catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(p);
}

// Constant-time-ish compare on a shared secret in the query string. It is a
// read key for low-value data, not a credential that protects anything.
function sameKey(given, key) {
  if (!key || given.length !== key.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ key.charCodeAt(i);
  return diff === 0;
}

export async function pullReports(request, env, url) {
  if (!env.REPORTS) return j({ error: 'reports not configured' }, 404);
  if (!env.REPORT_KEY) return j({ error: 'no report key set' }, 500);

  // Two keys. REPORT_KEY is the owner's: it reads and may drain. REPORT_READ_KEY,
  // when set, is for anything that only needs to look — it reads, and a drain
  // with it is refused, so handing it to an automated triager cannot lose a
  // report. Reports expire on their own after 30 days either way.
  const given = url.searchParams.get('key') || '';
  const owner = sameKey(given, env.REPORT_KEY);
  const reader = !owner && !!env.REPORT_READ_KEY && sameKey(given, env.REPORT_READ_KEY);
  if (!owner && !reader) return j({ error: 'forbidden' }, 403);

  const drain = url.searchParams.get('drain') === '1';
  if (drain && !owner) return j({ error: 'read-only key cannot drain' }, 403);
  const out = [];
  let cursor;
  do {
    const page = await env.REPORTS.list({ prefix: 'report:', cursor, limit: 1000 });
    for (const k of page.keys) {
      const v = await env.REPORTS.get(k.name);
      if (v) out.push(v);
      if (drain) await env.REPORTS.delete(k.name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  // NDJSON — one report per line, newest last (keys are time-prefixed).
  return new Response(out.join('\n') + (out.length ? '\n' : ''), {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'x-report-count': String(out.length),
    },
  });
}
