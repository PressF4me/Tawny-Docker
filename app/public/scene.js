/*
 * The welcome scene: a cat and a dog sitting either side of Tawny the owlet.
 *
 * A port of PetSceneView (MainActivity.kt) — same 260×170 scene space, same
 * shapes, same motion — so the page a browser, the desktop app or the
 * container serves opens on the same trio as the Android app. Canvas 2D maps
 * almost call for call onto android.graphics.Canvas, which is what keeps this
 * a port rather than a redrawing: when the native scene changes, change this
 * the same way.
 *
 * Mounts itself on every <canvas class="pet-scene">. Colours come from the
 * --pet-* custom properties (style.css), so it follows the theme; motion
 * follows data-motion="off" on <html> the way the stylesheet does, and holds a
 * still pose rather than freezing mid-gesture. Tap a pet and it does its
 * thing: the cat pounces, the dog play-bows, the owlet flies a loop.
 */
(() => {
  'use strict';

  const VW = 260, VH = 170, LOOP_MS = 4200;
  // Sky above the 260×170 scene: the owlet's flight loop peaks at y≈12 and
  // her ear tufts reach 22 above that, which a canvas cut off at y=0.
  const HEAD = 18;
  const PI = Math.PI, TWO_PI = PI * 2;
  const REACT_MS = [0, 1300, 1500, 2700];   // idx = who: 1 cat, 2 dog, 3 owlet

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const ramp = (x) => { const u = clamp(x, 0, 1); return u * u * (3 - 2 * u); };
  const hump = (x) => (x <= 0 || x >= 1 ? 0 : Math.sin(x * PI));
  const lerp = (a, b, u) => a + (b - a) * u;
  const snap = (u, out = 0.22) =>
    u <= 0 || u >= 1 ? 0 : u < out ? ramp(u / out) : 1 - ramp((u - out) / (1 - out));
  const hangs = (s, k = 0.55) => (1 + k) * s / (1 + k * Math.abs(s));

  // Kotlin's Int arithmetic, overflow and all, so the idle schedule matches.
  function hash01(n) {
    let h = (Math.imul(n | 0, 374761393) + 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) & 0x07ffffff) / 134217727;
  }

  const motionOff = () => document.documentElement.getAttribute('data-motion') === 'off';

  class Scene {
    constructor(canvas) {
      this.cv = canvas;
      this.cx = canvas.getContext('2d');
      this.born = performance.now();
      this.reactWho = 0;
      this.reactStart = 0;
      this.raf = 0;
      this.readColours();
      canvas.addEventListener('pointerdown', (e) => this.tap(e));
    }

    // ------------------------------------------------------------ clocks

    get still() { return motionOff(); }
    /** Seconds since the scene was made; 0 when still. */
    get clock() { return this.still ? 0 : (performance.now() - this.born) / 1000; }
    /** The 4.2 s loop, 0..1. */
    get t() { return this.still ? 0 : ((performance.now() - this.born) % LOOP_MS) / LOOP_MS; }

    reactP(who) {
      if (this.reactWho !== who) return 0;
      return clamp((performance.now() - this.reactStart) / REACT_MS[who], 0, 1);
    }
    reactSecs() { return (performance.now() - this.reactStart) / 1000; }

    // ------------------------------------------------------ organic motion

    drift(u) {
      if (this.still) return 0;
      return (Math.sin(u) + 0.62 * Math.sin(u * 1.73 + 1.3) + 0.41 * Math.sin(u * 2.91 + 2.6)) * 0.49;
    }
    breath(at, period = 2.9) {
      if (this.still) return 0.5;
      const u = at / period;
      return snap(u - Math.floor(u), 0.42);
    }
    beat(seed, every, dur, chance = 1) {
      const ck = this.clock;
      if (ck <= 0) return 0;
      const w = ck / every + hash01(seed * 977 + 13);
      const i = Math.floor(w);
      if (chance < 1 && hash01(i * 8191 + seed) > chance) return 0;
      const at = hash01(i * 131 + seed * 7) * Math.max(0, 1 - dur / every);
      const u = (w - i - at) * every / dur;
      return u <= 0 || u >= 1 ? 0 : u;
    }
    blinkAt(seed) {
      const shut = Math.max(
        snap(this.beat(seed, 3.6, 0.30), 0.38),
        snap(this.beat(seed + 101, 5.3, 0.26, 0.45), 0.38));
      return 1 - 0.94 * shut;
    }
    /** 1 = open; dips toward 0 once per loop. */
    blink(offset = 0) {
      const d = Math.abs(((this.t + offset) % 1) - 0.5);
      return d < 0.032 ? clamp(d / 0.032, 0.06, 1) : 1;
    }
    contact(seed) {
      const u = this.beat(seed * 31 + 8, 8.5, 2.2, 0.55);
      if (u <= 0) return 0;
      return clamp(ramp(u / 0.3) * (1 - ramp((u - 0.62) / 0.38)), 0, 1);
    }
    gazeX(seed, home) {
      if (this.still) return home;
      const wander = this.drift(this.clock * 0.29 + seed * 1.7) * 0.3;
      const away = snap(this.beat(seed * 31 + 7, 9.5, 2.0, 0.45), 0.25);
      const base = (home + wander) * (1 - away) - home * away * 0.9;
      return base * (1 - this.contact(seed));
    }
    gazeY(seed, home = 0) {
      if (this.still) return home;
      const up = snap(this.beat(seed * 31 + 9, 12, 1.6, 0.45), 0.28) * -0.85;
      return (home + up) * (1 - this.contact(seed));
    }

    owlFlight(op, perchX, perchY, cxA, cyA, rx, ry) {
      const a0 = -PI / 2;
      const at = (u) => {
        const a = a0 + clamp(u, 0, 1) * TWO_PI * 1.5;
        return [cxA + rx * Math.cos(a), cyA + ry * Math.sin(a), a];
      };
      if (op < 0.16) {
        const u = ramp(op / 0.16), [lx, ly] = at(0);
        return [lerp(perchX, lx, u), lerp(perchY, ly, u), u * -8, 0];
      }
      if (op < 0.82) {
        const [lx, ly, a] = at((op - 0.16) / 0.66);
        return [lx, ly, -Math.cos(a) * 15, -Math.sin(a) * 1.8];
      }
      const u = ramp((op - 0.82) / 0.18), [lx, ly] = at(1);
      return [lerp(lx, perchX, u), lerp(ly, perchY, u), lerp(-8, 0, u), 0];
    }

    // ------------------------------------------------------------ colours

    readColours() {
      const cs = getComputedStyle(this.cv);
      const v = (name) => cs.getPropertyValue(name).trim();
      this.onDark = v('--pet-dark') === '1';
      this.col = {
        cream: v('--pet-cream'), creamHi: v('--pet-cream-hi'), creamLo: v('--pet-cream-lo'),
        biscuit: v('--pet-biscuit'), biscuitLo: v('--pet-biscuit-lo'), dove: v('--pet-dove'),
        ink: v('--pet-ink'), edge: v('--pet-edge'), hair: v('--pet-hair'),
        tongue: v('--pet-tongue'), berry: v('--berry'), sky: v('--sky'),
        hi: this.onDark ? 'rgba(255,255,255,.133)' : 'rgba(255,255,255,.169)',
        lo: this.onDark ? 'rgba(0,0,0,.149)' : 'rgba(0,0,0,.122)',
      };
      this.hairAlpha = this.onDark ? 200 / 255 : 150 / 255;
      this.castMul = this.onDark ? 1.9 : 1;
    }

    // ------------------------------------------------------------ primitives

    fill(p) { this.cx.fillStyle = p; this.cx.fill(); }
    stroke(width = 2.6, colour = this.col.edge, alpha = 1) {
      const c = this.cx;
      c.save();
      c.globalAlpha *= alpha;
      c.strokeStyle = colour; c.lineWidth = width; c.lineCap = 'round'; c.lineJoin = 'round';
      c.stroke();
      c.restore();
    }
    rrect(l, t, r, b, rad) {
      const c = this.cx;
      c.beginPath();
      if (c.roundRect) c.roundRect(l, t, r - l, b - t, rad);
      else c.rect(l, t, r - l, b - t);
    }
    oval(l, t, r, b) {
      this.cx.beginPath();
      this.cx.ellipse((l + r) / 2, (t + b) / 2, Math.abs(r - l) / 2, Math.abs(b - t) / 2, 0, 0, TWO_PI);
    }
    capsule(cx, cy, w, h, p, edged = false) {
      this.rrect(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, Math.min(w, h) / 2);
      this.fill(p);
      if (edged) this.stroke();
    }
    mass(cx, cy, w, h, base) {
      const r = Math.min(w, h) / 2;
      this.rrect(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, r); this.fill(base);
      this.oval(cx - w * 0.36, cy - h * 0.44, cx + w * 0.06, cy - h * 0.02); this.fill(this.col.hi);
      this.oval(cx - w * 0.40, cy + h * 0.04, cx + w * 0.40, cy + h * 0.46); this.fill(this.col.lo);
      this.rrect(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2, r); this.stroke();
    }
    castShadow(cx, cy, w, alpha = 34) {
      const a = clamp(alpha * this.castMul, 0, 255) / 255;
      this.oval(cx - w / 2, cy - w * 0.11, cx + w / 2, cy + w * 0.11);
      this.fill(`rgba(0,0,0,${a})`);
    }
    eye(cx, cy, r, open, look = 0, lookY = 0) {
      const o = clamp(open, 0, 1);
      const y = cy + lookY * o;
      this.oval(cx - r + look, y - r * o, cx + r + look, y + r * o); this.fill(this.col.ink);
      if (o > 0.55) {
        this.cx.beginPath(); this.cx.arc(cx - r * 0.34 + look, cy - r * 0.44, r * 0.36, 0, TWO_PI);
        this.fill(this.col.creamHi);
      }
    }
    owlEye(cx, cy, r, open, look, lookY = 0) {
      const c = this.cx, o = clamp(open, 0.08, 1);
      c.save();
      c.translate(cx, cy); c.scale(1, o); c.translate(-cx, -cy);
      c.beginPath(); c.arc(cx, cy, r, 0, TWO_PI); this.fill(this.col.sky);
      c.beginPath(); c.arc(cx, cy, r, 0, TWO_PI); this.stroke(2.6 * 0.68);
      const px = cx + look, py = cy + r * 0.12 + lookY * r * 0.32;
      c.beginPath(); c.arc(px, py, r * 0.52, 0, TWO_PI); this.fill(this.col.ink);
      c.beginPath(); c.arc(px - r * 0.18, py - r * 0.36, r * 0.2, 0, TWO_PI); this.fill(this.col.creamHi);
      c.restore();
    }
    softTri(ax, ay, bx, by, cx, cy, p, edged = false) {
      const c = this.cx;
      c.beginPath();
      c.moveTo((ax + bx) / 2, (ay + by) / 2);
      c.quadraticCurveTo(bx, by, (bx + cx) / 2, (by + cy) / 2);
      c.quadraticCurveTo(cx, cy, (cx + ax) / 2, (cy + ay) / 2);
      c.quadraticCurveTo(ax, ay, (ax + bx) / 2, (ay + by) / 2);
      c.closePath();
      this.fill(p);
      if (edged) this.stroke();
    }
    tri(ax, ay, bx, by, cx, cy, p) {
      const c = this.cx;
      c.beginPath(); c.moveTo(ax, ay); c.lineTo(bx, by); c.lineTo(cx, cy); c.closePath();
      this.fill(p);
    }
    line(x1, y1, x2, y2) {
      this.cx.beginPath(); this.cx.moveTo(x1, y1); this.cx.lineTo(x2, y2);
      this.stroke(2.2, this.col.hair, this.hairAlpha);
    }
    /** android.graphics.Canvas#drawArc(oval, start, sweep, useCenter=false). */
    arcIn(l, t, r, b, startDeg, sweepDeg) {
      const c = this.cx;
      c.beginPath();
      c.ellipse((l + r) / 2, (t + b) / 2, (r - l) / 2, (b - t) / 2, 0,
        startDeg * PI / 180, (startDeg + sweepDeg) * PI / 180);
      this.stroke(2.2, this.col.hair, this.hairAlpha);
    }
    rotate(deg, px, py) {
      const c = this.cx;
      c.translate(px, py); c.rotate(deg * PI / 180); c.translate(-px, -py);
    }
    scaleAt(sx, sy, px, py) {
      const c = this.cx;
      c.translate(px, py); c.scale(sx, sy); c.translate(-px, -py);
    }
    floppyEar(ax, ay, len, wid, angleDeg, p) {
      const c = this.cx;
      c.save();
      this.rotate(angleDeg, ax, ay);
      c.beginPath();
      c.moveTo(ax - wid * 0.28, ay);
      c.bezierCurveTo(ax - wid * 0.60, ay + len * 0.38, ax - wid * 0.52, ay + len * 0.88, ax, ay + len);
      c.bezierCurveTo(ax + wid * 0.52, ay + len * 0.88, ax + wid * 0.60, ay + len * 0.38, ax + wid * 0.28, ay);
      c.quadraticCurveTo(ax, ay - wid * 0.30, ax - wid * 0.28, ay);
      c.closePath();
      this.fill(p); this.stroke();
      c.restore();
    }

    // ------------------------------------------------------------ the owlet

    owlet(x, groundY, tNorm, { hop = 0, flyX = null, flyY = 0, flyBank = 0, flyFlap = 0, flyLook = 0 } = {}) {
      const c = this.cx, k = this.col;
      if (flyX !== null) {
        const ax = flyX, ay = flyY;
        const alt = clamp((groundY - ay) / 66, 0, 1);
        this.castShadow(x, groundY + 3, 24 * (1 - 0.6 * alt), 30 * (1 - 0.7 * alt));
        c.save();
        this.rotate(flyBank, ax, ay);
        c.save(); this.rotate(-42 - 30 * flyFlap, ax - 6, ay - 1);
        this.capsule(ax - 15, ay + 1, 10, 22, k.cream, true); c.restore();
        c.save(); this.rotate(42 + 30 * flyFlap, ax + 6, ay - 1);
        this.capsule(ax + 15, ay + 1, 10, 22, k.cream, true); c.restore();
        this.softTri(ax - 8, ay - 10, ax - 3, ay - 22, ax + 1, ay - 11, k.cream, true);
        this.softTri(ax + 8, ay - 10, ax + 3, ay - 22, ax - 1, ay - 11, k.cream, true);
        this.mass(ax, ay, 25, 30, k.cream);
        this.capsule(ax, ay - 3, 21, 16, k.creamHi);
        this.softTri(ax - 5, ay + 12, ax, ay + 22, ax + 5, ay + 12, k.creamLo, true);
        const bl = this.blink(0.45);
        this.owlEye(ax - 5.2, ay - 4, 4.5, bl, flyLook, -0.35);
        this.owlEye(ax + 5.2, ay - 4, 4.5, bl, flyLook, -0.35);
        this.tri(ax - 2, ay + 1, ax + 2, ay + 1, ax, ay + 5, k.berry);
        c.restore();
        return;
      }
      const cy = groundY - 18 - hop;
      const flap = clamp(hop / 8, 0, 1);
      const owlUp = 1 - this.contact(4);
      const lookX = Math.cos(tNorm * TWO_PI) * 0.9 * owlUp;
      const lookY = 0;

      this.castShadow(x, groundY + 3, 26 * (1 - 0.35 * Math.min(flap, 1)), 34 * (1 - 0.5 * Math.min(flap, 1)));
      if (hop < 3) {
        this.tri(x - 4, groundY - 2, x - 7, groundY + 1, x - 1, groundY + 1, k.berry);
        this.tri(x + 4, groundY - 2, x + 1, groundY + 1, x + 7, groundY + 1, k.berry);
      }
      c.save(); this.rotate(-18 - 24 * Math.min(flap, 1), x - 8, cy - 2);
      this.capsule(x - 11, cy + 3, 9, 17, k.cream, true); c.restore();
      c.save(); this.rotate(18 + 24 * Math.min(flap, 1), x + 8, cy - 2);
      this.capsule(x + 11, cy + 3, 9, 17, k.cream, true); c.restore();

      this.softTri(x - 8, cy - 11, x - 3, cy - 23, x + 1, cy - 12, k.cream, true);
      this.softTri(x + 8, cy - 11, x + 3, cy - 23, x - 1, cy - 12, k.cream, true);
      this.mass(x, cy, 26, 32, k.cream);
      this.capsule(x, cy - 3, 22, 17, k.creamHi);
      const bl = this.blink(0.45);
      this.owlEye(x - 5.4, cy - 4, 4.6, bl, lookX, lookY);
      this.owlEye(x + 5.4, cy - 4, 4.6, bl, lookX, lookY);
      this.tri(x - 2, cy + 1, x + 2, cy + 1, x, cy + 5, k.berry);
    }

    // ------------------------------------------------------------ the scene

    draw() {
      const c = this.cx, k = this.col;
      const t = this.t, tau = t * TWO_PI, g = 150, bob = Math.sin(tau);

      // ---------------- cat, sitting, left ----------------
      {
        const x = 70, by = bob * 1.6;
        this.castShadow(x + 2, g + 4, 66, 40);
        const cp = this.reactP(1);
        const crouch = ramp(cp / 0.30) * (1 - ramp((cp - 0.34) / 0.18));
        const spring = hump((cp - 0.28) / 0.55);
        const land = hump((cp - 0.82) / 0.18);
        const wiggle = Math.sin(this.reactSecs() * 44) * crouch * 2.6;
        const active = Math.min(crouch + spring, 1);
        c.save();
        c.translate(wiggle, crouch * 3.6 - spring * 17 + land * 2.4);
        this.scaleAt(1 + spring * 0.05, 1 - spring * 0.06, x, g);

        const flick = Math.sin(t * 4 * PI + 1) + active * Math.sin(this.reactSecs() * 30) * 3.2;
        c.save(); this.rotate(flick * 4, x + 6, g - 6);
        c.beginPath();
        c.moveTo(x + 2, g - 4);
        c.bezierCurveTo(x + 30, g + 2, x + 34, g - 26, x + 20, g - 34);
        c.bezierCurveTo(x + 12, g - 39, x + 6, g - 32, x + 11, g - 24);
        c.bezierCurveTo(x + 16, g - 16, x + 12, g - 2, x - 2, g + 1);
        c.closePath();
        this.fill(k.dove); this.stroke();
        c.restore();

        this.mass(x - 4, g - 16 + by, 46, 30, k.dove);
        this.mass(x + 2, g - 40 + by, 34, 46, k.dove);
        this.capsule(x + 4, g - 30 + by, 18, 24, k.creamHi);
        this.capsule(x - 4, g - 3, 12, 9, k.cream, true);
        this.capsule(x + 10, g - 3, 12, 9, k.cream, true);

        const hx = x + 3, hy = g - 64 + by - spring * 3;
        const earTip = -3 - active * 3;
        this.softTri(hx - 16, hy - 2, hx - 20, hy - 22 - earTip, hx - 3, hy - 12, k.dove, true);
        this.softTri(hx + 16, hy - 2, hx + 20, hy - 22 - earTip, hx + 3, hy - 12, k.dove, true);
        this.softTri(hx - 13, hy - 4, hx - 16, hy - 17, hx - 5, hy - 11, k.berry);
        this.softTri(hx + 13, hy - 4, hx + 16, hy - 17, hx + 5, hy - 11, k.berry);
        this.mass(hx, hy, 32, 29, k.dove);
        this.capsule(hx, hy + 6, 15, 12, k.creamHi);
        const bl = clamp(this.blink() - spring, 0, 1);
        const er = 3.4 + active * 1.0;
        const gx = this.gazeX(2, 1) * 1.7, gy = this.gazeY(2) * 1.2;
        this.eye(hx - 6, hy - 1, er, bl, gx, gy);
        this.eye(hx + 6, hy - 1, er, bl, gx, gy);
        this.tri(hx, hy + 8, hx - 2.4, hy + 5.6, hx + 2.4, hy + 5.6, k.berry);
        this.line(hx + 6, hy + 5, hx + 20, hy + 3);
        this.line(hx + 6, hy + 8, hx + 20, hy + 9);
        this.line(hx - 6, hy + 5, hx - 20, hy + 3);
        this.line(hx - 6, hy + 8, hx - 20, hy + 9);
        c.restore();
      }

      // ---------------- dog, sitting, right ----------------
      {
        const x = 190, ck = this.clock;
        const by = (this.breath(ck) - 0.5) * 3.2;
        const hby = (this.breath(ck - 0.13) - 0.5) * 3.4;
        this.castShadow(x + 2, g + 4, 78, 40);

        const dp = this.reactP(2);
        const bow = ramp(dp / 0.20) * (1 - ramp((dp - 0.30) / 0.22));
        const bounce = dp >= 0.30 && dp <= 0.92
          ? hangs(Math.abs(Math.sin(((dp - 0.30) / 0.62) * PI * 2)), 0.5) : 0;
        const dogA = Math.min(bow + bounce, 1);
        const lean = snap(this.beat(21, 11, 2.4, 0.6), 0.3) - snap(this.beat(22, 13, 2.4, 0.6), 0.3);
        c.save();
        this.rotate(-13 * bow + lean * 2.2, x, g);
        c.translate(0, -bounce * 9);
        this.scaleAt(1 + bounce * 0.03, 1 - bounce * 0.045, x, g);

        const zeal = ramp(this.drift(ck * 0.42 + 2.1) * 1.15 + 0.66);
        const wagPh = ck * 3.5 + 1.5 * this.drift(ck * 0.44);
        const th = wagPh * TWO_PI;
        const wag = hangs(Math.sin(th + 0.5 * Math.sin(th)), 0.4) * (0.18 + 0.82 * zeal);
        const wagArc = wag * (7 + 8 * zeal + dogA * 20) + dogA * Math.sin(this.reactSecs() * 40) * 6;
        c.save(); this.rotate(wagArc + (1 - zeal) * 3 - dogA * 6, x + 14, g - 8);
        c.beginPath();
        c.moveTo(x + 12, g - 4);
        c.bezierCurveTo(x + 40, g - 4, x + 48, g - 26, x + 36, g - 40);
        c.bezierCurveTo(x + 31, g - 46, x + 21, g - 44, x + 22, g - 36);
        c.bezierCurveTo(x + 27, g - 30, x + 30, g - 16, x + 12, g - 4);
        c.closePath();
        this.fill(k.biscuit); this.stroke();
        c.restore();

        this.mass(x + 4, g - 16 + by, 52, 28, k.biscuit);
        this.mass(x, g - 40 + by, 42, 46, k.biscuit);
        this.capsule(x, g - 30 + by, 20, 26, k.cream);
        this.capsule(x - 8, g - 3, 13, 10, k.cream, true);
        this.capsule(x + 8, g - 3, 13, 10, k.cream, true);

        const cock = (snap(this.beat(24, 9.7, 2.1, 0.6), 0.16) - snap(this.beat(23, 8.2, 2.1, 0.6), 0.16)) * 11;
        const sniff = this.beat(25, 12, 0.9, 0.5);
        const sniffY = sniff > 0 ? Math.sin(sniff * 3 * TWO_PI) * hump(sniff) * 1.7 : 0;
        const hx = x, hy = g - 62 + hby + sniffY - bow * 2;
        c.save();
        this.rotate(cock, hx, hy + 17);
        const sway = (this.breath(ck - 0.26) - 0.5) * 5.6 + this.drift(ck * 0.62) * 1.4 +
          Math.sin(this.reactSecs() * 24) * dogA * 6;
        const flickL = snap(this.beat(26, 5.2, 0.45, 0.55), 0.14) * 12;
        const flickR = snap(this.beat(27, 6.7, 0.45, 0.55), 0.14) * 12;
        this.floppyEar(hx - 15, hy - 9, 33, 18, 22 + sway + flickL, k.biscuitLo);
        this.floppyEar(hx + 15, hy - 9, 33, 18, -22 - sway - flickR, k.biscuitLo);
        this.mass(hx, hy, 34, 31, k.cream);
        this.capsule(hx, hy + 7, 18, 14, k.creamHi);
        const bl = this.blinkAt(2);
        const gaze = this.gazeX(3, -1) * 1.7, gazeVert = this.gazeY(3) * 1.2;
        this.eye(hx - 6, hy - 2, 3.4, bl, gaze, gazeVert);
        this.eye(hx + 6, hy - 2, 3.4, bl, gaze, gazeVert);
        this.capsule(hx, hy + 4, 6, 5, k.ink);
        c.beginPath(); c.arc(hx - 1.6, hy + 2.6, 1.1, 0, TWO_PI); this.fill(k.creamHi);
        this.arcIn(hx - 6, hy + 6, hx, hy + 13, 20, 130);
        this.arcIn(hx, hy + 6, hx + 6, hy + 13, 30, 130);
        const pant = Math.max(
          Math.max(snap(this.beat(30, 7, 3.0, 0.85), 0.10), snap(this.beat(31, 11, 2.4, 0.55), 0.10)),
          dogA);
        const loll = Math.max(0, pant * (4.4 + 1.2 * Math.sin(ck * 12)) + dogA * 4);
        if (loll > 0.5) { this.rrect(hx - 2.4, hy + 9, hx + 2.4, hy + 9 + loll, 2.4); this.fill(k.tongue); }
        c.restore();
        c.restore();
      }

      // ---------------- owlet, centre (flies a loop when tapped) ----------------
      const op = this.reactP(3);
      if (op > 0) {
        const [fx, fy, bank, look] = this.owlFlight(op, 130, g - 20, 130, 46, 82, 34);
        const flap = 0.55 + 0.45 * Math.abs(Math.sin(this.reactSecs() * 24));
        this.owlet(130, g - 2, t, { flyX: fx, flyY: fy, flyBank: bank, flyFlap: flap, flyLook: look });
      } else {
        this.owlet(130, g - 2, t, { hop: this.still ? 0 : (0.5 + 0.5 * Math.sin(tau)) * 2 });
      }
    }

    // ------------------------------------------------------------ frame loop

    critterAt(sx, sy) {
      if (sx >= 108 && sx <= 152 && sy >= 88 && sy <= 156) return 3;
      if (sx >= 28 && sx <= 114 && sy >= 56 && sy <= 158) return 1;
      if (sx >= 146 && sx <= 244 && sy >= 50 && sy <= 158) return 2;
      return 0;
    }

    tap(e) {
      const r = this.cv.getBoundingClientRect();
      const s = Math.min(r.width / VW, r.height / (VH + HEAD));
      const sx = (e.clientX - r.left - (r.width - VW * s) / 2) / s;
      const sy = (e.clientY - r.top - (r.height - (VH + HEAD) * s) / 2) / s - HEAD;
      const who = this.critterAt(sx, sy);
      if (!who) return;
      this.reactWho = who;
      this.reactStart = performance.now();
      try { navigator.vibrate?.(8); } catch {}
      this.start();
    }

    frame() {
      this.raf = 0;
      const cv = this.cv;
      if (!cv.isConnected || !cv.offsetParent) return;   // hidden: stop until shown again
      const dpr = window.devicePixelRatio || 1;
      const w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      const c = this.cx;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, w, h);
      const s = Math.min(w / VW, h / (VH + HEAD));
      c.translate((w - VW * s) / 2, (h - (VH + HEAD) * s) / 2 + HEAD * s);
      c.scale(s, s);
      this.draw();
      if (this.reactWho && performance.now() - this.reactStart >= REACT_MS[this.reactWho]) this.reactWho = 0;
      // Still and not reacting: one frame is the whole picture.
      if (!this.still || this.reactWho) this.start();
    }

    start() { if (!this.raf) this.raf = requestAnimationFrame(() => this.frame()); }
  }

  const scenes = [];
  function mount() {
    for (const cv of document.querySelectorAll('canvas.pet-scene')) {
      if (!cv.__scene) { cv.__scene = new Scene(cv); scenes.push(cv.__scene); }
    }
    for (const s of scenes) s.start();
  }
  const repaint = () => { for (const s of scenes) { s.readColours(); s.start(); } };

  // Screens are shown by toggling [hidden]; theme and motion are attributes on
  // <html>. Watching both is what restarts a scene when its screen comes back
  // and recolours it the moment the theme changes.
  new MutationObserver(mount).observe(document.body || document.documentElement,
    { subtree: true, attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(repaint).observe(document.documentElement,
    { attributes: true, attributeFilter: ['data-theme', 'data-motion'] });
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', repaint); } catch {}
  window.addEventListener('resize', () => { for (const s of scenes) s.start(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
