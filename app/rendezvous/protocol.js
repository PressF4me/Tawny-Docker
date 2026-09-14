// Tawny relay protocol — the one copy of what the three relays must agree on.
//
// server.js (the container), room.js (the Cloudflare Durable Object) and
// deno/main.ts (the Deno Deploy port) each carry their own admission code,
// because their socket and storage models differ. The numbers, the relayed
// message types, the close codes and the ticket clock used to be copied into
// all three as well, and drifted: the Deno port still answered "no Monitor has
// ever registered" with 4008 after the other two moved to 4010, and only
// room.js kept a ticket alive under a Monitor that stayed connected. Anything
// the relays must agree on belongs here.
//
// Plain JavaScript with no imports, so Node, Workers and Deno all load it
// unchanged. Keep RELAY in step with LocalWeb.kt, which cannot import it.

// Addressed control messages a relay forwards. Must list every addressed `type`
// public/app.js sends through sig(): a missing type is dropped in silence and
// its feature never happens on that transport. That has bitten twice —
// `cameras`, `meta` and `camera-control` (lens picker, remote zoom, pet-name
// sync), then `torch`, which left the Viewer's Light key greyed out.
export const RELAY = new Set([
  'offer', 'answer', 'ice', 'bye', 'chime', 'chime-ack', 'talking',
  'cameras', 'meta', 'camera-control', 'torch', 'battery'
]);

// 1 Watcher + up to 3 Handhelds. Three is the product's answer, not a tunable:
// it is the same number in public/app.js (MAX_VIEWERS) and LocalWeb.kt.
export const MAX_PER_ROOM = 4;
export const MAX_STATIONS = 1;

// Signalling frames are a few KB. Anything larger is someone filling memory.
export const MAX_MSG = 64 * 1024;
// A socket that opens and never says hello is closed after this long.
export const ADMIT_TIMEOUT_MS = 10_000;

// Idle life of an admission ticket. Rolled forward while a Monitor is connected
// (see rollTicket) — a Monitor plugged in and left alone is the product's whole
// premise, and expiring the ticket under it locked every new Handheld out.
export const TICKET_TTL_MS = 24 * 60 * 60 * 1000;
// Absolute ceiling, however long the Monitor stays up or however often it
// reconnects. Re-registering the same hashT keeps the original issue time; only
// a re-paired channel (a different hashT) starts a new lifetime. This is the
// bound SECURITY.md quotes.
export const TICKET_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

// Close codes public/app.js tells apart. Reason strings are part of the
// contract too — keep them identical across relays.
export const CLOSE = {
  EXPECTED_HELLO: [4000, 'expected hello'],
  FULL: [4003, 'channel full'],
  MONITOR_RUNNING: [4004, 'monitor already running'],
  BUSY: [4005, 'busy'],
  REPLACED: [4005, 'replaced by owner'],
  NO_HELLO: [4008, 'no hello'],
  PAIRING_EXPIRED: [4008, 'pairing expired'],
  WRONG_KEY: [4008, 'wrong channel key'],
  NO_TICKET: [4008, 'no pairing ticket'],
  TOO_LARGE: [4009, 'message too large'],
  // No Monitor has ever registered this room. Nothing is wrong with the code in
  // the Viewer's hand; calling it "expired" sent people back to rescan the same
  // QR for ever.
  MONITOR_OFFLINE: [4010, 'monitor offline'],
  TOO_MANY_ATTEMPTS: [4029, 'too many attempts'],
};

/** When this ticket was first registered, reconstructed for pre-`iss` records. */
export const issuedAt = (rec) => rec.iss ?? (rec.exp - TICKET_TTL_MS);

/** Past the absolute ceiling, regardless of how often it has been rolled on. */
export const beyondLifetime = (rec, now = Date.now()) =>
  now - issuedAt(rec) >= TICKET_MAX_LIFETIME_MS;

/** Usable for admission right now: inside both the idle TTL and the ceiling. */
export const ticketLive = (rec, now = Date.now()) =>
  !!rec && now <= rec.exp && !beyondLifetime(rec, now);

/**
 * Periodic upkeep for one room's ticket. While a Monitor is connected the idle
 * TTL is rolled forward (never past the ceiling); otherwise a dead ticket is
 * reported for deletion. Mutates `rec` in place.
 *
 * @returns {'rolled' | 'drop' | 'keep'}
 */
export function rollTicket(rec, stationHere, now = Date.now()) {
  if (stationHere && !beyondLifetime(rec, now)) {
    rec.iss = issuedAt(rec);   // pin it, so pre-`iss` records get a clock
    rec.exp = now + TICKET_TTL_MS;
    return 'rolled';
  }
  return ticketLive(rec, now) ? 'keep' : 'drop';
}
