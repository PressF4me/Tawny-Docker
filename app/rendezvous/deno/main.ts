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
// so the Worker and this do not drift into two policies. `deployctl deploy`
// follows the import; if you are pasting this into the Deno Deploy playground,
// paste privacy.js above it and drop the import line.

import { privacyResponse } from "../privacy.js";

const ROOM_RE = /^[a-f0-9]{32}$/;
const TICKET_RE = /^[A-Za-z0-9_-]{8,64}$/;
const HEX64 = /^[a-f0-9]{64}$/;
// "cameras", "meta", "camera-control" and "torch" were each missing here at some
// point — the same drift that made the lens picker, remote zoom, pet-name sync
// and the Viewer's Light key inert on whichever relay was behind. Keep this set
// in step with ../room.js, ../../server.js and LocalWeb.kt.
const RELAY = new Set([
  "offer", "answer", "ice", "bye", "chime", "chime-ack", "talking",
  "cameras", "meta", "camera-control", "torch", "battery",
]);
const MAX_PER_ROOM = 4;      // 1 Monitor + up to 3 Viewers. Mirrors ../room.js.
const MAX_STATIONS = 1;
const TICKET_TTL = 24 * 60 * 60_000;
// Absolute ceiling on a ticket's life, mirroring ../room.js. A Monitor
// re-registers the same stored ticket on every reconnect, which would otherwise
// push the idle TTL out forever and leave a leaked pairing link valid for good.
// Re-registering the same hashT keeps the original issue time; only a re-paired
// channel (a different hashT) starts a new lifetime.
const TICKET_MAX_LIFETIME = 30 * 24 * 60 * 60_000;
// Signalling frames are a few KB. ../room.js and ../../server.js have always
// capped these; this port did not, so a single socket could hand it an
// arbitrarily large "ICE candidate" and take the isolate down.
const MAX_MSG = 64 * 1024;
// A socket that opens and never says hello held a slot forever here — there was
// no sweep at all. Matches ../room.js.
const ADMIT_TIMEOUT_MS = 10_000;
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
const issuedAt = (rec: { iss?: number; exp: number }) => rec.iss ?? (rec.exp - TICKET_TTL);
function ticketFor(room: string) {
  const rec = tickets.get(room);
  if (!rec) return null;
  // Two clocks: the idle TTL, and the absolute ceiling a re-registration may
  // not push past.
  if (Date.now() > rec.exp || Date.now() - issuedAt(rec) >= TICKET_MAX_LIFETIME) return null;
  return rec;
}

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
    if (!joined) { try { socket.close(4008, "no hello"); } catch { /* gone */ } }
  }, ADMIT_TIMEOUT_MS);

  const admit = async (msg: any) => {
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
    if (peers.size >= MAX_PER_ROOM) { socket.close(4003, "channel full"); return; }
    if (!rooms.has(room) && rooms.size >= MAX_ROOMS) { socket.close(4005, "busy"); return; }
    let evict: Peer[] = [];
    if (role === "station") {
      const stations = [...peers.values()].filter((p) => p.role === "station");
      if (stations.length >= MAX_STATIONS) {
        // A Monitor whose radio dropped can still be on the books here. Only
        // the holder of the channel key may take the room back from it; every
        // other caller keeps getting 4004, which is the anti-squat guard.
        if (!(rec?.auth && proof === rec.auth)) {
          socket.close(4004, "monitor already running"); return;
        }
        evict = stations;
      }
    }

    let register: { hashT: string; auth: string | null; iss: number } | null = null;
    if (role === "viewer") {
      if (!rec || (await sha256hex(msg.t)) !== rec.hashT) { socket.close(4008, "pairing expired"); return; }
    } else {
      if (rec?.auth && proof && proof !== rec.auth) { socket.close(4008, "wrong channel key"); return; }
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
        if ((await sha256hex(msg.t)) !== rec.hashT) { socket.close(4008, "pairing expired"); return; }
      } else {
        socket.close(4008, "no pairing ticket"); return;
      }
    }

    // Admitted. Only now may stored state change, or a sitting Monitor go.
    if (register) tickets.set(room, { ...register, exp: Date.now() + TICKET_TTL });
    for (const p of evict) {
      peers.delete(p.id);
      fanout({ room, kind: "announce", except: p.id, msg: { type: "peer-left", id: p.id } });
      try { p.ws.close(4005, "replaced by owner"); } catch { /* already gone */ }
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

  socket.onmessage = async (e) => {
    // Signalling frames are a few KB; anything larger is someone filling memory.
    const size = typeof e.data === "string" ? e.data.length : (e.data?.byteLength ?? 0);
    if (size > MAX_MSG) { socket.close(4009, "message too large"); return; }
    let msg: any;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    if (!joined) {
      if (msg.type !== "hello") { socket.close(4000, "expected hello"); return; }
      await admit(msg);
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

setInterval(() => {
  const now = Date.now();
  for (const [room, rec] of tickets) {
    if (now > rec.exp || now - issuedAt(rec) >= TICKET_MAX_LIFETIME) tickets.delete(room);
  }
}, 60_000);
