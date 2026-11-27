// Flipbook: a page-curl reader. Geometry is a flat sheet folded along the
// perpendicular bisector between the page corner C and the drag point P.
// All turn math happens in a "normalized" frame where the turning sheet is
// always on the right; backward turns in spread mode mirror the stage.

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const easeOut = t => 1 - Math.pow(1 - t, 3);
const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function clipPoly(poly, side) {
  // Sutherland–Hodgman against a half-plane: side(p) >= 0 is kept.
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const sa = side(a), sb = side(b);
    if (sa >= 0) out.push(a);
    if ((sa >= 0) !== (sb >= 0)) {
      const t = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}
const polyCss = (pts, ox = 0) =>
  pts.length < 3 ? 'polygon(0 0, 0 0, 0 0)' : `polygon(${pts.map(p => `${(p[0] - ox).toFixed(2)}px ${p[1].toFixed(2)}px`).join(',')})`;

function limitTo(P, O, r) {
  const dx = P.x - O.x, dy = P.y - O.y, d = Math.hypot(dx, dy);
  return d <= r ? P : { x: O.x + (dx / d) * r, y: O.y + (dy / d) * r };
}

export class Flipbook {
  /**
   * @param {HTMLElement} root
   * @param {{pageCount:number, aspect:number, startPage:number,
   *   renderPage:(n:number, w:number, h:number)=>Promise<HTMLCanvasElement>,
   *   onChange?:(state)=>void, reducedMotion?:boolean}} opts
   */
  constructor(root, opts) {
    this.root = root;
    this.n = opts.pageCount;
    this.aspect = opts.aspect; // width / height
    this.renderPage = opts.renderPage;
    this.onChange = opts.onChange || (() => {});
    this.reducedMotion = !!opts.reducedMotion;
    this.page = clamp(opts.startPage || 1, 1, this.n); // first visible page (anchor)
    this.cache = new Map();
    this.pending = new Map();
    this.turn = null;
    this.queue = [];
    this.build();
    this.ro = new ResizeObserver(() => this.layout());
    this.ro.observe(root);
    this.layout();
    // enable the centring slide only after the first paint
    requestAnimationFrame(() => requestAnimationFrame(() => this.root.classList.add('fb-ready')));
  }

  // ---------- DOM ----------
  build() {
    const el = (cls, parent, tag = 'div') => {
      const e = document.createElement(tag);
      e.className = cls;
      parent && parent.appendChild(e);
      return e;
    };
    this.root.classList.add('fb');
    this.book = el('fb-book', this.root);
    this.book.setAttribute('role', 'img');
    this.edgeL = el('fb-edge fb-edge-l', this.book);
    this.edgeR = el('fb-edge fb-edge-r', this.book);
    this.stage = el('fb-stage', this.book);
    this.baseL = el('fb-base fb-base-l', this.stage);
    this.baseR = el('fb-base fb-base-r', this.stage);
    const slot = cls => {
      const s = el('fb-slot ' + cls, this.stage);
      s.canvas = el('', s, 'canvas');
      s.spec = undefined;
      return s;
    };
    this.sLeft = slot('fb-left');
    this.sUnder = slot('fb-under');
    this.underShade = el('fb-shade fb-under-shade', this.stage);
    this.underBar = el('fb-bar fb-bar-under', this.underShade);
    this.sFront = slot('fb-front');
    this.frontBar = el('fb-bar fb-bar-front', this.sFront);
    this.gutter = el('fb-gutter', this.stage);
    this.flapWrap = el('fb-flapwrap', this.stage);
    this.flap = el('fb-slot fb-flap', this.flapWrap);
    this.flap.canvas = el('', this.flap, 'canvas');
    this.flapBar = el('fb-bar fb-bar-flap', this.flap);
    this.flapGloss = el('fb-bar fb-bar-gloss', this.flap);

    this.book.addEventListener('pointerdown', e => this.onDown(e));
    this.book.addEventListener('pointermove', e => this.onMove(e));
    this.book.addEventListener('pointerup', e => this.onUp(e));
    this.book.addEventListener('pointercancel', e => this.onUp(e, true));
    this.book.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !this.drag) this.endPeek(); });
    this.book.addEventListener('dragstart', e => e.preventDefault());
  }

  destroy() {
    this.ro.disconnect();
    cancelAnimationFrame(this.raf);
    this.destroyed = true;
    this.root.innerHTML = '';
    this.root.classList.remove('fb');
  }

  // ---------- layout ----------
  layout() {
    const r = this.root.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const padX = r.width < 600 ? 14 : 48, padY = r.width < 600 ? 14 : 28;
    const availW = r.width - padX * 2, availH = r.height - padY * 2;
    const spread = availW / availH >= this.aspect * 1.25 && availW >= 520;
    const W = Math.floor(spread ? Math.min(availW / 2, availH * this.aspect) : Math.min(availW, availH * this.aspect));
    const H = Math.floor(W / this.aspect);
    const changed = W !== this.W || spread !== this.spread;
    this.W = W; this.H = H; this.spread = spread;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.root.classList.toggle('fb-single', !spread);
    Object.assign(this.book.style, { width: (spread ? 2 * W : W) + 'px', height: H + 'px' });
    Object.assign(this.stage.style, { width: 2 * W + 'px', height: H + 'px', left: (spread ? 0 : -W) + 'px' });
    for (const s of [this.sLeft, this.baseL]) Object.assign(s.style, { left: '0px', width: W + 'px', height: H + 'px' });
    for (const s of [this.sUnder, this.sFront, this.underShade, this.baseR]) Object.assign(s.style, { left: W + 'px', width: W + 'px', height: H + 'px' });
    Object.assign(this.flap.style, { width: W + 'px', height: H + 'px' });
    Object.assign(this.gutter.style, { left: W - 40 + 'px', width: '80px', height: H + 'px' });
    if (changed) {
      if (this.turn) this.finishTurnNow(false);
      this.cache.clear();
      this.pending.clear();
      for (const s of [this.sLeft, this.sUnder, this.sFront, this.flap]) {
        s.canvas.width = Math.round(W * this.dpr);
        s.canvas.height = Math.round(H * this.dpr);
        s.spec = undefined;
      }
      this.page = this.anchor(this.page);
      this.showStatic();
    }
  }

  // ---------- page model ----------
  /** Normalizes any page number to the first page of its view. */
  anchor(p) {
    p = clamp(p, 1, this.n);
    if (!this.spread) return p;
    return p === 1 ? 1 : p - (p % 2); // spreads: [1], [2,3], [4,5]...
  }
  view() {
    if (!this.spread) return { left: null, right: this.page };
    if (this.page === 1) return { left: null, right: 1 };
    const l = this.page, r = l + 1 <= this.n ? l + 1 : null;
    return { left: l, right: r };
  }
  canNext() { return this.spread ? (this.view().right ? this.view().right + 1 <= this.n : false) : this.page < this.n; }
  canPrev() { return this.page > 1; }
  state() {
    const v = this.view();
    const pages = [v.left, v.right].filter(Boolean);
    return { pages, first: pages[0], last: pages[pages.length - 1], total: this.n, spread: this.spread, canNext: this.canNext(), canPrev: this.canPrev() };
  }

  // ---------- rendering ----------
  ensure(p) {
    if (!p || p < 1 || p > this.n) return null;
    if (this.cache.has(p)) return this.cache.get(p);
    if (!this.pending.has(p)) {
      const W = this.W;
      const job = this.renderPage(p, Math.round(this.W * this.dpr), Math.round(this.H * this.dpr))
        .then(c => {
          if (this.destroyed || W !== this.W) return;
          this.cache.set(p, c);
          this.pending.delete(p);
          // LRU-ish trim
          if (this.cache.size > 24) {
            const keep = new Set(this.wanted());
            for (const k of this.cache.keys()) if (!keep.has(k) && this.cache.size > 24) this.cache.delete(k);
          }
          for (const s of [this.sLeft, this.sUnder, this.sFront, this.flap]) if (s.spec && s.spec.page === p) this.paint(s, s.spec, true);
        })
        .catch(err => { this.pending.delete(p); console.error('render failed', p, err); });
      this.pending.set(p, job);
    }
    return null;
  }
  wanted() {
    const v = this.view(), base = v.left || v.right || 1;
    const out = [];
    for (let d = -3; d <= 4; d++) out.push(base + d);
    return out.filter(p => p >= 1 && p <= this.n);
  }
  prefetch() {
    // current pages first, then forward, then back
    const v = this.view();
    [v.left, v.right].forEach(p => this.ensure(p));
    this.wanted().sort((a, b) => Math.abs(a - (v.right || v.left)) - Math.abs(b - (v.right || v.left))).forEach(p => this.ensure(p));
  }

  /** spec: null (empty) | {page, ghost?:bool} */
  paint(slot, spec, force = false) {
    if (!force && slot.spec && spec && slot.spec.page === spec.page && !!slot.spec.ghost === !!spec.ghost) return;
    if (!force && slot.spec === null && spec === null) return;
    slot.spec = spec;
    slot.classList.toggle('empty', !spec);
    const cv = slot.canvas, ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!spec) return;
    const src = this.cache.get(spec.page) || (this.ensure(spec.page), this.cache.get(spec.page));
    ctx.fillStyle = spec.ghost ? '#fbf8f1' : '#fffdf8';
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (!src) return;
    const x = (cv.width - src.width) / 2, y = (cv.height - src.height) / 2;
    if (spec.ghost) {
      // reverse side of a single sheet: faint show-through of the front
      ctx.globalAlpha = 0.09;
      ctx.translate(cv.width, 0); ctx.scale(-1, 1);
      ctx.drawImage(src, x, y);
      ctx.globalAlpha = 1;
    } else {
      ctx.drawImage(src, x, y);
    }
  }

  showStatic() {
    const v = this.view();
    this.stage.classList.remove('mirror', 'turning');
    this.paint(this.sLeft, this.spread && v.left ? { page: v.left } : null);
    this.paint(this.sFront, v.right ? { page: v.right } : null);
    this.sFront.style.clipPath = '';
    this.sUnder.style.visibility = 'hidden';
    this.underShade.style.visibility = 'hidden';
    this.flapWrap.style.visibility = 'hidden';
    this.frontBar.style.opacity = 0;
    this.baseL.classList.toggle('on', !!(this.spread && v.left));
    this.baseR.classList.toggle('on', !!v.right);
    this.gutter.style.display = this.spread && v.left && v.right ? '' : 'none';
    // a lone cover (or back page) sits centred instead of off to one side
    const shift = this.spread && !v.left ? -this.W / 2 : this.spread && !v.right ? this.W / 2 : 0;
    this.book.style.transform = shift ? `translateX(${shift}px)` : '';
    this.updateEdges();
    this.book.setAttribute('aria-label', this.label());
    this.prefetch();
    this.onChange(this.state());
  }
  label() {
    const s = this.state();
    return s.pages.length > 1 ? `Pages ${s.first} and ${s.last} of ${s.total}` : `Page ${s.first} of ${s.total}`;
  }
  updateEdges() {
    const v = this.view();
    const before = (v.left || v.right) - 1, after = this.n - (v.right || v.left);
    const px = c => clamp(Math.round(Math.sqrt(c) * 1.6), 0, 12);
    this.edgeL.style.width = (this.spread && v.left ? px(before) : 0) + 'px';
    this.edgeR.style.width = (v.right ? px(after) : 0) + 'px';
  }

  // ---------- turn setup ----------
  /** dir: 'next' | 'prev'; corner: 'top' | 'bottom' */
  beginTurn(dir, corner) {
    if (dir === 'next' ? !this.canNext() : !this.canPrev()) return null;
    const W = this.W, H = this.H, v = this.view();
    const C = { x: 2 * W, y: corner === 'top' ? 0 : H };
    let t;
    if (this.spread && dir === 'next') {
      const r = v.right;
      t = { mode: 'normal', front: r, back: r + 1, under: r + 2 <= this.n ? r + 2 : null, staticLeft: v.left, target: this.anchor(r + 1) };
    } else if (this.spread) {
      const l = v.left;
      t = { mode: 'mirror', front: l, back: l - 1, under: l - 2 >= 1 ? l - 2 : null, staticLeft: v.right, target: this.anchor(l - 1) };
    } else if (dir === 'next') {
      const p = this.page;
      t = { mode: 'normal', front: p, back: p, ghost: true, under: p + 1, staticLeft: null, target: p + 1 };
    } else {
      const p = this.page;
      t = { mode: 'reverse', front: p - 1, back: p - 1, ghost: true, under: p, staticLeft: null, target: p - 1 };
    }
    Object.assign(t, { dir, C, corner });
    if (t.mode === 'reverse') { t.cancelP = { x: 0, y: C.y }; t.commitP = { ...C }; }
    else { t.cancelP = { ...C }; t.commitP = { x: 0, y: C.y }; }
    t.P = { ...t.cancelP };

    this.stage.classList.toggle('mirror', t.mode === 'mirror');
    this.stage.classList.add('turning');
    this.paint(this.sLeft, t.staticLeft && this.spread ? { page: t.staticLeft } : null);
    this.paint(this.sUnder, t.under ? { page: t.under } : null);
    this.paint(this.sFront, { page: t.front });
    this.paint(this.flap, { page: t.back, ghost: !!t.ghost });
    this.sUnder.style.visibility = '';
    this.underShade.style.visibility = '';
    this.flapWrap.style.visibility = '';
    this.baseL.classList.toggle('on', !!(this.spread && t.staticLeft));
    this.baseR.classList.toggle('on', !!t.under);
    this.underShade.style.display = t.under ? '' : 'none';
    this.gutter.style.display = this.spread && t.staticLeft ? '' : 'none';
    [t.front, t.back, t.under].forEach(p => this.ensure(p));
    this.turn = t;
    this.setP(t.P);
    return t;
  }

  clampP(P) {
    const W = this.W, H = this.H, top = this.turn.C.y === 0;
    const near = { x: W, y: top ? 0 : H }, far = { x: W, y: top ? H : 0 };
    let p = limitTo(P, near, W);
    p = limitTo(p, far, Math.hypot(W, H));
    return p;
  }

  progress(P = this.turn.P) {
    const t = this.turn;
    return clamp((P.x - t.cancelP.x) / (t.commitP.x - t.cancelP.x), 0, 1);
  }

  setP(Praw) {
    const t = this.turn;
    if (!t) return;
    const P = this.clampP(Praw);
    t.P = P;
    const W = this.W, H = this.H, C = t.C;
    const dx = C.x - P.x, dy = C.y - P.y, len = Math.hypot(dx, dy);
    if (len < 0.75) {
      // flat: nothing lifted
      this.sFront.style.clipPath = '';
      this.flapWrap.style.opacity = 0;
      this.underShade.style.opacity = 0;
      this.frontBar.style.opacity = 0;
      return;
    }
    this.flapWrap.style.opacity = 1;
    this.underShade.style.opacity = 1;
    const nx = dx / len, ny = dy / len; // normal pointing to the corner side
    const mx = (C.x + P.x) / 2, my = (C.y + P.y) / 2;
    const side = p => (p[0] - mx) * nx + (p[1] - my) * ny;
    const rect = [[W, 0], [2 * W, 0], [2 * W, H], [W, H]];
    const corner = clipPoly(rect, side);
    const flat = clipPoly(rect, p => -side(p));

    // flat part of the turning sheet
    this.sFront.style.clipPath = polyCss(flat, W);
    this.underShade.style.clipPath = polyCss(corner, W);

    // folded flap: reflection across the fold line, showing the reverse side
    const ux = -ny, uy = nx;
    const R00 = ux * ux - uy * uy, R01 = 2 * ux * uy, R11 = uy * uy - ux * ux;
    const F = (x, y) => [mx + R00 * (x - mx) + R01 * (y - my), my + R01 * (x - mx) + R11 * (y - my)];
    const [e, f] = F(2 * W, 0);
    this.flap.style.transform = `matrix(${-R00},${-R01},${R01},${R11},${e},${f})`;
    const flapPoly = corner.map(p => [2 * W - p[0], p[1]]);
    this.flap.style.clipPath = polyCss(flapPoly);

    // shading
    const prog = this.progress(P);
    const lift = Math.sin(Math.PI * clamp(len / (2 * W), 0, 1));
    const diag = Math.hypot(W, H) * 2.2;
    const shadowW = clamp(len * 0.32, 6, W * 0.42);
    this.setBar(this.underBar, mx - W, my, nx, ny, shadowW, diag);
    this.underBar.style.opacity = 0.35 + 0.55 * lift;
    this.setBar(this.frontBar, mx - W, my, -nx, -ny, clamp(len * 0.16, 4, W * 0.18), diag);
    this.frontBar.style.opacity = 0.25 + 0.5 * lift;
    this.setBar(this.flapBar, 2 * W - mx, my, -nx, ny, clamp(len * 0.5, 8, W * 0.7), diag);
    this.flapBar.style.opacity = 0.6 + 0.4 * lift;
    this.setBar(this.flapGloss, 2 * W - mx, my, -nx, ny, clamp(len * 0.14, 3, W * 0.12), diag);
    const blur = 4 + 18 * lift;
    this.flapWrap.style.filter = `drop-shadow(0 ${2 + 4 * lift}px ${blur}px rgba(38, 28, 16, ${0.16 + 0.22 * lift}))`;
    t.prog = prog;
  }

  setBar(el, mx, my, nx, ny, width, L) {
    // a strip whose top edge lies on the fold line, extending along (nx, ny)
    const ang = Math.atan2(-nx, ny);
    el.style.width = L + 'px';
    el.style.height = width + 'px';
    el.style.transform = `translate(${mx}px,${my}px) rotate(${ang}rad) translate(${-L / 2}px,0)`;
  }

  // ---------- animation ----------
  animateTo(target, duration, done, arc = 0) {
    cancelAnimationFrame(this.raf);
    const t = this.turn, from = { ...t.P }, start = performance.now();
    const ease = arc ? easeInOut : easeOut;
    t.animating = true;
    const step = now => {
      if (this.turn !== t) return;
      const k = duration <= 0 ? 1 : clamp((now - start) / duration, 0, 1);
      const e = ease(k);
      const lift = Math.sin(Math.PI * e) * arc * (t.C.y === 0 ? 1 : -1);
      this.setP({ x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e + lift });
      if (k < 1) this.raf = requestAnimationFrame(step);
      else { t.animating = false; done && done(); }
    };
    this.raf = requestAnimationFrame(step);
  }

  settle(commit, fromAuto = false) {
    const t = this.turn;
    if (!t) return;
    t.settling = commit ? 'commit' : 'cancel';
    const target = commit ? t.commitP : t.cancelP;
    if (this.reducedMotion && !fromAuto) return this.finishTurnNow(commit);
    const dist = Math.abs(target.x - t.P.x) / (2 * this.W);
    const dur = fromAuto ? 720 : 180 + 420 * dist;
    this.animateTo(target, dur, () => this.finishTurnNow(commit), fromAuto ? this.H * 0.07 : 0);
  }

  finishTurnNow(commit) {
    const t = this.turn;
    if (!t) return;
    cancelAnimationFrame(this.raf);
    this.turn = null;
    if (commit) this.page = this.anchor(t.target);
    this.showStatic();
    if (this.queue.length) {
      const next = this.queue.shift();
      setTimeout(() => this.go(next), 0);
    }
  }

  // ---------- public navigation ----------
  next() { this.go('next'); }
  prev() { this.go('prev'); }
  go(dir) {
    if (this.drag) return;
    if (this.turn) {
      if (this.turn.settling || this.turn.auto) {
        // stack quick presses: finish the running turn, then do this one
        if (this.queue.length < 3) this.queue.push(dir);
        if (this.queue.length > 1 || this.reducedMotion) this.finishTurnNow(this.turn.settling !== 'cancel');
        return;
      }
      this.finishTurnNow(false); // a peek
    }
    if (dir === 'next' ? !this.canNext() : !this.canPrev()) return;
    if (this.reducedMotion) {
      this.page = this.anchor(dir === 'next' ? (this.spread ? this.view().right + 1 : this.page + 1) : (this.spread ? this.view().left - 1 : this.page - 1));
      this.fade();
      this.showStatic();
      return;
    }
    const t = this.beginTurn(dir, 'bottom');
    if (!t) return;
    t.auto = true;
    if (t.mode !== 'reverse') this.setP({ x: t.C.x - this.W * 0.04, y: t.C.y - this.H * 0.02 });
    this.settle(true, true);
  }
  goTo(p) {
    if (this.turn) this.finishTurnNow(false);
    const a = this.anchor(p);
    if (a === this.page) return;
    this.page = a;
    if (this.reducedMotion) this.fade();
    this.showStatic();
  }
  fade() {
    this.stage.classList.remove('fade');
    void this.stage.offsetWidth;
    this.stage.classList.add('fade');
  }
  setReducedMotion(v) { this.reducedMotion = v; }

  // ---------- pointer ----------
  toNorm(e, mirror) {
    const r = this.stage.getBoundingClientRect();
    let x = e.clientX - r.left, y = e.clientY - r.top;
    if (mirror) x = 2 * this.W - x;
    return { x, y };
  }

  onDown(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (this.turn && (this.turn.auto || this.turn.settling)) this.finishTurnNow(this.turn.settling !== 'cancel');
    const p = this.toNorm(e, false);
    this.drag = { id: e.pointerId, start: p, startTime: performance.now(), last: [], started: false, type: e.pointerType };
    try { this.book.setPointerCapture(e.pointerId); } catch {}
    // spread: the grabbed page decides direction immediately, and the corner lifts on press
    if (this.spread) {
      const dir = p.x >= this.W ? 'next' : 'prev';
      const corner = p.y < this.H / 2 ? 'top' : 'bottom';
      if (this.turn && (this.turn.dir !== dir || this.turn.corner !== corner)) this.finishTurnNow(false);
      if (!this.turn) this.beginTurn(dir, corner);
      if (this.turn) this.startDrag(e);
    }
  }

  startDrag(e) {
    const t = this.turn, d = this.drag;
    d.started = true;
    d.origin = this.toNorm(e, t.mode === 'mirror');
    // corner lifts first: a small initial curl, then the fold follows the drag
    const base = t.mode === 'reverse' ? t.cancelP : t.C;
    const cur = t.P;
    const lifted = t.mode === 'reverse' ? base : { x: base.x - this.W * 0.07, y: base.y + (t.C.y === 0 ? 1 : -1) * this.H * 0.035 };
    // continue from a peek if one is showing
    d.anchorP = Math.hypot(cur.x - base.x, cur.y - base.y) > Math.hypot(lifted.x - base.x, lifted.y - base.y) ? { ...cur } : lifted;
    d.target = { ...d.anchorP };
    this.root.classList.add('fb-dragging');
    this.loop();
  }

  loop() {
    cancelAnimationFrame(this.raf);
    const step = () => {
      const t = this.turn, d = this.drag;
      if (!t || !d || !d.started) return;
      const P = t.P, tg = d.target;
      const k = 0.45; // light smoothing so the paper feels like it has mass
      this.setP({ x: P.x + (tg.x - P.x) * k, y: P.y + (tg.y - P.y) * k });
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  onMove(e) {
    const d = this.drag;
    if (!d) return this.hover(e);
    if (e.pointerId !== d.id) return;
    const raw = this.toNorm(e, false);
    const mdx = raw.x - d.start.x, mdy = raw.y - d.start.y;
    if (d.dead) return;
    if (!d.started) {
      if (this.spread || Math.hypot(mdx, mdy) < 6) return;
      // single-page: direction of the first movement decides
      const dir = mdx < 0 ? 'next' : 'prev';
      const corner = d.start.y < this.H / 2 ? 'top' : 'bottom';
      if (this.turn) this.finishTurnNow(false);
      if (!this.beginTurn(dir, corner)) { this.drag.dead = true; return; }
      this.startDrag(e);
      d.origin = this.toNorm({ clientX: e.clientX - mdx, clientY: e.clientY - mdy }, false);
    }
    if (d.dead) return;
    const t = this.turn;
    if (!t) return;
    const p = this.toNorm(e, t.mode === 'mirror');
    d.target = { x: d.anchorP.x + (p.x - d.origin.x), y: d.anchorP.y + (p.y - d.origin.y) };
    const now = performance.now();
    d.last.push({ x: p.x, t: now });
    while (d.last.length > 1 && now - d.last[0].t > 90) d.last.shift();
    e.preventDefault();
  }

  onUp(e, cancelled = false) {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.drag = null;
    this.root.classList.remove('fb-dragging');
    try { this.book.releasePointerCapture(e.pointerId); } catch {}
    const raw = this.toNorm(e, false);
    const moved = Math.hypot(raw.x - d.start.x, raw.y - d.start.y);
    const quick = performance.now() - d.startTime < 450;
    if (!cancelled && moved < 8 && quick) {
      // a tap: turn toward the tapped side
      const right = this.spread ? d.start.x >= this.W : d.start.x >= this.W + this.W * 0.35;
      if (this.turn) this.finishTurnNow(false);
      this.go(right ? 'next' : 'prev');
      return;
    }
    const t = this.turn;
    if (!t || !d.started) return;
    cancelAnimationFrame(this.raf);
    t.P = this.clampP(d.target);
    this.setP(t.P);
    let v = 0;
    if (d.last.length > 1) {
      const a = d.last[0], b = d.last[d.last.length - 1];
      v = (b.x - a.x) / Math.max(1, b.t - a.t); // px/ms in normalized frame
    }
    const towardCommit = Math.sign(t.commitP.x - t.cancelP.x);
    const prog = this.progress();
    const flick = v * towardCommit > 0.45 && prog > 0.04;
    const backFlick = v * towardCommit < -0.45;
    const commit = !cancelled && !backFlick && (prog > 0.32 || flick);
    this.settle(commit);
  }

  // hover peek: on desktop, the corner lifts a little when the pointer approaches it
  hover(e) {
    if (e.pointerType !== 'mouse' || !this.spread || this.reducedMotion) return;
    if (this.turn && (this.turn.auto || this.turn.settling)) return;
    const p = this.toNorm(e, false), W = this.W, H = this.H;
    const zone = Math.min(W, H) * 0.16;
    let dir = null, corner = null;
    if (p.x > 2 * W - zone && this.canNext()) dir = 'next';
    else if (p.x < zone && this.canPrev()) dir = 'prev';
    if (dir) {
      if (p.y > H - zone) corner = 'bottom'; else if (p.y < zone) corner = 'top'; else dir = null;
    }
    if (!dir) return this.endPeek();
    if (this.turn && (this.turn.dir !== dir || this.turn.corner !== corner)) this.finishTurnNow(false);
    if (!this.turn) { this.beginTurn(dir, corner); this.turn.peek = true; }
    const t = this.turn;
    const q = this.toNorm(e, t.mode === 'mirror');
    const C = t.C;
    // peek follows the pointer softly, never more than a small curl
    const tx = C.x - W * 0.06 - (C.x - q.x) * 0.35;
    const ty = C.y + (C.y === 0 ? 1 : -1) * H * 0.03 - (C.y - q.y) * 0.35;
    this.animateTo({ x: tx, y: ty }, 160);
  }
  endPeek() {
    const t = this.turn;
    if (!t || !t.peek || this.drag || t.settling) return;
    t.settling = 'cancel';
    this.animateTo(t.cancelP, 200, () => this.finishTurnNow(false));
  }
}
