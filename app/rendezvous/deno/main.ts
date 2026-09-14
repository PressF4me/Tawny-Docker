// Tawny rendezvous — Deno Deploy alternative to the Cloudflare Worker.
//
// SECONDARY target. There is no per-room actor and no durable storage here, so
// room membership and the admission ticket live in module scope:
//   * Pin the Deno Deploy project to ONE region (Settings → Region).
//   * Relay fan-out is mirrored across the region's isolates via BroadcastChannel;
//     ticket registration and membership are NOT — under light traffic Deno keeps
//     one warm isolate per region, which is the assumption. For anything heavier,
//     use the Cloudflare Worker (../worker.js + ../room.js).
//
// Same wire protocol as room.js: a socket must send {type:'hello'} first and
// pass admission before it is joined or told about anyone. A Handheld's hello
// carries the ticket `t`; the Watcher's carries `hashT = sha256(t)`.
//
// Env: STUN_URLS, TURN_MODE, ALLOWED_ORIGINS, TURN_STATIC_SECRET, TURN_URLS
//
// No longer strictly one file: it imports the privacy page from ../privacy.js
// and the relay's shared numbers, message types, close codes and ticket clock
// from ../protocol.js, so the Worker, server.js and this do not drift apart.
// `deployctl deploy` follows the imports; if you are pasting this into the Deno
// Deploy playground, paste both files above it and drop the import lines.

import { privacyResponse } from "../privacy.js";
import {
  ADMIT_TIMEOUT_MS, CLOSE, MAX_MSG, MAX_PER_ROOM, MAX_STATIONS, RELAY,
  TICKET_TTL_MS, issuedAt, rollTicket, ticketLive,
} from "../protocol.js";

const ROOM_RE = /^[a-f0-9]{32}$/;
const TICKET_RE = /^[A-Za-z0-9_-]{8,64}$/;
const HEX64 = /^[a-f0-9]{64}$/;
// Bounds on a map that could previously grow without limit from unauthenticated
// connections. Mirrors LocalWeb.kt / ../../server.js.
const MAX_ROOMS = 256;

const env = (k: string) => Deno.env.get(k) ?? "";
const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

type Peer = { id: string; role: string; ws: WebSocket };
const rooms = new Map<string, Map<string, Peer>>();
// `auth` is sha256("tawny-auth-v1|" + channel key): proof the sender holds the
// key, which this relay stores but can never derive. Older rooms have none.
const tickets = new Map<string, { hashT: string; auth: string | null; iss: number; exp: number }>();

const bus = new BroadcastChannel("tawny");
bus.onmessage = (e) => fanout(e.data, true);

function wsSend(ws: WebSocket, obj: unknown) {
  try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); } catch { /* gone */ }
}

// Deliver a relay/announce to local peers, and (unless it came from the bus)
// mirror it to the other isolates in this region.
function fanout(m: any, fromBus = false) {
  const peers = rooms.get(m.room);
  if (peers) {
    if (m.kind === "relay") {
      const t = peers.get(m.to);
      if (t) wsSend(t.ws, m.msg);
    } else if (m.kind === "announce") {
      for (const p of peers.values()) if (p.id !== m.except) wsSend(p.ws, m.msg);
    }
  }
  if (!fromBus) bus.postMessage(m);
}

async function sha256hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s ?? "")));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function ticketFor(room: string) {
  const rec = tickets.get(room);
  // Two clocks: the idle TTL, and the absolute ceiling a re-registration may
  // not push past.
  return rec && ticketLive(rec) ? rec : null;
}
type Close = readonly [number, string];
// protocol.js is plain JS, so its pairs infer as (string | number)[].
const C = CLOSE as unknown as Record<string, Close>;
const close = (ws: WebSocket, [code, reason]: Close) => {
  try { ws.close(code, reason); } catch { /* gone */ }
};

function cors(extra: Record<string, string> = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    ...extra,
  };
}
const json = (o: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(o), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });

function originOk(req: Request) {
  const o = req.headers.get("Origin");
  if (!o || o === "null") return true;
  try {
    const h = new URL(o);
    if (h.hostname === "127.0.0.1" || h.hostname === "localhost") return true;
    if (h.host === new URL(req.url).host) return true;
    return list(env("ALLOWED_ORIGINS")).includes(o);
  } catch {
    return false;
  }
}

async function turnCreds() {
  const secret = env("TURN_STATIC_SECRET");
  const urls = list(env("TURN_URLS"));
  if (!secret || !urls.length) return null;
  const ttl = 3600;
  const username = String(Math.floor(Date.now() / 1000) + ttl);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(username));
  const credential = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return { iceServers: [{ urls, username, credential }], ttl };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") return new Response(null, { headers: cors() });
  if (url.pathname === "/healthz") return json({ ok: true });
  // Same page the Worker serves — see ../privacy.js for why it lives here.
  if (url.pathname === "/privacy" || url.pathname === "/privacy/") {
    return privacyResponse();
  }
  if (url.pathname === "/config.json") {
    return json(
      { stun: list(env("STUN_URLS")), turnMode: env("TURN_MODE") || "auto", authRequired: false },
      200, cors(),
    );
  }
  if (url.pathname === "/turn") {
    const room = url.searchParams.get("room") || "";
    if (!ROOM_RE.test(room)) return json({ error: "bad room" }, 400, cors());
    const rec = ticketFor(room);
    if (!rec || (await sha256hex(url.searchParams.get("t") || "")) !== rec.hashT) {
      return json({ error: "not paired" }, 403, cors());
    }
    const c = await turnCreds();
    return c ? json(c, 200, cors()) : json({ error: "no turn configured" }, 404, cors());
  }
  if (url.pathname !== "/ws") return new Response("not found", { status: 404 });

  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("expected websocket", { status: 426 });
  }
  if (!originOk(req)) return new Response("forbidden", { status: 403 });

  const room = url.searchParams.get("room") || "";
  const role = url.searchParams.get("role") === "station" ? "station" : "viewer";
  if (!ROOM_RE.test(room)) return new Response("bad room", { status: 400 });

  const { socket, response } = Deno.upgradeWebSocket(req);
  const id = crypto.randomUUID().slice(0, 12);
  let joined = false;
  // Say hello or go away. Without this a socket that opened and never spoke sat
  // here for as long as it liked.
  const admitTimer = setTimeout(() => {
    if (!joined) close(socket, C.NO_HELLO);
  }, ADMIT_TIMEOUT_MS);

  // Admission is synchronous from the first capacity check to peers.set(). It
  // used to await sha256 in between, so two hellos landing together could both
  // pass MAX_PER_ROOM or MAX_STATIONS, overwrite each other's ticket, or each
  // build their own peers map for a new room. The one await — hashing the
  // ticket — now happens before this runs, in onmessage.
  const admit = (msg: any, tHash: string) => {
    const rec = ticketFor(room);
    // Deliberately NOT inserted into `rooms` yet. This used to be an
    // unconditional rooms.set() above every rejection path, so each refused
    // admission left a permanent empty Map behind and the map grew without
    // bound. The entry is created on success, below.
    const peers = rooms.get(room) ?? new Map<string, Peer>();
    const proof = typeof msg.a === "string" && HEX64.test(msg.a) ? msg.a : null;

    // Capacity first: nothing that gets rejected may change stored state. See
    // ../room.js — registering a ticket for a socket that is then turned away
    // let a caller who knew only the room id re-key the channel on its way out.
    if (peers.size >= MAX_PER_ROOM) return close(socket, C.FULL);
    if (!rooms.has(room) && rooms.size >= MAX_ROOMS) return close(socket, C.BUSY);
    let evict: Peer[] = [];
    if (role === "station") {
      const stations = [...peers.values()].filter((p) => p.role === "station");
      if (stations.length >= MAX_STATIONS) {
        // A Monitor whose radio dropped can still be on the books here. Only
        // the holder of the channel key may take the room back from it; every
        // other caller keeps getting 4004, which is the anti-squat guard.
        if (!(rec?.auth && proof === rec.auth)) return close(socket, C.MONITOR_RUNNING);
        evict = stations;
      }
    }

    let register: { hashT: string; auth: string | null; iss: number } | null = null;
    if (role === "viewer") {
      // No Monitor has ever registered this room: the code in the Viewer's hand
      // is fine, the other end is just not running. 4010, as server.js and
      // ../room.js say — "pairing expired" sent people rescanning the same QR.
      if (!rec) return close(socket, C.MONITOR_OFFLINE);
      if (tHash !== rec.hashT) return close(socket, C.PAIRING_EXPIRED);
    } else {
      if (rec?.auth && proof && proof !== rec.auth) return close(socket, C.WRONG_KEY);
      const mayRekey = proof !== null || !rec?.auth;
      const hashT = typeof msg.hashT === "string" && HEX64.test(msg.hashT) ? msg.hashT : null;
      if (hashT && mayRekey) {
        // Same hashT means the Monitor is re-registering the ticket it already
        // had, so the original issue time carries over and the absolute ceiling
        // cannot be walked forward by reconnecting.
        register = {
          hashT, auth: proof || rec?.auth || null,
          iss: rec && rec.hashT === hashT ? issuedAt(rec) : Date.now(),
        };
      } else if (rec) {
        if (tHash !== rec.hashT) return close(socket, C.PAIRING_EXPIRED);
      } else {
        return close(socket, C.NO_TICKET);
      }
    }

    // Admitted. Only now may stored state change, or a sitting Monitor go.
    if (register) tickets.set(room, { ...register, exp: Date.now() + TICKET_TTL_MS });
    for (const p of evict) {
      peers.delete(p.id);
      fanout({ room, kind: "announce", except: p.id, msg: { type: "peer-left", id: p.id } });
      close(p.ws, C.REPLACED);
    }

    joined = true;
    clearTimeout(admitTimer);
    if (!rooms.has(room)) rooms.set(room, peers);   // first admission creates it
    peers.set(id, { id, role, ws: socket });
    socket.send(JSON.stringify({
      type: "welcome", id, role,
      peers: [...peers.values()].filter((p) => p.id !== id).map((p) => ({ id: p.id, role: p.role })),
    }));
    fanout({ room, kind: "announce", except: id, msg: { type: "peer-joined", id, role } });
  };

  // One hello per socket: a second frame arriving while the first is still
  // being hashed must not run admission twice.
  let admitting = false;

  socket.onmessage = async (e) => {
    // Signalling frames are a few KB; anything larger is someone filling memory.
    const size = typeof e.data === "string" ? e.data.length : (e.data?.byteLength ?? 0);
    if (size > MAX_MSG) { close(socket, C.TOO_LARGE); return; }
    let msg: any;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    if (!joined) {
      if (admitting) return;
      if (msg.type !== "hello") { close(socket, C.EXPECTED_HELLO); return; }
      admitting = true;
      const tHash = await sha256hex(msg.t);
      if (socket.readyState !== WebSocket.OPEN) return;   // left while hashing
      admit(msg, tHash);
      return;
    }
    if (!RELAY.has(msg.type) || typeof msg.to !== "string") return;
    msg.from = id;
    fanout({ room, kind: "relay", to: msg.to, msg });
  };
  const gone = () => {
    clearTimeout(admitTimer);
    if (!joined) return;
    rooms.get(room)?.delete(id);
    fanout({ room, kind: "announce", except: id, msg: { type: "peer-left", id } });
    if (!rooms.get(room)?.size) rooms.delete(room);
  };
  socket.onclose = gone;
  socket.onerror = gone;

  return response;
});

// Ticket upkeep. While this room's Monitor is connected its ticket is rolled
// forward, as ../room.js's alarm() does: a Monitor on a socket that never drops
// used to see its ticket lapse after 24h, and every new Viewer was turned away
// with 4008 until the phone happened to reconnect. The ceiling still applies.
setInterval(() => {
  const now = Date.now();
  for (const [room, rec] of tickets) {
    const stationHere = [...(rooms.get(room)?.values() ?? [])].some((p) => p.role === "station");
    if (rollTicket(rec, stationHere, now) === "drop") tickets.delete(room);
  }
}, 60_000);
