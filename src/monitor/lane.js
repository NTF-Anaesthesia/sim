// @ts-check
// Sweeping trace on a canvas. Adapted from the NTF `ot` repo (ot/js/ui/lanes.js): a lane shows a fixed window of display
// time, the write point moves left to right and wraps, erasing a short gap ahead of itself like a theatre monitor.
// `refill` redraws one full sweep from the wave source's history (load, resize, speed change, tab back), so the screen
// is never blank. Colours, line width, gap and speed come from the theme through the options.

export class Lane {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{
   *   pxPerSec: number, color: string, lineWidth: number, gapPx: number, lo: number, hi: number,
   *   sample: (t: number) => number | null,
   *   scale?: { canvas: HTMLCanvasElement, lines: number[], font: string, px: number }
   * }} opts
   */
  constructor(canvas, opts) {
    this.c = canvas;
    this.pxPerSec = opts.pxPerSec;
    this.color = opts.color;
    this.lineWidth = opts.lineWidth;
    this.gapPx = opts.gapPx;
    this.lo = opts.lo;
    this.hi = opts.hi;
    this.sample = opts.sample;
    this.scale = opts.scale;
    /** @type {number | null} */
    this.last = null;
    /** @type {number | null} */
    this.lastY = null;
    this.w = 0;
    this.h = 0;
    this.dpr = 1;
    /** @type {CanvasRenderingContext2D | null} */
    this.ctx = null;
    this.blank = false;
  }

  get window() { return this.w / this.pxPerSec; }

  /** Size the backing store to the element (device pixels, capped at 2x). True when it changed. */
  fit() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = this.c.clientWidth;
    const h = this.c.clientHeight;
    if (!w || !h) return false;
    const W = Math.round(w * dpr);
    const H = Math.round(h * dpr);
    const changed = this.c.width !== W || this.c.height !== H || this.dpr !== dpr || !this.ctx;
    if (changed) { this.c.width = W; this.c.height = H; }
    this.w = w; this.h = h; this.dpr = dpr;
    this.ctx = this.c.getContext('2d');
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    return changed;
  }

  /** @param {number} t */
  x(t) {
    const p = t / this.window;
    return (p - Math.floor(p)) * this.w;
  }

  /** @param {number} v */
  y(v) {
    if (!Number.isFinite(v)) return null;
    const pad = 4;
    const f = (v - this.lo) / (this.hi - this.lo);
    return this.h - pad - Math.max(-0.05, Math.min(1.05, f)) * (this.h - 2 * pad);
  }

  /** The value farthest from the baseline within a pixel, so narrow waves (an R wave is about 20 ms) keep their height. */
  /** @param {number} s @param {number} step */
  peak(s, step) {
    let best = this.sample(s);
    if (best === null) return null;
    const mid = (this.lo + this.hi) / 2;
    for (let k = 1; k < 4; k++) {
      const v = this.sample(s - (step * k) / 4);
      if (v !== null && Math.abs(v - mid) > Math.abs(best - mid)) best = v;
    }
    return best;
  }

  clear() {
    this.ctx?.clearRect(0, 0, this.w, this.h);
    this.last = null;
    this.lastY = null;
  }

  /** Dotted reference lines with their values at the left, in the wave's colour but dim. Own canvas, so the sweep never erases them. */
  drawScale() {
    const sc = this.scale;
    if (!sc) return;
    const W = Math.round(this.w * this.dpr);
    const H = Math.round(this.h * this.dpr);
    if (sc.canvas.width !== W || sc.canvas.height !== H) { sc.canvas.width = W; sc.canvas.height = H; }
    const ctx = sc.canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = this.color;
    ctx.fillStyle = this.color;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 4]);
    ctx.font = `${sc.px}px ${sc.font}`;
    ctx.textBaseline = 'bottom';
    for (const v of sc.lines) {
      const y = this.y(v);
      if (y === null || y < 0 || y > this.h) continue;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(this.w, y);
      ctx.stroke();
      ctx.fillText(String(v), 3, y - 1);
    }
  }

  /** Redraw the whole window ending at display time t. */
  refill(/** @type {number} */ t) {
    this.fit();
    if (!this.ctx) return;
    this.drawScale();
    this.clear();
    if (!this.blank) this.draw(t, true);
  }

  /** Draw from the last drawn time up to display time t. */
  draw(/** @type {number} */ t, full = false) {
    if (this.blank) return;
    if (!this.ctx) { if (!this.fit()) return; full = true; }
    const ctx = /** @type {CanvasRenderingContext2D} */ (this.ctx);
    const step = this.window / (this.w * this.dpr);
    let from = this.last;
    if (full || from == null || t - from > this.window || t < from) {
      from = t - this.window;
      full = true;
      ctx.clearRect(0, 0, this.w, this.h);
      this.lastY = null;
    }
    if (t - from < step && !full) return;
    ctx.strokeStyle = this.color;
    ctx.lineWidth = this.lineWidth;
    ctx.lineJoin = 'round';
    let px = this.x(from);
    let py = this.lastY;
    ctx.beginPath();
    for (let s = from + step; s <= t + 1e-9; s += step) {
      const x = this.x(s);
      const pk = this.peak(s, step);
      const y = pk === null ? null : this.y(pk);
      if (x < px) { ctx.stroke(); ctx.beginPath(); py = null; } // wrapped: start again at the left edge
      ctx.clearRect(x + 1, 0, this.gapPx, this.h); // erase the gap ahead of the write point
      if (x + 1 + this.gapPx > this.w) ctx.clearRect(0, 0, x + 1 + this.gapPx - this.w, this.h);
      if (y != null) {
        if (py == null) ctx.moveTo(x, y);
        else { ctx.moveTo(px, py); ctx.lineTo(x, y); }
      }
      px = x;
      py = y;
    }
    ctx.stroke();
    this.last = from + Math.floor((t - from) / step + 1e-9) * step;
    this.lastY = py;
  }
}
