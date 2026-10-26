// @ts-check
// Room logic with no Cloudflare or DOM types: takes a storage object, returns what to send. The Durable Object
// (worker/room.js) is a thin shell around this, so node can test it with a fake storage (DESIGN.md sections 2, 5).
import { MAX_PATIENTS, SCHEMA_VERSION, TARGETS, numericsOf, defaultPatient, defaultState, fillDefaults, validatePatch } from '../shared/schema.js';
import { displayed, restartGlide } from '../engine/glide.js';

/** @typedef {import('../shared/schema.js').RoomState} RoomState */

export const IDLE_MS = 24 * 60 * 60 * 1000;
export const MAX_MESSAGE_CHARS = 16 * 1024;
export const MAX_PER_SECOND = 30;
export const SILENCE_MS = 120000;
export const MAX_EVENTS = 20;
export const MAX_TEST_CHARS = 1024;

/**
 * @typedef {{ kind: string, what: string, p?: string }} EventInfo
 * @typedef {{
 *   get(key: string): Promise<any>,
 *   put(key: string, value: any): Promise<void>,
 *   setAlarm(ms: number): Promise<void>,
 *   deleteAll(): Promise<void>
 * }} HubStorage
 * @typedef {{ reply?: object, broadcast?: object }} HubResult
 */

export class RoomHub {
  /**
   * @param {HubStorage} storage
   * @param {() => number} [clock]
   */
  constructor(storage, clock = Date.now) {
    this.storage = storage;
    this.clock = clock;
    /** @type {RoomState | null} */
    this.cache = null;
    /** @type {Map<string, number[]>} message times per client, for the rate limit */
    this.recent = new Map();
  }

  /** @returns {Promise<RoomState>} */
  async state() {
    if (!this.cache) {
      const stored = await this.storage.get('state');
      this.cache = fillDefaults(/** @type {RoomState} */ (stored ?? defaultState(this.clock())));
    }
    return this.cache;
  }

  /** First message to a client that just connected: the current state, so a late joiner is up to date. */
  async hello() {
    return { t: 'state', state: await this.state(), now: this.clock() };
  }

  /**
   * @param {string} clientId
   * @param {string} text one frame
   * @returns {Promise<HubResult>}
   */
  async onMessage(clientId, text) {
    const now = this.clock();
    if (typeof text !== 'string' || text.length > MAX_MESSAGE_CHARS) return { reply: err('too_big', 'message too large') };
    if (!this.allow(clientId, now)) return { reply: err('rate', 'too many messages') };
    /** @type {any} */
    let msg;
    try { msg = JSON.parse(text); } catch { return { reply: err('bad_json', 'not JSON') }; }
    if (typeof msg !== 'object' || msg === null || typeof msg.t !== 'string') return { reply: err('bad_json', 'missing t') };

    switch (msg.t) {
      case 'ping': return { reply: { t: 'pong', n: msg.n ?? null, now } };
      case 'hello': return { reply: await this.hello() };
      case 'set': return this.apply(clientId, now, msg, (s) => this.doSet(s, msg, now));
      case 'nibp': {
        const cur = pick(await this.state(), msg.p);
        if (cur && msg.after !== undefined && msg.after !== cur.nibpRead.at) return {};
        return this.apply(clientId, now, msg, (s) => this.doNibp(s, msg.p, now));
      }
      case 'addPatient': return this.apply(clientId, now, msg, (s) => this.doAdd(s, msg, now));
      case 'removePatient': return this.apply(clientId, now, msg, (s) => this.doRemove(s, msg));
      case 'silence': return this.apply(clientId, now, msg, (s) => { s.alarms.silencedUntil = now + SILENCE_MS; return { kind: 'silence', what: 'silence' }; });
      case 'mark': return this.apply(clientId, now, msg, (s) => this.doMark(s, msg));
      case 'flush': return this.apply(clientId, now, msg, (s) => this.doFlush(s, msg));
      case 'test': return this.apply(clientId, now, msg, (s) => {
        if (JSON.stringify(msg.value ?? null).length > MAX_TEST_CHARS) throw new BadPatch('test value too large');
        s.test = msg.value;
        return { kind: 'test', what: 'test' };
      });
      default: return { reply: err('bad_json', `unknown type ${msg.t}`) };
    }
  }

  /**
   * Run a change on a copy of the state, then store it, bump `rev`, schedule expiry and broadcast.
   * @param {string} clientId
   * @param {number} now
   * @param {object} _msg
   * @param {(s: RoomState) => EventInfo} change returns the event-log entry (kind, short text, patient id if any)
   * @returns {Promise<HubResult>}
   */
  async apply(clientId, now, _msg, change) {
    const before = await this.state();
    const next = structuredClone(before);
    let info;
    try { info = change(next); } catch (e) {
      if (e instanceof BadPatch) return { reply: err('bad_patch', e.message) };
      throw e;
    }
    next.rev = before.rev + 1;
    next.events.push({ t: now, by: clientId, kind: info.kind, ...(info.p ? { p: info.p } : {}), what: info.what });
    if (next.events.length > MAX_EVENTS) next.events.splice(0, next.events.length - MAX_EVENTS);
    await this.storage.put('state', next);
    await this.storage.put('last', now);
    await this.storage.setAlarm(now + IDLE_MS);
    this.cache = next;
    return { broadcast: { t: 'state', state: next, now } };
  }

  /**
   * @param {RoomState} s the copy to change
   * @param {any} msg `p` names the patient (default: the first)
   * @param {number} now
   */
  doSet(s, msg, now) {
    const v = validatePatch(msg.patch);
    if (!v.ok) throw new BadPatch(v.msg);
    const p = v.patch;
    const pt = pick(s, msg.p);
    if (!pt) throw new BadPatch('unknown patient');
    const before = structuredClone(pt);
    if (p.patient) {
      const { nibp, abp, abp2, off, ...flat } = p.patient;
      Object.assign(pt, flat);
      if (nibp) Object.assign(pt.nibp, nibp);
      if (abp) Object.assign(pt.abp, abp);
      if (abp2) Object.assign(pt.abp2, abp2);
      if (off) Object.assign(pt.off, off);
    }
    if (p.modules) s.modules = p.modules;
    if (p.alarms) {
      if (p.alarms.limits) Object.assign(s.alarms.limits, p.alarms.limits);
      if ('enabled' in p.alarms) s.alarms.enabled = p.alarms.enabled;
    }
    if (p.nibp) Object.assign(pt.nibpRead, p.nibp);
    if (p.theme) {
      s.theme = p.theme;
      if (p.theme === 'default') delete s.themeJson; // back to the default for every monitor
    }
    if (p.themeJson) s.themeJson = p.themeJson;

    if (p.patient && TARGETS.some((k) => k in p.patient)) {
      let ms = pt.glideMs;
      if (msg.glideMs !== undefined) {
        if (typeof msg.glideMs !== 'number' || !(msg.glideMs >= 0 && msg.glideMs <= 600000)) throw new BadPatch('glideMs out of range');
        ms = msg.glideMs;
      }
      pt.glide = restartGlide(before, now, ms);
    }
    return { kind: p.patient && 'rhythm' in p.patient ? 'rhythm' : 'set', what: `set ${Object.keys(p).join(',')}`, p: pt.id };
  }

  /**
   * @param {RoomState} s
   * @param {string | undefined} id
   * @param {number} now
   */
  doNibp(s, id, now) {
    const pt = pick(s, id);
    if (!pt) throw new BadPatch('unknown patient');
    const d = displayed(pt, now).nibp;
    pt.nibpRead.sys = Math.round(d.sys);
    pt.nibpRead.dia = Math.round(d.dia);
    pt.nibpRead.at = now;
    return { kind: 'nibp', what: 'nibp', p: pt.id };
  }

  /**
   * @param {RoomState} s
   * @param {any} msg
   * @param {number} now
   */
  doAdd(s, msg, now) {
    if (s.patients.length >= MAX_PATIENTS) throw new BadPatch(`at most ${MAX_PATIENTS} patients`);
    let label = `Bed ${s.patients.length + 1}`;
    if (msg.label !== undefined) {
      if (typeof msg.label !== 'string' || !msg.label.trim() || msg.label.length > 24) throw new BadPatch('label must be 1-24 characters');
      label = msg.label.trim();
    }
    let n = 1;
    while (s.patients.some((x) => x.id === `p${n}`)) n++;
    s.patients.push(defaultPatient(`p${n}`, label, now));
    return { kind: 'patient', what: `add p${n}`, p: `p${n}` };
  }

  /**
   * @param {RoomState} s
   * @param {any} msg
   */
  doRemove(s, msg) {
    if (s.patients.length <= 1) throw new BadPatch('cannot remove the last patient');
    const i = s.patients.findIndex((x) => x.id === msg.p);
    if (i < 0) throw new BadPatch('unknown patient');
    s.patients.splice(i, 1);
    return { kind: 'patient', what: `remove ${msg.p}`, p: msg.p };
  }

  /**
   * Bookmark in the event log (for debriefs); `text` is optional, `p` names a patient.
   * @param {RoomState} s
   * @param {any} msg
   */
  doMark(s, msg) {
    if (msg.text !== undefined && (typeof msg.text !== 'string' || msg.text.length > 200)) throw new BadPatch('text must be up to 200 characters');
    if (msg.p !== undefined && !pick(s, msg.p)) throw new BadPatch('unknown patient');
    return { kind: 'bookmark', what: msg.text ? `mark ${msg.text}` : 'mark', ...(msg.p ? { p: msg.p } : {}) };
  }

  /**
   * Flush test of an arterial line: only an event (kind `flush`, `what` = the line, `abp` or `abp2`); every monitor draws
   * the square wave and ringing from the event time. Nothing in the patient changes.
   * @param {RoomState} s
   * @param {any} msg
   */
  doFlush(s, msg) {
    const pt = pick(s, msg.p);
    if (!pt) throw new BadPatch('unknown patient');
    const line = msg.line ?? 'abp';
    if (line !== 'abp' && line !== 'abp2') throw new BadPatch('line must be abp or abp2');
    return { kind: 'flush', what: line, p: pt.id };
  }

  /**
   * Rate limit: at most MAX_PER_SECOND messages in any 1 s window per client.
   * @param {string} clientId
   * @param {number} now
   */
  allow(clientId, now) {
    const times = (this.recent.get(clientId) ?? []).filter((t) => now - t < 1000);
    if (times.length >= MAX_PER_SECOND) { this.recent.set(clientId, times); return false; }
    times.push(now);
    this.recent.set(clientId, times);
    return true;
  }

  /**
   * Storage alarm: delete the room if it has been idle for 24 h, else wait for the rest of the time.
   * @returns {Promise<{ expired: boolean }>}
   */
  async onAlarm() {
    const now = this.clock();
    const last = (await this.storage.get('last')) ?? 0;
    if (now - last >= IDLE_MS) {
      await this.storage.deleteAll();
      this.cache = null;
      this.recent.clear();
      return { expired: true };
    }
    await this.storage.setAlarm(last + IDLE_MS);
    return { expired: false };
  }
}

class BadPatch extends Error {}

/**
 * @param {RoomState} s
 * @param {unknown} id patient id, or undefined for the first patient
 */
function pick(s, id) {
  return id === undefined ? s.patients[0] : s.patients.find((x) => x.id === id);
}

/**
 * @param {string} code
 * @param {string} msg
 */
function err(code, msg) {
  return { t: 'error', code, msg };
}

export { SCHEMA_VERSION, numericsOf };
