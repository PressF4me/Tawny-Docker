# How Tawny's container is put together

The single source of truth for what this deployment is and why. If a comment in
the code disagrees with this file, the comment is right — fix this file.

There is **one topology**. It runs over Tailscale. There is no self-signed
certificate, no certificate authority, nothing for anyone to import, and no
hosted service of any kind — no Cloudflare, no signup, no API token. You paste
one Tailscale auth key into a compose file and approve one route.

---

## The shape

```
   Android app                          the box running the container
   the Monitor                          (same LAN as the phone)
   192.168.1.34                         ┌─────────────────────────────────┐
   relay on :8820 (0.0.0.0)             │ node server.js  :8099 http      │
        │                               │ tailscaled (userspace)          │
        │  h=192.168.1.34:8820          │   • joins your tailnet          │
        │  in every pairing link        │   • advertises 192.168.1.0/24   │
        │                               │   • tailscale serve → :8099     │
        ▼                               │ coturn :3478  (fallback only)   │
   ┌─────────┐                          └───────────────┬─────────────────┘
   │ browser │  https://tawny.<tailnet>.ts.net          │ subnet route + SNAT
   │ Viewer  │  (Let's Encrypt, no warning) ───────────►│
   │ +Tailsc.│                                          ▼
   │ --accept│═══════ WebRTC to 192.168.1.34 ══════════ the phone
   │  -routes│        through the subnet route,
   └─────────┘        host/peer-reflexive candidates.
                      Video and audio never touch the container.
```

The **Monitor is the stock Android app** — the Servers screen left blank, which
is the default. That screen exists for people who run their own signalling
server for privacy or self-hosting reasons; it is **not** how you connect a
container Tawny to a phone Tawny, and this deployment never asks anyone to touch
it. The app already runs a signalling relay of its own on
`ws://<phone-ip>:8820`, bound to every interface, and puts that address in every
pairing link as `h=`.

The **Viewer is a browser** with Tailscale running and subnet routes accepted.
It loads the app from the container at `https://<node>.<tailnet>.ts.net` — over
**https**, and this is not a nicety. `start()` in `public/app.js` bails on
`!window.isSecureContext` for **both roles** before opening anything: the
Viewer takes a microphone for talk-back just as the Monitor takes a camera. So
on `http://192.168.x` the page loads and then refuses to begin. It is not a
degraded mode with talk-back missing — it is no session at all. A browser
counts `https://` and loopback as secure and nothing else, which is why the one
plain-http client that works is the Android app, serving itself from
`http://127.0.0.1:<port>` (`MainActivity.kt`).

The **container** does three things:

1. **Joins your tailnet** as its own node (`tailscaled` in userspace-networking
   mode — no `NET_ADMIN`, no `/dev/net/tun`), using the `TS_AUTHKEY` you set.
2. **Advertises the Monitor phone's LAN into the tailnet** as a subnet route —
   *once asked to*. `TS_ROUTES` defaults to `off`, because a container that
   advertises a subnet the instant it starts makes a second router for a
   network that very often already has one, and Tailscale answers that by
   flipping between them; from inside the house that reads as the internet
   stalling. Off is safe but it is also the whole remote feature switched off,
   so it is a **question `/setup` asks out loud**, not a setting to discover:
   the deployment does not count as finished (`setupReady()`) until the
   operator has either turned it on or answered "this Wi-Fi only", and the
   answer is written to `/data/route-choice` so it survives a restart and
   needs no file editing. If a peer already carries the range, no question is
   asked — `findRouteCoverage()` treats that as the route existing.
   This is the part every earlier tailnet attempt got wrong. If only the
   container is on the tailnet, the remote Viewer and the phone live in two
   address spaces that cannot form an ICE pair, and coturn — handed a source
   from a network the other end never advertised — drops the traffic. Advertise
   `192.168.1.0/24` and the Viewer reaches `192.168.1.34` directly: one address
   space, ordinary NAT, the case ICE was built for.
3. **Publishes the app with `tailscale serve`**, which fronts it at
   `https://<node>.<tailnet>.ts.net` with a real Let's Encrypt certificate.

Tailscale masquerades subnet-routed traffic by default (`NoSNAT: false`), so the
phone sees each connectivity check arriving from the router's LAN address and
answers there. ICE calls that a peer-reflexive candidate and pairs on it. No
relay is involved; the media is peer-to-peer, DTLS-SRTP, end to end.

### Why not just point the phone at the container?

Because the shipped app (v0.3.1, build 28) cannot be pointed anywhere useful,
and it cannot be rebuilt.

* Its Servers screen takes a `ws://` rendezvous — and then the WebView's own
  `connect-src`, built in `LocalWeb.kt`'s `connectSrc()`, only ever emits
  `wss://<host>` and `https://<host>`. Under CSP scheme matching a `wss` source
  does not permit a `ws` URL, so a cleartext rendezvous never leaves the
  process. Measured here against Chromium.
* `wss://` would need a certificate, and `network_security_config.xml` gives the
  app `<certificates src="system" />` only — no operator CA, and no public CA
  will sign `192.168.1.50`.
* Its `lanIp()` returns the `wlan*` RFC1918 address and never a Tailscale
  `100.64/10` one, so its pairing link's `h=` is always the Wi-Fi address.

So the phone contributes exactly what a stock phone on Wi-Fi contributes: a
`192.168.x` host candidate and a public server-reflexive one. The subnet route
is what makes that first candidate reachable from outside the house. Nothing on
the phone changes, ever.

### The `/lan` bridge

`server.js` also carries a WebSocket bridge at
`wss://<node>.<tailnet>.ts.net/lan/<phone-ip>/<port>/ws`. `adopt()` in
`public/app.js` rewrites the pairing link's `h=` to that URL. It exists for the
signalling handshake only — an https page may not open `ws://192.168.x` (mixed
content, no private-address exception), so the page asks the container, which is
on the phone's LAN, to make that hop in cleartext on the operator's own network.
The relay's HMAC challenge, the room id and every SDP pass through byte for
byte; nothing is parsed or reframed. Media does not go through it — that is the
subnet route's job.

Under host networking the container reaches `192.168.1.34:8820` directly. In the
bridge-networking fallback it cannot, and a remote Viewer then depends on the
phone falling back to its cloud rendezvous plus coturn.

---

## coturn

Stays in the image. Starts with a secret generated per container, listens on
**all interfaces** (never pinned to one — pinning it to the Tailscale address is
what broke the September 2026 deployment: the relay answered only there, so a
peer that reached it over the LAN arrived from an unpermitted source and was
dropped). It is the fallback for a network that blocks direct UDP between two
hosts on it, and for a phone that fell back to the cloud rendezvous. The
supported topology does not use it and the end-to-end test did not either.

---

## Why host networking

`network_mode: host` is load-bearing:

* the container has to see the **real LAN interface** to know which subnet to
  advertise (`entrypoint.sh` derives the CIDR from it) — behind a bridge it sees
  `172.18.x` and advertises the wrong thing;
* it has to open a socket to the **Monitor phone** on that LAN for the `/lan`
  bridge;
* it hands **coturn** the real interface addresses, the difference between a
  relay that allocates and one that quietly hands out unreachable candidates;
* `tailscaled` in userspace mode forwards subnet-routed traffic with ordinary
  sockets, which under host networking leave from the real LAN interface — that
  is the SNAT the design depends on, for free.

The Portainer stack keeps a bridge variant for environments that forbid host
networking. It works for the LAN case at the cost of supplying `TS_ROUTES` by
hand; the `/lan` bridge and a clean remote path do not survive it.

---

## The manual steps

Two things live in the Tailscale admin console and cannot be driven from a
compose file, because they are properties of the operator's whole account, not
of this node. Both are one-time.

**1. HTTPS certificates + MagicDNS must be enabled** for the tailnet
(login.tailscale.com/admin/dns). `tailscale serve` publishes an HTTPS host, and
it will not — it errors on stderr — unless the tailnet has HTTPS certificates
turned on; MagicDNS is what makes `tawny.<tailnet>.ts.net` resolve on the
operator's other devices. **Both are off by default on a newly created
tailnet**, which is the single most likely reason a fresh deployment's
`https://…ts.net` address simply does not open. An account that has used
`tailscale serve` or Funnel before already has them on. `entrypoint.sh` copies
the `serve` error to its log with a pointer to the DNS page; `/setup` reads the
same error and, when it mentions HTTPS or MagicDNS, renders the "turn on HTTPS
in Tailscale" step instead of the generic "leftover setting" advice.

**2. The subnet route must be approved.** A subnet route carries nothing until
it is **approved once** — this node → *Edit route settings* → tick the subnet.
Until then it is advertised and inert, and from the far end that looks exactly
like a firewall problem. `entrypoint.sh` prints the exact link at every start,
and `probe.sh` reports which state you are in.

---

## When the machine is already on Tailscale

The common case, not the exception: a box that runs Docker is a box that
somebody already put on their tailnet, for a NAS share or an SSH shortcut. Two
rules follow, and everything in `entrypoint.sh` and `server.js` obeys them.

**On the host's daemon, Tawny only ever adds.** `TS_AUTHKEY` empty and the
host's socket mounted means the daemon belongs to the operator. So:

* `tailscale set --advertise-routes=` **replaces** a node's whole route list.
  Writing just Tawny's CIDR there withdrew every other route the machine
  carried — silently, and invisibly until something far away stopped working.
  `merged_routes()` (shell) and `advertiseRoute()` (node) read the current
  prefs and union ours in; `withdrawRoutes()` subtracts only ours.
* `tailscale serve --bg` **takes over** `https://<node>/`. If that node already
  serves something, Tawny declines and says so — the fix is `TS_AUTHKEY`, which
  gives Tawny a node of its own, not evicting whatever was there.
* `tailscale up` is refused outright against the host's daemon. It would
  re-authenticate the operator's actual machine: new hostname, possibly a
  different tailnet, `--accept-routes=false` applied to a device that wanted it
  true. `/setup` explains rather than offering a key box that must not work.

**An exit node is not a subnet router.** A peer's `AllowedIPs` carries
`0.0.0.0/0` when it is an exit node, and a Tailscale account can add a hundred
Mullvad exit nodes with one click. A default route overlaps every subnet, so
the overlap test read every one of them as "somebody already carries your LAN"
and Tawny declined to advertise the single route the remote path depends on.
`notASubnetRoute()` in `docker/route-conflict.js` excludes default routes and
`/32`s; `probe.sh` has the regression test.

---

## What is deliberately not here

* **Hosted TURN of any kind.** Nobody creates an account with a media
  infrastructure company to watch their cat.
* **A self-signed certificate or a CA to import.** Tailscale's Let's Encrypt
  cert is the only TLS in the design. `server.js` runs a plain HTTP listener and
  nothing else; `tailscale serve` terminates TLS in front of it.
* **A public domain, DNS records, port forwarding.** The tailnet is the only
  network path in.
* **Anything on the phone.** No Servers screen, no certificate, no app rebuild.

---

## The pieces, and where they live

| Thing | File |
|---|---|
| HTTP listener, signalling, `/lan` bridge, host-derived `/config.json` + `/turn` | `../frentalk/server.js` |
| tailscaled + `tailscale serve` + route advertisement, coturn, supervision | `../frentalk/docker/entrypoint.sh` |
| Routing a pairing link's `h=` through the bridge | `../frentalk/public/app.js`, `adopt()` |
| The Monitor's own LAN relay, and the CSP that constrains all of this | `../frentalk/android/.../LocalWeb.kt` |
| Image | `Dockerfile` |
| Deployment | `docker-compose.yml`, `docker-compose.portainer.yml` |
| Everything above, checked | `probe.sh` |

---

## Security notes

* The `/lan` bridge only dials private address space (RFC1918, link-local, and
  `100.64/10`), ports ≥1024, at most 16 at once, and only for a request whose
  `Origin` matches the page it served. A pairing link is something a stranger
  can hand you, so the target is checked twice — in `app.js` before it is used
  and in `server.js` before a socket opens.
* The LAN hop is cleartext, the same exposure the Android app has always had
  between two phones on one Wi-Fi: signalling carries SDP and a hashed room id,
  never the channel key, and the media is DTLS-SRTP end to end regardless.
* The channel key never reaches the container, and neither does a frame of
  video. See `../frentalk/SECURITY.md`.
* `TS_AUTHKEY` is a bearer credential for joining your tailnet. Use a
  pre-approved reusable key, not an ephemeral one (an ephemeral node drops its
  advertised route when it goes offline). Keep it in `.env`, not in the compose
  file.
