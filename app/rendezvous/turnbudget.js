// A monthly cap on Cloudflare Realtime TURN, so a busy month cannot run up a
// bill. Cloudflare has no spending limit of its own: past the free allowance
// TURN is simply charged per GB, to the card on the account.
//
// /turn asks turnPaused() before minting credentials. It reads this month's TURN
// egress from Cloudflare's GraphQL analytics and, at or over TURN_CAP_GB, hands
// out no more credentials until the 1st (UTC). Phones then connect directly or
// not at all; nobody's traffic is cut mid-call beyond the credentials already
// issued, which expire within their one-hour TTL.
//
// The figure is cached per data centre for CACHE_S, so analytics is asked at
// most a few times an hour per location, not once per call. If analytics cannot
// be read, the last good figure (kept for STALE_S) decides; with none at all it
// fails open: a broken analytics token must not take TURN away from everyone.
// A separate usage alert (outside this repository) warns well before the cap.
//
// Needs: ANALYTICS_TOKEN (secret, "Account Analytics: Read" only), ACCOUNT_ID
// and TURN_CAP_GB (vars). Without ANALYTICS_TOKEN or TURN_CAP_GB there is no cap.

const CACHE_S = 600;
const STALE_S = 6 * 3600;
const KEY = 'https://turn-budget.internal/usage';

function monthStart(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

export async function turnEgressThisMonth(env, fetchImpl = fetch) {
  const month = monthStart();
  const r = await fetchImpl('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.ANALYTICS_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `query($a: String!, $d: Date!) { viewer { accounts(filter: {accountTag: $a}) {
        t: callsTurnUsageAdaptiveGroups(limit: 100, filter: {date_geq: $d}) {
          sum { egressBytes } dimensions { keyId } } } } }`,
      variables: { a: env.ACCOUNT_ID, d: month },
    }),
  });
  if (!r.ok) throw new Error(`analytics HTTP ${r.status}`);
  const j = await r.json();
  if (j.errors && j.errors.length) throw new Error(j.errors[0].message || 'analytics error');
  const groups = j.data.viewer.accounts[0].t;
  // Only this Worker's TURN key, if known: other keys on the account are not ours to cap.
  const mine = env.TURN_KEY_ID ? groups.filter((g) => g.dimensions.keyId === env.TURN_KEY_ID) : groups;
  return { month, bytes: mine.reduce((n, g) => n + g.sum.egressBytes, 0) };
}

/** { paused, bytes, capBytes } — paused true only when this month is at or over the cap. */
export async function turnPaused(env, { cache = globalThis.caches && caches.default, fetchImpl = fetch } = {}) {
  const capGb = Number(env.TURN_CAP_GB);
  if (!env.ANALYTICS_TOKEN || !env.ACCOUNT_ID || !(capGb > 0)) return { paused: false };
  const capBytes = capGb * 1e9;
  const month = monthStart();

  let rec = null;
  const hit = cache && (await cache.match(KEY));
  if (hit) rec = await hit.json();
  const fresh = rec && rec.month === month && Date.now() - rec.at < CACHE_S * 1000;

  if (!fresh) {
    try {
      const u = await turnEgressThisMonth(env, fetchImpl);
      rec = { ...u, at: Date.now() };
      console.log(`turn budget: ${(u.bytes / 1e9).toFixed(2)} GB of ${capGb} GB this month`);
      if (cache) {
        await cache.put(KEY, new Response(JSON.stringify(rec), {
          headers: { 'cache-control': `max-age=${STALE_S}` },
        }));
      }
    } catch (e) {
      console.log(`turn budget: analytics unreadable (${e.message || e})`);
      // Keep deciding on the last good figure from this month; with none, fail open.
      if (!rec || rec.month !== month) return { paused: false, error: String(e.message || e) };
    }
  }
  return { paused: rec.bytes >= capBytes, bytes: rec.bytes, capBytes };
}
