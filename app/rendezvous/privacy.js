// The Tawny privacy policy, as one self-contained HTML page.
//
// Play will not accept a submission without a publicly reachable HTTPS URL for
// a privacy policy, and the rendezvous service is the one piece of Tawny that
// is already public, already on HTTPS, and already has to stay up for the app
// to work off-Wi-Fi. Serving it from here removes the GitHub Pages dependency
// (and the "who remembers to update the other copy" problem that came with it).
//
// Deliberately dependency-free and static: no template engine, no fetch, no
// build step. The markup carries its own CSS in a <style> block so the response
// is a single cacheable body with no subresources at all — which is also why
// PRIVACY_HEADERS ships a CSP that allows inline style and nothing else.
//
// This is the canonical copy for the hosted page. `privacy-policy.md` at the
// repo root is the same text in Markdown; keep the two in step.
//
// Imported by:
//   worker.js        (Cloudflare Worker — the deployed one)
//   deno/main.ts     (Deno Deploy alternative)
//   ../server.js     (self-host reference)

export const PRIVACY_UPDATED = '2026-10-01';

export const PRIVACY_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  // A policy page changes a few times a year. An hour at the edge, a day in a
  // browser, and `stale-while-revalidate` so a reader never waits on us.
  'cache-control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; " +
    "base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY'
};

export const PRIVACY_HTML = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tawny — Privacy Policy</title>
<meta name="description" content="What the Tawny pet monitor does and does not do with your information.">
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbf4f1; --panel: #fff; --fg: #33323d; --dim: #6b6572;
    --line: #e3d8d2; --accent: #d24b6d;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #191410; --panel: #241d16; --fg: #efe5d5; --dim: #a99e8e;
      --line: #3a2f25; --accent: #c79b64;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 32px 20px 72px;
    background: var(--bg);
    color: var(--fg);
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  main { max-width: 44rem; margin: 0 auto; }
  h1 { font-size: 1.9rem; line-height: 1.2; margin: 0 0 .25rem; }
  h2 { font-size: 1.15rem; margin: 2.25rem 0 .5rem; }
  .updated { color: var(--dim); font-size: .875rem; margin: 0 0 2rem; }
  a { color: var(--accent); }
  ul { padding-left: 1.25rem; }
  li { margin: .4rem 0; }
  strong { font-weight: 600; }
  .wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { border-collapse: collapse; width: 100%; min-width: 34rem; font-size: .9rem; }
  th, td { text-align: left; vertical-align: top; padding: .55rem .7rem; border: 1px solid var(--line); }
  th { background: var(--panel); font-weight: 600; }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line); color: var(--dim); font-size: .85rem; }
</style>
<main>
  <h1>Tawny — Privacy Policy</h1>
  <p class="updated">Last updated: ${PRIVACY_UPDATED}</p>

  <p>Tawny is a two-way pet monitor. One device (<strong>the Monitor</strong>)
  stays with your pet and sends its camera and microphone; one or more other
  devices (<strong>Viewers</strong>) watch and talk back. This policy explains
  what the app does and does not do with your information.</p>

  <h2>The short version</h2>
  <ul>
    <li><strong>No account. No sign-up.</strong> The app never asks for your
      name, email, or phone number.</li>
    <li><strong>No analytics, no advertising, no tracking.</strong> The app
      contains no third-party analytics, crash-reporting, or advertising
      SDKs.</li>
    <li><strong>Your video and audio are not recorded or stored</strong> by us,
      anywhere. They flow directly between your own devices, encrypted.</li>
    <li>On your home Wi-Fi, <strong>nothing leaves your home</strong> — one of
      your phones acts as the server.</li>
  </ul>

  <h2>What the app accesses on your device</h2>
  <div class="wrap">
  <table>
    <tr><th>Data / permission</th><th>Why</th><th>Leaves the device?</th></tr>
    <tr>
      <td><strong>Camera</strong></td>
      <td>The Monitor streams live video of your pet. The Viewer uses the camera
        only to scan the Monitor's pairing QR code.</td>
      <td>Video is sent, encrypted, only to your paired Viewer(s). Never to
        us.</td>
    </tr>
    <tr>
      <td><strong>Microphone</strong></td>
      <td>The Monitor streams room sound; the Viewer sends your voice when you
        hold &ldquo;talk&rdquo;.</td>
      <td>Audio is sent, encrypted, only to the paired device(s). Never to
        us.</td>
    </tr>
    <tr>
      <td><strong>Local network</strong></td>
      <td>To discover and connect your two phones.</td>
      <td>Stays on your Wi-Fi.</td>
    </tr>
    <tr>
      <td><strong>Photos you save</strong> (&ldquo;Snapshot&rdquo;)</td>
      <td>Saved to your device's Pictures folder, in a &ldquo;Tawny&rdquo;
        album.</td>
      <td>No.</td>
    </tr>
    <tr>
      <td><strong>Video clips you save</strong> (&ldquo;Record&rdquo;)</td>
      <td>Short clips, up to 20 seconds, saved to your device's Movies folder,
        in a &ldquo;Tawny&rdquo; album.</td>
      <td>No.</td>
    </tr>
    <tr>
      <td><strong>Diagnostics log</strong></td>
      <td>An optional, deliberately out-of-the-way log (long-press the small
        version number) for working out why a connection failed. Records hashed
        room identifiers and connection events, never your key or IP
        addresses.</td>
      <td>Only if you tap <strong>Send to Tawny</strong> &mdash; see
        &ldquo;Sending a diagnostics report&rdquo; below. Otherwise it stays on
        your device and is excluded from cloud backup.</td>
    </tr>
    <tr>
      <td><strong>Pairing key</strong></td>
      <td>A random 128-bit key, generated on your device, that identifies your
        private channel. Stored in the app's private storage.</td>
      <td>No — it is never sent to any server. Servers only ever see an
        irreversible hash of it.</td>
    </tr>
  </table>
  </div>

  <p>The app requests camera and microphone access only when you set up a role,
  and only after showing you a screen explaining what they are for.</p>

  <h2>How a connection is made</h2>
  <p>Video and audio use <strong>WebRTC</strong> and are encrypted end to end
  with DTLS-SRTP.</p>
  <ul>
    <li><strong>Same Wi-Fi:</strong> one of your phones runs a tiny signalling
      relay on the local network. No server on the internet is involved, and no
      data leaves your home.</li>
    <li><strong>From away:</strong> both devices dial out to a small
      &ldquo;rendezvous&rdquo; service whose only job is to introduce them to
      each other. That service:
      <ul>
        <li>never receives your pairing key (only an irreversible hash of it);</li>
        <li>never receives video or audio frames;</li>
        <li>may, when the two devices cannot reach each other directly, relay
          the <strong>encrypted</strong> media stream (a TURN relay). It cannot
          decrypt it, and it does not store it.</li>
        <li>briefly processes the devices' <strong>IP addresses</strong>, as any
          internet connection must, to route packets. These are not logged to
          identify you and are not shared with anyone.</li>
      </ul>
    </li>
    <li><strong>To find a direct path</strong>, each device may ask a public
      <strong>STUN</strong> server what its public IP address is. The Play
      release uses Cloudflare's (<code>stun.cloudflare.com</code>) and
      Google's (<code>stun.l.google.com</code>). A STUN server sees the
      device's IP address and nothing else: no key, no room, no media.</li>
  </ul>
  <p>The rendezvous service for the Play release is operated by the developer of
  this listing, on Cloudflare's infrastructure (Cloudflare Workers for the
  rendezvous, Cloudflare Realtime for the TURN relay); contact details are
  below. Cloudflare processes the connection data described above on the
  developer's behalf. This page is served by that same service.</p>
  <p>The app draws its screens in Android's own <strong>System
  WebView</strong>. On most devices the WebView may contact Google for its own
  services, such as Safe Browsing, under Google's privacy policy. The app
  itself sends Google nothing.</p>

  <h2>Using your own servers</h2>
  <p>The diagnostics screen (long-press the version number) has a
  <strong>Servers</strong> screen where you can point the app at a rendezvous,
  STUN and TURN servers of your own. Those servers then receive what Tawny's
  would (IP addresses, hashed room identifiers, encrypted media when relaying),
  and they are operated by whoever runs them, not by us. Normally, Tawny's
  servers stay behind yours as a fallback, used only if yours do not
  answer.</p>
  <p>The same screen has <strong>For tighter privacy [advanced]</strong>. With
  it on, the app contacts only the servers you type there and nothing
  else:</p>
  <ul>
    <li>no Tawny rendezvous or TURN relay, not even as a fallback;</li>
    <li>no public STUN (a blank STUN field means none);</li>
    <li>no relay picked up from a scanned pairing code;</li>
    <li>no <strong>Send to Tawny</strong> button for diagnostics;</li>
    <li>the WebView's Safe Browsing checks are turned off.</li>
  </ul>
  <p>If your servers are wrong or unreachable, the app does not connect over the
  internet at all. It never falls back to ours.</p>

  <h2>Sending a diagnostics report</h2>
  <p>The diagnostics screen has a <strong>Send to Tawny</strong> button. It does
  nothing unless you tap it. When you do, the app sends <strong>that one
  diagnostics log</strong>, together with your device model, your Android version
  and the app's version number, to the developer's rendezvous service over an
  encrypted connection, to help work out why a connection failed.</p>
  <ul>
    <li>It is never sent automatically, only when you tap the button.</li>
    <li>It contains no account, name, email or advertising identifier &mdash;
      there are none in the app &mdash; and the log records only hashed room
      identifiers and connection events (for example whether a connection was
      direct or relayed), never your pairing key or IP addresses.</li>
    <li>Reports are held for at most 30 days and then deleted automatically.</li>
    <li>If you would rather not send it through the app, the same screen offers
      &ldquo;Send another way&rdquo; (your device's normal share sheet) and
      &ldquo;Copy&rdquo;.</li>
  </ul>

  <h2>Children</h2>
  <p>Tawny is not directed to children under 13 and does not knowingly collect
  information from them.</p>

  <h2>Security</h2>
  <p>Media is encrypted in transit (DTLS-SRTP). The first time a phone connects
  to a monitor over the internet, both screens show a short safety code for you
  to compare, which detects a tampered relay. You are asked once per phone:
  after you confirm the codes match, that phone is not asked again.
  Pairing codes are like a key to your channel —
  only share them with devices you own, and re-pair if a code may have
  leaked.</p>

  <h2>Supporting Tawny</h2>
  <p>Supporting Tawny is entirely optional and unlocks nothing &mdash; every
  feature is available to everyone, whether or not anyone ever contributes.</p>
  <ul>
    <li><strong>Ko-fi.</strong> The About screen and the web client's footer
      carry one external link, to
      <a href="https://ko-fi.com/tawnyone">ko-fi.com/tawnyone</a>. Following it
      opens your browser; nothing about you is sent there by the app. Any payment
      page reached that way is operated by Ko-fi under its own privacy policy,
      not by us.</li>
    <li><strong>Bitcoin (Lightning).</strong> The <strong>Tip in Bitcoin</strong>
      screen shows a Lightning Address (<code>loustrikes@strike.me</code>). Its
      button asks Android to open that address in whatever Lightning wallet you
      have installed; the wallet, not Tawny, does everything from there. Tawny
      sets no amount, holds no funds, includes no wallet, and never handles a
      key, an invoice or a payment. If you have no wallet installed, the screen
      simply shows the address and a QR code. Nothing about you is sent anywhere
      by opening this screen.</li>
  </ul>

  <h2>Changes</h2>
  <p>If this policy changes materially, the &ldquo;Last updated&rdquo; date
  above will change and the new version will ship with an app update.</p>

  <h2>If you email us</h2>
  <p>Mail to <a href="mailto:tawnysupport@pm.me">tawnysupport@pm.me</a> is
  received by Proton Mail. To help answer it, a copy is kept on the developer's
  own server for up to 30 days and read by an AI assistant that runs entirely on
  the developer's own hardware. Your message is not sent to any outside AI or
  analytics service. The assistant only drafts; every reply is written or
  checked and sent by the developer. Don't include pairing codes or passwords in
  an email.</p>

  <h2>Contact</h2>
  <p>Questions or a data-deletion request:
  <a href="mailto:tawnysupport@pm.me">tawnysupport@pm.me</a></p>
  <p>There is generally nothing for us to delete, because we do not collect or
  store your personal data. Clearing the app's data (Android Settings &rarr; Apps
  &rarr; Tawny &rarr; Storage) removes the pairing key and all local state from
  that device.</p>

  <footer>Tawny — a private pet monitor. This page is static and loads nothing
  from anywhere else.</footer>
</main>
</html>
`;

/** For the fetch-style runtimes (Cloudflare Workers, Deno Deploy). */
export function privacyResponse() {
  return new Response(PRIVACY_HTML, { headers: PRIVACY_HEADERS });
}
