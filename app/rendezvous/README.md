# Tawny rendezvous

**For phone-to-phone remote pairing** when the Monitor and the Viewer are on
different networks; see `../Tawny Docker/` instead if you want a browser Viewer
over your own Tailscale.

The one always-on piece Tawny needs for **remote** (off-Wi-Fi) monitoring. It is
a signaling *introducer* only — it never sees a video frame and never sees the
channel key. Devices only ever dial **out** to it over `wss:443`, so no inbound
port is opened on any phone.

At home, on the same Wi-Fi, this is not used at all: the Monitor's own embedded
LAN relay carries the session and nothing leaves the house.

Two ways to run it, both free at pet-monitor scale. **Cloudflare is the
recommended one** (no server to keep alive).

---

## Option A — Cloudflare Workers + Durable Objects (recommended)

Files: `worker.js`, `room.js`, `wrangler.toml`.

### 1. Create the project

```sh
cd rendezvous
npm i -g wrangler            # or: npx wrangler ...
wrangler login
```

### 2. Rate-limit KV namespace

```sh
wrangler kv namespace create RL
```

Copy the printed `id` into `wrangler.toml` (`[[kv_namespaces]] id = "..."`).

### 3. TURN credentials

TURN relays media only when a direct peer-to-peer path can't be found
(symmetric NAT, some mobile carriers). Media stays DTLS-SRTP encrypted end to
end — the relay forwards packets it cannot read.

**This is set for the production deployment** — Tawny's Worker runs on
Cloudflare Realtime TURN, so `/turn` issues real credentials to any caller
holding a ticket valid for the room. The steps below are for standing up your
own instance.

**Cloudflare Realtime TURN** (free allowance: 1 TB/month of relayed egress, then
$0.05/GB):

1. Dashboard → *Realtime* → *TURN* → create a key.
2. ```sh
   wrangler secret put TURN_KEY_ID       # the key id
   wrangler secret put TURN_API_TOKEN    # the API token
   ```

*or* **self-hosted coturn** (see Option C) — then instead:

```sh
wrangler secret put TURN_STATIC_SECRET   # == coturn `static-auth-secret`
# and set TURN_URLS in wrangler.toml [vars], e.g.
#   "turn:turn.example.net:3478,turns:turn.example.net:5349"
```

If you set neither, `/turn` returns 404 and that deployment is STUN-only — fine
for most phone-to-home cases, but two peers both behind carrier-grade NAT will
not connect at all. Tawny's own deployment sets the Realtime pair above, so 404
from `/turn` there means the secrets did not take, not that TURN is optional.

### 4. Deploy

```sh
wrangler deploy
```

You get `https://tawny-rendezvous.<subdomain>.workers.dev`.

### 5. Point the app at it

**In an installed app**, with no rebuild: long-press the version stamp in the
bottom-left of any screen → Diagnostics → **Servers**, and put the `wss://` URL
in. Optional STUN and TURN fields sit under it. This is the only route open to
someone who installed from Play; details and the fallback behaviour are in
`README-ANDROID.md`, "Servers (advanced)". If your relay stops answering the app
drops back to Tawny's rather than losing the remote path, so a typo costs a few
seconds.

**At build time**, to make it this build's default, in `android/local.properties`
(never committed):

```properties
tawny.rendezvousUrl=wss://tawny-rendezvous.<subdomain>.workers.dev
tawny.stunUrls=stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302
tawny.turnMode=auto
```

Rebuild — `syncWebAssets` bakes these into `assets/web/config.json` and
`BuildConfig.RENDEZVOUS_URL`. With the properties unset the app builds LAN-only;
the runtime setting above still works, so a LAN-only APK can be given a remote
path without recompiling.

### Free-tier notes

- A **live** session holds a WebSocket open the whole time, so the room's Durable
  Object is billable-active for its duration (hibernation only helps while
  *idle*). Fine for "check in for a few minutes"; a household that streams
  remotely for hours every day will want the paid Workers plan or an SFU.
- TURN egress: ~0.5–0.7 GB per relayed hour of video, against a 1 TB/month free
  allowance — call it 1,400–2,000 relayed hours before it bills at $0.05/GB.
  `turnMode:"auto"` keeps TURN off whenever a direct path exists, so only
  genuinely CGNAT-bound calls count against it. This is the one metered
  recurring cost the project has.

---

## Option B — Deno Deploy (alternative)

`deno/main.ts` is a single-file port. Deno Deploy's free tier includes
WebSockets and a custom domain. It has **no per-room actor**, so pin one region
(so two Viewers always land on the same isolate) — set it in the Deno Deploy
project settings. Same `/config.json`, `/turn`, `/ws` surface. Deploy by linking
the repo or `deployctl deploy --project=tawny-rendezvous deno/main.ts`.

---

## Option C — self-hosted coturn (free TURN, one small VM)

An **Oracle Cloud Always-Free** ARM instance (or any small VPS) runs coturn
forever at no cost (10 TB/mo egress on Oracle):

```sh
sudo apt install coturn
# /etc/turnserver.conf
listening-port=3478
tls-listening-port=5349
fingerprint
use-auth-secret
static-auth-secret=<long random string>   # -> TURN_STATIC_SECRET / TAWNY_TURN_SECRET
realm=turn.example.net
total-quota=100
no-cli
# TLS (Let's Encrypt):
cert=/etc/letsencrypt/live/turn.example.net/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.net/privkey.pem
# on a NAT'd VM:
external-ip=<public-ip>
```

Open **only** 3478/udp+tcp and 5349/tcp on that VM. The phones still open no
ports — they dial the relay outbound.

---

## Endpoints

| Route | Purpose |
|---|---|
| `GET /healthz` | `{ ok: true }` |
| `GET /config.json` | `{ stun, turnMode, authRequired:false }` (CORS `*`) |
| `GET /privacy` | the privacy policy as a static page — the URL to give Play |
| `GET /turn?room=&t=` | short-lived `{ iceServers, ttl }` or 404 |
| `GET /ws?room=&role=&t=` | signaling relay → per-room actor |

`room` is `sha256("tawny-room-v1|" + channelKey)` truncated to 32 hex, computed
on the device. `t` is a per-pairing admission ticket: the Monitor registers
`sha256(t)` for its room on connect; a Viewer must present the matching `t`.
The ticket is admission + abuse control — it is **not** what protects the media
(that is the 128-bit channel key, which never reaches this service).

## Self-host the Node reference instead

`../server.js` also speaks all of this (`/turn` via coturn REST,
`RENDEZVOUS_URL`, `TURN_MODE`, `TAWNY_TURN_URLS`, `TAWNY_TURN_SECRET`, the same
`register`/`t` ticket flow). Put it behind TLS (a reverse proxy or
`tailscale serve`) and set `tawny.rendezvousUrl` to its `wss://` origin.
