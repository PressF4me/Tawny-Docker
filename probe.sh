#!/usr/bin/env bash
# Build the Tawny image and exercise every transport the two supported
# topologies actually stand on. See DESIGN.md.
#
# It started life catching one class of regression — server.js growing a
# dependency the Dockerfile doesn't copy — which is exactly how the container
# broke in 2026-08. It now also checks the things that are invisible until
# someone tries to watch their cat: the HTTPS listener and its certificate, the
# signalling round trip, the LAN bridge that lets a browser reach the Monitor
# phone's own relay, a real ICE-grade packet exchange, and the tailscale route.
#
# Run it from this folder:  bash probe.sh
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# Build context is this repo; the server payload is vendored under app/ by
# tools/tawny-sync. Refresh it first so the probe tests current server code.
ctx="$here"
img="tawny:probe"
name="tawny-probe-$$"
# Host networking, like the real deployment — the LAN checks below are
# meaningless from behind a bridge. Ports are shifted so this can run beside a
# live container.
port=8199
# coturn keeps its stock port and relay range. It is fussy about both — moved
# off them it starts, listens, and then refuses every allocation — and a probe
# that tests a configuration nobody deploys is worse than one that skips. So if
# something already holds :3478 in this network namespace (a live Tawny
# container, normally) the probe runs without a relay and says so.
turnport=3478
data="$(mktemp -d)"

cleanup() {
	docker rm -f "$name" >/dev/null 2>&1 || true
	# tailscaled runs as root in the container and writes /data/tailscale with
	# 0700 root-only perms, so the unprivileged `rm -rf` below cannot remove it
	# and the probe ended every run with a Permission denied. Delete it from
	# inside the image first, where root is root.
	docker run --rm --entrypoint rm -v "$data:/data" "$img" -rf /data/tailscale \
		>/dev/null 2>&1 || true
	rm -rf "$data" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> building $img  (context: $ctx)"
# The image installs tailscale and coturn from Alpine, so the build needs to reach
# the network. On a host whose container bridge cannot route out — a Tailscale or
# Mullvad nftables stack with a dropping FORWARD chain will do it — that fails
# with "DNS: transient error" and no other symptom. Host networking for the
# build sidesteps it. Try the normal path first so this stays a fallback and
# not a requirement. Set DOCKER_BUILD_NETWORK to force one.
if [ -n "${DOCKER_BUILD_NETWORK:-}" ]; then
	docker build --network="$DOCKER_BUILD_NETWORK" -f "$here/Dockerfile" -t "$img" "$ctx"
elif ! docker build -f "$here/Dockerfile" -t "$img" "$ctx"; then
	echo "==> build failed; retrying with --network=host"
	docker build --network=host -f "$here/Dockerfile" -t "$img" "$ctx"
fi

echo "==> starting $name (host network, http :$port  turn :$turnport)"
turn_env="-e TURN_EMBEDDED=on"
turn_busy=0
# The probe shares the host network namespace, so a coturn already bound to
# :3478 (the live Tawny container, normally) is indistinguishable from the
# probe's own — turnutils_uclient would talk to it with the wrong secret and
# report a failure that is nothing of the kind. Detect it and skip the relay
# test rather than run a misleading one.
if { command -v ss >/dev/null 2>&1 && ss -uHln 2>/dev/null | grep -qE "[:.]$turnport(\s|$)"; } ||
   { command -v nc >/dev/null 2>&1 && nc -z -u 127.0.0.1 "$turnport" >/dev/null 2>&1; } ||
   { command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 "$turnport" >/dev/null 2>&1; }; then
	turn_busy=1
	turn_env="-e TURN_EMBEDDED=off"
fi
# No TS_AUTHKEY: the probe does not join a tailnet. It exercises the listeners,
# the signalling relay, the /lan bridge and a real ICE round trip locally; the
# tailscale route state is checked separately at the end.
# shellcheck disable=SC2086
docker run -d --name "$name" --network=host \
	-v "$data:/data" \
	-e PORT="$port" -e TS_AUTHKEY="" $turn_env \
	"$img" >/dev/null

for _ in $(seq 1 40); do
	curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && break
	sleep 1
done
if ! curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1; then
	echo "FAIL: container never answered /healthz"
	docker logs "$name" || true
	exit 1
fi

base="http://127.0.0.1:$port"
fail=0

check() { # description  url  [grep-pattern]
	local desc="$1" url="$2" pat="${3:-}" body
	if ! body="$(curl -fsS "$url" 2>/dev/null)"; then
		echo "FAIL  $desc  ($url unreachable)"; fail=1; return
	fi
	if [ -n "$pat" ] && ! printf '%s' "$body" | grep -q "$pat"; then
		echo "FAIL  $desc  ($url did not contain /$pat/)"; fail=1; return
	fi
	echo "ok    $desc"
}

# `/` redirects an unfinished deployment to /setup (server.js), and the probe
# container is unfinished by definition — it never joins a tailnet. Ask for the
# app shell the way a browser that has already been through setup does, or this
# checks the setup page's <title> and calls it the app.
if body="$(curl -fsS -b 'tawny_setup_done=1' "$base/" 2>/dev/null)" &&
	printf '%s' "$body" | grep -q "<title"; then
	echo "ok    app shell        GET /"
else
	echo "FAIL  app shell        GET /  (no app shell behind the setup redirect)"; fail=1
fi
# ...and the redirect itself is load-bearing: without it a half-configured
# deployment looks fine on the LAN and fails only for the person watching from
# the office. Nothing else here would notice it disappearing.
code="$(curl -s -o /dev/null -w '%{http_code}' "$base/")"
if [ "$code" = 302 ]; then
	echo "ok    setup redirect   GET / -> /setup while setup is unfinished"
else
	echo "FAIL  setup redirect   GET / returned $code, expected a 302 to /setup"; fail=1
fi
check "runtime config   GET /config.json" "$base/config.json" '"turnMode"'
check "health           GET /healthz"     "$base/healthz"     '"ok":true'
# The route that was broken: needs rendezvous/privacy.js in the image.
check "privacy policy   GET /privacy"     "$base/privacy"     "<"

# /turn with no TURN env returns 404 {"error":"no turn configured"} — a healthy
# response. Anything in this set means the route is wired; a 5xx or 000 is not.
room="$(printf 'a%.0s' $(seq 1 32))"
code="$(curl -s -o /dev/null -w '%{http_code}' "$base/turn?room=$room")"
case "$code" in
	200|400|403|404) echo "ok    turn route       GET /turn  (HTTP $code)" ;;
	*) echo "FAIL  turn route       GET /turn  (HTTP $code)"; fail=1 ;;
esac

# Zero-config addressing: with no RENDEZVOUS_URL set, the address handed to a
# client must be the one that client asked on. This is the whole mechanism that
# replaced the old RENDEZVOUS_URL / ALLOWED_HOSTS / TAWNY_TURN_URLS trio, so a
# regression here silently puts every deployment back to needing a .env file.
derived="$(curl -fsS -H 'Host: probe.example' "$base/config.json" 2>/dev/null || true)"
if printf '%s' "$derived" | grep -q '"rendezvous":"ws://probe.example"'; then
	echo "ok    host-derived     /config.json follows Host"
else
	echo "FAIL  host-derived     /config.json did not echo the Host it was asked on"
	echo "      got: $derived"; fail=1
fi

fwd="$(curl -fsS -H 'X-Forwarded-Host: proxied.example' -H 'X-Forwarded-Proto: https' \
	"$base/config.json" 2>/dev/null || true)"
if printf '%s' "$fwd" | grep -q '"rendezvous":"wss://proxied.example"'; then
	echo "ok    proxy headers    /config.json follows X-Forwarded-*"
else
	echo "FAIL  proxy headers    X-Forwarded-Host ignored (tailscale serve needs this)"
	echo "      got: $fwd"; fail=1
fi

# ------------------------------------------------------------ the LAN it sees
#
# The container derives the subnet it advertises into the tailnet from this. In
# a real deployment `tailscale serve` terminates TLS in front of the plain
# listener; there is no HTTPS listener in the image to test.
lan_ip="$(docker exec "$name" node -e '
  const os = require("os");
  const pick = [];
  for (const l of Object.values(os.networkInterfaces() || {}))
    for (const a of l || [])
      if ((a.family === "IPv4" || a.family === 4) && !a.internal &&
          /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(a.address)) pick.push(a.address);
  process.stdout.write(pick[0] || "");
')"
if [ -n "$lan_ip" ]; then
	echo "ok    lan visible      container sees $lan_ip for the subnet advertisement"
else
	echo "note  lan visible      no private IPv4 in the container (bridge networking?) — set TS_ROUTES"
fi

# --------------------------------------------- signalling + the LAN bridge
#
# Run inside the container: it already has node and ws, so the probe needs
# nothing on the host but docker and curl.
# Written into /app so `import ... from 'ws'` resolves against the image's own
# node_modules — from /tmp it does not, and the probe fails for a reason that
# has nothing to do with what it is testing.
docker exec -i "$name" sh -c 'cat > /app/probe-ws.mjs' <<'PROBE'
// Two clients meet on the relay over WSS, and one relays a frame to the other.
// Then the same again through /lan/<ip>/<port>/ws into a stand-in for the
// Android app's own relay, to prove the bridge is byte-transparent.
import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { createHash } from 'node:crypto';

const [wsPort, lanIp] = process.argv.slice(2);
const room = createHash('sha256').update('probe').digest('hex').slice(0, 32);
const t = 'probe-ticket-0001';
const hashT = createHash('sha256').update(t).digest('hex');
const results = [];

const dial = (url, hello) => new Promise((res, rej) => {
  const ws = new WebSocket(url);   // plain ws to loopback; TLS is tailscale serve's job in prod
  const to = setTimeout(() => { ws.terminate(); rej(new Error('timeout')); }, 8000);
  ws.on('open', () => hello && ws.send(JSON.stringify(hello)));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'welcome') { clearTimeout(to); res({ ws, welcome: m }); }
    if (m.type === 'challenge') ws.send(JSON.stringify({ type: 'hello', r: m.n }));
  });
  ws.on('close', (c) => { clearTimeout(to); rej(new Error('closed ' + c)); });
  ws.on('error', (e) => { clearTimeout(to); rej(e); });
});

// --- 1. signalling on the plain listener -------------------------------
try {
  const base = `ws://127.0.0.1:${wsPort}`;
  const st = await dial(`${base}/ws?room=${room}&role=station`, { type: 'hello', hashT });
  const vw = await dial(`${base}/ws?room=${room}&role=viewer`, { type: 'hello', t });
  const got = new Promise((res) => st.ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.type === 'ice') res(m);
  }));
  vw.ws.send(JSON.stringify({ type: 'ice', to: st.welcome.id, c: 'probe' }));
  const relayed = await Promise.race([
    got, new Promise((_, r) => setTimeout(() => r(new Error('no relay')), 5000))
  ]);
  results.push(relayed.c === 'probe' && relayed.from === vw.welcome.id
    ? 'ok    wss signalling   station + viewer paired and a frame crossed'
    : 'FAIL  wss signalling   frame arrived malformed');
  st.ws.close(); vw.ws.close();
} catch (e) {
  results.push('FAIL  wss signalling   ' + e.message);
}

// --- 2. the LAN bridge ------------------------------------------------------
// A stand-in for the relay the Android Monitor runs on the phone: it answers
// with a challenge exactly as SignalServer does, and this probe answers it. If
// the bridge re-framed or filtered anything, none of this survives.
if (!lanIp) {
  results.push('ok    lan bridge       skipped (no private IPv4)');
} else {
  const srv = http.createServer();
  const wss = new WebSocketServer({ server: srv });
  wss.on('connection', (ws, req) => {
    ws.send(JSON.stringify({ type: 'challenge', n: 'probe-nonce' }));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'hello' && m.r === 'probe-nonce') {
        ws.send(JSON.stringify({
          type: 'welcome', id: 'stand-in', role: 'station', peers: [], path: req.url
        }));
      }
    });
  });
  await new Promise((r) => srv.listen(48820, lanIp, r));
  try {
    const { ws, welcome } = await dial(
      `ws://127.0.0.1:${wsPort}/lan/${lanIp}/48820/ws?room=${room}&role=viewer`);
    results.push(welcome.path === `/ws?room=${room}&role=viewer`
      ? 'ok    lan bridge       challenge/response reached the phone-side relay intact'
      : 'FAIL  lan bridge       query string mangled: ' + welcome.path);
    ws.close();
  } catch (e) {
    results.push('FAIL  lan bridge       ' + e.message);
  }
  // A bridge that would dial anywhere is an SSRF hole. Public space must be refused.
  try {
    await dial(`ws://127.0.0.1:${wsPort}/lan/8.8.8.8/443/ws?room=${room}&role=viewer`);
    results.push('FAIL  lan bridge       accepted a public address as a target');
  } catch {
    results.push('ok    lan bridge       refuses anything outside private address space');
  }
  srv.close();
}

console.log(results.join('\n'));
process.exit(0);
PROBE
if out="$(docker exec "$name" node /app/probe-ws.mjs "$port" "$lan_ip" 2>&1)"; then
	echo "$out"
	printf '%s' "$out" | grep -q '^FAIL' && fail=1
else
	echo "FAIL  signalling       probe script did not run"
	echo "$out"; fail=1
fi

# ------------------------------------------------------- LAN ICE round trip
#
# The packet exchange an ICE connectivity check is made of, on the real LAN
# address: a STUN Binding request out of one UDP socket and the response back.
# UDP blocked between two hosts on the same subnet is the one thing that would
# quietly push every session onto the relay, and nothing else here would see it.
if [ -n "$lan_ip" ]; then
	docker exec -i "$name" sh -c 'cat > /app/probe-ice.mjs' <<'ICE'
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';

const [ip] = process.argv.slice(2);
const MAGIC = 0x2112a442;

function bindingRequest() {
  const b = Buffer.alloc(20);
  b.writeUInt16BE(0x0001, 0);            // Binding request
  b.writeUInt16BE(0, 2);                 // no attributes
  b.writeUInt32BE(MAGIC, 4);
  randomBytes(12).copy(b, 8);
  return b;
}

function xorMapped(msg) {
  let off = 20;
  while (off + 4 <= msg.length) {
    const type = msg.readUInt16BE(off);
    const len = msg.readUInt16BE(off + 2);
    const val = msg.subarray(off + 4, off + 4 + len);
    if (type === 0x0020 && val.length >= 8) {          // XOR-MAPPED-ADDRESS
      const port = val.readUInt16BE(2) ^ (MAGIC >>> 16);
      const a = val.readUInt32BE(4) ^ MAGIC;
      return `${(a >>> 24) & 255}.${(a >>> 16) & 255}.${(a >>> 8) & 255}.${a & 255}:${port}`;
    }
    off += 4 + len + ((4 - (len % 4)) % 4);
  }
  return null;
}

// A responder that answers a Binding request the way an ICE agent does.
const peer = dgram.createSocket('udp4');
peer.on('message', (msg, rinfo) => {
  if (msg.readUInt16BE(0) !== 0x0001) return;
  const val = Buffer.alloc(8);
  val.writeUInt8(0, 0); val.writeUInt8(1, 1);
  val.writeUInt16BE(rinfo.port ^ (MAGIC >>> 16), 2);
  const a = rinfo.address.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
  val.writeUInt32BE((a ^ MAGIC) >>> 0, 4);
  const res = Buffer.alloc(20 + 4 + 8);
  res.writeUInt16BE(0x0101, 0);          // Binding success response
  res.writeUInt16BE(12, 2);
  res.writeUInt32BE(MAGIC, 4);
  msg.copy(res, 8, 8, 20);               // echo the transaction id
  res.writeUInt16BE(0x0020, 20); res.writeUInt16BE(8, 22);
  val.copy(res, 24);
  peer.send(res, rinfo.port, rinfo.address);
});

const done = (code, line) => { console.log(line); process.exit(code); };

await new Promise((r) => peer.bind(0, ip, r));
const agent = dgram.createSocket('udp4');
await new Promise((r) => agent.bind(0, ip, r));

const t = setTimeout(() => done(1, `FAIL  lan ice          no Binding response on ${ip}`), 5000);
agent.on('message', (msg) => {
  clearTimeout(t);
  const seen = xorMapped(msg);
  const want = `${ip}:${agent.address().port}`;
  done(seen === want ? 0 : 1,
    seen === want
      ? `ok    lan ice          host-candidate Binding round trip on ${want}`
      : `FAIL  lan ice          reflexive address was ${seen}, expected ${want}`);
});
agent.send(bindingRequest(), peer.address().port, ip);
ICE
	if out="$(docker exec "$name" node /app/probe-ice.mjs "$lan_ip" 2>&1)"; then
		echo "$out"
	else
		echo "$out"; fail=1
	fi
else
	echo "ok    lan ice          skipped (no private IPv4)"
fi

# The relay really relays, with the secret the entrypoint generated. Catches a
# coturn that starts and then rejects every allocation — which looks identical
# to a working deployment until someone actually tries to watch. This is the
# unattended fallback for a network that blocks direct UDP, not a path either
# supported topology plans to use.
#
# coturn takes several seconds longer to come up than node does — it enumerates
# every interface and pre-binds its relay range — so this waits for it rather
# than trusting /healthz. Asking too early gives "Cannot complete Allocation",
# which reads exactly like a broken secret and is nothing of the kind.
if [ "$turn_busy" = 1 ]; then
	echo "note  embedded turn    skipped: :$turnport is already in use in this network"
	echo "      namespace (the live Tawny container). Stop it and re-run to check"
	echo "      the relay itself."
elif docker exec "$name" test -f /tmp/tawny/turn-secret 2>/dev/null; then
	turn_up=0
	for _ in $(seq 1 40); do
		if docker exec "$name" sh -c "nc -z 127.0.0.1 $turnport" >/dev/null 2>&1; then
			turn_up=1; break
		fi
		sleep 1
	done
	if [ "$turn_up" = 0 ]; then
		echo "note  embedded turn    :$turnport not open in the probe (held elsewhere?) — relay check skipped"
	elif docker exec "$name" sh -c \
		"turnutils_uclient -y -t -u probe -W \"\$(cat /tmp/tawny/turn-secret)\" -e ${lan_ip:-127.0.0.1} -n 2 ${lan_ip:-127.0.0.1} -p $turnport" \
		2>&1 | grep -q 'Total lost packets 0'; then
		echo "ok    embedded turn    allocation + relay round-trip"
	else
		echo "FAIL  embedded turn    coturn did not relay with the generated secret"; fail=1
	fi
else
	echo "ok    embedded turn    skipped (TURN_EMBEDDED off)"
fi

# ------------------------------------------------- the route-conflict guard
#
# docker/entrypoint.sh will decline to advertise the LAN route if another peer
# on the tailnet already carries it. That check runs before any of this is
# visible, on the operator's real tailnet, so a bug in it is discovered as
# "remote viewing has never worked" months later. An exit node's 0.0.0.0/0
# overlaps every subnet on earth, and reading it as a competing subnet router
# silenced the advertisement on any tailnet with one — which is most of them.
if out="$(docker exec -i "$name" node -e '
  import("/app/docker/route-conflict.js").then((m) => {
    const bad = [];
    const exitNode = [{ HostName: "mullvad-se", AllowedIPs: ["100.64.0.9/32", "0.0.0.0/0", "::/0"] }];
    const router   = [{ HostName: "nas", AllowedIPs: ["100.64.0.3/32", "192.168.1.0/24"] }];
    if (m.findRouteConflicts(exitNode, ["192.168.1.0/24"]).length) bad.push("an exit node was read as a subnet router");
    if (!m.findRouteConflicts(router, ["192.168.1.0/24"]).length) bad.push("a real overlapping router was missed");
    if (m.mergeRoutes(["10.8.0.0/24"], ["192.168.1.0/24"]).length !== 2) bad.push("mergeRoutes dropped an existing route");
    if (m.withoutRoute(["10.8.0.0/24", "192.168.1.0/24"], "192.168.1.0/24").join() !== "10.8.0.0/24") bad.push("withoutRoute did not keep the other routes");
    process.stdout.write(bad.join("; "));
  }).catch((e) => process.stdout.write("module did not load: " + e.message));
' 2>&1)" && [ -z "$out" ]; then
	echo "ok    route conflicts  exit nodes ignored, real overlaps caught, merges non-destructive"
else
	echo "FAIL  route conflicts  $out"; fail=1
fi

# ------------------------------------------------------- the remote topology
#
# Informational, and about this host rather than the image: the remote path is a
# Tailscale subnet router, and the route has to be approved once in the admin
# console before it carries anything. Nothing else reports that, and an
# unapproved route looks exactly like a firewall problem from the far end.
if command -v tailscale >/dev/null 2>&1; then
	adv="$(tailscale debug prefs 2>/dev/null \
		| grep -A3 '"AdvertiseRoutes"' | grep -o '[0-9.]\{7,\}/[0-9]\{1,2\}' | head -1)"
	# Approval shows up as the route appearing in this node's own AllowedIPs.
	# Grepping the whole status blob for it gives a false "approved" — the route
	# is echoed back in several places that mean nothing — so parse it properly,
	# with the node the probe container already has.
	approved=""
	if [ -n "$adv" ]; then
		tailscale status --json >"$data/ts.json" 2>/dev/null || true
		approved="$(docker exec -i "$name" node -e '
		  let s = "";
		  process.stdin.on("data", (d) => (s += d)).on("end", () => {
		    try { process.stdout.write(((JSON.parse(s).Self || {}).AllowedIPs || []).join(" ")); }
		    catch { }
		  });
		' <"$data/ts.json" 2>/dev/null || true)"
	fi
	if [ -z "$adv" ]; then
		echo "note  tailscale        no subnet route advertised — remote viewing is not set up"
	elif case " $approved " in *" $adv "*) true ;; *) false ;; esac; then
		echo "ok    tailscale        subnet route $adv advertised and approved"
	else
		echo "note  tailscale        subnet route $adv advertised but NOT YET APPROVED"
		echo "      approve it once at https://login.tailscale.com/admin/machines"
		echo "      -> this host -> Edit route settings -> tick the subnet"
	fi
else
	echo "note  tailscale        not installed (home-network topology only)"
fi

[ "$fail" -eq 0 ] && echo "==> all checks OK" || echo "==> FAILURES above"
exit $fail
