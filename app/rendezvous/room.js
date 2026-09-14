// Tawny rendezvous — one Durable Object per channel room.
//
// A faithful reduction of server.js's signaling relay: it introduces peers and
// forwards addressed control messages, and it never sees media or the channel
// key. The room id is sha256("tawny-room-v1|" + key) truncated to 32 hex,
// computed on the device — this DO only ever sees that opaque id and a
// per-pairing admission ticket.
//
// Admission (fail-closed): every socket must send {type:'hello'} as its first
// frame before it is joined to the room or told about anyone. A Viewer's hello
// must carry a ticket `t` whose sha256 matches the one the Monitor registered
// (in its own hello's `hashT`). No ticket ⇒ no admission. A Monitor that wants
// to *change* the registered ticket must also prove it holds the channel key,
// with `a` = sha256("tawny-auth-v1|" + key).
//
// Uses the WebSocket Hibernation API so an idle room costs nothing.

import {
  ADMIT_TIMEOUT_MS, CLOSE, MAX_MSG, MAX_PER_ROOM, MAX_STATIONS, RELAY,
  TICKET_MAX_LIFETIME_MS, TICKET_TTL_MS, beyondLifetime, issuedAt, rollTicket
} from './protocol.js';

// The room caps, relayed message types, close codes and the ticket clock live in
// ./protocol.js, shared with ../server.js and deno/main.ts. They used to be
// copied into each, and drifted.
//
// On the ticket clock: the idle TTL is rolled forward while a Monitor is sitting
// in the room (see alarm()), because a Monitor plugged in and left alone is the
// product's whole premise and expiring the ticket out from under it locked every
// new Handheld out with 4008. That roll-forward is bounded by
// TICKET_MAX_LIFETIME_MS from first registration, however long the Monitor stays
// up. Reaching it means new Handhelds must be re-paired; sessions already
// connected are not touched, because the ticket is only consulted at admission.
// A Monitor that reconnects re-registers the *same* stored ticket, which
// deliberately does not restart that clock — only a genuinely new ticket (a
// different hashT, i.e. a re-paired channel) does. This is the bound SECURITY.md
// quotes.

const HEX64 = /^[a-f0-9]{64}$/;
// A socket that connects and never says hello held a slot forever: pending
// sockets are excluded from members(), so MAX_PER_ROOM never stopped them.
// Hence ADMIT_TIMEOUT_MS, swept in alarm().
// Wrong answers, per room, before this room stops entertaining new sockets.
const MAX_FAILED_ADMITS = 20;
const FAIL_WINDOW_MS = 10 * 60 * 1000;

const hex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha256Hex(s) {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s ?? ''))));
}
function send(ws, obj) {
  try { if (ws.readyState === 1 || ws.readyState === undefined) ws.send(JSON.stringify(obj)); } catch {}
}

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async ticket() {
    const rec = await this.state.storage.get('ticket');
    if (!rec) return null;
    // Two independent clocks: the idle TTL, and the absolute ceiling that the
    // roll-forward in alarm() may not cross.
    if (beyondLifetime(rec)) return null;
    // Past the idle TTL but the Monitor is still here: alarm() is about to roll
    // it forward (it wakes a minute after exp), so do not turn Handhelds away
    // with 4008 in that window.
    if (Date.now() > rec.exp && !this.members()
      .some((w) => w.deserializeAttachment()?.role === 'station')) return null;
    return rec;
  }

  /**
   * Count a rejected admission. A room that is being probed stops accepting
   * new sockets for a while — strongly consistent, unlike the KV counter in the
   * Worker, because it lives in the one object that owns this room.
   */
  async noteFailure() {
    const now = Date.now();
    const f = (await this.state.storage.get('fails')) || { n: 0, since: now };
    if (now - f.since > FAIL_WINDOW_MS) { f.n = 0; f.since = now; }
    f.n += 1;
    await this.state.storage.put('fails', f);
  }

  async tooManyFailures() {
    const f = await this.state.storage.get('fails');
    if (!f) return false;
    if (Date.now() - f.since > FAIL_WINDOW_MS) return false;
    return f.n >= MAX_FAILED_ADMITS;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Worker asks: is this ticket good for this room? (used to gate /turn)
    if (url.pathname === '/verify') {
      const rec = await this.ticket();
      const ok = rec && (await sha256Hex(url.searchParams.get('t'))) === rec.hashT;
      return new Response(null, { status: ok ? 200 : 403 });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 400 });
    }
    const role = url.searchParams.get('role') === 'station' ? 'station' : 'viewer';

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // pending: joined to the socket set but not yet admitted to the room.
    server.serializeAttachment({ role, pending: true, since: Date.now() });
    this.state.acceptWebSocket(server);
    // Close anything still unadmitted when the next alarm runs.
    const due = Date.now() + ADMIT_TIMEOUT_MS;
    const cur = await this.state.storage.getAlarm();
    if (cur === null || cur > due) await this.state.storage.setAlarm(due);
    return new Response(null, { status: 101, webSocket: client });
  }

  members() {
    return this.state.getWebSockets().filter((w) => !w.deserializeAttachment()?.pending);
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw === 'string' ? raw.length > MAX_MSG : raw.byteLength > MAX_MSG) {
      ws.close(...CLOSE.TOO_LARGE); return;
    }
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const meta = ws.deserializeAttachment();
    if (!meta) return;

    // ---- admission ----
    //
    // Order matters here, and it did not used to. The ticket was re-written
    // before the room's capacity and single-Monitor checks ran, so an attacker
    // who knew only the room id could connect, be turned away with 4004
    // "monitor already running" — and still have re-keyed the channel on the
    // way out, locking every paired Viewer to 4008 until the 24h TTL expired.
    // Nothing that gets rejected may change stored state.
    if (meta.pending) {
      if (msg.type !== 'hello') { ws.close(...CLOSE.EXPECTED_HELLO); return; }
      if (await this.tooManyFailures()) { ws.close(...CLOSE.TOO_MANY_ATTEMPTS); return; }

      const rec = await this.ticket();
      const here = this.members();

      // 1. Capacity first — a refused socket must be a no-op.
      if (here.length >= MAX_PER_ROOM) { ws.close(...CLOSE.FULL); return; }

      // The Monitor's own key beats a ghost Monitor.
      //
      // A phone whose radio drops loses its socket without a close handshake.
      // Hibernation keeps that dead socket in getWebSockets() until a ping or
      // TCP timeout notices — minutes — and for all of that window the same
      // device, re-hosting the same pairing, was told 4004 "monitor already
      // running" by its own corpse. Observed in the field: cloud close 1006,
      // then a hard lockout two minutes later.
      //
      // So: a station that *proves the channel key* — sha256("tawny-auth-v1|"
      // + key), which the relay stores but can never derive — may take its room
      // back, and the sitting station is closed with 4005 instead. Anyone else
      // still gets 4004, unchanged: this is strictly `claimed === rec.auth`,
      // never "the room has no auth on file, so anything goes". A room claimed
      // by an older shell that stored no auth keeps the old behaviour, because
      // there the 4004 IS the anti-squat guard.
      //
      // The eviction itself is deferred to step 3. Rejections below it must
      // stay no-ops, and hanging up on the live Monitor for a caller we then
      // turn away would leave the room with no Monitor at all.
      let evict = [];
      if (meta.role === 'station') {
        const stations = here.filter((w) => w.deserializeAttachment()?.role === 'station');
        if (stations.length >= MAX_STATIONS) {
          const proof = typeof msg.a === 'string' && HEX64.test(msg.a) ? msg.a : null;
          if (!(rec?.auth && proof === rec.auth)) {
            ws.close(...CLOSE.MONITOR_RUNNING); return;
          }
          evict = stations;
        }
      }

      // 2. Then prove admission.
      //
      // `a` is sha256("tawny-auth-v1|" + channel key) — a second, independent
      // hash of the key under a different domain separator. It proves the
      // sender holds the key without revealing it, and unlike the room id it
      // cannot be learned by watching traffic: the room id travels in the
      // WebSocket URL, is written to the on-device diagnostics log, and until
      // this release went out in clear text on the LAN.
      //
      // It is stored with the ticket and expires with it, so a room whose
      // Monitor never comes back resets on its own rather than staying claimed
      // by whoever spoke first.
      let rekey = null;
      if (meta.role === 'viewer') {
        // Two very different things used to share one close code, one sentence
        // and one failure counter.
        //
        // `!rec` is "no Monitor has ever registered this room". Nothing is
        // wrong with the code in this Viewer's hand — the other end is simply
        // not running. Reporting that as "pairing expired" sent people back to
        // rescan the same QR for ever; 4010 says the true thing, and
        // public/app.js already has its own sentence for it. The code and the
        // reason string match server.js's split exactly, so the two relays
        // cannot drift into telling the same person different stories.
        //
        // It also must not count as a failed admission. noteFailure() feeds
        // the room's lockout, so someone patiently rescanning an offline
        // Monitor's QR was walking their own channel into 4029 "too many
        // attempts" — locked out of their own room for doing nothing wrong.
        // Nobody being home is not an attack on the door.
        if (!rec) { ws.close(...CLOSE.MONITOR_OFFLINE); return; }
        // A ticket that genuinely does not match this room still counts.
        if ((await sha256Hex(msg.t)) !== rec.hashT) {
          await this.noteFailure();
          ws.close(...CLOSE.PAIRING_EXPIRED); return;
        }
      } else {
        const claimed = typeof msg.a === 'string' && HEX64.test(msg.a) ? msg.a : null;
        if (rec?.auth && claimed && claimed !== rec.auth) {
          await this.noteFailure();
          ws.close(...CLOSE.WRONG_KEY); return;
        }
        // A channel this build has claimed cannot be re-keyed by a caller that
        // cannot prove the key. Older shells are still admitted below on a
        // ticket matching what is already stored.
        const mayRekey = claimed !== null || !rec?.auth;
        const hashT = typeof msg.hashT === 'string' && HEX64.test(msg.hashT) ? msg.hashT : null;

        if (hashT && mayRekey) {
          // Deferred: applied only once this socket is actually admitted.
          rekey = { hashT, auth: claimed || rec?.auth || null };
        } else if (rec) {
          if ((await sha256Hex(msg.t)) !== rec.hashT) {
            await this.noteFailure();
            ws.close(...CLOSE.PAIRING_EXPIRED); return;
          }
        } else {
          await this.noteFailure();
          ws.close(...CLOSE.NO_TICKET); return;
        }
      }

      // 3. Admitted. Only now may stored state change.
      if (rekey && (!rec || rec.hashT !== rekey.hashT || rec.auth !== rekey.auth)) {
        // Re-registering the same ticket (a Monitor reconnecting) keeps the
        // original issue time, so reconnects cannot be used — deliberately or
        // by accident — to walk the absolute ceiling forward forever. Only a
        // different hashT, which means the channel was genuinely re-paired,
        // starts a new lifetime.
        const iss = rec && rec.hashT === rekey.hashT ? issuedAt(rec) : Date.now();
        await this.state.storage.put('ticket', {
          hashT: rekey.hashT, auth: rekey.auth, iss, exp: Date.now() + TICKET_TTL_MS,
        });
        await this.state.storage.setAlarm(Date.now() + TICKET_TTL_MS + 60_000);
      }

      // The owner reclaim, now that nothing below can reject this socket. A
      // server-initiated close does not run webSocketClose(), so the departure
      // is announced here and the evicted sockets are dropped from the peer
      // list by hand rather than trusted to leave getWebSockets() in time.
      const gone = new Set(evict);
      const peers = here.filter((w) => !gone.has(w));
      for (const w of evict) {
        const m = w.deserializeAttachment();
        if (m?.id) for (const p of peers) send(p, { type: 'peer-left', id: m.id });
        try { w.close(...CLOSE.REPLACED); } catch {}
      }

      const id = hex(crypto.getRandomValues(new Uint8Array(6)));
      ws.serializeAttachment({ id, role: meta.role });
      send(ws, {
        type: 'welcome', id, role: meta.role,
        peers: peers.map((w) => w.deserializeAttachment()).filter(Boolean)
          .map((m) => ({ id: m.id, role: m.role }))
      });
      for (const w of peers) send(w, { type: 'peer-joined', id, role: meta.role });
      return;
    }

    // ---- relay ----
    if (!RELAY.has(msg.type) || typeof msg.to !== 'string') return;
    const target = this.members().find((w) => w.deserializeAttachment()?.id === msg.to);
    if (!target || target === ws) return;
    msg.from = meta.id;
    send(target, msg);
  }

  webSocketClose(ws) { this.announceLeft(ws); }
  webSocketError(ws) { this.announceLeft(ws); }

  announceLeft(ws) {
    const meta = ws.deserializeAttachment();
    if (!meta?.id) return;   // pending socket never joined
    for (const w of this.members()) {
      if (w !== ws) send(w, { type: 'peer-left', id: meta.id });
    }
  }

  async alarm() {
    // Nothing here can reap a *station* that died without a close handshake:
    // a hibernating socket that will never speak again is indistinguishable
    // from the product's whole premise — a Monitor plugged in, left alone, and
    // silent for hours. Telling them apart would mean an app-level heartbeat on
    // both ends, i.e. waking that idle phone's radio on a timer forever, to buy
    // back a window the admission path now handles for free: the owner proves
    // the channel key and takes the room back (see 4005 above).

    // Sweep sockets that connected and never said hello.
    const cutoff = Date.now() - ADMIT_TIMEOUT_MS;
    for (const w of this.state.getWebSockets()) {
      const m = w.deserializeAttachment();
      if (m?.pending && (m.since || 0) < cutoff) {
        try { w.close(...CLOSE.NO_HELLO); } catch {}
      }
    }

    const rec = await this.state.storage.get('ticket');
    if (!rec) return;
    // A Monitor that is plugged in and left alone — the whole point of the
    // product — registers its ticket once and never says hello again. Expiring
    // it out from under a live Monitor locked out every new Handheld with 4008
    // until someone restarted the phone. While the Monitor is here, the pairing
    // is by definition still current, so roll it forward instead.
    const stationHere = this.members()
      .some((w) => w.deserializeAttachment()?.role === 'station');
    if (rollTicket(rec, stationHere) === 'rolled') {
      await this.state.storage.put('ticket', rec);
      // Wake again either at the next idle expiry or at the ceiling, whichever
      // comes first, so the ticket is actually dropped when its life is up
      // rather than lingering until something else happens to touch the room.
      const ceiling = issuedAt(rec) + TICKET_MAX_LIFETIME_MS;
      await this.state.storage.setAlarm(
        Math.min(Date.now() + TICKET_TTL_MS, ceiling) + 60_000
      );
      return;
    }
    if (Date.now() > rec.exp || beyondLifetime(rec)) {
      await this.state.storage.delete('ticket');
    }
  }
}
