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
  out:  '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'
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

/** An external link, always marked as one. */
function goLink(href, label) {
  const a = el('a', { class: 'go', href, target: '_blank', rel: 'noopener noreferrer' }, label);
  a.append(svg(ICONS.out));
  return a;
}

/** A collapsible plain-language explainer. */
function why(question, ...paragraphs) {
  return el('details', { class: 'why' },
    el('summary', {}, question),
    ...paragraphs.map((p) => el('p', {}, p)));
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
  return el('div', { class: 'url-hero' },
    el('a', { class: 'open-app', href: url, target: '_blank', rel: 'noopener noreferrer' },
      el('span', { class: 'open-app-label' }, 'Open Tawny'),
      el('span', { class: 'open-app-url' }, url),
      svg(ICONS.out, 'open-app-out')),
    el('button', { class: 'copy-btn', type: 'button', 'data-copy-text': url }, 'Copy'));
}

// Fires once when the setup actually completes — on the transition, or the
// first time a finished deployment is ever opened. Not on every poll, and not
// on every reload for the rest of the deployment's life.
let celebrated = false;
let sawIncomplete = false;

function confetti() {
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
  for (let i = 0; i < 150; i++) {
    bits.push({
      x: Math.random() * W,
      y: -Math.random() * H * 0.5,
      w: (5 + Math.random() * 7) * dpr,
      h: (8 + Math.random() * 10) * dpr,
      vx: (Math.random() - 0.5) * 2.6 * dpr,
      vy: (2 + Math.random() * 3.4) * dpr,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.24,
      c: colours[(Math.random() * colours.length) | 0]
    });
  }

  const DUR = 3400;
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
    id: 'join-key', class: 'join-input', type: 'text',
    placeholder: 'tskey-auth-…',
    autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false'
  });
  const btn = el('button', { id: 'join-go', class: 'wide primary', type: 'submit' }, 'Connect');
  const msg = el('p', { id: 'join-msg', class: 'join-msg', hidden: 'hidden' });

  // On the "stale_unrecovered" card the same field feeds a second action:
  // archive the stuck identity and rejoin with this key.
  const resetBtn = opts.resetLabel
    ? el('button', { id: 'join-reset', class: 'wide', type: 'button' }, opts.resetLabel)
    : null;

  const form = el('form', { id: 'join-form', class: 'join' },
    el('label', { class: 'join-label', for: 'join-key' }, 'Paste your auth key'),
    input, btn, resetBtn, msg);

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
    if (serve && serve.ok === false) {
      // Tailscale prints a specific error when the tailnet has not turned on
      // the HTTPS/MagicDNS features `tailscale serve` needs. That is a switch
      // in the admin console, not a leftover setting — and it is off by
      // default on a brand-new tailnet, so it is the first thing to rule out.
      const d = String(serve.detail || '');

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
        /admin\/dns|1153|enabling-https/i.test(d);

      if (needsHttps) {
        return {
          state: 'bad',
          title: 'Connect to Tailscale',
          tag: 'turn on HTTPS in Tailscale',
          body: [
            el('p', { class: 'step-say' }, 'Tawny is on your network, but your Tailscale account has not switched on the two features it needs to publish a web address: MagicDNS and HTTPS certificates. Until they are on, the https:// address will not exist and talk-back cannot work.'),
            el('div', { class: 'step-do' }, 'On the DNS page of your Tailscale admin console:',
              el('ol', {},
                el('li', {}, 'Under "MagicDNS", press Enable.'),
                el('li', {}, 'Under "HTTPS Certificates", press Enable HTTPS. (MagicDNS has to be on first.)'))),
            goLink(LINK.dns, 'Open Tailscale DNS settings'),
            el('p', { class: 'step-say' }, 'Then restart the container. This is a one-time setting for your whole account — you will not touch it again.'),
            why('Why does Tawny need these turned on?',
              'MagicDNS is what gives every device on your network a name like tawny.your-tailnet.ts.net instead of a bare number. HTTPS certificates let Tailscale put a real, browser-trusted certificate on that name.',
              'Both together are what "tailscale serve" uses to front Tawny at a secure address. A browser only hands a page the microphone on a secure address, so without them there is no talk-back — and the plain http://…:8099 address is the LAN-only fallback.'),
            serve.detail ? el('pre', { class: 'step-log' }, serve.detail) : null
          ]
        };
      }

      return {
        state: 'bad',
        title: 'Connect to Tailscale',
        tag: 'no web address',
        body: [
          el('p', { class: 'step-say' }, 'You are on the network, but Tailscale could not publish Tawny at a web address — so the https:// address will not load, and talk-back will not work.'),
          el('p', { class: 'step-do' }, 'A leftover setting from an earlier run is the usual cause. Run tailscale serve reset on this machine and restart the container. If that does not fix it, check that MagicDNS and HTTPS certificates are enabled on the DNS page of your Tailscale admin console.'),
          goLink(LINK.dns, 'Open Tailscale DNS settings'),
          serve.detail ? el('pre', { class: 'step-log' }, serve.detail) : null
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
          el('li', {}, `Tick ${cidr} and save.`))),
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
  const ready = tailscale.loggedIn && !(tailscale.pendingRoutes || []).length
    && (tailscale.approvedRoutes || []).length;

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
    && !(data.startup || []).some((s) => s.ok === false);

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
    && !badLan && !undecided && !!tailscale.dnsName;

  const set = (cls, ico, h, p) => {
    box.className = `verdict is-${cls}`;
    icon.innerHTML = `<svg viewBox="0 0 24 24">${ico}</svg>`;
    title.textContent = h;
    say.textContent = p;
  };

  if (allGood) {
    set('ok', ICONS.tick, 'Tawny is ready',
      'Everything is connected. Open this on whatever you want to watch from — step 5 walks through pairing the camera phone.');
    box.classList.add('is-finish');
    extra.append(openLink(`https://${tailscale.dnsName}/`));
    maybeCelebrate();
    return;
  }
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

  const defs = [stepMachine(data), stepConnect(data), stepRoute(data), stepDevices(data), stepWatch(data)];

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
  renderVerdict(data, defs);

  const fresh = document.getElementById('join-key');
  if (fresh && carried) fresh.value = carried;

  // Only worth offering once we know there is nothing to finish here.
  document.getElementById('skip-line').hidden = data.tailscale.loggedIn;

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
