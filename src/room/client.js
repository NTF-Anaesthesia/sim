// @ts-check
// Browser client for a room: connect, reconnect with backoff, send, subscribe, estimate the server clock offset
// (DESIGN.md section 5). The WebSocket constructor and timers are injected so node can test it. No work on import.

/** @typedef {import('../shared/schema.js').RoomState} RoomState */
/** @typedef {'connecting' | 'open' | 'reconnecting' | 'full' | 'expired' | 'closed'} Status */

export const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
export const PING_EVERY_MS = 10000;

export class RoomClient {
  /**
   * @param {{
   *   url: string, WebSocketCtor?: typeof WebSocket, now?: () => number,
   *   setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (id: any) => void
   * }} opts url is the full wss://host/ws/CODE?role=..&id=.. address
   */
  constructor(opts) {
    this.url = opts.url;
    this.WS = opts.WebSocketCtor ?? WebSocket;
    this.now = opts.now ?? Date.now;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id));
    /** @type {RoomState | null} */
    this.state = null;
    /** @type {Status} */
    this.status = 'connecting';
    /** server clock minus local clock, ms (smallest-round-trip estimate) */
    this.offsetMs = 0;
    this.bestRtt = Infinity;
    this.attempt = 0;
    this.stopped = false;
    /** @type {WebSocket | null} */
    this.ws = null;
    this.pingTimer = null;
    this.retryTimer = null;
    this.pingN = 0;
    /** @type {Map<number, number>} */
    this.pings = new Map();
    /** @type {Map<string, Set<(arg: any) => void>>} */
    this.handlers = new Map();
    /** @type {{ monitors: number, controllers: number, screens: { s: string, dev: string[] }[] } | null} who is connected, from the server's `presence` message */
    this.presence = null;
    this.lastPongAt = 0;
    this.wakeTimer = null;
  }

  /**
   * @param {'state' | 'status' | 'error' | 'presence' | 'screen' | 'history'} name
   * @param {(arg: any) => void} fn
   * @returns {() => void} unsubscribe
   */
  on(name, fn) {
    if (!this.handlers.has(name)) this.handlers.set(name, new Set());
    /** @type {Set<(arg: any) => void>} */ (this.handlers.get(name)).add(fn);
    return () => this.handlers.get(name)?.delete(fn);
  }

  /** @param {string} name @param {any} arg */
  emit(name, arg) {
    for (const fn of this.handlers.get(name) ?? []) fn(arg);
  }

  /** @param {Status} s */
  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  /** Server time now, from the local clock and the estimated offset. */
  serverNow() {
    return this.now() + this.offsetMs;
  }

  connect() {
    this.stopped = false;
    const ws = new this.WS(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setStatus('open');
      this.sendPing();
      this.pingTimer = this.setTimer(() => this.pingLoop(), PING_EVERY_MS);
    };
    ws.onmessage = (ev) => this.onMessage(String(ev.data));
    ws.onclose = (ev) => this.onClose(ev.code);
    ws.onerror = () => {};
  }

  pingLoop() {
    this.sendPing();
    this.pingTimer = this.setTimer(() => this.pingLoop(), PING_EVERY_MS);
  }

  sendPing() {
    const n = ++this.pingN;
    this.pings.set(n, this.now());
    this.send({ t: 'ping', n });
  }

  /** @param {string} text */
  onMessage(text) {
    /** @type {any} */
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.t === 'state') {
      if (msg.state?.schema > 1) { this.emit('error', { code: 'schema', msg: 'update needed' }); return; }
      this.state = msg.state;
      if (this.bestRtt === Infinity && typeof msg.now === 'number') this.offsetMs = msg.now - this.now();
      this.emit('state', msg.state);
    } else if (msg.t === 'presence') {
      const screens = Array.isArray(msg.screens)
        ? msg.screens.filter((/** @type {any} */ x) => typeof x?.s === 'string').map((/** @type {any} */ x) => ({ s: x.s, dev: Array.isArray(x.dev) ? x.dev.map(String) : [] }))
        : [];
      this.presence = { monitors: Number(msg.monitors) || 0, controllers: Number(msg.controllers) || 0, screens };
      this.emit('presence', this.presence);
    } else if (msg.t === 'pong') {
      this.lastPongAt = this.now();
      const sent = this.pings.get(msg.n);
      this.pings.delete(msg.n);
      if (sent === undefined) return;
      const rtt = this.now() - sent;
      if (rtt < this.bestRtt) {
        this.bestRtt = rtt;
        this.offsetMs = msg.now + rtt / 2 - this.now();
      }
    } else if (msg.t === 'history') {
      this.emit('history', msg);
    } else if (msg.t === 'error') {
      this.emit('error', msg);
    } else if (msg.t === 'screenAdded' || msg.t === 'identify' || msg.t === 'clearDevice') {
      this.emit('screen', msg); // named screens (DESIGN.md section 4a)
    }
  }

  /**
   * Ask the room for its full log (events and glide records) for the last `range` ms, or all of it. Resolves with the
   * `history` reply, or null when the socket is not open or nothing came back within `timeoutMs`.
   * @param {{ range?: number, all?: boolean }} [opts]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  history(opts = {}, timeoutMs = 5000) {
    return new Promise((resolve) => {
      let off = () => {};
      const rid = (this.historySeq = (this.historySeq || 0) + 1); // the room echoes it, so overlapping asks stay apart
      const timer = setTimeout(() => { off(); resolve(null); }, timeoutMs);
      off = this.on('history', (m) => { if (m.rid !== rid) return; clearTimeout(timer); off(); resolve(m); });
      if (!this.send({ t: 'history', ...opts, rid })) { clearTimeout(timer); off(); resolve(null); }
    });
  }

  /**
   * Call when the page comes back (phone woke, network returned). A connection that went down is replaced at once
   * with no backoff wait; one that looks open is checked with a ping and replaced if no answer comes in `waitMs`.
   * @param {number} [waitMs]
   */
  wake(waitMs = 2500) {
    if (this.stopped || this.status === 'full' || this.status === 'expired') return;
    if (!this.ws || this.ws.readyState > 1) { this.reconnectNow(); return; }
    const before = this.lastPongAt;
    this.sendPing();
    this.clearTimer(this.wakeTimer);
    this.wakeTimer = this.setTimer(() => { if (this.lastPongAt === before) this.reconnectNow(); }, waitMs);
  }

  /** Drop the current socket (if any) and connect again now. */
  reconnectNow() {
    this.clearTimer(this.retryTimer);
    this.clearTimer(this.pingTimer);
    const old = this.ws;
    if (old) { old.onclose = null; old.onmessage = null; try { old.close(); } catch { /* already gone */ } }
    this.ws = null;
    this.attempt = 0;
    this.setStatus('reconnecting');
    this.connect();
  }

  /** @param {number} code */
  onClose(code) {
    this.clearTimer(this.pingTimer);
    this.ws = null;
    if (this.stopped) { this.setStatus('closed'); return; }
    if (code === 4002) { this.setStatus('full'); return; }
    if (code === 4001) { this.setStatus('expired'); return; }
    this.setStatus('reconnecting');
    const wait = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)];
    this.attempt++;
    this.retryTimer = this.setTimer(() => this.connect(), wait);
  }

  /** @param {object} msg */
  send(msg) {
    if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(msg)); return true; }
    return false;
  }

  /**
   * @param {object} patch allowed paths only (DESIGN.md section 5)
   * @param {number} [glideMs]
   */
  set(patch, glideMs) {
    return this.send(glideMs === undefined ? { t: 'set', patch } : { t: 'set', patch, glideMs });
  }

  close() {
    this.stopped = true;
    this.clearTimer(this.pingTimer);
    this.clearTimer(this.retryTimer);
    this.clearTimer(this.wakeTimer);
    this.ws?.close();
    this.setStatus('closed');
  }
}

/**
 * Build the socket address for a page.
 * @param {{ protocol: string, host: string }} loc
 * @param {string} code
 * @param {'monitor' | 'controller'} role
 * @param {string} id
 */
export function roomUrl(loc, code, role, id) {
  const scheme = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${loc.host}/ws/${code}?role=${role}&id=${id}`;
}

/** @param {'monitor' | 'controller'} role */
export function newClientId(role) {
  const hex = [...crypto.getRandomValues(new Uint8Array(2))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${role === 'monitor' ? 'm' : 'c'}-${hex}`;
}
