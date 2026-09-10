// Two Tailscale nodes advertising the same (or an overlapping) subnet route
// is an unsupported configuration — see
// https://tailscale.com/kb/1019/subnets#subnet-relay-with-overlapping-routes.
// Tailscale does not reject it: it picks a "primary" router per route and can
// flip between the two candidates, which from inside the house looks like
// every device's LAN traffic randomly stalling — reported to us as "the
// internet goes in a loop". A lot of people already run Tailscale with a
// router for their NAS, their Pi-hole, or a previous Tawny box, so this is
// the ordinary case for a second box on the same network, not a rare one.
//
// This module is the one place that decides "does advertising this route
// collide with something already on the tailnet" — used both from
// docker/entrypoint.sh (a boot-time decision: advertise, or stay quiet) and
// from server.js (a live one: what does /setup tell the operator right now,
// and what does the "advertise anyway" button actually check).

/** Parse "a.b.c.d/n" into its [network, broadcast] integers, or null. */
export function cidrRange(cidr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(cidr || ''));
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number);
  const bits = Number(m[5]);
  if (octets.some((o) => o < 0 || o > 255) || bits < 0 || bits > 32) return null;
  const ip = octets.reduce((a, o) => (a << 8) + o, 0) >>> 0;
  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
  const network = (ip & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return { network, broadcast };
}

export function cidrsOverlap(a, b) {
  const ra = cidrRange(a);
  const rb = cidrRange(b);
  if (!ra || !rb) return false;
  return ra.network <= rb.broadcast && rb.network <= ra.broadcast;
}

/**
 * A peer's AllowedIPs entry that is NOT a subnet route we can collide with.
 *
 * `0.0.0.0/0` (and `::/0`) is how an **exit node** shows up, and exit nodes are
 * ordinary — a home NAS with `--advertise-exit-node`, or any of the ~100
 * Mullvad nodes a Tailscale account can add with one click. A default route
 * contains every address, so a naive overlap test called every such tailnet
 * conflicted with the LAN route, and Tawny silently refused to advertise the
 * one route the whole remote topology stands on. An exit node is not a subnet
 * router for 192.168.1.0/24: Tailscale picks it per-client, by explicit opt-in,
 * and it never competes for "who carries this subnet".
 *
 * `/32` is the peer's own address, not a route at all. IPv6 is out of scope —
 * the advertised route is always the IPv4 LAN.
 */
function notASubnetRoute(cidr) {
  if (typeof cidr !== 'string') return true;
  if (cidr.includes(':')) return true;          // IPv6, incl. the ::/0 exit route
  if (cidr.endsWith('/32')) return true;        // the peer itself
  if (cidr.replace(/\s/g, '') === '0.0.0.0/0') return true; // exit node
  return false;
}

/**
 * Which of `routes` (CIDR strings this node is about to advertise, or already
 * does) are covered — wholly or in part — by a route some *other* peer in the
 * tailnet already carries. `peers` is `Object.values(status.Peer || {})` from
 * `tailscale status --json`: each peer's AllowedIPs includes its own approved
 * subnet routes alongside its bare Tailscale address and, for an exit node, a
 * default route — see notASubnetRoute() for what that excludes and why.
 */
export function findRouteConflicts(peers, routes) {
  const mine = (routes || [])
    .map((r) => ({ cidr: r, range: cidrRange(r) }))
    .filter((r) => r.range);
  if (!mine.length) return [];

  const conflicts = [];
  for (const peer of peers || []) {
    const name = (peer && (peer.HostName || String(peer.DNSName || '').replace(/\.$/, ''))) ||
      'another device on your tailnet';
    for (const cidr of (peer && peer.AllowedIPs) || []) {
      if (notASubnetRoute(cidr) || !cidrRange(cidr)) continue;
      for (const m of mine) {
        if (cidrsOverlap(m.cidr, cidr)) conflicts.push({ route: m.cidr, peer: name, peerRoute: cidr });
      }
    }
  }
  return conflicts;
}

/** Does `outer` contain the whole of `inner`? */
export function cidrContains(outer, inner) {
  const o = cidrRange(outer);
  const i = cidrRange(inner);
  if (!o || !i) return false;
  return o.network <= i.network && i.broadcast <= o.broadcast;
}

/**
 * Which of `routes` are ALREADY carried, in full, by a peer on the tailnet.
 *
 * This is the other half of findRouteConflicts, and the difference matters:
 * an overlap is a problem only when nobody ends up carrying the whole range.
 * If a NAS already routes 192.168.1.0/24 and that route is approved — which
 * is what its presence in AllowedIPs means — then the path to the Monitor
 * phone exists and Tawny declining to advertise a second time is the correct,
 * finished state, not a half-configured one.
 *
 * A partial overlap (a peer carrying 192.168.1.0/25 of our /24) is NOT
 * coverage: half the LAN would still be unreachable, so it stays a conflict
 * the operator has to resolve.
 */
export function findRouteCoverage(peers, routes) {
  const wanted = (routes || []).filter((r) => cidrRange(r));
  if (!wanted.length) return [];

  const covered = [];
  for (const peer of peers || []) {
    const name = (peer && (peer.HostName || String(peer.DNSName || '').replace(/\.$/, ''))) ||
      'another device on your tailnet';
    for (const cidr of (peer && peer.AllowedIPs) || []) {
      if (notASubnetRoute(cidr) || !cidrRange(cidr)) continue;
      for (const route of wanted) {
        if (cidrContains(cidr, route)) covered.push({ route, peer: name, peerRoute: cidr });
      }
    }
  }
  return covered;
}

/**
 * The route list to hand to `tailscale set --advertise-routes=`.
 *
 * That flag REPLACES the node's whole list; it does not add to it. On the
 * host-socket path Tawny drives a daemon the operator set up for their own
 * reasons, and that daemon may already advertise a second subnet, a VLAN, or a
 * container network. Writing only Tawny's CIDR there silently withdrew every
 * one of them. Union instead, and keep the order stable so a restart does not
 * churn the node's prefs.
 */
export function mergeRoutes(existing, add) {
  const out = [];
  for (const r of [...(existing || []), ...(add || [])]) {
    const s = String(r || '').trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * The route list with `drop` taken back out — what "stop advertising this
 * route" has to write. Withdrawing by writing an empty list took every other
 * route on the node down with it.
 */
export function withoutRoute(existing, drop) {
  const gone = String(drop || '').trim();
  return (existing || []).map((r) => String(r || '').trim()).filter((r) => r && r !== gone);
}

// CLI mode, for docker/entrypoint.sh, which has no easy way to hold a JS
// object across the shell/node boundary otherwise. Three shapes:
//
//   node docker/route-conflict.js <routes>          < `tailscale status --json`
//     -> a JSON array (possibly empty) of conflicts
//   node docker/route-conflict.js --merge <routes>  < `tailscale debug prefs`
//     -> the comma-separated list to pass to --advertise-routes, existing
//        routes on the node included
//   node docker/route-conflict.js --without <route> < `tailscale debug prefs`
//     -> the same list with that one route removed
//
// `<routes>` is comma-separated in every case.
if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = /^--/.test(process.argv[2] || '') ? process.argv[2] : '';
  const routes = String((mode ? process.argv[3] : process.argv[2]) || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  let raw = '';
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* no status/prefs yet */ }
    if (mode === '--merge' || mode === '--without') {
      const existing = Array.isArray(parsed && parsed.AdvertiseRoutes) ? parsed.AdvertiseRoutes : [];
      const out = mode === '--merge'
        ? mergeRoutes(existing, routes)
        : withoutRoute(existing, routes[0]);
      process.stdout.write(out.join(','));
      return;
    }
    const peers = parsed ? Object.values(parsed.Peer || {}) : [];
    process.stdout.write(JSON.stringify(findRouteConflicts(peers, routes)));
  });
}
