// Zoomed reading: the visible page(s) laid flat at a larger size, re-rendered
// sharply from the PDF, and panned by scrolling or dragging.

const MAX_SIDE = 8192;
const MAX_PIXELS = 24e6; // per page canvas

export class ZoomView {
  /**
   * @param {HTMLElement} host
   * @param {{pdf:any, getPreview:(p:number)=>HTMLCanvasElement|undefined, onDoubleClick?:(e:MouseEvent)=>void}} opts
   */
  constructor(host, opts) {
    this.pdf = opts.pdf;
    this.getPreview = opts.getPreview;
    this.el = document.createElement('div');
    this.el.className = 'zoom';
    this.el.hidden = true;
    this.el.tabIndex = -1;
    this.content = document.createElement('div');
    this.content.className = 'zoom-content';
    this.spreadEl = document.createElement('div');
    this.spreadEl.className = 'zoom-spread';
    this.content.appendChild(this.spreadEl);
    this.el.appendChild(this.content);
    host.appendChild(this.el);
    this.pages = [];
    this.key = '';
    this.token = 0;
    this.tasks = [];
    this.el.addEventListener('dblclick', e => opts.onDoubleClick && opts.onDoubleClick(e));
    this.bindPan();
  }

  bindPan() {
    // mouse drag pans; touch uses native scrolling
    let pan = null;
    this.el.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      pan = { x: e.clientX, y: e.clientY, sl: this.el.scrollLeft, st: this.el.scrollTop, id: e.pointerId };
      this.el.setPointerCapture(e.pointerId);
      this.el.classList.add('panning');
    });
    this.el.addEventListener('pointermove', e => {
      if (!pan || e.pointerId !== pan.id) return;
      this.el.scrollLeft = pan.sl - (e.clientX - pan.x);
      this.el.scrollTop = pan.st - (e.clientY - pan.y);
    });
    const end = e => {
      if (!pan || e.pointerId !== pan.id) return;
      pan = null;
      this.el.classList.remove('panning');
    };
    this.el.addEventListener('pointerup', end);
    this.el.addEventListener('pointercancel', end);
  }

  /**
   * @param {{pages:number[], W:number, H:number, z:number, marks:Set<number>}} s
   * @param {{x:number,y:number}=} anchor client point that should stay put while zooming
   */
  update(s, anchor) {
    this.el.hidden = false;
    const pagesKey = s.pages.join(',');
    const pagesChanged = pagesKey !== this.pages.join(',');
    // remember where the anchor sits on the spread before resizing
    let fx = 0.5, fy = 0.5, ax, ay;
    const vr = this.el.getBoundingClientRect();
    if (!pagesChanged && this.spreadEl.offsetWidth) {
      const r = this.spreadEl.getBoundingClientRect();
      ax = anchor ? anchor.x : vr.left + vr.width / 2;
      ay = anchor ? anchor.y : vr.top + vr.height / 2;
      fx = (ax - r.left) / r.width;
      fy = (ay - r.top) / r.height;
    }
    if (pagesChanged) this.build(s.pages);
    const w = Math.round(s.W * s.z), h = Math.round(s.H * s.z);
    for (const pg of this.pageEls) {
      pg.style.width = w + 'px';
      pg.style.height = h + 'px';
      pg.ribbon.classList.toggle('on', s.marks.has(pg.page));
      pg.ribbon.style.height = Math.round(h * 0.17) + 'px';
      pg.ribbon.style.left = pg.side === 'left' ? Math.round(w * 0.1) + 'px' : Math.round(w * 0.9 - 22) + 'px';
    }
    if (pagesChanged) {
      // new pages: start at the top, horizontally centred
      this.el.scrollTop = 0;
      this.el.scrollLeft = (this.el.scrollWidth - this.el.clientWidth) / 2;
    } else if (ax !== undefined) {
      const r2 = this.spreadEl.getBoundingClientRect();
      this.el.scrollLeft += r2.left + fx * r2.width - ax;
      this.el.scrollTop += r2.top + fy * r2.height - ay;
    }
    this.s = s;
    const key = `${pagesKey}|${w}x${h}`;
    if (key !== this.key) {
      this.key = key;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.renderSharp(), pagesChanged ? 0 : 180);
    }
  }

  build(pages) {
    this.cancel();
    this.pages = pages.slice();
    this.spreadEl.innerHTML = '';
    this.spreadEl.classList.toggle('two', pages.length > 1);
    this.pageEls = pages.map((p, i) => {
      const pg = document.createElement('div');
      pg.className = 'zoom-page';
      pg.page = p;
      pg.side = pages.length > 1 && i === 0 ? 'left' : 'right';
      const c = document.createElement('canvas');
      const prev = this.getPreview(p);
      if (prev) {
        c.width = prev.width; c.height = prev.height;
        c.getContext('2d').drawImage(prev, 0, 0);
      } else { c.width = 2; c.height = 2; }
      pg.canvas = c;
      pg.ribbon = document.createElement('div');
      pg.ribbon.className = 'fb-ribbon';
      pg.append(c, pg.ribbon);
      this.spreadEl.appendChild(pg);
      return pg;
    });
  }

  cancel() {
    this.token++;
    for (const t of this.tasks) { try { t.cancel(); } catch {} }
    this.tasks = [];
  }

  async renderSharp() {
    this.cancel();
    const token = this.token;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const pg of this.pageEls) {
      try {
        const page = await this.pdf.getPage(pg.page);
        if (token !== this.token) return;
        const vp1 = page.getViewport({ scale: 1 });
        let tw = pg.offsetWidth * dpr, th = pg.offsetHeight * dpr;
        const cap = Math.min(1, MAX_SIDE / Math.max(tw, th), Math.sqrt(MAX_PIXELS / (tw * th)));
        tw *= cap; th *= cap;
        const vp = page.getViewport({ scale: Math.min(tw / vp1.width, th / vp1.height) });
        const c = document.createElement('canvas');
        c.width = Math.floor(vp.width);
        c.height = Math.floor(vp.height);
        const ctx = c.getContext('2d', { alpha: false });
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, c.width, c.height);
        const task = page.render({ canvasContext: ctx, viewport: vp });
        this.tasks.push(task);
        await task.promise;
        if (token !== this.token) return;
        pg.replaceChild(c, pg.canvas);
        pg.canvas = c;
      } catch (err) {
        if (err && err.name === 'RenderingCancelledException') return;
        console.error('zoom render failed', err);
      }
    }
  }

  hide() {
    this.cancel();
    clearTimeout(this.timer);
    this.el.hidden = true;
    this.key = '';
    this.pages = [];
    this.spreadEl.innerHTML = '';
    this.pageEls = [];
  }

  destroy() {
    this.hide();
    this.el.remove();
  }
}
