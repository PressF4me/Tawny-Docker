#!/bin/sh
# Tawny container entrypoint: Tailscale + coturn + node server.js, no config.
#
# The design goal is that the operator pastes one auth key and is finished.
# Everything this script does is something they would otherwise have had to do
# by hand, and every value it derives is one that cannot be known until the
# container is running.
#
# There is exactly one topology — see DESIGN.md. The container joins the
# operator's tailnet, advertises the Monitor phone's LAN into it, and publishes
# the app over `tailscale serve`. TLS comes from Tailscale's Let's Encrypt
# certificate and from nowhere else: this deployment is not a certificate
# authority, generates no certificate, and asks nobody to import anything.
set -eu

RUN_DIR=/tmp/tawny
mkdir -p "$RUN_DIR"

PORT="${PORT:-8099}"
export PORT

# --- startup state, for /setup ----------------------------------------------
#
# Everything below already logs its own success/failure to stdout/stderr.
# step() persists the same information as one JSON record per call, so
# server.js can hand it to a browser without shelling out to `docker logs`.
# One JSON array, rewritten (not appended-as-text) on every call so the file
# is always valid JSON even if a call lands mid-write of another.
STATE_FILE="$RUN_DIR/setup-state.json"
echo '[]' >"$STATE_FILE"
export TAWNY_SETUP_STATE="$STATE_FILE"

step() { # step_name ok(0/1) detail [kind]
	node -e '
	  const fs = require("fs");
	  const [file, name, ok, detail, kind] = process.argv.slice(1);
	  let arr = [];
	  try {
	    arr = JSON.parse(fs.readFileSync(file, "utf8"));
	    if (!Array.isArray(arr)) arr = [];
	  } catch {}
	  arr.push({ step: name, ok: ok === "1", detail, kind: kind || "", at: new Date().toISOString() });
	  fs.writeFileSync(file, JSON.stringify(arr));
	' "$STATE_FILE" "$1" "$2" "${3:-}" "${4:-}" 2>/dev/null || true
}

# Strip an auth key out of anything we log or record. `tailscale up`'s own
# error output, and Node's execFile "Command failed:" message, both echo the
# full --authkey=… argument; that string is served on /setup over plain HTTP.
redact_key() { sed -e 's/--authkey=[A-Za-z0-9._~-]*/--authkey=<redacted>/g' \
                   -e 's/tskey-[A-Za-z0-9._~-]\{6,\}/tskey-<redacted>/g'; }

# server.js used to run a second, self-signed HTTPS listener. It is gone. Pin
# the variable off so an old value left in a .env or a stale compose file cannot
# bring it back half-configured.
TLS_PORT=off
export TLS_PORT

log() { echo "tawny: $*"; }

# --- what LAN are we on? ----------------------------------------------------
#
# Under host networking this is the real interface address, which is both the
# subnet the Monitor phone lives on and the subnet that has to be advertised
# into the tailnet for a remote Viewer to reach it. Deriving it is the
# difference between "paste an auth key" and "work out your own CIDR".
LAN_IP="$(node -e '
  const os = require("os");
  const priv = (a) => /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(a);
  let hit = "";
  for (const [name, list] of Object.entries(os.networkInterfaces() || {})) {
    if (hit) break;
    if (/^(docker|br-|veth|tailscale|lo)/.test(name)) continue;
    for (const a of list || []) {
      if ((a.family !== "IPv4" && a.family !== 4) || a.internal) continue;
      if (priv(a.address)) { hit = a.address; break; }
    }
  }
  process.stdout.write(hit);
' 2>/dev/null || true)"

# The /24 (or whatever the netmask says) that address sits in. A phone gets its
# address from the same DHCP server this box did, so this is the right subnet
# essentially always; TS_ROUTES overrides it when it is not.
LAN_CIDR=""
if [ -n "$LAN_IP" ]; then
	LAN_CIDR="$(node -e '
	  const os = require("os");
	  const want = process.argv[1];
	  for (const list of Object.values(os.networkInterfaces() || {}))
	    for (const a of list || [])
	      if (a.address === want && a.netmask) {
	        const ip = want.split(".").map(Number);
	        const nm = a.netmask.split(".").map(Number);
	        const net = ip.map((o, i) => o & nm[i]).join(".");
	        const bits = nm.reduce((n, o) => n + ((o >>> 0).toString(2).match(/1/g) || []).length, 0);
	        process.stdout.write(net + "/" + bits);
	        break;
	      }
	' "$LAN_IP" 2>/dev/null || true)"
fi
log "lan address ${LAN_IP:-none} subnet ${LAN_CIDR:-none}"
export TAWNY_LAN_IP="$LAN_IP"
export TAWNY_LAN_CIDR="$LAN_CIDR"
if [ -n "$LAN_IP" ]; then
	step lan_detect 1 "lan address $LAN_IP subnet ${LAN_CIDR:-none}"
else
	step lan_detect 0 "no private IPv4 address found on any interface"
fi

# --- Tailscale --------------------------------------------------------------
#
# Two ways in, tried in this order. Both end in the same place — this container
# reachable at https://<name>.<tailnet>.ts.net with a real certificate, and the
# phone's LAN advertised into the tailnet — and both are driven from here, so
# the operator configures Tailscale in the same compose file as everything else
# and never on the phone.
#
#   1. TS_AUTHKEY set  — the container runs its own tailscaled and joins as its
#      own node. Nothing at all has to be installed on the host. Userspace
#      networking (netstack) deliberately: with network_mode: host a kernel-mode
#      tailscaled would try to create a second tailscale0 in the host's network
#      namespace and fight any tailscaled the host already runs, and it would
#      need NET_ADMIN and /dev/net/tun to do it. In userspace mode it creates no
#      interface, needs no capability, and forwards subnet-routed traffic with
#      ordinary sockets — which, under host networking, leave from the real LAN
#      interface. That is the SNAT the design depends on, for free.
#
#   2. The host's tailscaled socket is mounted — the container drives the
#      daemon that is already logged in. Nothing to paste; the operator ran
#      `tailscale up` once, ever, for reasons that had nothing to do with Tawny.
#
# TS_SERVE=off / TS_ROUTES=off opt out of either half independently.
TS_AUTHKEY="${TS_AUTHKEY:-}"
TS_HOSTNAME="${TS_HOSTNAME:-tawny}"
TS_STATE_DIR="${TS_STATE_DIR:-/data/tailscale}"
TS_HOST_SOCKET="${TS_HOST_SOCKET:-/var/run/tailscale/tailscaled.sock}"
# Normalised to exactly `on` or `off`, and exported, because server.js reads
# the same variable and reads it the other way round: this script asks
# `= on` (anything else is off) and server.js asks `!== 'off'` (anything else
# is on). An operator writing TS_SERVE=false or TS_SERVE=0 therefore got a
# container that skipped `serve` at boot while server.js went on re-running it
# from every /setup poll and reporting the missing address as a fault.
case "${TS_SERVE:-on}" in
	0|off|OFF|no|NO|false|FALSE|disabled) TS_SERVE=off ;;
	*) TS_SERVE=on ;;
esac
export TS_SERVE
# Subnet routing is OFF unless somebody asks for it.
#
# It used to default to "advertise whatever subnet this container is on", which
# quietly made every fresh container a subnet router for the whole house. In a
# household that already runs Tailscale — a NAS, a Pi-hole, an earlier Tawny —
# that is a second router for one range, and Tailscale responds by flipping
# between them: reported to us as "the internet goes in a loop". A default
# should not be able to do that to a network.
#
#   off (default) — advertise nothing, unless /setup has been told otherwise
#   empty / auto  — the subnet this container is on
#   a CIDR        — exactly that
#
# The point of the route is watching from OUTSIDE the house, so turning it off
# by default removes a real feature. That is why it is a decision /setup makes
# the operator take rather than a setting they have to discover: the answer is
# remembered in TAWNY_ROUTE_CHOICE_FILE, so turning it on needs no file editing
# and survives a restart. server.js writes that file; this reads it.
# `${X-default}`, not `${X:-default}`. The colon form fires on unset *or empty*,
# which quietly made the "empty / auto" contract documented four lines above
# into dead code: an explicitly empty TS_ROUTES= became "off" before the case
# below could ever see it, so only the literal word `auto` ever auto-detected.
# The bare form defaults on unset alone, which is what was always meant — unset
# stays off, and off-by-default is deliberate (see the long note above).
TS_ROUTES="${TS_ROUTES-off}"
ROUTE_CHOICE_FILE="${TAWNY_ROUTE_CHOICE_FILE:-/data/route-choice}"
export TAWNY_ROUTE_CHOICE_FILE="$ROUTE_CHOICE_FILE"

route_choice=unset
if [ -f "$ROUTE_CHOICE_FILE" ]; then
	route_choice="$(cat "$ROUTE_CHOICE_FILE" 2>/dev/null || echo unset)"
fi
case "$TS_ROUTES" in
'' | auto)
	# An explicit opt-in through the environment. No question to ask.
	TS_ROUTES="$LAN_CIDR"
	;;
off)
	if [ "$route_choice" = advertise ]; then
		TS_ROUTES="$LAN_CIDR"
		log "remote access was turned on at /setup — advertising ${TS_ROUTES:-none}"
	fi
	;;
esac
export TAWNY_TS_ROUTES="$TS_ROUTES"
# Escape hatch for the operator who has already checked and knows two routers
# on this range is fine (e.g. Tailscale's own "shadow" routing, or they always
# stop the old one first). Left off, a detected conflict is reported, not
# forced — see advertise_route() below.
TS_ROUTES_FORCE="${TS_ROUTES_FORCE:-}"

# Advertise TS_ROUTES on the given socket — but only after checking that no
# other peer on the tailnet already carries an overlapping route. Two subnet
# routers for the same range is an unsupported Tailscale configuration: it
# does not fail loudly, it silently flips which one actually carries traffic,
# which from inside the house reads as "the internet goes in a loop" — see
# docker/route-conflict.js for the full story and 34768c3/4282b48's history of
# getting this topology right. Skipping the advertisement is always safe:
# Tawny still works over plain LAN and over the tailnet's own point-to-point
# link, it just cannot bridge the operator's whole home network for this box.
#
# `tailscale set --advertise-routes=` REPLACES the node's whole list rather
# than adding to it. On the host-socket path the daemon belongs to the
# operator, not to Tawny, and may already carry a route for a second subnet, a
# VLAN or a container network — writing only our CIDR silently withdrew every
# one of them, and a route disappearing is invisible until something far away
# stops working. Ask the daemon what it already advertises and union ours in.
merged_routes() { # socket -> comma-separated list for --advertise-routes
	out="$(tailscale --socket="$1" debug prefs 2>/dev/null |
		node /app/docker/route-conflict.js --merge "$TS_ROUTES" 2>/dev/null || true)"
	# No prefs (an old CLI, a daemon that has not settled) must not mean
	# "advertise nothing" — fall back to just ours, which is the old behaviour.
	[ -n "$out" ] || out="$TS_ROUTES"
	printf '%s' "$out"
}

advertise_route() {
	sock="$1"
	[ -n "$TS_ROUTES" ] && [ "$TS_ROUTES" != off ] || return 0

	conflicts="$(tailscale --socket="$sock" status --json 2>/dev/null |
		node /app/docker/route-conflict.js "$TS_ROUTES" 2>/dev/null || echo '[]')"
	want="$(merged_routes "$sock")"
	case "$conflicts" in
	'[]' | '')
		if tailscale --socket="$sock" set --advertise-routes="$want" \
			>"$RUN_DIR/ts-set.log" 2>&1; then
			log "advertising $TS_ROUTES into the tailnet"
			step tailscale_routes 1 "advertising $TS_ROUTES into the tailnet"
		else
			log "could not advertise $TS_ROUTES:" >&2
			sed 's/^/tawny:   /' "$RUN_DIR/ts-set.log" >&2 || true
			step tailscale_routes 0 "$(tail -n 20 "$RUN_DIR/ts-set.log" 2>/dev/null || true)"
		fi
		;;
	*)
		if [ "$TS_ROUTES_FORCE" = 1 ] || [ "$TS_ROUTES_FORCE" = on ]; then
			log "TS_ROUTES_FORCE is set — advertising $TS_ROUTES despite: $conflicts" >&2
			if tailscale --socket="$sock" set --advertise-routes="$want" \
				>"$RUN_DIR/ts-set.log" 2>&1; then
				step tailscale_routes 1 "advertising $TS_ROUTES (forced past a conflict: $conflicts)"
			else
				step tailscale_routes 0 "$(tail -n 20 "$RUN_DIR/ts-set.log" 2>/dev/null || true)"
			fi
		else
			log "NOT advertising $TS_ROUTES — already carried by another device on your" >&2
			log "  tailnet ($conflicts). Two routers for the same range is what makes a" >&2
			log "  tailnet's internet routing loop; see http://${LAN_IP:-<this box>}:$PORT/setup" >&2
			step route_conflict 0 "$conflicts"
		fi
		;;
	esac
}

ts_sock=""
tsd_pid=''
# 'own'  — our tailscaled, our node, ours to configure however we like.
# 'host' — the operator's daemon, which was doing something before Tawny
#          existed and will go on doing it afterwards. Every write to it is
#          therefore additive or refused, never a replacement: see
#          merged_routes() above and the `serve` guard below.
ts_mode=none

# A leftover node key in $TS_STATE_DIR that the coordination server will not
# take back (the volume outlived a tailnet, the node was deleted, an earlier
# `up` half-registered) wedges tailscaled in NoState *forever* — every later
# `up` then hangs with no key ever at fault. This marker, a sibling of the
# state dir so it survives a restart, stops the self-heal below from archiving
# the state on every single boot when a genuinely bad key is the problem.
TS_RESET_MARK="$(dirname "$TS_STATE_DIR")/.tawny-ts-reset"
# server.js drops the pasted key here to ask the supervisor loop for a reset
# it cannot do itself (it does not own the tailscaled process).
TS_RECOVER_REQ="$RUN_DIR/ts-recover.req"

# Start (or restart) our own tailscaled and wait for its socket. Sets tsd_pid.
ts_launch() {
	mkdir -p "$TS_STATE_DIR"
	tailscaled \
		--tun=userspace-networking \
		--socket="$ts_sock" \
		--statedir="$TS_STATE_DIR" \
		--port=0 >"$RUN_DIR/tailscaled.log" 2>&1 &
	tsd_pid=$!
	# The daemon opens its socket a moment after the process exists; `tailscale
	# up` against a socket that is not there yet fails with a connection error
	# that reads exactly like a broken mount.
	i=0
	while [ ! -S "$ts_sock" ] && [ "$i" -lt 30 ]; do i=$((i + 1)); sleep 1; done
}

# Why did `up` fail? Read its output *and* the daemon's health.
#   stale   — a persisted node key control rejects; a fresh one fixes it and
#             the operator's auth key is fine.
#   badkey  — the auth key: expired, single-use spent, tags not permitted.
#   network — could not reach the coordination server at all.
#   unknown — anything else; do not touch the state dir.
#
# The daemon's own account of why it is not logged in has to come from
# `status --json`: plain `tailscale status` prints "Logged out." and stops
# there in exactly the states this classifies, while the JSON `Health` array
# reliably carries "You are logged out. The last login error was: register
# request: http 400: node nodekey:… already exists" — the one string that tells
# a stale identity apart from a key the operator simply got wrong. Folding in
# the plain output instead was letting `stale` go undetected.
ts_health() {
	tailscale --socket="$ts_sock" status --json 2>/dev/null | node -e '
	  let s = "";
	  process.stdin.on("data", (d) => (s += d)).on("end", () => {
	    try {
	      const j = JSON.parse(s);
	      // Health is an array in current releases and was a map in older
	      // ones; take either without caring which.
	      const h = Array.isArray(j.Health) ? j.Health : Object.values(j.Health || {});
	      process.stdout.write([j.BackendState || "", ...h.map(String)].join("\n"));
	    } catch {}
	  });
	' 2>/dev/null || true
}

ts_fail_kind() { # up_log
	txt="$(cat "$1" 2>/dev/null || true)
$(ts_health)"
	# Order matters, and so does what is NOT a signal here. Getting this wrong
	# is destructive: `stale` archives the node identity, so a household whose
	# internet happens to be down at boot would come back needing a fresh auth
	# key and a fresh route approval. Observed doing exactly that.
	#
	#   - "last login error" is NOT a stale signal. It is the wrapper Tailscale
	#     puts round *every* failed login, DNS outages included — the health
	#     line for an unreachable control plane reads "You are logged out. The
	#     last login error was: fetch control key: … failed to resolve …".
	#   - "register request: http 4" is not one either on its own: a refused
	#     auth key comes back as a 401 through the same path. It is kept, but
	#     only after badkey and network have had their say.
	#   - NoState is too noisy (it shows briefly on any fresh start).
	#
	# What is left in the first arm is unambiguous: control has this node key
	# already and will not re-register it. Nothing else produces those strings.
	# The up log always contains "timeout waiting for …" once --timeout fires,
	# which is why network cannot be checked first.
	case "$txt" in
		*"already exists"*|*"wrong nodekey"*|*"duplicate node key"*|*"node key has been used"*) echo stale ;;
		*"invalid key"*|*"bad authkey"*|*"authkey"*|*expired*|*"is not valid"*|*"requires an auth key"*|*unauthorized*|*"not permitted"*|*"http 401"*|*"http 403"*) echo badkey ;;
		*timeout*|*deadline*|*"dial tcp"*|*"no route to host"*|*"lookup "*|*"failed to resolve"*|*"no dns"*|*"network is unreachable"*|*"i/o timeout"*|*"connection refused"*|*"TLS handshake"*) echo network ;;
		*"register request: http 4"*) echo stale ;;
		*) echo unknown ;;
	esac
}

# Move an unusable identity aside (never delete — keep it for inspection),
# keep the two most recent archives, and bring tailscaled back clean.
ts_reset_state() {
	log "clearing a leftover Tailscale identity in $TS_STATE_DIR"
	tailscale --socket="$ts_sock" logout >/dev/null 2>&1 || true
	if [ -n "$tsd_pid" ]; then
		kill "$tsd_pid" 2>/dev/null || true
		i=0; while kill -0 "$tsd_pid" 2>/dev/null && [ "$i" -lt 10 ]; do i=$((i + 1)); sleep 1; done
	fi
	broken="$TS_STATE_DIR.broken-$(date -u +%Y%m%dT%H%M%SZ)"
	mv "$TS_STATE_DIR" "$broken" 2>/dev/null && printf '%s\n' "$broken" >"$RUN_DIR/ts-archived" || rm -rf "$TS_STATE_DIR"
	ls -1dt "$TS_STATE_DIR".broken-* 2>/dev/null | tail -n +3 | while read -r d; do rm -rf "$d"; done
	ts_launch
}

# Join the tailnet with $1. --timeout so a control-plane stall returns a real,
# classifiable error instead of blocking; on a stale identity, archive it and
# retry once — the "replace an old session on the spot" the operator should
# never have to do by hand. Records tailscale_up with a kind for /setup.
ts_join() { # authkey
	# `if cmd; then` (not `cmd; [ $? ]`) so `set -e` does not abort on the
	# expected failure path.
	if tailscale --socket="$ts_sock" up \
		--authkey="$1" --hostname="$TS_HOSTNAME" \
		--accept-dns=false --accept-routes=false --timeout=60s \
		>"$RUN_DIR/ts-up.log" 2>&1; then
		rm -f "$TS_RESET_MARK"
		log "joined the tailnet as $TS_HOSTNAME"
		step tailscale_up 1 "joined the tailnet as $TS_HOSTNAME"
		advertise_route "$ts_sock"
		return 0
	fi

	kind="$(ts_fail_kind "$RUN_DIR/ts-up.log")"
	if [ "$kind" = stale ] && [ ! -f "$TS_RESET_MARK" ]; then
		log "tailscale up failed on a leftover identity — clearing it and retrying" >&2
		ts_reset_state
		: >"$TS_RESET_MARK"
		if tailscale --socket="$ts_sock" up \
			--authkey="$1" --hostname="$TS_HOSTNAME" \
			--accept-dns=false --accept-routes=false --timeout=60s \
			>"$RUN_DIR/ts-up.log" 2>&1; then
			# Clearing the state dir is what fixed it, so the marker has done
			# its job and must not survive: left behind it disarms the
			# self-heal for the life of the volume, and the *next* time an
			# identity goes stale nothing would clear it.
			rm -f "$TS_RESET_MARK"
			log "joined as $TS_HOSTNAME after clearing a leftover identity"
			step tailscale_up 1 "joined after clearing a leftover Tailscale identity; the old state was archived to $(cat "$RUN_DIR/ts-archived" 2>/dev/null || true)"
			advertise_route "$ts_sock"
			return 0
		fi
		kind="$(ts_fail_kind "$RUN_DIR/ts-up.log")"
		if [ "$kind" = stale ]; then kind=stale_unrecovered; fi
	fi

	detail="$(tail -n 20 "$RUN_DIR/ts-up.log" 2>/dev/null | redact_key)"
	log "tailscale up FAILED ($kind) — remote viewing will not work:" >&2
	printf '%s\n' "$detail" | sed 's/^/tawny:   /' >&2
	step tailscale_up 0 "$detail" "$kind"
	return 1
}

# The daemon starts whether or not there is a key, so that an operator who has
# not got one yet can paste it into /setup and be joined without ever editing a
# file or restarting anything. A logged-out tailscaled is idle and harmless;
# `up` is what joins, and that can happen now or in five minutes from a browser.
if command -v tailscaled >/dev/null 2>&1 &&
	{ [ -n "$TS_AUTHKEY" ] || [ ! -S "$TS_HOST_SOCKET" ]; }; then
	ts_sock="$RUN_DIR/tailscaled.sock"
	ts_mode=own
	log "starting our own tailscaled (userspace networking), state in $TS_STATE_DIR"
	ts_launch

	if [ -n "$TS_AUTHKEY" ]; then
		# --advertise-routes is deliberately not passed to `up`. A household
		# that already runs Tailscale for something else — a NAS, a Pi-hole, a
		# previous Tawny box — very often already has a subnet router for this
		# same /24, and joining first is what lets us ask "does anyone already
		# carry this route" *before* announcing it too. See advertise_route()
		# and docker/route-conflict.js.
		ts_join "$TS_AUTHKEY" || true
	else
		log "no auth key yet — paste one at http://${LAN_IP:-<this box>}:$PORT/setup"
	fi
elif [ -S "$TS_HOST_SOCKET" ] && command -v tailscale >/dev/null 2>&1; then
	ts_sock="$TS_HOST_SOCKET"
	ts_mode=host
	log "using the host's tailscaled via $TS_HOST_SOCKET (its existing routes and"
	log "  serve configuration are left alone — Tawny only adds to them)"
	advertise_route "$ts_sock"
else
	log "no Tailscale (set TS_AUTHKEY, or mount the host's tailscaled socket)"
	# Careful with this claim: /setup answers over plain http, and two phones
	# on this Wi-Fi still pair directly without the container at all. But a
	# BROWSER will not run a session on http://<lan-ip> — public/app.js
	# start() bails on !window.isSecureContext for both roles, because the
	# Viewer takes a microphone for talk-back too. Only 127.0.0.1 on this
	# machine is a secure context without TLS.
	log "  /setup still answers on http://${LAN_IP:-<this box>}:$PORT, and two phones"
	log "  on this Wi-Fi can still pair with each other directly. A browser needs"
	log "  the https address, though — it will not start a session on a plain one."
fi

# Neither path may have produced a usable socket (auth failed, nothing
# configured at all) — /setup then reports "not on a tailnet" rather than
# trying to query a socket that was never opened.
if [ -n "$ts_sock" ]; then
	export TAWNY_TS_SOCKET="$ts_sock"
fi
# server.js has to know whose daemon it is talking to, for the same reason this
# script does: on the host's it may only add, and /setup must not offer to log
# the operator's own machine into a different tailnet.
export TAWNY_TS_MODE="$ts_mode"

# The daemon can now be running but logged out (no key yet). Advertising a
# route or publishing a `serve` both need a login, so ask before doing either —
# otherwise a first boot with no key records a serve "failure" that is really
# just "not joined yet", which is exactly the misleading state /setup exists to
# prevent.
ts_state=''
if [ -n "$ts_sock" ]; then
	ts_state="$(tailscale --socket="$ts_sock" status --json 2>/dev/null | node -e '
	  let s = "";
	  process.stdin.on("data", (d) => (s += d)).on("end", () => {
	    try { process.stdout.write(String(JSON.parse(s).BackendState || "")); } catch {}
	  });
	' 2>/dev/null || true)"
fi
export TAWNY_TS_HOSTNAME="$TS_HOSTNAME"

if [ -n "$ts_sock" ] && [ "$ts_state" = Running ]; then
	if [ -n "$TS_ROUTES" ] && [ "$TS_ROUTES" != off ]; then
		# Approval shows up as the advertised CIDR appearing in this node's own
		# AllowedIPs — same check probe.sh does against the host, run here
		# against the container's own socket, which is where it is actually
		# true. Silences the reminder once the operator has done the one
		# thing it is nagging about, instead of printing it on every restart.
		approved="$(tailscale --socket="$ts_sock" status --json 2>/dev/null | node -e '
		  let s = "";
		  process.stdin.on("data", (d) => (s += d)).on("end", () => {
		    try {
		      const allowed = (JSON.parse(s).Self || {}).AllowedIPs || [];
		      process.stdout.write(allowed.includes(process.argv[1]) ? "1" : "0");
		    } catch { process.stdout.write("0"); }
		  });
		' "$TS_ROUTES" 2>/dev/null || echo 0)"
		if [ "$approved" != 1 ]; then
			log "NOTE: a subnet route carries nothing until it is approved once at"
			log "      https://login.tailscale.com/admin/machines — this node ->"
			log "      Edit route settings -> tick $TS_ROUTES"
		fi
	fi
	# `serve --bg <url>` publishes at https://<node>/ — and takes that mount
	# point over from whatever was there before. On our own node that is only
	# ever our own previous run. On the operator's node it could be the thing
	# they actually installed Tailscale for, and replacing it without asking is
	# not ours to do. So on the host path: look first, and step aside if the
	# node is already serving something that is not us.
	serve_taken=0
	if [ "$ts_mode" = host ] && [ "$TS_SERVE" = on ]; then
		# `serve status --json` looks like:
		#   {"TCP":{"443":{"HTTPS":true}},
		#    "Web":{"host:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8099"}}}}}
		# A populated TCP block is NOT evidence of someone else: the `443/HTTPS`
		# entry is what terminates TLS for our own Web handler, so treating it
		# as "taken" would make a restart refuse to re-publish Tawny's own
		# config. Only a raw TCPForward, or a Web handler proxying somewhere
		# other than our port, is somebody else's.
		serve_taken="$(tailscale --socket="$ts_sock" serve status --json 2>/dev/null | node -e '
		  let s = "";
		  process.stdin.on("data", (d) => (s += d)).on("end", () => {
		    let j = null;
		    try { j = JSON.parse(s); } catch {}
		    // No output, or a CLI too old for --json: assume free, which is
		    // exactly what this script did before the check existed.
		    if (!j) return process.stdout.write("0");
		    const mine = "http://127.0.0.1:" + process.argv[1];
		    let other = false;
		    for (const t of Object.values(j.TCP || {})) if (t && t.TCPForward) other = true;
		    for (const host of Object.values(j.Web || {}))
		      for (const h of Object.values((host && host.Handlers) || {}))
		        if (!h || h.Proxy !== mine) other = true;
		    process.stdout.write(other ? "1" : "0");
		  });
		' "$PORT" 2>/dev/null || echo 0)"
	fi
	if [ "$TS_SERVE" = on ] && [ "$serve_taken" = 1 ]; then
		log "NOT publishing over tailscale serve: this machine already serves" >&2
		log "  something else at its Tailscale address, and taking that over would" >&2
		log "  break it. Use TS_AUTHKEY to give Tawny its own node, or free the" >&2
		log "  address with 'tailscale serve reset' and restart." >&2
		step tailscale_serve 0 "this machine's Tailscale address already serves something else; Tawny left it alone. Give Tawny its own node with TS_AUTHKEY, or free the address with 'tailscale serve reset'."
	elif [ "$TS_SERVE" = on ]; then
		# --bg because this script has a supervision loop of its own below and
		# `serve` in the foreground would own the process. Serving http (not
		# https+insecure) because there is no local TLS listener any more:
		# Tailscale terminates TLS with its Let's Encrypt certificate and
		# proxies to the plain listener on loopback.
		if tailscale --socket="$ts_sock" serve --bg "http://127.0.0.1:$PORT" \
			>"$RUN_DIR/ts-serve.log" 2>&1; then
			name="$(tailscale --socket="$ts_sock" status --json 2>/dev/null \
				| node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
				    try{process.stdout.write((JSON.parse(s).Self||{}).DNSName||"")}catch{}})' \
				| sed 's/\.$//')"
			log "serving the app at https://${name:-<this node>.<tailnet>.ts.net}/"
			step tailscale_serve 1 "https://${name:-<this node>.<tailnet>.ts.net}/"
		else
			log "tailscale serve FAILED:" >&2
			sed 's/^/tawny:   /' "$RUN_DIR/ts-serve.log" >&2 || true
			step tailscale_serve 0 "$(tail -n 20 "$RUN_DIR/ts-serve.log" 2>/dev/null || true)"
			# The overwhelmingly common cause on a new tailnet: HTTPS/MagicDNS
			# are off. They are account-wide switches, off by default, and
			# `serve` says so on stderr — but spell it out here too.
			if grep -qiE 'https|magicdns' "$RUN_DIR/ts-serve.log" 2>/dev/null; then
				log "  ^ turn on MagicDNS and HTTPS certificates once at" >&2
				log "    https://login.tailscale.com/admin/dns — server.js keeps retrying" >&2
				log "    serve, so it publishes on its own within seconds, no restart" >&2
			fi
		fi
	fi
fi

# --- TURN shared secret -----------------------------------------------------
# coturn and server.js must agree on one secret. Making the operator invent it
# and paste it into two places was the single most error-prone step in the old
# setup, and a secret that ships in an image or a compose file is not a secret.
# Generate one per container start and hand it to both through a file.
TURN_SECRET_FILE="$RUN_DIR/turn-secret"
if [ -n "${TAWNY_TURN_SECRET:-}" ]; then
	printf '%s' "$TAWNY_TURN_SECRET" >"$TURN_SECRET_FILE"
else
	# node is always present in this image; it needs no extra package the way
	# openssl would, and this is a CSPRNG.
	node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64url"))' \
		>"$TURN_SECRET_FILE"
fi
chmod 600 "$TURN_SECRET_FILE"
export TURN_SECRET_FILE

# --- coturn -----------------------------------------------------------------
# The fallback, not the plan. The subnet route is what carries media; this is
# for the network that blocks direct UDP between two hosts on it, and for the
# phone that fell back to the cloud rendezvous. TURN_EMBEDDED=off to drop it.
TURN_EMBEDDED="${TURN_EMBEDDED:-on}"
TURN_PORT="${TURN_PORT:-3478}"
TURN_MIN_PORT="${TURN_MIN_PORT:-49160}"
TURN_MAX_PORT="${TURN_MAX_PORT:-49200}"
export TURN_EMBEDDED TURN_PORT

turn_pid=''
if [ "$TURN_EMBEDDED" = on ] && command -v turnserver >/dev/null 2>&1; then
	# --external-ip is the one thing a relay behind NAT must be told and cannot
	# always work out. In host networking it is not needed at all (coturn sees
	# the real address); behind a port-forward the operator sets
	# TAWNY_PUBLIC_IP and we pass it here so relay candidates carry the address
	# that is actually reachable rather than a private one.
	set -- \
		-n --no-cli --no-tls --no-dtls \
		--use-auth-secret --static-auth-secret="$(cat "$TURN_SECRET_FILE")" \
		--realm=tawny \
		--listening-port="$TURN_PORT" \
		--min-port="$TURN_MIN_PORT" --max-port="$TURN_MAX_PORT" \
		--no-multicast-peers --no-software-attribute \
		--stale-nonce=600
	# Deliberately NOT pinning --listening-ip/--relay-ip. Pinning them to one
	# interface is what broke the tailnet deployment in 2026-09: the relay only
	# answered on the Tailscale address, so a peer that reached it over the LAN
	# arrived from a source the other end had never advertised and coturn
	# dropped it for want of a permission. Listening everywhere lets each peer
	# reach the relay by whichever of its addresses it already uses — the LAN
	# one, the tailnet one, or a forwarded public one.
	if [ -n "${TAWNY_PUBLIC_IP:-}" ]; then
		set -- "$@" --external-ip="$TAWNY_PUBLIC_IP"
	fi
	turnserver "$@" &
	turn_pid=$!
	log "coturn started on :$TURN_PORT (relay $TURN_MIN_PORT-$TURN_MAX_PORT), all interfaces"
	step coturn 1 "coturn started on :$TURN_PORT (relay $TURN_MIN_PORT-$TURN_MAX_PORT)"
else
	if [ "$TURN_EMBEDDED" = on ]; then
		log "no embedded TURN (turnserver binary not found)"
		step coturn 0 "TURN_EMBEDDED=on but the turnserver binary is missing from this image"
	else
		log "no embedded TURN (TURN_EMBEDDED=$TURN_EMBEDDED)"
		step coturn 1 "embedded TURN disabled (TURN_EMBEDDED=$TURN_EMBEDDED)"
	fi
	export TURN_EMBEDDED=off
fi

log "open http://${LAN_IP:-<this box>}:$PORT/setup — it will tell you if anything needs doing"

# --- node -------------------------------------------------------------------
# Either process dying should take the container down so the restart policy can
# do its job, rather than leaving a half-working deployment that answers HTTP
# but relays nothing.
node /app/server.js &
node_pid=$!

term() {
	[ -n "$turn_pid" ] && kill "$turn_pid" 2>/dev/null || true
	[ -n "$tsd_pid" ] && kill "$tsd_pid" 2>/dev/null || true
	kill "$node_pid" 2>/dev/null || true
}
trap term TERM INT

# busybox ash has no reliable `wait -n`, so poll. One second of latency on a
# crash is irrelevant next to portability across the shells this image may use.
while :; do
	# /setup cannot restart tailscaled itself (server.js does not own the
	# process), so it leaves the pasted key here to ask for the same
	# archive-and-rejoin ts_join() does at boot. Handled before the
	# tailscaled-exited check because ts_reset_state() kills the daemon.
	if [ "$ts_mode" = own ] && [ -f "$TS_RECOVER_REQ" ]; then
		rk="$(cat "$TS_RECOVER_REQ" 2>/dev/null || true)"
		rm -f "$TS_RECOVER_REQ"
		echo "tawny: /setup asked to clear a leftover Tailscale identity" >&2
		ts_reset_state
		# `|| true`: this loop is the container's supervisor and `set -e` is in
		# force here — a marker that cannot be written (a read-only /data) must
		# not be what takes the whole deployment down.
		: >"$TS_RESET_MARK" || true   # deliberate reset; ts_join reports if it still fails
		[ -n "$rk" ] && ts_join "$rk" || true
		continue
	fi
	if ! kill -0 "$node_pid" 2>/dev/null; then
		wait "$node_pid" 2>/dev/null; status=$?; break
	fi
	if [ -n "$turn_pid" ] && ! kill -0 "$turn_pid" 2>/dev/null; then
		echo "tawny: coturn exited — stopping so the restart policy can retry" >&2
		status=1; break
	fi
	if [ -n "$tsd_pid" ] && ! kill -0 "$tsd_pid" 2>/dev/null; then
		echo "tawny: tailscaled exited — stopping so the restart policy can retry" >&2
		status=1; break
	fi
	sleep 1
done
term
exit "${status:-1}"
