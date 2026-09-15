> [!NOTE]
> **Built with AI.** Tawny, including this container, is made by its
> maintainer working with Claude, an AI model made by Anthropic. Most of the
> code, documentation and artwork here was written with Claude, under the
> maintainer's direction. Some people avoid AI-built software for ethical,
> political, professional or personal reasons, so you should know that before
> you install, run or contribute.

# Tawny Docker

Run your own Tawny — the two-way pet monitor — as a container on a box at home.
No account, no domain, no port forwarding, no certificates. It runs over your
Tailscale.

**A pet monitor with no paywalls.** No subscription, no locked features, no ads,
nothing hosted by anyone else. You point an old phone at the pet and watch from
a browser; the only thing that ever sees the stream is you.

<p align="center">
  <img src="docs/media/screenshot-01.jpg" width="200" alt="Your pet, live on your phone">
  <img src="docs/media/screenshot-02.jpg" width="200" alt="Pair with one photo">
  <img src="docs/media/screenshot-03.jpg" width="200" alt="See, hear and talk back">
  <img src="docs/media/screenshot-04.jpg" width="200" alt="Private by design">
</p>
<p align="center">
  <img src="docs/media/screenshot-05.jpg" width="200" alt="One stays home, one comes along">
  <img src="docs/media/screenshot-06.jpg" width="200" alt="Dim the screen, keep listening">
  <img src="docs/media/screenshot-07.jpg" width="200" alt="Back in one tap">
  <img src="docs/media/screenshot-08.jpg" width="200" alt="Light or dark">
</p>
<p align="center">
  <sub>Shown on the Android app. The page this container serves is the same
  web client, so a browser Viewer looks and works the same way.</sub><br>
  <a href="https://github.com/PressF4me/Tawny-Pet-Monitor-APK/blob/master/docs/media/demo.mp4"><b>▶ Watch the setup video</b></a> (79 s)
</p>

**What this is mainly for: a bridge.** The Monitor phone runs the Tawny Android
app, pointed at your pet. Whoever's watching doesn't need the app at all — they
open the `https://…ts.net` address this container publishes, in a plain
browser, on anything signed into your tailnet: a laptop, someone else's phone,
a shared family tablet. No app store, no install, no account, for them. That's
the point of running this at all — the app download that's easy for you is a
wall for a grandparent, a house-sitter, or a phone you don't control.

It doesn't stop there, though. Both ends can just as well be this same web
page — open it on two phones, pick Monitor on one and Viewer on the other, and
it works exactly the same way with nothing installed on either. Use whichever
mix fits the room: app on the Monitor and a browser Viewer (the common case),
or browser on both. The container serves either role and joins your tailnet so
the two ends can find each other; the video and audio go straight between them
and never pass through it.

The image is pulled from `ghcr.io/pressf4me/tawny` — nothing to build, and the
only file you need from this repo is `docker-compose.yml`.

---

## Setup

Once. After this, watching is: open the app on the phone, open a URL on the
Viewer, scan.

**1. Auth key.** At <https://login.tailscale.com/admin/settings/keys> → generate
one, **Reusable**, **Ephemeral off**.

**2. HTTPS in your tailnet.** At <https://login.tailscale.com/admin/dns> enable
**MagicDNS**, then **HTTPS Certificates**. Account-wide, done once, **off by
default on a new tailnet**. Without it `tailscale serve` can't publish an
`https://…ts.net` address, and talk-back (a mic needs HTTPS) can't work. Already
on if you've used `tailscale serve` or Funnel before.

**3. Start it.**

```sh
echo 'TS_AUTHKEY=tskey-auth-xxxxxxxxxxxx' > .env
docker compose up -d
```

Pin a version with `TAWNY_TAG=2.0.3` in `.env` instead of tracking `latest`;
upgrade later with `docker compose pull && docker compose up -d`. On start the
container joins your tailnet as node `tawny`, detects its LAN, advertises that
subnet, and publishes the app. `docker logs tawny` prints the URL and the route.

**4. Approve the subnet route, and disable key expiry.** Open
`http://<box>:8099/setup` from the LAN — it shows live status and names the
exact next step. Until the route is approved at
<https://login.tailscale.com/admin/machines> → **tawny** → **Edit route
settings** → tick the subnet, a remote Viewer can't reach the phone. While
you're in that same **⋯** menu, also choose **Disable key expiry** — Tawny
runs unattended, and without this Tailscale logs it out roughly every 180
days, silently breaking remote access until someone notices and pastes a
fresh key in `/setup` or `.env`. If `/setup` says HTTPS isn't on, step 2 was
skipped — fix it and `docker compose restart`.

**5. Put your devices on the tailnet.** Every viewing device and the Monitor
phone need Tailscale, signed into the same tailnet, with subnet routes accepted
(Linux: `tailscale up --accept-routes`). Nothing else on the Monitor phone
changes — leave Tawny's Servers screen blank.

Setup survives restarts and DHCP changes: identity lives in the `tawny-data`
volume, the route follows the LAN.

---

## Watching

1. **Monitor phone** — open Tawny, choose **Monitor**, allow the camera, let it
   show its pairing code. Servers screen stays blank.
2. **Viewing device** — open the **`https://…ts.net`** URL (from `/setup` or
   `docker logs tawny`), *not* `http://<box>:8099` — browsers only give a mic
   over HTTPS, so the plain address silently kills talk-back.
3. Choose **Viewer**, **Scan** the phone's QR (or paste the copied pairing
   link), **Join**.

Video, audio, and hold-to-talk. Watch from anywhere the Viewer device has
Tailscale.

**Recommended:** give the Monitor phone a DHCP reservation. Its address is baked
into each pairing code; a lease change breaks the code and forces a rescan.

---

## Checking it

```sh
bash probe.sh
```

Builds the image and exercises the real transports — signalling, the bridge to
the phone's relay, an ICE packet exchange, the built-in relay, route approval.
Two caveats: it reads the *host's* Tailscale state, so under the `TS_AUTHKEY`
path it prints "not installed" for the route check (use `/setup` instead), and
it certifies the *image*, not a running deployment. Stop the running container
first so the relay check can bind port 3478.

---

## Ports

| Port | What |
|---|---|
| 8099 | the app, plain HTTP. `tailscale serve` terminates TLS in front of it; only reached from `localhost`. |
| 3478, 49160-49200/udp | the built-in relay — fallback for a network that blocks direct UDP. Nothing to forward. |

No HTTPS port on the container. TLS is Tailscale's.

---

## If something is wrong

Open `http://<box>:8099/setup` first — it diagnoses most of this and names the
next step.

| Symptom | Cause / fix |
|---|---|
| Container never came up, `/healthz` dead | `docker logs tawny`; `docker ps -a` if no output at all. |
| `/setup`: `tailscale up FAILED` / key rejected | Auth key expired, already used (not Reusable), or wrong tailnet. Fresh key in `.env`, `docker compose restart`. |
| `/setup`: "leftover identity — needs a hand" (or a join that hangs then fails despite a good key) | A Tailscale identity from an earlier run is stuck in `tawny-data` and the coordination server won't take it back. Tawny normally clears it automatically; if it can't, press **Reset Tailscale identity** on `/setup`, or `docker exec <container> rm -rf /data/tailscale` and restart. The old state is kept at `/data/tailscale.broken-…`. |
| `https://tawny.<tailnet>.ts.net` won't open, or `/setup`: `serve FAILED` re HTTPS/MagicDNS | Step 2 skipped. Enable MagicDNS then HTTPS Certificates, `docker compose restart`. |
| Address opens on the box but not on your laptop/phone | That device also needs Tailscale up with MagicDNS on. On the box's LAN, `http://<box>:8099` works (no talk-back). |
| Viewer loads, "Join" hangs, no video | Subnet route not approved yet (`/setup` confirms). If approved, check the Viewer has `--accept-routes`. |
| "Pairing code expired" | Phone unreachable — usually its IP changed: show a fresh code. Confirm it's on the **same** Wi-Fi as the box, not a guest VLAN (that blocks the phone's relay). |
| `/setup`: LAN looks like a Docker bridge (172.16–172.31, `br-`) | Auto-detect failed. Set `TS_ROUTES=192.168.1.0/24` (your real LAN) in `.env`, `docker compose up -d`. |
| Talk-back dead, watching fine | You opened `http://…:8099` instead of the `https://…ts.net` URL. |
| Whole internet starts stalling/looping after setup | Another device already advertises this LAN into the tailnet (NAS, Pi-hole, old Tawny box). Two subnet routers for one range is unsupported. Tawny won't advertise a conflicting route on its own — `/setup` names the other device and offers "stop advertising" / "advertise anyway". |

---

## No Tailscale?

The app still serves on the LAN at `http://<box>:8099` and two devices on that
Wi-Fi can pair and watch — but no talk-back (needs HTTPS) and no way in from
outside. Tailscale is how this is meant to run; LAN-only is a fallback.

---

## Two ways to self-host

This container is the bridge: the app as the Monitor, and a **browser Viewer**
— any device, no install — over your Tailscale. It works the other way and
both-ways too; either role can be a browser, either can be the app.

For **phone-to-phone remote pairing without this container at all** — both ends
the Tawny app, on different networks — see the `rendezvous/` service in the
Tawny app repo: a Cloudflare Worker / Deno signalling introducer. The two paths
are independent and can run together.

---

## Building it yourself

The published image is the supported path. To build locally — a fork, an
unreleased change, an air-gapped registry:

```sh
bash tools/tawny-sync        # vendor the server payload into app/ from ../Tawny Android
                             #   (override the source with TAWNY_ANDROID=/path)
docker build --network=host -t ghcr.io/pressf4me/tawny:latest .
docker compose up -d         # picks up the local image (pull_policy: missing)
```

`app/public/` is a snapshot of the web client from the Tawny app repo (the same
bundle that ships inside the APK); `tools/tawny-sync` refreshes only that folder
and writes the source commit to `app/.source-commit`. Everything else in `app/`
— `server.js`, `docker/`, `rendezvous/`, `package*.json` — lives in this repo.
`--network=host` matters only if your
Docker bridge can't reach the internet during `apk add` (a Tailscale/Mullvad
nftables symptom).

Releases build from a `vX.Y.Z` tag via `.github/workflows/release.yml` —
`linux/amd64` + `linux/arm64`, with provenance.

---

## Design

`DESIGN.md` — why it's shaped this way, what the shipped Android app can and
can't be made to do, and what was measured.
