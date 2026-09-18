// Tawny — the setup flow. Polls /setup.json and renders it as an ordered set
// of steps rather than a flat status list: a finished step collapses to its
// title, and whatever you still have to do stays open with the reason it
// matters and a link straight to the page that does it.
//
// No framework, no build step, same "no CDN, nothing external" rule as the
// rest of the app.
'use strict';

const POLL_MS = 4000;

const LINK = {
  keys:     'https://login.tailscale.com/admin/settings/keys',
  machines: 'https://login.tailscale.com/admin/machines',
  dns:      'https://login.tailscale.com/admin/dns',
  download: 'https://tailscale.com/download',
  subnets:  'https://tailscale.com/kb/1019/subnets'
};

const ICONS = {
  tick: '<path d="M4 12.5 9 17.5 20 6.5"/>',
  bang: '<path d="M12 4 21.5 20H2.5Z"/><path d="M12 10v4.2"/><circle cx="12" cy="17.3" r=".3" fill="currentColor" stroke="none"/>',
  cross: '<path d="M6 6 18 18M18 6 6 18"/>',
  out:  '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  eye:    '<path d="M2 12s3.8-7 10-7 10 7 10 7-3.8 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M2 12s3.8-7 10-7c2 0 3.7.6 5.1 1.5M22 12s-3.8 7-10 7c-2 0-3.7-.6-5.1-1.5"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/>'
};

function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (v != null) n.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
  return n;
}

const svg = (d, cls) => el('span', { class: cls || '', html: `<svg viewBox="0 0 24 24">${d}</svg>` });

/** Eye / eye-off glyph for the auth-key reveal toggle. `shown` = key is currently visible. */
function eyeIcon(shown) {
  return svg(shown ? ICONS.eyeOff : ICONS.eye, 'join-reveal-icon');
}

/** An external link, always marked as one. */
function goLink(href, label) {
  const a = el('a', { class: 'go', href, target: '_blank', rel: 'noopener noreferrer' }, label);
  a.append(svg(ICONS.out));
  return a;
}

/**
 * Is the https://<node>.<tailnet>.ts.net address actually being served? A
 * MagicDNS name (dnsName) can exist while HTTPS certs are off and `tailscale
 * serve` is failing, so nothing may treat dnsName as "done".
 *   true  — serve is fronting our port, or the operator turned serve off
 *   false — serve is wanted but demonstrably not up (HTTPS switches, usually)
 *   null  — the tailscale CLI could not say; fall back to the step record
 */
function serveState(ts) {
  if (!ts || !ts.serveWanted) return true;
  if (ts.serving === true) return true;
  if (ts.serving === false) return false;
  return null;
}

// render() rebuilds every step row on each 4 s poll, which used to snap any
// open explainer shut — it looked like it "closed itself after a few seconds".
// Remember which are open (keyed by their question) and restore on rebuild.
const whyOpen = new Set();

/** A collapsible plain-language explainer that survives a re-render. */
function why(question, ...paragraphs) {
  const key = question.slice(0, 60);
  const d = el('details', whyOpen.has(key) ? { class: 'why', open: 'open' } : { class: 'why' },
    el('summary', {}, question),
    ...paragraphs.map((p) => el('p', {}, p)));
  d.addEventListener('toggle', () => {
    if (d.open) whyOpen.add(key); else whyOpen.delete(key);
  });
  return d;
}

function copyRow(text) {
  return el('div', { class: 'copy-row' },
    el('code', { class: 'pair-url' }, text),
    el('button', { class: 'copy-btn', type: 'button', 'data-copy-text': text }, 'Copy'));
}

/**
 * One step. `state` ('done' | 'now' | 'todo' | 'bad') is what the step IS;
 * `open` is whether it is the one expanded on screen. They used to be the same
 * thing, which is why there was no way to look at a step you had already
 * finished — and so nothing for a Back button to go back to.
 *
 * The head is a real button: every step can be opened by pressing its row, so
 * the flow reads forwards and backwards instead of only forwards.
 */
function stepRow(n, { state, title, tag, body }, open, idx) {
  const badge = state === 'done'
    ? svg(ICONS.tick, 'step-badge')
    : state === 'bad'
      ? svg(ICONS.cross, 'step-badge')
      : el('span', { class: 'step-badge' }, String(n));

  const head = el('button', {
    class: 'step-head', type: 'button',
    'data-step': String(idx),
    'aria-expanded': open ? 'true' : 'false'
  }, badge, el('span', { class: 'step-title' }, title, tag ? el('small', {}, tag) : null));

  const kids = (body || []).filter(Boolean);
  // The body is built only when open. A collapsed step used to keep its form
  // fields in the DOM, which put an invisible auth-key box in the tab order.
  return el('div', { class: `step is-${state}${open ? ' is-open' : ''}` },
    head,
    open && kids.length ? el('div', { class: 'step-body' }, ...kids) : null);
}

// Which step is expanded. null means "follow the flow" — the first one that
// actually needs someone. A number means the operator navigated by hand, with
// the Back arrow or by pressing a row, and we stop moving it under them.
let selected = null;
// The index currently on screen, so Back knows what it is stepping back from.
let openNow = 0;
// The last payload rendered, so a navigation press can repaint immediately
// instead of waiting out the four-second poll.
let lastData = null;

// Set by renderVerdict on every paint: is the whole setup finished, and what is
// the https://<node>.<tailnet>.ts.net address to hand off to. The back arrow
// reads these — once everything is done it stops stepping through the flow and
// opens Tawny for real instead.
let setupComplete = false;
let finishUrl = '';
// Flipped when the operator actually clicks "Open Tawny" on the finish screen,
// so the page can switch to a plain "you're done, close this tab" panel.
let openedApp = false;

function repaint() {
  if (lastData) render(lastData);
}

/**
 * The most recent record for a step. The state file is append-only, so a
 * rejected key followed by a good one leaves both behind — only the last one
 * describes the present.
 */
function findStep(startup, name) {
  if (!Array.isArray(startup)) return null;
  for (let i = startup.length - 1; i >= 0; i--) {
    if (startup[i] && startup[i].step === name) return startup[i];
  }
  return null;
}

/**
 * The newest entry for each step. The startup log is append-only, so reading
 * every entry kept a failure that was since fixed (a bad auth key, retried)
 * counting against the setup for ever. Same rule as findStep().
 */
function latestSteps(startup) {
  if (!Array.isArray(startup)) return [];
  const seen = new Map();
  const loose = [];   // an entry with no step name has nothing to supersede it
  for (const s of startup) {
    if (!s) continue;
    if (s.step) seen.set(s.step, s); else loose.push(s);
  }
  return [...seen.values(), ...loose];
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    } catch { return false; }
  }
}

function toast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2200);
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.copy-btn');
  if (!btn) return;
  const text = btn.getAttribute('data-copy-text') || '';
  if (!text) return;
  const ok = await copyText(text);
  toast(ok ? 'Copied' : 'Could not copy — select and copy manually');
  if (ok) { btn.classList.add('done'); setTimeout(() => btn.classList.remove('done'), 1200); }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('#devices-ack')) return;
  try { localStorage.setItem(DEVICES_ACK, '1'); } catch { /* private window */ }
  selected = null;
  tick();
});

// The appbar arrow goes back one STEP. It used to leave the page entirely —
// and, on the way out, quietly write the same "setup is finished" cookie the
// skip link writes, so a press meant as "let me look at that again" marked the
// whole deployment done for a day and dropped you on the home screen. A back
// arrow means up one level; leaving is a different intent and now has its own
// labelled link in the footer.
document.getElementById('setup-back').addEventListener('click', () => {
  // Once the whole setup is finished, Back is not "previous step" any more —
  // there is nothing left to go back to and the operator is done here. Hand
  // them off to the real address instead.
  if (setupComplete && finishUrl) {
    location.href = finishUrl;
    return;
  }
  selected = Math.max(0, openNow - 1);
  repaint();
});

// Open a step by pressing its row, so the arrow is not a one-way trip.
document.addEventListener('click', (e) => {
  const head = e.target.closest('.step-head');
  if (!head) return;
  const i = Number(head.getAttribute('data-step'));
  if (!Number.isInteger(i)) return;
  selected = i;
  repaint();
});

// "Open Tawny without finishing." Explicit, labelled, and this device only —
// everything the back arrow used to do without saying so.
document.getElementById('leave-link').addEventListener('click', (e) => {
  e.preventDefault();
  document.cookie = 'tawny_setup_done=1; path=/; max-age=86400; samesite=lax';
  location.href = '/';
});

// "Use it on this Wi-Fi only." Recorded on the container so it settles the
// question for every device in the house, not just this browser. The cookie
// is only a fallback for a deployment with no writable volume.
document.getElementById('skip-link').addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    await fetch('/setup/skip', { method: 'POST' });
  } catch { /* offline — the cookie below still helps this device */ }
  document.cookie = 'tawny_setup_done=1; path=/; max-age=31536000; samesite=lax';
  location.href = '/';
});

/* ------------------------------------------------------- the finish line */

/** The address, as something you can actually click. */
function openLink(url) {
  const a = el('a', { class: 'open-app', href: url, target: '_blank', rel: 'noopener noreferrer' },
    el('span', { class: 'open-app-label' }, 'Open Tawny'),
    el('span', { class: 'open-app-url' }, url),
    svg(ICONS.out, 'open-app-out'));
  // The click opens the app in a new tab; here it also flips the finish screen
  // into "you're done" mode — a fresh burst of confetti and a close prompt.
  a.addEventListener('click', () => {
    if (openedApp) return;
    openedApp = true;
    confetti({ big: true });
    setTimeout(repaint, 0);
  });
  return el('div', { class: 'url-hero' },
    a,
    el('button', { class: 'copy-btn', type: 'button', 'data-copy-text': url }, 'Copy'));
}

// Fires once when the setup actually completes — on the transition, or the
// first time a finished deployment is ever opened. Not on every poll, and not
// on every reload for the rest of the deployment's life.
let celebrated = false;
let sawIncomplete = false;

function confetti(opts = {}) {
  const big = !!opts.big;
  // A full-screen animation is precisely what this setting is for.
  try {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  } catch { /* no matchMedia — carry on */ }

  const cv = el('canvas', { class: 'confetti', 'aria-hidden': 'true' });
  document.body.append(cv);
  const ctx = cv.getContext('2d');
  if (!ctx) return cv.remove();

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = cv.width = Math.floor(window.innerWidth * dpr);
  const H = cv.height = Math.floor(window.innerHeight * dpr);
  cv.style.width = window.innerWidth + 'px';
  cv.style.height = window.innerHeight + 'px';

  // Read the palette rather than hard-coding it: those literals were the
  // light theme's strawberry and blue, and Tawny's dark theme is brass and
  // sage — so the one celebratory moment in the whole product was the only
  // place the brand changed colour.
  const css = getComputedStyle(document.documentElement);
  const tone = (name, fallback) => (css.getPropertyValue(name).trim() || fallback);
  const colours = [
    tone('--berry', '#d24b6d'), tone('--sky', '#5b93b8'), tone('--alert', '#e0a63c'),
    tone('--berry-d', '#a83c58'), tone('--glass-fg', '#f7f1e8')
  ];
  const bits = [];
  const count = big ? 320 : 150;
  for (let i = 0; i < count; i++) {
    bits.push({
      x: Math.random() * W,
      y: -Math.random() * H * (big ? 0.9 : 0.5),
      w: (5 + Math.random() * 7) * dpr,
      h: (8 + Math.random() * 10) * dpr,
      vx: (Math.random() - 0.5) * (big ? 3.4 : 2.6) * dpr,
      vy: (2 + Math.random() * (big ? 4.6 : 3.4)) * dpr,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.24,
      c: colours[(Math.random() * colours.length) | 0]
    });
  }

  const DUR = big ? 5200 : 3400;
  const t0 = performance.now();
  const frame = (now) => {
    const t = now - t0;
    ctx.clearRect(0, 0, W, H);
    const fade = t > DUR - 900 ? Math.max(0, (DUR - t) / 900) : 1;
    for (const b of bits) {
      b.x += b.vx; b.y += b.vy; b.rot += b.vr; b.vy += 0.035 * dpr;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.fillStyle = b.c;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.restore();
    }
    if (t < DUR) requestAnimationFrame(frame);
    else cv.remove();
  };
  requestAnimationFrame(frame);
}

function maybeCelebrate() {
  if (celebrated) return;
  celebrated = true;
  let firstEver = false;
  try {
    firstEver = localStorage.getItem('tawny.celebrated') !== '1';
    localStorage.setItem('tawny.celebrated', '1');
  } catch { /* private window — then it just fires on the transition */ }
  if (firstEver || sawIncomplete) confetti();
}

/* ------------------------------------------------------------------ steps */

function stepMachine(data) {
  const { lan } = data;
  const step = findStep(data.startup, 'lan_detect');

  if (!lan.cidr || (step && step.ok === false)) {
    return {
      state: 'bad',
      title: 'This machine',
      tag: 'no network found',
      body: [
        el('p', { class: 'step-say' }, 'Tawny could not find a normal home-network address on this machine, so it does not know which network your pet camera phone is on.'),
        el('p', { class: 'step-do' }, 'Set TS_ROUTES in your .env to your home network, then restart the container. It usually looks like 192.168.1.0/24 — the same as your router’s address with a 0 at the end.')
      ]
    };
  }

  if (lan.looksLikeDockerBridge) {
    return {
      state: 'bad',
      title: 'This machine',
      tag: 'wrong network',
      body: [
        el('p', { class: 'step-say' }, `Tawny found ${lan.cidr}, which is Docker’s own internal network rather than your home Wi-Fi. Your phone is not on that network, so it could never be reached.`),
        el('p', { class: 'step-do' }, 'This happens when the container is not using host networking. Either turn host networking on, or set TS_ROUTES in your .env to your real home network (for example 192.168.1.0/24) and restart the container.')
      ]
    };
  }

  return {
    state: 'done',
    title: 'This machine',
    tag: lan.cidr,
    body: [el('p', { class: 'step-say' }, `Found on your home network at ${lan.ip}.`)]
  };
}

// While a join is in flight the poll must not rebuild the steps underneath it,
// or the button and its message vanish mid-request.
let joinBusy = false;

function joinForm(opts = {}) {
  const input = el('input', {
    id: 'join-key', class: 'join-input', type: 'password',
    placeholder: 'tskey-auth-…',
    autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false'
  });

  // Masked by default — this key can join a device to the tailnet, so it is
  // treated like a password: hidden on screen, and uncopiable while hidden
  // (the raw characters are still what a password field copies, dots or not,
  // so masking alone does not stop a shoulder-surfed clipboard).
  const revealBtn = el('button', {
    id: 'join-reveal', class: 'join-reveal', type: 'button',
    'aria-label': 'Show auth key', 'aria-pressed': 'false'
  }, eyeIcon(false));
  const blockWhileHidden = (e) => { if (input.type === 'password') e.preventDefault(); };
  input.addEventListener('copy', blockWhileHidden);
  input.addEventListener('cut', blockWhileHidden);
  input.addEventListener('dragstart', blockWhileHidden);
  revealBtn.addEventListener('click', () => {
    const shown = input.type === 'password';
    input.type = shown ? 'text' : 'password';
    revealBtn.replaceChildren(eyeIcon(shown));
    revealBtn.setAttribute('aria-label', shown ? 'Hide auth key' : 'Show auth key');
    revealBtn.setAttribute('aria-pressed', String(shown));
  });
  const inputWrap = el('div', { class: 'join-input-wrap' }, input, revealBtn);

  const btn = el('button', { id: 'join-go', class: 'wide primary', type: 'submit' }, 'Connect');
  const msg = el('p', { id: 'join-msg', class: 'join-msg', hidden: 'hidden' });

  // On the "stale_unrecovered" card the same field feeds a second action:
  // archive the stuck identity and rejoin with this key.
  const resetBtn = opts.resetLabel
    ? el('button', { id: 'join-reset', class: 'wide', type: 'button' }, opts.resetLabel)
    : null;

  const form = el('form', { id: 'join-form', class: 'join' },
    el('label', { class: 'join-label', for: 'join-key' }, 'Paste your auth key'),
    inputWrap, btn, resetBtn, msg);

  const post = async (path, label) => {
    const key = input.value.trim();
    if (!key) return;
    joinBusy = true;
    btn.disabled = true;
    if (resetBtn) resetBtn.disabled = true;
    btn.textContent = 'Connecting…';
    msg.hidden = true;
    msg.className = 'join-msg';
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authkey: key })
      });
      const out = await res.json().catch(() => ({}));
      if (res.ok && out.ok) {
        msg.className = 'join-msg is-ok';
        msg.textContent = 'Joined. Checking what is left to do…';
        msg.hidden = false;
        input.value = '';
        joinBusy = false;
        selected = null;   // finished — let the flow move on
        return tick();
      }
      if (out.recovering) {
        msg.className = 'join-msg';
        msg.textContent = 'Clearing a leftover Tailscale identity and rejoining — this can take a few seconds…';
        msg.hidden = false;
        input.value = '';
        joinBusy = false;
        selected = null;
        return tick();
      }
      msg.className = 'join-msg is-bad';
      msg.textContent = out.error || `${label} failed (${res.status}).`;
      msg.hidden = false;
    } catch {
      msg.className = 'join-msg is-bad';
      msg.textContent = 'Could not reach the container. It may be restarting.';
      msg.hidden = false;
    }
    btn.disabled = false;
    if (resetBtn) resetBtn.disabled = false;
    btn.textContent = 'Connect';
    joinBusy = false;
  };

  form.addEventListener('submit', (e) => { e.preventDefault(); post('/setup/join', 'Join'); });
  if (resetBtn) resetBtn.addEventListener('click', () => post('/setup/ts-reset', 'Reset'));

  return form;
}

function stepConnect(data) {
  const { tailscale } = data;
  const up = findStep(data.startup, 'tailscale_up') || findStep(data.startup, 'tailscale_routes');
  const serve = findStep(data.startup, 'tailscale_serve');
  const short = (tailscale.dnsName || '').split('.')[0];

  // One disclosure, not two. This step used to carry "What is Tailscale" and
  // "Other ways to do this step" side by side under an already long card;
  // three collapsed triangles in a column is its own kind of clutter.
  const explain = why('What is Tailscale, and are there other ways to do this?',
    'Tailscale is a free private network. You install it on the devices you own, sign in on each one, and from then on they can reach each other from anywhere — as if they were all sitting on your home Wi-Fi. Tawny uses it to get a real web address with a proper certificate (browsers only hand over a microphone on one, so talk-back depends on it) and to let you watch from outside the house without opening any ports.',
    'Instead of pasting a key you can set TS_AUTHKEY as a setting and restart — in Portainer under Stacks → Editor → Environment variables, or as TS_AUTHKEY=… in a .env file beside docker-compose.yml. Either way the key is not written to any file. If this machine already runs Tailscale for its own reasons, mount /var/run/tailscale into the container instead and Tawny will use the daemon that is already signed in.');

  // Already on a tailnet. How it got there decides what there is to say — and
  // when the machine was already running Tailscale, the honest answer is
  // "nothing, this step did itself".
  if (tailscale.loggedIn) {
    // "Joined" is not "finished". The address is only real once `tailscale
    // serve` is fronting our port — treat a failed serve step AND a live
    // "serve is not up" reading the same way, so the flow never reports done
    // while HTTPS is still off.
    const sv = serveState(tailscale);
    const serveBroken = sv === false || (serve && serve.ok === false);

    if (serveBroken) {
      // Tailscale prints a specific error when the tailnet has not turned on
      // the HTTPS/MagicDNS features `tailscale serve` needs. That is a switch
      // in the admin console, not a leftover setting — and it is off by
      // default on a brand-new tailnet, so it is the first thing to rule out.
      const d = String((serve && serve.detail) || '');

      // Tawny is driving the machine's own tailscaled and that machine was
      // already serving something at its Tailscale address. Taking the mount
      // point over is not ours to do, so the entrypoint stepped aside — and
      // the fix is a separate node, not a reset of whatever is there.
      if (/already serves something else/i.test(d)) {
        return {
          state: 'bad',
          title: 'Connect to Tailscale',
          tag: 'address already in use',
          body: [
            el('p', { class: 'step-say' }, 'This machine is on your Tailscale network, but its Tailscale web address is already serving something else. Tawny left that alone rather than replacing it.'),
            el('div', { class: 'step-do' }, 'Pick one:',
              el('ol', {},
                el('li', {}, 'Give Tawny its own address — set TS_AUTHKEY to a Tailscale auth key and restart the container. It joins as a separate device with a name of its own, and nothing on this machine changes.'),
                el('li', {}, 'Or free the address: run tailscale serve reset on this machine, if you know what it was serving is no longer needed, and restart the container.'))),
            goLink(LINK.keys, 'Get an auth key'),
            explain
          ]
        };
      }

      const needsHttps = /magicdns/i.test(d) ||
        (/https/i.test(d) && /enabl/i.test(d)) ||
        /admin\/dns|1153|enabling-https/i.test(d) ||
        // Serve is demonstrably not up and nothing errored loudly — on a fresh
        // tailnet that is the MagicDNS / HTTPS-certificate switches every time.
        (!d && sv === false);

      if (needsHttps) {
        return {
          state: 'bad',
          title: 'Connect to Tailscale',
          tag: 'turn on HTTPS in Tailscale',
          body: [
            el('p', { class: 'step-say' }, 'Tawny is on your network, but your Tailscale account has not switched on the two features it needs to publish a web address: MagicDNS and HTTPS certificates. These are account-wide switches that only you can flip — a container cannot turn them on for you.'),
            el('div', { class: 'step-do' }, 'On the DNS page of your Tailscale admin console:',
              el('ol', {},
                el('li', {}, 'Under "MagicDNS", press Enable.'),
                el('li', {}, 'Under "HTTPS Certificates", press Enable HTTPS. (MagicDNS has to be on first.)'))),
            goLink(LINK.dns, 'Open Tailscale DNS settings'),
            el('p', { class: 'step-say' }, 'Then come back to this page and wait a few seconds — Tawny keeps retrying and will publish the address on its own. No restart. This is a one-time setting for your whole account.'),
            why('Why does Tawny need these turned on?',
              'MagicDNS is what gives every device on your network a name like tawny.your-tailnet.ts.net instead of a bare number. HTTPS certificates let Tailscale put a real, browser-trusted certificate on that name.',
              'Both together are what "tailscale serve" uses to front Tawny at a secure address. A browser only hands a page the microphone on a secure address, so without them there is no talk-back — and the plain http://…:8099 address is the LAN-only fallback.'),
            // `d`, not serve.detail: serveBroken is now also reached from the
            // live "serve is not up" reading, and on that path there may be no
            // tailscale_serve step at all — `serve` is then undefined and
            // reading .detail off it throws, blanking the whole page.
            d ? el('pre', { class: 'step-log' }, d) : null
          ]
        };
      }

      return {
        state: 'bad',
        title: 'Connect to Tailscale',
        tag: 'no web address',
        body: [
          el('p', { class: 'step-say' }, 'You are on the network, but Tailscale could not publish Tawny at a web address — so the https:// address will not load, and talk-back will not work. Tawny keeps retrying; if this does not clear on its own:'),
          el('p', { class: 'step-do' }, 'A leftover setting from an earlier run is the usual cause. Run tailscale serve reset on this machine. If that does not fix it, check that MagicDNS and HTTPS certificates are enabled on the DNS page of your Tailscale admin console.'),
          goLink(LINK.dns, 'Open Tailscale DNS settings'),
          d ? el('pre', { class: 'step-log' }, d) : null   // see above: `serve` may be undefined here
        ]
      };
    }
    return {
      state: 'done',
      title: 'Connect to Tailscale',
      tag: tailscale.mode === 'host'
        ? `using this machine${short ? ` (${short})` : ''}`
        : `joined${short ? ` as ${short}` : ''}`
    };
  }

  // Tawny is pointed at the machine's own tailscaled and that daemon is
  // logged out. An auth key pasted here would run `tailscale up` against the
  // operator's actual computer — renaming it, possibly moving it to another
  // tailnet, and turning off its accept-routes preference on the way past. So
  // the server refuses it, and this says so instead of offering a form that
  // cannot work.
  if (tailscale.mode === 'host' && tailscale.configured && tailscale.reachable) {
    return {
      state: 'bad',
      title: 'Connect to Tailscale',
      tag: 'sign this machine in',
      body: [
        el('p', { class: 'step-say' }, 'Tawny is using the Tailscale already installed on this machine, but that machine is not signed in to a network yet. A key pasted here would sign in the machine itself, not Tawny, so Tawny will not do it for you.'),
        el('div', { class: 'step-do' }, 'Pick one:',
          el('ol', {},
            el('li', {}, 'Run tailscale up on this machine and follow the link it prints.'),
            el('li', {}, 'Or give Tawny its own device instead: set TS_AUTHKEY to an auth key and restart the container. Nothing on this machine changes.'))),
        goLink(LINK.keys, 'Get an auth key'),
        explain
      ]
    };
  }

  // A daemon is running inside the container, logged out. This is the only
  // situation where an auth key is worth asking anyone for.
  if (tailscale.configured && tailscale.reachable) {
    const failed = up && up.ok === false;
    const kind = (up && up.kind) || '';

    // A leftover identity is being archived and rejoined automatically. Nothing
    // for the operator to do but wait for the next poll.
    if (failed && kind === 'stale') {
      return {
        state: 'now',
        title: 'Connect to Tailscale',
        tag: 'clearing a leftover identity',
        body: [
          el('p', { class: 'step-say' }, 'A Tailscale identity from an earlier run was stuck in this container’s data volume. Tawny is clearing it and rejoining — this page updates on its own in a few seconds.'),
          up.detail ? el('pre', { class: 'step-log' }, up.detail) : null,
          explain
        ]
      };
    }

    // The automatic clear could not run or did not take. Hand the operator the
    // manual step, and a one-click retry.
    if (failed && kind === 'stale_unrecovered') {
      return {
        state: 'bad',
        title: 'Connect to Tailscale',
        tag: 'leftover identity — needs a hand',
        body: [
          el('p', { class: 'step-say' }, 'An earlier run left a Tailscale identity in this container’s data volume that the coordination server will not take back, and Tawny could not clear it automatically.'),
          el('div', { class: 'step-do' }, 'Do one of:',
            el('ol', {},
              el('li', {}, 'Paste the key below and press Reset Tailscale identity.'),
              el('li', {}, 'Or run  docker exec <container> rm -rf /data/tailscale  and restart the container.'),
              el('li', {}, 'Or delete and recreate the tawny-data volume.'))),
          el('p', { class: 'step-say' }, 'The unusable state was moved to /data/tailscale.broken-… inside the volume — nothing was deleted.'),
          up.detail ? el('pre', { class: 'step-log' }, up.detail) : null,
          joinForm({ resetLabel: 'Reset Tailscale identity' }),
          explain
        ]
      };
    }

    if (failed && kind === 'network') {
      return {
        state: 'bad',
        title: 'Connect to Tailscale',
        tag: 'could not reach Tailscale',
        body: [
          el('p', { class: 'step-say' }, 'Tawny got as far as contacting Tailscale, but the connection timed out. This is almost always the host’s firewall or DNS — not the key.'),
          el('div', { class: 'step-do' }, 'Check that this machine can reach controlplane.tailscale.com and login.tailscale.com on port 443. A VPN kill-switch (Mullvad) or an nftables / ufw drop is the usual cause. Then paste the key again.'),
          up.detail ? el('pre', { class: 'step-log' }, up.detail) : null,
          joinForm(),
          explain
        ]
      };
    }

    // badkey, unknown, or a step from before this field existed.
    const retry = failed;
    return {
      state: retry ? 'bad' : 'now',
      title: 'Connect to Tailscale',
      tag: retry ? 'key rejected — try another' : 'needs you',
      body: [
        el('p', { class: 'step-say' }, retry
          ? 'That key was refused. Usually it has expired, it was a one-off key that has already been used, or it belongs to a different Tailscale account. Paste a fresh one — nothing needs restarting.'
          : 'This machine is not on a Tailscale network yet. One key joins it, which is what lets you watch from outside the house and what makes talk-back work at all.'),

        retry && up.detail ? el('pre', { class: 'step-log' }, up.detail) : null,

        el('div', { class: 'step-do' }, 'On the auth keys page:',
          el('ol', {},
            el('li', {}, 'Press Generate auth key. A free account covers a household.'),
            el('li', {}, 'Turn Reusable ON, leave Ephemeral OFF — an ephemeral key makes Tawny vanish from your network on every restart.'),
            el('li', {}, 'Copy it, and paste it below.'))),
        goLink(LINK.keys, 'Get an auth key'),
        el('p', { class: 'step-say' }, 'Once this works, Tawny remembers it — an update or a restart never asks again.'),

        joinForm(),

        explain
      ]
    };
  }

  // No Tailscale in the image at all, so nothing here can fix it.
  return {
    state: 'now',
    title: 'Connect to Tailscale',
    tag: 'needs a setting',
    body: [
      el('p', { class: 'step-say' }, 'There is no Tailscale running in this container, so a key cannot be applied from here.'),
      el('div', { class: 'step-do' }, 'Set TS_AUTHKEY and restart:',
        el('ol', {},
          el('li', {}, 'Portainer: Stacks → your tawny stack → Editor → Environment variables → add TS_AUTHKEY → Update the stack.'),
          el('li', {}, 'Compose: put TS_AUTHKEY=tskey-auth-… in a .env file beside docker-compose.yml, then docker compose up -d.'),
          el('li', {}, 'docker run: add -e TS_AUTHKEY=tskey-auth-… and start it again.'))),
      goLink(LINK.keys, 'Get an auth key'),
      explain
    ]
  };
}

// Buttons for the two ways an operator can respond to a detected route
// conflict. Both are one click, no restart — the whole point of catching this
// live instead of just documenting "don't do that" in a README.
let routeBusy = false;

function routeActionButton(label, cls, path, body) {
  const btn = el('button', { class: cls, type: 'button' }, label);
  btn.addEventListener('click', async () => {
    routeBusy = true;
    btn.disabled = true;
    const was = btn.textContent;
    btn.textContent = 'Working…';
    try {
      await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {})
      });
    } catch { /* the poll right after will show whatever actually happened */ }
    routeBusy = false;
    btn.disabled = false;
    btn.textContent = was;
    selected = null;
    tick();
  });
  return btn;
}

function stepRoute(data) {
  const { tailscale } = data;
  if (!tailscale.loggedIn) {
    return { state: 'todo', title: 'Let your devices reach the camera', tag: 'after the step above' };
  }

  const pending = tailscale.pendingRoutes || [];
  const approved = tailscale.approvedRoutes || [];
  const conflicts = tailscale.routeConflicts || [];
  // Peers whose approved route already covers ours in full. Not the same as a
  // conflict: this is the path existing, carried by somebody else.
  const covered = tailscale.routeCoveredBy || [];
  const cidr = pending[0] || approved[0] || data.lan.cidr;

  // One disclosure for this step, same rule as stepConnect: "Where do I click"
  // and "What am I approving" were two triangles stacked under one short card,
  // and the answer to the second is the reason the first exists.
  const explain = why('What am I approving, and where?',
    `Your pet camera phone sits on your home network at an address like ${data.lan.ip || '192.168.1.50'}, which is private to your house — a device somewhere else has no way to reach it. Approving this route tells Tailscale that this machine may pass traffic through to your home network, so a phone or laptop out in the world reaches the camera directly. Tailscale makes you do it by hand, once, because it is your network and it will not open it without asking.`,
    'On the machines page you get one row per device. The row for this container carries a "Subnets" badge — that badge is the thing you are approving. Tailscale documents the whole mechanism at tailscale.com/kb/1019/subnets.');

  // Another device on the tailnet already carries this range (or an
  // overlapping one) — a NAS, a Pi-hole, an earlier Tawny box. Two subnet
  // routers for the same network is unsupported: Tailscale silently flips
  // which one actually carries traffic, which is what "the internet keeps
  // looping" almost always turns out to be. Tawny declined to advertise (or,
  // if this shows up after upgrading, is still advertising from before this
  // check existed) rather than create that on its own.
  if (conflicts.length) {
    const who = conflicts.map((c) => `${c.peer} (already carries ${c.peerRoute})`).join(', ');
    // What we are putting out right now, approved or not. A PENDING
    // advertisement collides just as hard as an approved one — it is the same
    // announcement — so both have to reach the withdraw branch. Checking only
    // `approved` sent this state to the "already carried, nothing to do" reply
    // below while the route was still being advertised, and the banner said
    // "one click left" over a step that called itself finished.
    const advertising = approved.concat(pending);
    if (advertising.length) {
      return {
        state: 'bad',
        title: 'Let your devices reach the camera',
        tag: 'conflicts with another device',
        body: [
          el('p', { class: 'step-say' }, `Tawny is advertising ${advertising.join(', ')}, but ${who} already advertises an overlapping range. If your Wi-Fi has been dropping or looping since you set this up, this is almost certainly why.`),
          el('p', { class: 'step-do' }, 'Stop this device from advertising the route. The other device already covers it, so nothing that works today should stop working.'),
          routeActionButton('Stop advertising this route', 'wide', '/setup/route/withdraw'),
          goLink(LINK.subnets, 'Read Tailscale’s notes on overlapping subnets'),
          explain
        ]
      };
    }
    // The ordinary, healthy case: another device already carries the whole
    // range, approved. The path to the phone exists, Tawny correctly declined
    // to be a second router for it, and there is nothing for anyone to do.
    // This used to be presented as a decision the operator had to make, and
    // counted as unfinished for ever if they did not make it.
    if (covered.length) {
      const by = covered.map((c) => c.peer).join(', ');
      return {
        state: 'done',
        title: 'Let your devices reach the camera',
        tag: `carried by ${covered[0].peer}`,
        body: [
          el('p', { class: 'step-say' }, `${by} already routes ${covered[0].peerRoute} into your Tailscale network, and that covers ${cidr} — so your devices can already reach the camera from outside the house. Nothing to do here.`),
          el('p', { class: 'step-say' }, 'Tawny is deliberately not advertising the same range a second time. Two routers for one network is what makes a tailnet flip between them, which looks like your whole internet connection stalling.'),
          explain
        ]
      };
    }

    // The decision has already been taken: this Wi-Fi only. Tawny advertises
    // nothing in that state, so the overlap is between other people's devices
    // and there is nothing left here for this operator to decide. Asking again
    // below left the step reading "needs your decision" for ever over a question
    // they had answered, and setupReady() agreeing with it bounced every visit
    // back to /setup. Same test setupReady() now makes, so the page and the
    // redirect cannot disagree.
    if (!tailscale.routesEnabled && tailscale.routeChoice === 'lan-only') {
      return {
        state: 'done',
        title: 'Let your devices reach the camera',
        tag: 'this Wi-Fi only',
        body: [
          el('p', { class: 'step-say' }, `Remote access is off, so Tawny works from devices on this Wi-Fi. Nothing is advertised to the rest of your Tailscale network — so the overlap with ${who} is not something Tawny is taking part in.`),
          routeActionButton('Turn on remote access after all', 'wide', '/setup/route/advertise', { force: true }),
          goLink(LINK.subnets, 'Read Tailscale’s notes on overlapping subnets'),
          explain
        ]
      };
    }

    return {
      state: 'now',
      title: 'Let your devices reach the camera',
      tag: 'needs your decision',
      body: [
        el('p', { class: 'step-say' }, `Tawny did not advertise ${cidr} because ${who} already advertises part of that range — but not all of it, so some of your home network would still be unreachable. Advertising the same range twice is what makes a tailnet's routing flip back and forth, which looks like your whole internet connection going in a loop, so Tawny will not do it on its own.`),
        el('p', { class: 'step-say' }, 'If that other device is being retired, or you know it is not actually routing this range in practice, you can advertise anyway:'),
        routeActionButton('Advertise anyway', 'wide', '/setup/route/advertise', { force: true }),
        el('p', { class: 'step-say' }, 'Otherwise, leave this alone — Tawny still works over this Wi-Fi, and over the tailnet address on a single device, without it.'),
        goLink(LINK.subnets, 'Read Tailscale’s notes on overlapping subnets'),
        explain
      ]
    };
  }

  if (!pending.length && approved.length) {
    return {
      state: 'done',
      title: 'Let your devices reach the camera',
      tag: 'approved',
      body: [el('p', { class: 'step-say' }, `${approved.join(', ')} is approved.`)]
    };
  }

  // Routing is off by default — deliberately, because a container that
  // advertises a subnet the moment it starts is how a house ends up with two
  // routers for one network. But off means you cannot watch from outside,
  // which is what most people are here for. So this is asked out loud, once,
  // and the answer is remembered on the container. Not a setting to discover
  // in a .env file, and not a silent default either way.
  if (!tailscale.routesEnabled && tailscale.routeChoice === 'unset') {
    return {
      state: 'now',
      title: 'Let your devices reach the camera',
      tag: 'your choice',
      body: [
        el('p', { class: 'step-say' }, 'Do you want to watch from ', el('b', {}, 'outside the house'), ' — from work, or on mobile data? Tawny needs your permission to pass traffic through to your home network first. It is off until you say so.'),
        el('p', { class: 'step-say' }, `This is off by default on purpose: if something else on your network already does this job, switching it on here would give you two devices routing ${cidr || 'the same range'}, which makes a tailnet flip between them and looks like your internet stalling. Tawny checks for that before it does anything.`),
        routeActionButton('Turn on remote access', 'wide primary', '/setup/route/advertise'),
        el('p', { class: 'step-say' }, 'Only ever watching from home? Then you do not need it:'),
        routeActionButton('No — this Wi-Fi only', 'wide', '/setup/route/withdraw'),
        explain
      ]
    };
  }

  if (!tailscale.routesEnabled) {
    // Answered "this Wi-Fi only". Settled, and reversible from right here.
    return {
      state: 'done',
      title: 'Let your devices reach the camera',
      tag: 'this Wi-Fi only',
      body: [
        el('p', { class: 'step-say' }, 'Remote access is off, so Tawny works from devices on this Wi-Fi. Nothing is advertised to the rest of your Tailscale network.'),
        routeActionButton('Turn on remote access after all', 'wide', '/setup/route/advertise'),
        explain
      ]
    };
  }

  if (!pending.length && !approved.length) {
    return {
      state: 'bad',
      title: 'Let your devices reach the camera',
      tag: 'could not offer the route',
      body: [
        el('p', { class: 'step-say' }, 'Remote access is switched on, but Tawny is not offering a route to your home network — so you will only be able to watch from a device on this same Wi-Fi.'),
        el('p', { class: 'step-do' }, `Try switching it on again. If it keeps failing, set TS_ROUTES to your home network (for example ${data.lan.cidr || '192.168.1.0/24'}) in your .env and restart the container.`),
        routeActionButton('Try again', 'wide', '/setup/route/advertise'),
        explain
      ]
    };
  }

  return {
    state: 'now',
    title: 'Let your devices reach the camera',
    tag: 'needs you — one click',
    body: [
      el('p', { class: 'step-say' }, 'Everything is running. Tailscale just needs your permission to carry traffic to your home network — this is the one step nothing can do for you.'),
      el('div', { class: 'step-do' }, 'On the page below:',
        el('ol', {},
          el('li', {}, `Find the machine called ${tailscale.dnsName ? tailscale.dnsName.split('.')[0] : 'tawny'} in the list.`),
          el('li', {}, 'Open its ⋯ menu and choose Edit route settings.'),
          el('li', {}, `Tick ${cidr} and save.`),
          el('li', {}, 'While you are in that ⋯ menu: also choose Disable key expiry. Tawny runs unattended — without this, Tailscale logs it out roughly every 180 days and remote access quietly stops until someone notices and pastes a fresh key.'))),
      goLink(LINK.machines, 'Open Tailscale machines'),
      copyRow(cidr),
      explain
    ]
  };
}

const DEVICES_ACK = 'tawny.devicesAck';

function devicesAcked() {
  try { return localStorage.getItem(DEVICES_ACK) === '1'; } catch { return false; }
}

function stepDevices(data) {
  const { tailscale } = data;
  // A route carried by somebody else counts. renderVerdict() and setupReady()
  // both already treat "a peer routes this range" as the path existing — only
  // this step insisted on a route of Tawny's own, so the common healthy
  // deployment (a NAS already routing the LAN, Tawny correctly declining to be
  // a second router) sat here reading "after the steps above" for ever, with
  // the banner above it saying everything was ready.
  const ready = tailscale.loggedIn && !(tailscale.pendingRoutes || []).length
    && ((tailscale.approvedRoutes || []).length || (tailscale.routeCoveredBy || []).length);

  // "This Wi-Fi only" advertises no route by design, so the test above can
  // never pass there — and nothing on this step applies: subnet routes are
  // exactly what that answer turned down. Settled the same way step 3 settles
  // it, so this cannot sit on "after the steps above" under a "ready" banner.
  const carried = (tailscale.approvedRoutes || []).length || (tailscale.routeCoveredBy || []).length;
  if (tailscale.loggedIn && !carried && !tailscale.routesEnabled
      && tailscale.routeChoice && tailscale.routeChoice !== 'unset') {
    return { state: 'done', title: 'Put your devices on the network', tag: 'this Wi-Fi only' };
  }

  const peers = (tailscale.peers || []).filter((p) => p.name);
  const peerBox = peers.length
    ? el('div', { class: 'peers' }, ...peers.map((p) =>
        el('span', { class: `peer${p.online ? '' : ' off'}` },
          el('span', { class: `dot${p.online ? ' on' : ''}` }), p.name)))
    : null;

  // Nothing in this container can see whether a peer accepts routes, so this
  // step cannot verify itself. Left as an open action it would sit here for
  // ever, telling people to do something they have already done — so it is
  // theirs to close.
  if (devicesAcked()) {
    return { state: 'done', title: 'Put your devices on the network', tag: 'you confirmed this' };
  }
  if (!ready) {
    return { state: 'todo', title: 'Put your devices on the network', tag: 'after the steps above' };
  }

  const ack = el('button', { class: 'wide', type: 'button', id: 'devices-ack' },
    'Done — my devices are set up');

  return {
    state: 'now',
    title: 'Put your devices on the network',
    tag: 'needs you',
    body: [
      el('p', { class: 'step-say' }, 'Two devices need Tailscale installed and signed in to the same account: the phone that watches the pet, and whatever you want to watch from.'),
      el('div', { class: 'step-do' }, 'On the device you will watch from, after installing Tailscale:',
        el('ol', {},
          el('li', {}, 'iPhone or Android: open the Tailscale app and turn on "Use Tailscale subnets".'),
          el('li', {}, 'Mac or Windows: nothing to do, it is on by default.'),
          el('li', {}, 'Linux: run sudo tailscale up --accept-routes.'))),
      goLink(LINK.download, 'Install Tailscale'),
      peerBox ? el('p', { class: 'step-say' }, 'Signed in to your network right now:') : null,
      peerBox,
      el('p', { class: 'step-say' }, 'Tawny cannot check this one from inside the container — the list above shows which of your devices are on the network, not whether they accept routes. If you have already done it, close this step off:'),
      ack
    ]
  };
}

function stepWatch(data) {
  const { tailscale } = data;
  const ready = tailscale.loggedIn && tailscale.reachable && tailscale.dnsName
    && !(tailscale.pendingRoutes || []).length
    && serveState(tailscale) !== false
    && !latestSteps(data.startup).some((s) => s.ok === false);

  if (!ready) {
    return { state: 'todo', title: 'Start watching', tag: 'once the steps above are done' };
  }

  // The address is NOT repeated here. renderVerdict() puts it at the top of
  // the page the moment the setup is finished, and two identical full-width
  // "Open Tawny" buttons a screen apart is the clutter this layout is supposed
  // to prevent — the eye has to decide which one is the real one.
  return {
    state: 'now',
    title: 'Start watching',
    tag: 'you’re ready',
    body: [
      el('p', { class: 'step-say' },
        'Open the address at the top of this page on your laptop or phone — anywhere with Tailscale signed in. ',
        el('b', {}, 'Always that https:// one'), ', never the plain address with a port number. A browser only starts a session on a secure address — on the plain one the page loads and then refuses, because both watching and talking back need the microphone.'),

      el('div', { class: 'step-do' }, 'To start a session:',
        el('ol', {},
          el('li', {}, 'On the old phone you are leaving with the pet: open Tawny, choose The Monitor, and let it use the camera. It shows a QR code.'),
          el('li', {}, 'On the device you are watching from: open the address, choose Viewer, and press Scan.'),
          el('li', {}, 'Point it at the phone’s QR code. That is the pairing done — video, sound, and hold-to-talk back. A code lasts ten minutes; after that the phone shows a fresh one.'))),

      why('It does not open, or it stops working later',
        'The first time, give it a minute: Tailscale fetches a certificate for the name on the first request, and until it lands the page can fail or warn. The device you open it on needs Tailscale signed in to the same account with MagicDNS on — if the name resolves nowhere, MagicDNS is probably off for the whole account (login.tailscale.com/admin/dns).',
        'Before you walk away: give the camera phone a fixed address in your router settings (a DHCP reservation). Its address is baked into each pairing code, so if the router hands it a different one later the code stops working. And leave the phone plugged in — a screen-off phone keeps streaming, a flat one does not.')
    ]
  };
}

/* --------------------------------------------------------- harder privacy */
//
// The panel under the steps, and — once it is running — the steps themselves.
//
// Everything above this assumes one topology: Tailscale, `tailscale serve`,
// public STUN. This is the way out of every one of those for somebody who wants
// their own infrastructure end to end. The server keeps the settings in the data
// volume (docker/privacy.js); this panel edits them. The first time the mode is
// switched on it asks for an explicit acknowledgement, and the server refuses
// to save without one.

const priv = {
  form: null,         // working copy of the settings, edited in place
  dirty: false,       // unsaved edits — the poll must not rebuild over them
  ack: false,         // the risk acknowledgement, first enable only
  errors: {},         // field -> message, from the last save attempt
  warnings: null,     // from the last save, else the server's for what is saved
  busy: false,
  msg: '', msgKind: '',
  restarting: false
};

function privFormFrom(p) {
  const base = p.saved || p.startingPoint || {};
  return JSON.parse(JSON.stringify({ ...base, turnSecret: '' }));
}

/** A labelled text input bound to priv.form[key]. List fields are one per line. */
function privText(key, label, { placeholder = '', help = '', list = false, type = 'text' } = {}) {
  const id = `priv-${key}`;
  const val = priv.form[key];
  const input = list
    ? el('textarea', { id, class: 'join-input priv-input', rows: '3', placeholder, spellcheck: 'false' })
    : el('input', { id, class: 'join-input priv-input', type, placeholder,
      autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  input.value = list ? (val || []).join('\n') : (val == null ? '' : String(val));
  input.addEventListener('input', () => {
    priv.form[key] = list ? input.value.split(/[\s,]+/).filter(Boolean) : input.value;
    priv.dirty = true;
    delete priv.errors[key];
    input.classList.remove('is-bad');
    const e = document.getElementById(`${id}-err`);
    if (e) e.hidden = true;
  });
  if (priv.errors[key]) input.classList.add('is-bad');
  return el('div', { class: 'priv-field' },
    el('label', { class: 'join-label', for: id }, label),
    input,
    help ? el('p', { class: 'priv-help' }, help) : null,
    el('p', Object.assign({ id: `${id}-err`, class: 'join-msg is-bad' }, priv.errors[key] ? {} : { hidden: 'hidden' }),
      priv.errors[key] || ''));
}

/** A checkbox bound to priv.form[key]. */
function privCheck(key, label, help) {
  const id = `priv-${key}`;
  const box = el('input', { id, type: 'checkbox' });
  box.checked = !!priv.form[key];
  box.addEventListener('change', () => { priv.form[key] = box.checked; priv.dirty = true; renderPrivacy(lastData, true); });
  return el('div', { class: 'priv-field' },
    el('label', { class: 'priv-check', for: id }, box, el('span', {}, label)),
    help ? el('p', { class: 'priv-help' }, help) : null,
    priv.errors[key] ? el('p', { class: 'join-msg is-bad' }, priv.errors[key]) : null);
}

/** Radio choices bound to priv.form[key]. */
function privChoice(key, label, options) {
  const wrap = el('fieldset', { class: 'priv-choice' }, el('legend', { class: 'join-label' }, label));
  for (const o of options) {
    const id = `priv-${key}-${o.v}`;
    const r = el('input', { id, type: 'radio', name: `priv-${key}`, value: o.v });
    r.checked = priv.form[key] === o.v;
    r.addEventListener('change', () => { priv.form[key] = o.v; priv.dirty = true; delete priv.errors[key]; renderPrivacy(lastData, true); });
    wrap.append(el('label', { class: 'priv-radio', for: id }, r,
      el('span', {}, el('b', {}, o.label), o.desc ? el('small', {}, o.desc) : null)));
  }
  if (priv.errors[key]) wrap.append(el('p', { class: 'join-msg is-bad' }, priv.errors[key]));
  return wrap;
}

function privSection(title, ...kids) {
  return el('div', { class: 'priv-section' }, el('h3', {}, title), ...kids.filter(Boolean));
}

async function privSave(andRestart) {
  if (priv.busy) return;
  priv.busy = true;
  priv.msg = 'Saving…'; priv.msgKind = '';
  renderPrivacy(lastData, true);
  try {
    const res = await fetch('/setup/privacy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ config: priv.form, acknowledge: priv.ack })
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) {
      priv.errors = out.errors || {};
      priv.warnings = out.warnings || priv.warnings;
      priv.msg = out.error || `Could not save (${res.status}).`;
      priv.msgKind = 'is-bad';
      priv.busy = false;
      renderPrivacy(lastData, true);
      return;
    }
    priv.errors = {};
    priv.warnings = out.warnings || [];
    priv.dirty = false;
    priv.form.turnSecret = '';
    if (andRestart) {
      priv.busy = false;
      return privRestart();
    }
    priv.msg = 'Saved. Nothing changes until the container restarts — press “Restart and apply” when you are ready.';
    priv.msgKind = 'is-ok';
  } catch {
    priv.msg = 'Could not reach the container.';
    priv.msgKind = 'is-bad';
  }
  priv.busy = false;
  await tick();
}

async function privRestart() {
  priv.busy = true;
  priv.msg = 'Restarting with your settings…'; priv.msgKind = '';
  renderPrivacy(lastData, true);
  try {
    const res = await fetch('/setup/privacy/restart', { method: 'POST' });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || String(res.status));
    priv.restarting = true;
    const lan = lastData && lastData.lan && lastData.lan.ip;
    priv.msg = 'Restarting. This page reconnects on its own in a few seconds.' +
      (lan ? ` If this address stops answering (for example you turned off Tailscale or its HTTPS), open http://${lan}:${location.port || 8099}/setup on your home network.` : '');
    priv.msgKind = 'is-ok';
  } catch (e) {
    priv.msg = `Could not restart: ${e.message}. Restart the container yourself (docker compose restart) to apply.`;
    priv.msgKind = 'is-bad';
  }
  priv.busy = false;
  priv.form = null;           // re-read from the server once it is back
  renderPrivacy(lastData, true);
}

/**
 * Build (or rebuild) the panel. `force` rebuilds even with unsaved edits —
 * used by the panel's own controls, which keep priv.form as the truth. The
 * poll passes false, so it never wipes what someone is typing.
 */
function renderPrivacy(data, force) {
  const host = document.getElementById('privacy');
  if (!host || !data || !data.privacy) return;
  const p = data.privacy;
  if (!force && (priv.dirty || priv.busy || host.contains(document.activeElement))) return;
  if (!priv.form || (!priv.dirty && !force)) priv.form = privFormFrom(p);
  // Back from a restart: the running settings are the saved ones again.
  if (priv.restarting && !p.pendingRestart) { priv.restarting = false; priv.msg = ''; }

  const f = priv.form;
  const firstEnable = f.enabled && !p.savedEnabled;
  host.className = `privacy${f.enabled ? ' is-on' : ''}`;
  host.textContent = '';

  const sw = el('button', {
    class: 'priv-switch', type: 'button', role: 'switch',
    'aria-checked': f.enabled ? 'true' : 'false', 'aria-labelledby': 'priv-title'
  }, el('i', {}));
  sw.addEventListener('click', () => {
    f.enabled = !f.enabled;
    priv.dirty = true;
    if (!f.enabled) priv.ack = false;
    priv.msg = '';
    renderPrivacy(lastData, true);
  });

  host.append(el('div', { class: 'priv-head' },
    el('div', {},
      el('h2', { id: 'priv-title' }, 'For harder privacy ', el('span', { class: 'priv-tag' }, '[advanced]')),
      el('p', { class: 'priv-sub' }, 'Your own infrastructure, every connection chosen by you, and no fallbacks.')),
    sw));

  // What is running, as opposed to what the switch is showing.
  const running = p.active
    ? (p.broken ? 'Running now: harder privacy, but the saved settings could not be used — everything networked is OFF until you fix and save them.'
      : 'Running now: harder privacy. Only the settings below are in use.')
    : 'Running now: the normal setup (Tailscale, with safety nets).';
  host.append(el('p', { class: `priv-running${p.active ? ' is-on' : ''}${p.broken ? ' is-bad' : ''}` }, running));

  if (p.pendingRestart && !priv.dirty) {
    const btn = el('button', { class: 'wide primary', type: 'button' }, 'Restart and apply');
    btn.disabled = priv.busy || priv.restarting || !p.canRestart;
    btn.addEventListener('click', () => privRestart());
    host.append(el('div', { class: 'priv-pending' },
      el('p', {}, el('b', {}, 'Saved, not applied yet. '),
        p.canRestart ? 'The container restarts in place, which takes a few seconds, and live calls drop.'
          : 'Restart the container to apply (docker compose restart).'),
      p.canRestart ? btn : null));
  }

  if (!f.enabled) {
    host.append(el('p', { class: 'step-say' },
      'Off: Tawny works the normal way. It uses Tailscale for the address and remote access, public STUN from Google and Cloudflare, and the fallbacks that keep a session alive when something is misconfigured. Turn this on to replace all of it with your own infrastructure: your own certificate, a Headscale server or no Tailscale at all, your own STUN and TURN, or none.'));
    if (p.savedEnabled || p.active) {
      host.append(el('p', { class: 'step-say' },
        el('b', {}, 'Turning it off '), 'goes back to the normal setup after a restart. Your settings are kept, so turning it on again starts where you left off.'));
    }
  }

  if (f.enabled && firstEnable) {
    const ack = el('input', { id: 'priv-ack', type: 'checkbox' });
    ack.checked = priv.ack;
    ack.addEventListener('change', () => { priv.ack = ack.checked; renderPrivacy(lastData, true); });
    host.append(el('div', { class: 'priv-risk' },
      el('h3', {}, 'Read this first'),
      el('ul', {},
        el('li', {}, el('b', {}, 'No fallbacks. '), 'If a setting here is wrong, or a server of yours is down, the part it covers does not work. Tawny will not switch to Tailscale, public STUN or its own relay to rescue it.'),
        el('li', {}, el('b', {}, 'Blank means none. '), 'Blank STUN is no STUN. No TURN means no relay. No Tailscale means nothing here gets a viewer outside your house into this network. That becomes your VPN, WireGuard, port forward or other tool, and Tawny cannot check it.'),
        el('li', {}, el('b', {}, 'Browsers need HTTPS. '), 'Camera and microphone only work on a secure page. With no certificate, or one a device does not trust, browsers will not start a session on it.'),
        el('li', {}, el('b', {}, 'The Android app trusts public CAs only. '), 'A certificate from your own CA works in browsers once you install that CA, but the app will refuse it. Its own Servers screen has the same harder-privacy switch for the phone side.'),
        el('li', {}, el('b', {}, 'You can lock yourself out of this page’s https address. '), `http://${data.lan.ip || '<this machine>'}:${location.port || 8099}/setup on your home network always stays open to undo it.`),
        el('li', {}, el('b', {}, 'Your video stays end-to-end encrypted either way. '), 'This changes who you depend on to connect, not whether anyone can watch.')),
      el('label', { class: 'priv-check priv-ack', for: 'priv-ack' }, ack,
        el('span', {}, 'I understand there are no fallbacks, and that a setup that is wrong will not work at all.'))));
  }

  if (f.enabled) {
    host.append(
      privSection('Network — how viewers reach this house',
        privChoice('tailscale', 'Tailscale', [
          { v: 'own', label: 'Tawny’s own node', desc: 'This container joins a tailnet by itself (auth key in /setup or TS_AUTHKEY).' },
          { v: 'host', label: 'This machine’s Tailscale', desc: 'Use the tailscaled already on the host (its socket must be mounted). Never swaps to a node of its own.' },
          { v: 'off', label: 'No Tailscale', desc: 'Not started at all. Remote access is your VPN, WireGuard, port forward or other tool.' }
        ]),
        f.tailscale !== 'off' ? privText('loginServer', 'Control server (Headscale)', {
          placeholder: 'https://headscale.example.net — blank = Tailscale’s',
          help: 'Your own coordination server instead of Tailscale’s. Tawny keeps a separate identity and saved key for each control server, so switching never mixes them or sends one server’s key to another. Join with a pre-auth key from your server.'
        }) : null,
        f.tailscale !== 'off' ? privCheck('tsLogs', 'Send tailscaled’s diagnostic logs to Tailscale',
          'Off (recommended here) runs tailscaled with --no-logs-no-support.') : null),

      privSection('HTTPS — the address browsers open',
        privChoice('tls', 'Who provides the certificate', [
          { v: 'tailscale', label: 'Tailscale (tailscale serve)', desc: 'A ts.net Let’s Encrypt certificate. Needs Tailscale on, with MagicDNS and HTTPS certificates.' },
          { v: 'files', label: 'My own certificate', desc: 'Tawny serves HTTPS itself with your certificate and key files. It reloads them when they change.' },
          { v: 'proxy', label: 'My own reverse proxy', desc: 'Caddy, nginx, Traefik and so on terminate TLS in front of port ' + (location.port || 8099) + '.' },
          { v: 'none', label: 'None', desc: 'Plain http only. Browsers will not start a session. Only the Android app on this Wi-Fi works.' }
        ]),
        f.tls === 'files' ? privText('tlsCert', 'Certificate (full chain, PEM)', { placeholder: '/data/tls/fullchain.pem',
          help: 'A path inside the container. The data volume is mounted at /data, or mount your own directory read-only.' }) : null,
        f.tls === 'files' ? privText('tlsKey', 'Private key (PEM)', { placeholder: '/data/tls/privkey.pem' }) : null,
        f.tls === 'files' ? privText('httpsPort', 'HTTPS port', { placeholder: '8443', type: 'number' }) : null,
        f.tls === 'files' && p.tls ? privTlsSummary(p.tls) : null,
        f.tls === 'proxy' ? privCheck('trustProxy', 'Trust X-Forwarded-* from private addresses',
          'Needed so the page learns its real https:// address from your proxy. Turn off if untrusted hosts can reach port ' + (location.port || 8099) + ' directly.') : null),

      privSection('Signalling — how the two ends find each other',
        privText('rendezvous', 'Rendezvous for browsers', { placeholder: 'wss://relay.example.net — blank = this server',
          help: 'Blank: browsers signal through this container, which already is a relay. Set it only if you run the relay somewhere else.' }),
        privCheck('lanBridge', 'LAN bridge to an Android Monitor',
          'Lets a browser Viewer reach the app’s own Wi-Fi relay through this server. Off: this server never opens a connection to anything on your network.'),
        privText('allowedHosts', 'Hostnames this server answers to', { list: true, placeholder: 'tawny.example.net\n192.168.1.10',
          help: 'One per line. Blank keeps what the container was started with (ALLOWED_HOSTS).' })),

      privSection('STUN — finding a public address',
        privText('stun', 'STUN servers', { list: true, placeholder: 'stun:stun.example.net:3478',
          help: 'One per line. Blank = none at all, not Google’s or Cloudflare’s. The built-in coturn answers STUN too: stun:<your public host>:3478.' })),

      privSection('TURN — relaying when nothing direct works',
        privChoice('turnMode', 'Use a relay', [
          { v: 'auto', label: 'When needed', desc: 'Direct first. The relay only carries a call that cannot connect otherwise.' },
          { v: 'always', label: 'Always', desc: 'Every call goes through the relay, so the two ends never learn each other’s IP address.' },
          { v: 'never', label: 'Never', desc: 'No relay handed out at all. Strict networks will not connect.' }
        ]),
        f.turnMode !== 'never' ? privCheck('turnEmbedded', 'Built-in relay (coturn in this container)') : null,
        f.turnMode !== 'never' && f.turnEmbedded ? el('div', { class: 'priv-row' },
          privText('turnPort', 'Port', { type: 'number', placeholder: '3478' }),
          privText('turnMinPort', 'Relay ports from', { type: 'number', placeholder: '49160' }),
          privText('turnMaxPort', 'to', { type: 'number', placeholder: '49200' })) : null,
        f.turnMode !== 'never' && f.turnEmbedded ? privText('publicIp', 'Public IP (behind a port forward)', { placeholder: 'blank = this network’s address' }) : null,
        f.turnMode !== 'never' && f.turnEmbedded && f.tls === 'files' ? privCheck('turnTls', 'Also relay over TLS (turns:) with my certificate') : null,
        f.turnMode !== 'never' && f.turnEmbedded && f.turnTls ? privText('turnTlsPort', 'TURN TLS port', { type: 'number', placeholder: '5349' }) : null,
        f.turnMode !== 'never' ? privText('turnUrls', 'Or your own TURN servers', { list: true, placeholder: 'turns:turn.example.net:5349',
          help: 'One per line. When set, these replace the built-in relay.' }) : null,
        f.turnMode !== 'never' && (f.turnUrls || []).length ? privText('turnSecret', 'Their static-auth-secret', {
          type: 'password',
          placeholder: (p.saved && p.saved.turnSecretSet) ? 'saved — leave blank to keep it' : 'coturn use-auth-secret secret' }) : null)
    );
  }

  // Consequences of what is saved, or of the last attempt to save.
  const warns = priv.warnings || (f.enabled ? p.warnings : []) || [];
  if (f.enabled && warns.length) {
    host.append(el('div', { class: 'priv-warn' },
      el('h3', {}, 'What these choices give up'),
      el('ul', {}, ...warns.map((w) => el('li', {}, w)))));
  }

  const changed = priv.dirty || (f.enabled !== !!p.savedEnabled);
  if (f.enabled || p.savedEnabled || p.active) {
    const save = el('button', { class: 'wide primary', type: 'button' },
      f.enabled ? 'Save and restart' : 'Turn off and restart');
    save.disabled = priv.busy || (firstEnable && !priv.ack) || (!changed && !p.pendingRestart && !priv.dirty);
    save.addEventListener('click', () => privSave(true));
    const saveOnly = el('button', { class: 'wide', type: 'button' }, 'Save only');
    saveOnly.disabled = priv.busy || (firstEnable && !priv.ack) || !changed;
    saveOnly.addEventListener('click', () => privSave(false));
    host.append(el('div', { class: 'priv-actions' }, save, saveOnly));
  }
  if (priv.msg) host.append(el('p', { class: `join-msg ${priv.msgKind}` }, priv.msg));
  host.append(el('p', { class: 'priv-help' }, `Stored in ${p.file} in the data volume. When it is on, these settings override the compose file’s environment.`));
}

function privTlsSummary(t) {
  if (t.error && !t.names) return el('p', { class: 'join-msg is-bad' }, t.error);
  const rows = [
    ['Covers', (t.names || []).join(', ') || t.subject],
    ['Expires', `${(t.notAfter || '').slice(0, 10)} (${t.daysLeft} days)`],
    ['Key', t.keyMatches ? 'matches' : 'does NOT match'],
    ['Trusted by', t.publicTrust ? 'every browser and the Android app (public CA)'
      : t.selfSigned ? 'nothing until you install it on each device (self-signed). The Android app will refuse it.'
      : 'only devices that have your CA installed. The Android app will refuse it.']
  ];
  return el('div', { class: `priv-cert${t.ok ? '' : ' is-bad'}` },
    ...rows.map(([k, v]) => el('p', {}, el('b', {}, k + ': '), v)),
    t.error ? el('p', { class: 'join-msg is-bad' }, t.error) : null);
}

/* The steps, when harder privacy is what is running. */

function privAddress(data) {
  const p = data.privacy || {};
  const a = p.applied || {};
  if (a.tls === 'files') {
    const name = ((p.tls && p.tls.names) || []).find((n) => !n.startsWith('*')) || data.lan.ip;
    return name ? `https://${name}${a.httpsPort === 443 ? '' : ':' + a.httpsPort}/` : '';
  }
  if (a.tls === 'tailscale' && data.tailscale.dnsName && serveState(data.tailscale) !== false) {
    return `https://${data.tailscale.dnsName}/`;
  }
  return '';
}

function privStepNetwork(data) {
  const a = data.privacy.applied || {};
  const ts = data.tailscale;
  if (a.tailscale === 'off') {
    return {
      state: 'done', title: 'Your network', tag: 'no Tailscale — your choice',
      body: [
        el('p', { class: 'step-say' }, 'Tailscale is not running. On this Wi-Fi, devices reach each other directly. For watching from outside the house, a viewer needs a way into this network that you provide: a VPN such as WireGuard or OpenVPN, a port forward to this machine, or any other tool.'),
        why('What has to be reachable?',
          `The page: the HTTPS address in the next step. The camera phone: for video to flow, the viewer has to reach the Monitor phone’s address (for example ${data.lan.ip || '192.168.1.x'}) directly, which a VPN into this network gives you, or reach a TURN relay both ends can use. Tawny cannot see or check your network from here.`)
      ]
    };
  }
  if (!a.loginServer) return ts.loggedIn ? stepRoute(data) : stepConnect(data);
  // Headscale: the same mechanism, none of Tailscale's admin-console wording.
  if (!ts.loggedIn) {
    return {
      state: 'now', title: 'Join your control server', tag: a.loginServer,
      body: [
        el('p', { class: 'step-say' }, `Tawny’s node signs in to ${a.loginServer} rather than Tailscale’s. Create a reusable pre-auth key on your server and paste it here.`),
        el('div', { class: 'step-do' }, el('code', {}, 'headscale preauthkeys create --user <you> --reusable')),
        joinForm()
      ]
    };
  }
  const pending = ts.pendingRoutes || [];
  if (pending.length) {
    return {
      state: 'now', title: 'Approve the route', tag: pending.join(', '),
      body: [
        el('p', { class: 'step-say' }, `Signed in to ${a.loginServer}. The route to your home network is waiting for approval on your control server.`),
        el('div', { class: 'step-do' }, el('code', {}, `headscale nodes approve-routes --identifier <tawny's id> --routes ${pending.join(',')}`))
      ]
    };
  }
  return {
    state: 'done', title: 'Your control server', tag: `signed in to ${a.loginServer}`,
    body: [el('p', { class: 'step-say' }, `On your own tailnet as ${ts.dnsName || 'this node'}. Routes: ${(ts.approvedRoutes || []).join(', ') || 'none advertised'}.`)]
  };
}

function privStepHttps(data) {
  const p = data.privacy;
  const a = p.applied || {};
  if (a.tls === 'files') {
    const t = p.tls || {};
    const listening = p.https && p.https.listening;
    const ok = t.ok && listening;
    const url = privAddress(data);
    return {
      state: ok ? 'done' : 'bad', title: 'HTTPS — your certificate',
      tag: ok ? `serving on :${a.httpsPort}` : 'needs fixing',
      body: [
        privTlsSummary(t),
        !listening ? el('p', { class: 'join-msg is-bad' }, (p.https && p.https.error) || `Not listening on :${a.httpsPort} yet.`) : null,
        ok && url ? copyRow(url) : null,
        why('Renewals, and where the files go',
          'Put the files in the data volume (for example /data/tls/) or mount a directory read-only, and give the paths above. When your ACME client replaces them, Tawny picks up the new certificate within a minute with no restart.',
          'Both ends need to trust the certificate. A public CA (Let’s Encrypt through DNS-01 works for a name that only resolves inside your network) is trusted everywhere. Your own CA must be installed on every browser device, and the Android app will not accept it.')
      ]
    };
  }
  if (a.tls === 'tailscale') {
    const sv = serveState(data.tailscale);
    return {
      state: data.tailscale.loggedIn && sv !== false && data.tailscale.dnsName ? 'done' : 'todo',
      title: 'HTTPS — tailscale serve', tag: data.tailscale.dnsName || 'after the network step',
      body: [el('p', { class: 'step-say' }, 'Your node’s ts.net name with a Let’s Encrypt certificate, provided by tailscale serve.')]
    };
  }
  if (a.tls === 'proxy') {
    return {
      state: 'done', title: 'HTTPS — your reverse proxy', tag: 'not visible from here',
      body: [
        el('p', { class: 'step-say' }, `Point your proxy at http://${data.lan.ip || '<this machine>'}:${location.port || 8099}. Tawny cannot see it, so it cannot tell you whether it works. It needs to:`),
        el('div', { class: 'step-do' }, el('ol', {},
          el('li', {}, 'terminate TLS with a certificate your devices trust;'),
          el('li', {}, 'pass WebSocket upgrades through (the app signals over /ws, and /lan/… for the LAN bridge);'),
          el('li', {}, 'set X-Forwarded-Proto and X-Forwarded-Host.'))),
        why('Caddy example', `tawny.example.net {\n  reverse_proxy ${data.lan.ip || '192.168.1.10'}:${location.port || 8099}\n}`)
      ]
    };
  }
  return {
    state: 'done', title: 'HTTPS', tag: 'none — your choice',
    body: [el('p', { class: 'step-say' }, 'No HTTPS. A browser will load the page but refuse to start a session, because camera and microphone need a secure address. The Android app on this Wi-Fi is unaffected.')]
  };
}

function privStepRelays(data) {
  const p = data.privacy;
  const a = p.applied || {};
  const bad = latestSteps(data.startup).filter((s) => s.ok === false && /^coturn/.test(s.step));
  const turn = a.turnMode === 'never' ? 'never'
    : [...(a.turnUrls || []), ...(a.turnEmbedded ? [`built-in coturn :${data.coturn.port || 3478}${a.turnTlsPort ? ` + TLS :${a.turnTlsPort}` : ''}`] : [])]
      .join(', ') || 'none configured';
  const lines = [
    ['STUN', (a.stun || []).join(', ') || 'none'],
    ['TURN', `${turn}${a.turnMode === 'always' ? ' — every call relayed' : ''}`],
    ['Rendezvous', a.rendezvous || 'this server'],
    ['LAN bridge', a.lanBridge ? 'on' : 'off'],
    ['Tailscale logs', a.tailscale === 'off' ? '—' : a.tsLogs ? 'sent to Tailscale' : 'off']
  ];
  return {
    state: bad.length ? 'bad' : 'done', title: 'Connections', tag: bad.length ? 'relay failed to start' : 'exactly what you chose',
    body: [
      el('div', { class: 'priv-cert' }, ...lines.map(([k, v]) => el('p', {}, el('b', {}, k + ': '), v))),
      ...bad.map((s) => el('p', { class: 'join-msg is-bad' }, s.detail)),
      (p.warnings || []).length ? why('What these choices give up', ...p.warnings) : null
    ]
  };
}

function privStepWatch(data, ready) {
  const url = privAddress(data);
  if (!ready) return { state: 'todo', title: 'Start watching', tag: 'once the steps above are done' };
  return {
    state: 'now', title: 'Start watching', tag: 'you’re ready',
    body: [
      el('p', { class: 'step-say' }, url
        ? 'Open the address at the top of this page on the device you watch from.'
        : 'Open this server through the https address your proxy or network provides.'),
      el('div', { class: 'step-do' }, el('ol', {},
        el('li', {}, 'On the camera phone: open Tawny, choose The Monitor. With the app’s own harder privacy on, give it the same rendezvous, STUN and TURN as here.'),
        el('li', {}, 'On the viewing device: open the address, choose Viewer, and scan the phone’s code.')))
    ]
  };
}

function privacyDefs(data) {
  const defs = [stepMachine(data), privStepNetwork(data), privStepHttps(data), privStepRelays(data)];
  const ready = !data.privacy.broken && defs.every((d) => d.state === 'done');
  defs.push(privStepWatch(data, ready));
  if (data.privacy.broken) {
    defs.unshift({
      state: 'bad', title: 'Harder privacy settings', tag: 'could not be used',
      body: [el('p', { class: 'step-say' }, 'The saved settings could not be read or have errors, so everything networked is off: no Tailscale, no relay, no STUN. Nothing fell back to the normal setup. Fix them in the panel below and restart.'),
        ...latestSteps(data.startup).filter((s) => s.step === 'privacy' && !s.ok).map((s) => el('p', { class: 'join-msg is-bad' }, s.detail))]
    });
  }
  return defs;
}

function renderPrivacyVerdict(data, defs) {
  const box = document.getElementById('verdict');
  const icon = document.getElementById('verdict-icon');
  const title = document.getElementById('verdict-title');
  const say = document.getElementById('verdict-say');
  const extra = document.getElementById('verdict-extra');
  extra.textContent = '';
  const set = (cls, ico, h, t) => {
    box.className = `verdict is-${cls}`;
    icon.innerHTML = `<svg viewBox="0 0 24 24">${ico}</svg>`;
    title.textContent = h;
    say.textContent = t;
  };
  const failed = defs.some((d) => d.state === 'bad');
  const waiting = defs.slice(0, -1).some((d) => d.state === 'now' || d.state === 'todo');
  if (!failed && !waiting) {
    finishUrl = privAddress(data);
    setupComplete = !!finishUrl;
    set('ok', ICONS.tick, 'Ready, on your own infrastructure',
      'Harder privacy is on. Everything you chose is running, with no fallbacks. Whether a viewer outside can reach this network is up to your own setup.');
    if (finishUrl) extra.append(openLink(finishUrl));
    return;
  }
  setupComplete = false;
  if (failed) {
    set('bad', ICONS.cross, 'Something you chose is not working',
      'Harder privacy is on, so nothing takes over for it. The step marked below says what failed.');
    return;
  }
  set('warn', ICONS.bang, 'Harder privacy is on — not finished yet',
    'Follow the open step below. Everything else is exactly what you chose.');
}

/* ---------------------------------------------------------------- verdict */

function renderVerdict(data, defs) {
  const icon = document.getElementById('verdict-icon');
  const box = document.getElementById('verdict');
  const title = document.getElementById('verdict-title');
  const say = document.getElementById('verdict-say');
  const extra = document.getElementById('verdict-extra');
  extra.textContent = '';

  const { tailscale, lan } = data;
  // Read the failure off the steps actually on screen, not off the log. The
  // banner disagreeing with the list below it is worse than either being
  // wrong on its own.
  const failed = defs.some((d) => d.state === 'bad');
  const pending = (tailscale.pendingRoutes || []).length > 0;
  const badLan = !lan.cidr || lan.looksLikeDockerBridge;
  // Must agree with setupReady() in server.js — that one decides the redirect
  // from "/", this one decides the banner, and a banner saying "ready" over a
  // page that keeps bouncing you back to setup is worse than either being
  // wrong alone.
  const carried = (tailscale.approvedRoutes || []).length ||
    (tailscale.routeCoveredBy || []).length;
  const undecided = !carried && tailscale.routeChoice === 'unset';
  const allGood = tailscale.loggedIn && tailscale.reachable && !failed && !pending
    && !badLan && !undecided && !!tailscale.dnsName
    // dnsName exists as soon as MagicDNS is on; the address only *works* once
    // `tailscale serve` is up. Never celebrate before that.
    && serveState(tailscale) !== false;

  const set = (cls, ico, h, p) => {
    box.className = `verdict is-${cls}`;
    icon.innerHTML = `<svg viewBox="0 0 24 24">${ico}</svg>`;
    title.textContent = h;
    say.textContent = p;
  };

  if (allGood) {
    finishUrl = `https://${tailscale.dnsName}/`;
    setupComplete = true;
    box.classList.add('is-finish');
    if (openedApp) {
      // They clicked through. Nothing left to do on this page.
      set('ok', ICONS.tick, 'You’re all set 🎉',
        'Tawny opened in a new tab. You can close this one — or press the back arrow (top-left) to open Tawny here instead.');
      extra.append(openLink(finishUrl));
    } else {
      set('ok', ICONS.tick, 'Tawny is ready',
        'Everything is connected. Open this on whatever you want to watch from — step 5 walks through pairing the camera phone.');
      extra.append(openLink(finishUrl));
      maybeCelebrate();
    }
    return;
  }
  setupComplete = false;
  sawIncomplete = true;
  if (failed || badLan) {
    set('bad', ICONS.cross, 'Something needs fixing',
      'One of the steps below did not work. Each one says what to do about it.');
    return;
  }
  if (pending) {
    set('warn', ICONS.bang, 'One click left',
      'Everything is running. Tailscale needs you to approve one thing before you can watch from outside the house.');
    return;
  }
  if (undecided) {
    set('warn', ICONS.bang, 'One choice left',
      'Everything is running, and it works on this Wi-Fi now. Step 3 asks the one question Tawny will not answer for you: whether to open a path for watching from outside the house.');
    return;
  }
  if (!tailscale.loggedIn) {
    set('warn', ICONS.bang, 'Start here',
      tailscale.configured
        ? 'Tawny is installed and running. It needs to join your Tailscale network before you can watch from anywhere — step 2 below.'
        : 'Tawny is running on this Wi-Fi. Step 2 below connects it to your Tailscale network so you can watch from anywhere.');
    return;
  }
  set('warn', ICONS.bang, 'Not finished yet',
    'Tawny is running on this Wi-Fi. Follow the steps below to watch from anywhere.');
}

/** A bar per step, and "Step 3 of 5" — so the page says where you are. */
function renderProgress(defs) {
  const track = document.getElementById('progress-track');
  const label = document.getElementById('progress-label');
  track.textContent = '';
  for (const d of defs) {
    const cls = d.state === 'done' ? 'done' : d.state === 'now' ? 'now' : d.state === 'bad' ? 'bad' : '';
    track.append(el('i', { class: cls }));
  }
  const done = defs.filter((d) => d.state === 'done').length;
  const brokenAt = defs.findIndex((d) => d.state === 'bad');
  const current = defs.findIndex((d) => d.state === 'now' || d.state === 'bad');
  label.textContent = brokenAt >= 0
    ? `Step ${brokenAt + 1} of ${defs.length} — needs fixing`
    : done === defs.length
      ? 'All done'
      : `Step ${current < 0 ? done + 1 : current + 1} of ${defs.length}`;
}

/* -------------------------------------------------------------- the loop */

function render(data) {
  lastData = data;
  document.getElementById('fetch-error').hidden = true;

  const host = document.getElementById('steps');

  // Never rebuild the steps out from under someone typing a key into them: a
  // four-second poll would otherwise wipe a half-pasted key, or the error
  // message explaining why the last one failed.
  const keyIn = document.getElementById('join-key');
  if (joinBusy || routeBusy || (keyIn && document.activeElement === keyIn)) return;
  const carried = keyIn ? keyIn.value : '';

  const privOn = !!(data.privacy && data.privacy.active);
  const defs = privOn ? privacyDefs(data)
    : [stepMachine(data), stepConnect(data), stepRoute(data), stepDevices(data), stepWatch(data)];

  // Exactly one step is the card. Several steps can legitimately be actionable
  // at once — "add your devices" and "start watching" both open the moment the
  // route is approved — but two competing cards is precisely the "where do I
  // look" problem the layout exists to solve.
  //
  // Which one is open is now separate from what each step's state IS: by
  // default it is the first that needs someone, and once the operator has
  // navigated by hand it is whatever they chose. Everything keeps its own
  // colour either way, so a finished step still reads as finished when you
  // open it to look.
  let autoIdx = defs.findIndex((d) => d.state === 'now' || d.state === 'bad');
  if (autoIdx < 0) autoIdx = defs.length - 1;
  const openIdx = selected == null
    ? autoIdx
    : Math.max(0, Math.min(selected, defs.length - 1));
  openNow = openIdx;

  host.textContent = '';
  defs.forEach((d, i) => host.append(stepRow(i + 1, d, i === openIdx, i)));

  // Nothing to step back to from the first one, and a dead control is worse
  // than no control.
  document.getElementById('setup-back').hidden = openIdx === 0;
  renderProgress(defs);
  if (privOn) renderPrivacyVerdict(data, defs);
  else renderVerdict(data, defs);
  renderPrivacy(data, false);

  const fresh = document.getElementById('join-key');
  if (fresh && carried) fresh.value = carried;

  // Only worth offering once we know there is nothing to finish here.
  document.getElementById('skip-line').hidden = data.tailscale.loggedIn || privOn;

  const coturn = data.coturn || {};
  if (coturn.embedded && !coturn.listening) {
    host.append(el('p', { class: 'warn' },
      'The built-in relay is not answering on port 3478. Video will still work in almost every home; this only matters on networks that block direct connections.'));
  }
}

let timer = null;

async function tick() {
  const dot = document.getElementById('refresh-dot');
  const label = document.getElementById('refresh-label');
  try {
    const res = await fetch('/setup.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    render(await res.json());
    dot.className = 'dot on';
    label.textContent = `Checked ${new Date().toLocaleTimeString()} — rechecks every few seconds`;
  } catch {
    document.getElementById('fetch-error').hidden = false;
    dot.className = 'dot live';
    label.textContent = 'Cannot reach the container';
  }
  clearTimeout(timer);
  timer = setTimeout(tick, POLL_MS);
}

tick();
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
