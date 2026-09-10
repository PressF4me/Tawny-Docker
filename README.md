# Tawny Docker

Run your own Tawny — the two-way pet monitor — as a container on a box at home.
No account with anyone, no domain, no port forwarding, no certificates to
import. It runs over your Tailscale.

The **Monitor** is the Tawny Android app on an old phone pointed at the cat. The
**Viewer** is a browser on your laptop, desktop, or another phone. This
container serves the Viewer's page and joins your tailnet so the two ends can
reach each other; the video and audio go straight between them and never pass
through it.

---

## Prerequisites

- **Docker and Docker Compose v2** (`docker compose` not `docker-compose`).
- That's it. The image is pulled from the GitHub Container Registry —
  **`ghcr.io/pressf4me/tawny`** — so there is no source checkout to keep beside
  this folder and nothing to build. All you need from this repo is
  `docker-compose.yml`. To build the image yourself instead, see
  [Building it yourself](#building-it-yourself).

---

## Setup

You do this once. After it, watching is: open the app on the phone, open a URL
on the Viewer, scan.

### 1. Get a Tailscale auth key

At <https://login.tailscale.com/admin/settings/keys> → **Generate auth key** →
tick **Reusable**, leave **Ephemeral** off. Copy it.

### 2. Turn on HTTPS in your tailnet

At <https://login.tailscale.com/admin/dns>:

- Under **MagicDNS**, press **Enable**.
- Under **HTTPS Certificates**, press **Enable HTTPS** (MagicDNS must be on
  first).

This is an account-wide switch, done once, and it is **off by default on a new
tailnet**. It is what lets `tailscale serve` publish Tawny at
`https://tawny.<your-tailnet>.ts.net` with a real certificate — without it that
address does not exist, the page never loads, and talk-back (which needs a
browser-trusted HTTPS page to get a microphone) cannot work. If you have used
`tailscale serve` or Tailscale Funnel on this account before, it is already on.

### 3. Start the container

From this folder (only `docker-compose.yml` is needed):

```sh
echo 'TS_AUTHKEY=tskey-auth-xxxxxxxxxxxx' > .env
docker compose up -d      # pulls ghcr.io/pressf4me/tawny:latest
```

To pin a version instead of tracking `latest`, add it to `.env`:
`TAWNY_TAG=2.0.3`. Update later with `docker compose pull && docker compose up -d`.

That is the whole configuration. On start the container joins your tailnet as a
node called `tawny`, works out which LAN it is on, advertises that LAN into the
tailnet, and publishes the app. `docker logs tawny` prints the URL it is served
at and the route it advertised.

### 4. Check and approve the subnet route

Open `http://<box>:8099/setup` from the LAN — it shows live status: whether the
route was advertised, whether it is approved yet, and whether everything worked.
Until the route is approved in the Tailscale admin console, a remote Viewer
cannot reach the phone. If it is not approved yet, the page tells you exactly
where to go: <https://login.tailscale.com/admin/machines> → click **tawny** →
**Edit route settings** → tick the subnet (e.g. `192.168.1.0/24`).

If `/setup` says **turn on HTTPS in Tailscale**, step 2 was skipped — do it and
`docker compose restart`.

### 5. Put your devices on the tailnet

- **The phone you will watch from / the laptop / the desktop** — install
  Tailscale, sign in to the same tailnet, and turn on **Use Tailscale subnets**
  (Linux: `sudo tailscale up --accept-routes`).
- **The Monitor phone needs Tailscale too**, signed in to the same tailnet.
  Nothing else on it changes — you do **not** touch Tawny's Servers screen; blank
  is correct.

That's setup. It survives restarts and DHCP changes: the node identity is in the
`tawny-data` volume, and the advertised route follows the LAN the container is
on.

---

## Watching

1. **On the Monitor phone**, open Tawny, choose **Monitor**, give the camera
   what it asks for, let it show its pairing code. The Servers screen stays
   blank.
2. **On the viewing device**, open the real app URL — **use the `https://…ts.net`
   URL, not `http://<box>:8099`**. Browsers only grant microphone access over
   HTTPS; the plain HTTP address silently breaks talk-back. Get the URL from
   `http://<box>:8099/setup` (the status page shows it) or from `docker logs
   tawny`. It looks like:

   ```
   https://tawny.<your-tailnet>.ts.net/
   ```

3. Choose **Viewer**, scan the phone's QR with the **Scan** button (or tap the
   pairing row on the phone to copy the link and paste it), and press **Join**.

Video, audio, and hold-to-talk back to the phone. Leave the phone where the pet
is; watch from anywhere your Viewer device has Tailscale.

**Strongly recommended:** give the Monitor phone a fixed address in your
router's DHCP settings (a DHCP reservation). Its address is baked into each
pairing code; without a reservation, a router lease change breaks the code and
forces a rescan.

---

## Checking it

```sh
bash probe.sh
```

Builds the image and exercises the real transports: the signalling round trip,
the bridge to the phone's own relay, an ICE-grade packet exchange, the built-in
relay, and whether your Tailscale route is approved. Everything should say `ok`
or `note`.

**Note:** probe.sh reads your *host's* Tailscale state to check the route. When
using the `TS_AUTHKEY` path (where tailscaled runs inside the container), it
prints "not installed" — a false negative on the most important check. Ignore
that line and open `http://<box>:8099/setup` instead, which checks the
container's own Tailscale state and tells you whether the route is approved.
"All checks OK" from probe.sh certifies the *image*, not the *running
deployment*.

To check the built-in relay too, stop the running container first — it holds
port 3478 and two of them on one host cannot both be tested.

---

## Ports

| Port | What |
|---|---|
| 8099 | the app, plain HTTP. `tailscale serve` terminates TLS in front of it; you never hit this directly except from `localhost`. |
| 3478, 49160-49200/udp | the built-in relay — an unattended fallback for a network that blocks direct UDP between two hosts. Nothing to forward. |

There is no HTTPS port on the container. TLS is Tailscale's.

---

## If something is wrong

* **Setup page or `/healthz` unreachable, container never came up** — check
  `docker logs tawny`. If there is no output at all, the container is not
  running; check `docker ps -a`.
* **`/setup` shows `tailscale up FAILED`** — the auth key is expired, already
  used (if you did not tick *Reusable*), or for a different tailnet. Generate
  a fresh one, put it in `.env`, `docker compose restart`.
* **The `https://tawny.<tailnet>.ts.net` address does not open at all**
  (NXDOMAIN / can't resolve / certificate error), or `/setup` shows
  **`tailscale serve FAILED`** mentioning HTTPS or MagicDNS — step 2 was
  skipped. Enable **MagicDNS** and then **HTTPS Certificates** at
  <https://login.tailscale.com/admin/dns> (account-wide, one time, off by
  default on a new tailnet), then `docker compose restart`. `docker logs tawny`
  will then print the real URL.
* **The address opens on the box but not on your laptop/phone** — the device
  you are opening it from also needs Tailscale connected with **MagicDNS on**
  for the `…ts.net` name to resolve. On the box's own LAN you can reach it at
  `http://<box>:8099` (no talk-back), but every remote device needs Tailscale.
* **Viewer loads but "Join" hangs / no video** — the subnet route is not
  approved yet. Check `http://<box>:8099/setup` — it tells you if the route is
  approved or still pending. If approved and video still doesn't work, confirm
  the viewing device has *accept subnets* on (`tailscale up --accept-routes` on
  Linux).
* **"Pairing code expired"** — the phone is not reachable. Usually its address
  changed since that code was made: show a fresh code and re-scan. Confirm the
  Monitor phone is on the same Wi-Fi as the container. If it is on a different
  VLAN or guest Wi-Fi than the Docker host, that is the problem: the container
  reaches the phone's own relay by its LAN address, and a guest network blocks
  exactly that. Move the phone onto the main network, or advertise its subnet
  instead with `TS_ROUTES`.
* **`/setup` says LAN looks like a Docker bridge (172.16–172.31 range, or `br-`)**
  — the container cannot auto-detect your real LAN (you might be on a host with
  multiple NICs or VLANs). Set `TS_ROUTES` in `.env` to your real LAN CIDR,
  e.g. `TS_ROUTES=192.168.1.0/24`, then `docker compose up -d`.
* **Talk-back is dead, watching works** — you opened `http://…:8099` instead of
  the `https://…ts.net` URL. Browsers only hand out a microphone over HTTPS.
* **Everything worked, then the phone's IP changed** — re-scan a fresh code.
  Give the Monitor phone a fixed DHCP reservation in your router so its address
  never changes.
* **Your whole internet connection started dropping/looping after setting this
  up** — you likely already have another device on your tailnet advertising
  the same home network (a NAS, a Pi-hole, an earlier Tawny box). Two subnet
  routers for the same range is unsupported by Tailscale: it silently flips
  which one actually carries traffic, and from inside the house that looks
  exactly like your Wi-Fi randomly stalling. Tawny checks for this itself and
  will not advertise a conflicting route on its own — `/setup` names the other
  device and offers a one-click "stop advertising" or "advertise anyway" if
  you know it's safe (e.g. the other router is being retired).

---

## No Tailscale?

The app still serves on the LAN over `http://<box>:8099` and two devices on that
same Wi-Fi can pair and watch — but with no microphone for talk-back (browsers
require HTTPS for that) and no way in from outside the house. Tailscale is how
this deployment is meant to run; the LAN-only mode is a fallback, not a feature.

---

## Two ways to self-host

This folder is for **browser Viewers** — one or more people watching via a
browser on their laptop, desktop, or phone, reached over your Tailscale. The
Monitor phone stays stock.

For **phone-to-phone remote pairing** — Monitor and Viewer both the Tawny app,
on different networks — see the `rendezvous/` service in the Tawny Android repo:
a separate deployment (Cloudflare Worker or Deno) that acts as the signalling
introducer only. Both options can run at the same time; they are independent
paths.

---

## Building it yourself

The published image is what you get by default and is the supported path. To
build locally — a fork, an unreleased change, an air-gapped registry:

```sh
bash tools/tawny-sync        # vendor the server payload into app/ from
                             # ../Tawny Android (override with TAWNY_ANDROID=…)
docker build --network=host -t ghcr.io/pressf4me/tawny:latest .
docker compose up -d         # now uses your local image (pull_policy: missing)
```

`app/` holds a snapshot of the app's server (`server.js`, `public/`,
`rendezvous/`, `docker/`) taken from the Tawny Android repo; `tools/tawny-sync`
refreshes it and records the source commit in `app/.source-commit`. `--network=host`
is only needed if your Docker bridge cannot reach the internet during `apk add`
(a common symptom of a Tailscale/Mullvad nftables stack).

Releases are built by `.github/workflows/release.yml` on a `vX.Y.Z` tag and
pushed to GHCR for `linux/amd64` and `linux/arm64` with build provenance.

---

## Design

`DESIGN.md` — why it is shaped this way, what the shipped Android app can and
cannot be made to do, and what was measured to establish it.
