// @ts-check
// Room logic with no Cloudflare or DOM types: takes a storage object, returns what to send. The Durable Object
// (worker/room.js) is a thin shell around this, so node can test it with a fake storage (DESIGN.md sections 2, 5).
import {
  DEVICE_CHOICES, MAX_PATIENTS, MAX_SCREENS, SCHEMA_VERSION, SCREEN_ID, SCREEN_KINDS, SHOCK_JOULES, TARGETS, validatePace, numericsOf, defaultPatient,
  defaultState, fillDefaults, screenName, validateIam, validatePatch,
} from '../shared/schema.js';
import { displayed, restartGlide, startGlide, remainingMs, GLIDE_FIELDS } from '../engine/glide.js';
import { MAX_LOG_ROWS, makeLog } from './log.js';
import { nibpJitter } from '../engine/nibp.js';
import {
  LIBRARY_KIND, LIBRARY_VERSION, MAX_FILE_CHARS, MAX_STEPS, drugPatch, validateDrug, validateGlideMsBy, validateLibraryFile, validateScenario, validateStep,
} from '../shared/scenario.js';

/** @typedef {import('../shared/schema.js').RoomState} RoomState */

export const IDLE_MS = 24 * 60 * 60 * 1000;
export const MAX_MESSAGE_CHARS = 16 * 1024;
/** Only `libraryOffer` may be longer: a library file is up to 32 KB (DESIGN.md section 12). */
export const MAX_OFFER_CHARS = MAX_FILE_CHARS + 2048;
export const MAX_PER_SECOND = 30;
export const SILENCE_MS = 120000;
export const MAX_EVENTS = 20;
export const MAX_HISTORY_MS = IDLE_MS;
export const DEFAULT_HISTORY_MS = 4 * 60 * 60 * 1000;
export const MAX_TEST_CHARS = 1024;
export const IDENTIFY_MS = 3000;

/**
 * @typedef {{ kind: string, what: string, p?: string }} EventInfo
 * @typedef {{
 *   get(key: string): Promise<any>,
 *   put(key: string, value: any): Promise<void>,
 *   setAlarm(ms: number): Promise<void>,
 *   deleteAll(): Promise<void>,
 *   sql?: import('./log.js').SqlStorage
 * }} HubStorage
 * @typedef {{ reply?: object, broadcast?: object, iam?: { s: string | null, dev: string[] } }} HubResult
 *   `iam`: the socket's screen and device choices changed; the Durable Object keeps them with the socket and sends `presence`
 */

export class RoomHub {
  /**
   * @param {HubStorage} storage
   * @param {() => number} [clock]
   * @param {() => number} [rand] 0-1, for the NIBP reading error
   */
  constructor(storage, clock = Date.now, rand = Math.random) {
    this.storage = storage;
    this.clock = clock;
    this.rand = rand;
    this.log = makeLog(storage);
    /** @type {RoomState | null} */
    this.cache = null;
    /** @type {import('./log.js').LogEvent[]} teaching notes reached by the change being applied; logged by `record` (phones only) */
    this.reached = [];
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
    if (typeof text !== 'string' || text.length > MAX_OFFER_CHARS) return { reply: err('too_big', 'message too large') };
    if (!this.allow(clientId, now)) return { reply: err('rate', 'too many messages') };
    /** @type {any} */
    let msg;
    try { msg = JSON.parse(text); } catch { return { reply: err(text.length > MAX_MESSAGE_CHARS ? 'too_big' : 'bad_json', text.length > MAX_MESSAGE_CHARS ? 'message too large' : 'not JSON') }; }
    if (typeof msg !== 'object' || msg === null || typeof msg.t !== 'string') return { reply: err('bad_json', 'missing t') };
    if (text.length > MAX_MESSAGE_CHARS && msg.t !== 'libraryOffer') return { reply: err('too_big', 'message too large') };

    switch (msg.t) {
      case 'ping': return { reply: { t: 'pong', n: msg.n ?? null, now } };
      case 'hello': return { reply: await this.hello() };
      case 'set': return this.apply(clientId, now, msg, (s) => this.doSet(s, msg, now));
      case 'nibp': {
        const cur = pick(await this.state(), msg.p);
        if (cur && msg.after !== undefined && msg.after !== cur.nibpRead.at) return {};
        return this.apply(clientId, now, msg, (s) => this.doNibp(s, msg.p, now));
      }
      case 'tof': {
        const cur = pick(await this.state(), msg.p);
        if (cur && msg.after !== undefined && msg.after !== cur.tofRead.at) return {};
        return this.apply(clientId, now, msg, (s) => this.doTof(s, msg.p, now));
      }
      case 'addPatient': return this.apply(clientId, now, msg, (s) => this.doAdd(s, msg, now));
      case 'removePatient': return this.apply(clientId, now, msg, (s) => this.doRemove(s, msg));
      case 'silence': return this.apply(clientId, now, msg, (s) => { s.alarms.silencedUntil = now + SILENCE_MS; return { kind: 'silence', what: 'silence' }; });
      case 'history': return { reply: await this.history(msg, now) };
      case 'mark': return this.apply(clientId, now, msg, (s) => this.doMark(s, msg));
      case 'addScreen': {
        let id = '';
        const out = await this.apply(clientId, now, msg, (s) => { id = this.doAddScreen(s, msg); return { kind: 'screen', what: `add ${id}` }; });
        if (out.broadcast) out.reply = { t: 'screenAdded', s: id };
        return out;
      }
      case 'forgetScreen': return this.apply(clientId, now, msg, (s) => this.doForgetScreen(s, msg));
      case 'iam': {
        const v = validateIam(msg);
        if (!v.ok) return { reply: err('bad_patch', v.msg) };
        return { iam: { s: v.s, dev: v.dev } };
      }
      case 'identify':
      case 'clearDevice': {
        // sent on to every socket, the named screen acts on it; nothing is stored
        const st = await this.state();
        if (typeof msg.s !== 'string' || !st.screens?.[msg.s]) return { reply: err('bad_patch', 'unknown screen') };
        if (msg.t === 'identify') return { broadcast: { t: 'identify', s: msg.s, ms: IDENTIFY_MS } };
        if (!DEVICE_CHOICES.includes(msg.what)) return { reply: err('bad_patch', 'what must be theme or p') };
        return { broadcast: { t: 'clearDevice', s: msg.s, what: msg.what } };
      }
      case 'scenarioStart': {
        const v = validateScenario(msg.scenario);
        if (!v.ok) return { reply: err('bad_patch', v.msg) };
        const st = await this.state();
        const pid = msg.p ?? st.patients[0].id;
        if (!st.patients.some((x) => x.id === pid)) return { reply: err('bad_patch', 'unknown patient') };
        const prev = await this.storage.get('scenarioSteps');
        await this.storage.put('scenarioSteps', v.scenario.steps);
        const out = await this.apply(clientId, now, msg, (s) => this.doScenarioStart(s, v.scenario, pid, now));
        if (out.reply) await this.storage.put('scenarioSteps', prev ?? null);
        return out;
      }
      case 'scenarioPause':
      case 'scenarioResume':
      case 'scenarioNext':
      case 'scenarioStop': {
        const run = (await this.state()).scenario;
        if (!run) return { reply: err('bad_patch', 'no scenario is running') };
        const steps = (await this.storage.get('scenarioSteps')) ?? [];
        const out = await this.apply(clientId, now, msg, (s) => this.doScenarioControl(s, msg.t, steps, now));
        if (msg.t === 'scenarioStop') await this.storage.put('scenarioSteps', null);
        return out;
      }
      case 'queueAdd': {
        const v = validateStep(msg.step, 'queue step');
        if (!v.ok) return { reply: err('bad_patch', v.msg) };
        const st = await this.state();
        const pid = msg.p ?? st.patients[0].id;
        if (!st.patients.some((x) => x.id === pid)) return { reply: err('bad_patch', 'unknown patient') };
        const live = st.scenario && !st.scenario.done ? st.scenario : null;
        if (live && (!live.queue || live.p !== pid) && msg.replace !== true) return { reply: err('bad_patch', `"${live.name}" is running; send replace to stop it`) };
        const prev = live?.queue && live.p === pid ? ((await this.storage.get('scenarioSteps')) ?? []) : [];
        if (prev.length >= MAX_STEPS) return { reply: err('bad_patch', `a queue holds up to ${MAX_STEPS} steps`) };
        const steps = [...prev, v.step];
        const out = await this.apply(clientId, now, msg, (s) => this.doQueueAdd(s, steps, pid, now));
        if (!out.reply) await this.storage.put('scenarioSteps', steps);
        return out;
      }
      case 'queueMove':
      case 'queueRemove': {
        const run = (await this.state()).scenario;
        if (!run?.queue || run.done) return { reply: err('bad_patch', 'no queue is running') };
        const steps = (await this.storage.get('scenarioSteps')) ?? [];
        const next = steps.slice();
        const out = await this.apply(clientId, now, msg, (s) => this.doQueueEdit(s, msg, next));
        if (!out.reply) await this.storage.put('scenarioSteps', next);
        return out;
      }
      case 'tempo': {
        if (![0.5, 1, 2, 'finish'].includes(msg.x)) return { reply: err('bad_patch', 'x must be 0.5, 1, 2 or finish') };
        const steps = (await this.storage.get('scenarioSteps')) ?? [];
        const out = await this.apply(clientId, now, msg, (s) => this.doTempo(s, msg, steps, now));
        if (!out.reply && out.broadcast && msg.x === 'finish') await this.storage.put('scenarioSteps', null);
        return out;
      }
      case 'drug': {
        const v = validateDrug(msg.drug);
        if (!v.ok) return { reply: err('bad_patch', v.msg) };
        return this.apply(clientId, now, msg, (s) => this.doDrug(s, v.drug, msg.p, now));
      }
      case 'libraryOffer': {
        // one library per room, kept in Room storage (not in the broadcast state); the next offer replaces it
        const v = validateLibraryFile(JSON.stringify(msg.library ?? null));
        if (!v.ok) return { reply: err('bad_patch', v.msg) };
        const prev = await this.storage.get('libraryOffer');
        await this.storage.put('libraryOffer', { sim: LIBRARY_KIND, version: LIBRARY_VERSION, scenarios: v.scenarios, drugs: v.drugs });
        const out = await this.apply(clientId, now, msg, (s) => {
          s.offer = { scenarios: v.scenarios.length, drugs: v.drugs.length, at: now, by: clientId };
          return { kind: 'library', what: `offer ${v.scenarios.length} scenarios, ${v.drugs.length} drugs` };
        });
        if (out.reply) await this.storage.put('libraryOffer', prev ?? null);
        return out;
      }
      case 'libraryGet': {
        const lib = await this.storage.get('libraryOffer');
        return lib ? { reply: { t: 'library', library: lib } } : { reply: err('bad_patch', 'no library is offered in this room') };
      }
      case 'shock': return this.apply(clientId, now, msg, (s) => this.doShock(s, msg));
      case 'pace': return this.apply(clientId, now, msg, (s) => this.doPace(s, msg));
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
    this.reached = [];
    try { info = change(next); } catch (e) {
      this.reached = [];
      if (e instanceof BadPatch) return { reply: err('bad_patch', e.message) };
      throw e;
    }
    next.rev = before.rev + 1;
    next.events.push({ t: now, by: clientId, kind: info.kind, ...(info.p ? { p: info.p } : {}), what: info.what });
    if (next.events.length > MAX_EVENTS) next.events.splice(0, next.events.length - MAX_EVENTS);
    this.record(before, next, now, clientId, info);
    await this.storage.put('state', next);
    await this.storage.put('last', now);
    await this.storage.setAlarm(alarmAt(next, now));
    this.cache = next;
    return { broadcast: { t: 'state', state: next, now } };
  }

  /**
   * Append to the full log (SQLite rows): the event, and a glide record for every patient whose glide just started
   * (a new bed counts), so trends can be rebuilt later from glide records plus events (DESIGN.md section 5a).
   * @param {RoomState} before
   * @param {RoomState} next
   * @param {number} now
   * @param {string} clientId
   * @param {EventInfo} info
   */
  record(before, next, now, clientId, info) {
    this.log.addEvent({ t: now, by: clientId, kind: info.kind, ...(info.p ? { p: info.p } : {}), what: info.what });
    for (const e of this.reached) this.log.addEvent(e);
    this.reached = [];
    for (const pt of next.patients) {
      const old = before.patients.find((x) => x.id === pt.id);
      if (old && JSON.stringify(old.glide) === JSON.stringify(pt.glide) && JSON.stringify(numericsOf(old)) === JSON.stringify(numericsOf(pt))) continue;
      this.log.addGlide({ t: pt.glide.startedAt, p: pt.id, dur: pt.glide.durationMs, from: pt.glide.from, to: numericsOf(pt), ...(pt.glide.glideMsBy ? { by: pt.glide.glideMsBy } : {}) });
    }
  }

  /**
   * Reply to `history`: the full log for the last `range` ms (default 4 h, at most 24 h) or all of it with `all`.
   * @param {any} msg
   * @param {number} now
   */
  async history(msg, now) {
    const range = msg.all === true ? MAX_HISTORY_MS
      : typeof msg.range === 'number' && msg.range > 0 ? Math.min(msg.range, MAX_HISTORY_MS) : DEFAULT_HISTORY_MS;
    const since = Math.max(0, now - range);
    const last = (await this.storage.get('last')) ?? now;
    return { t: 'history', rid: Number.isSafeInteger(msg.rid) ? msg.rid : undefined, now, since, expiresAt: last + IDLE_MS, events: this.log.events(since, MAX_LOG_ROWS), glides: this.log.glides(since) };
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
    if (p.tof) Object.assign(pt.tofRead, p.tof);
    if (p.theme) {
      s.theme = p.theme;
      if (p.theme === 'default') delete s.themeJson; // back to the default for every monitor
    }
    if (p.themeJson) s.themeJson = p.themeJson;
    if (p.screens) for (const [id, sp] of Object.entries(p.screens)) applyScreen(s, id, sp);

    if (p.patient && TARGETS.some((k) => k in p.patient)) {
      let ms = pt.glideMs;
      if (msg.glideMs !== undefined) {
        if (typeof msg.glideMs !== 'number' || !(msg.glideMs >= 0 && msg.glideMs <= 600000)) throw new BadPatch('glideMs out of range');
        ms = msg.glideMs;
      }
      let by = null;
      if (msg.glideMsBy !== undefined) {
        const b = validateGlideMsBy(msg.glideMsBy);
        if (!b.ok) throw new BadPatch(b.msg);
        by = b.by;
      }
      if (!by && !before.glide.glideMsBy) pt.glide = restartGlide(before, now, ms);
      else {
        // per-field times: a changed field takes its own time (else `ms`); a field not in this patch keeps the time it
        // still had left, so a slow SpO2 glide is not cut short by an unrelated change
        const left = remainingMs(before, now);
        const patient = /** @type {Record<string, any>} */ (p.patient);
        /** @type {Record<string, number>} */
        const times = {};
        for (const k of GLIDE_FIELDS) times[k] = k in patient ? by?.[k] ?? ms : left[k];
        pt.glide = startGlide(before, now, times);
      }
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
    const j = nibpJitter(d.sys, d.dia, this.rand);
    pt.nibpRead.sys = j.sys;
    pt.nibpRead.dia = j.dia;
    pt.nibpRead.at = now;
    return { kind: 'nibp', what: 'nibp', p: pt.id };
  }

  /**
   * Train-of-four reading: the count and ratio the patient has now, stamped with the time. Monitors show it as the
   * last reading; on an interval the monitor asks again (like NIBP).
   * @param {RoomState} s
   * @param {string | undefined} id
   * @param {number} now
   */
  doTof(s, id, now) {
    const pt = pick(s, id);
    if (!pt) throw new BadPatch('unknown patient');
    pt.tofRead.count = pt.tofCount;
    pt.tofRead.ratio = pt.tofRatio;
    pt.tofRead.at = now;
    return { kind: 'tof', what: 'tof', p: pt.id };
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
    if (s.scenario?.p === msg.p) delete s.scenario; // its bed is gone
    for (const sc of Object.values(s.screens ?? {})) if (sc.p === msg.p) delete sc.p; // back to the device's own bed
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
   * A new named screen: id `s<n>` (lowest free), name default `Screen <n>`, kind default `monitor`. The sender gets
   * `screenAdded` with the id (kept on that device) as well as the new state.
   * @param {RoomState} s
   * @param {any} msg
   * @returns {string} the new id
   */
  doAddScreen(s, msg) {
    const screens = (s.screens ??= {});
    if (Object.keys(screens).length >= MAX_SCREENS) throw new BadPatch(`at most ${MAX_SCREENS} screens`);
    const kind = msg.kind ?? 'monitor';
    if (!SCREEN_KINDS.includes(kind)) throw new BadPatch('unknown screen kind');
    let n = 1;
    while (`s${n}` in screens) n++;
    let name = `Screen ${n}`;
    if (msg.name !== undefined && msg.name !== '') {
      const t = screenName(msg.name);
      if (t === null) throw new BadPatch('name must be 1-24 characters');
      name = t;
    }
    screens[`s${n}`] = { name, kind };
    return `s${n}`;
  }

  /**
   * Forget a screen: its settings go; a monitor still using the id asks for a name again.
   * @param {RoomState} s
   * @param {any} msg
   */
  doForgetScreen(s, msg) {
    if (typeof msg.s !== 'string' || !s.screens?.[msg.s]) throw new BadPatch('unknown screen');
    delete s.screens[msg.s];
    return { kind: 'screen', what: `forget ${msg.s}` };
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
   * A shock from a defib screen: one event (kind `shock`, `what` = energy and sync) so every screen of the bed and the
   * log agree, then the patient's `postShock` rhythm applies at once (`none` = no change). Pads off blocks it.
   * @param {RoomState} s
   * @param {{ p?: string, energy?: unknown, sync?: unknown }} msg
   * @returns {EventInfo}
   */
  doShock(s, msg) {
    const pt = pick(s, msg.p);
    if (!pt) throw new BadPatch('unknown patient');
    const j = msg.energy;
    if (typeof j !== 'number' || !Number.isInteger(j) || j < SHOCK_JOULES[0] || j > SHOCK_JOULES[1]) throw new BadPatch('energy must be a whole number of joules, 1 to 360');
    if (pt.off?.pads) throw new BadPatch('pads are off: no shock delivered');
    const sync = msg.sync === true;
    if (pt.postShock && pt.postShock !== 'none') pt.rhythm = pt.postShock;
    return { kind: 'shock', what: `${j}J${sync ? ' sync' : ''}`, p: pt.id };
  }

  /**
   * Pacing set from a defib screen: rate, mA, mode, on/off. One event (kind `pace`) so every screen and the log agree.
   * Pads off blocks turning it on. The capture threshold and failure to sense stay with the phone.
   * @param {RoomState} s
   * @param {{ p?: string, on?: boolean }} msg
   * @returns {EventInfo}
   */
  doPace(s, msg) {
    const pt = pick(s, msg.p);
    if (!pt) throw new BadPatch('unknown patient');
    const v = validatePace(msg);
    if (!v.ok) throw new BadPatch(v.msg);
    if (v.patch.paceOn && pt.off?.pads) throw new BadPatch('pads are off: pacing cannot start');
    Object.assign(pt, v.patch);
    const set = `${pt.paceRate}/min ${pt.paceMa}mA ${pt.paceMode}`;
    const what = pt.paceOn ? `${msg.on ? 'on' : 'set'} ${set}` : msg.on === false ? 'off' : `set ${set} (pacer off)`;
    return { kind: 'pace', what, p: pt.id };
  }

  /**
   * Start a scenario on one patient (replacing any running one): the first step runs after its own delay (at once at 0).
   * The steps are kept in storage, not in the broadcast state.
   * @param {RoomState} s
   * @param {import('../shared/scenario.js').Scenario} sc
   * @param {string} p
   * @param {number} now
   */
  doScenarioStart(s, sc, p, now) {
    const first = sc.steps[0];
    s.scenario = {
      id: `n${s.rev + 1}`, name: sc.name, p, step: 0, total: sc.steps.length, startedAt: now, pausedAt: 0,
      nextAt: first.onTap ? 0 : now + (first.atSec ?? 0) * 1000, baseAt: now, waiting: !!first.onTap, done: false,
      ...(sc.objectives ? { objectives: sc.objectives } : {}),
    };
    const run = s.scenario;
    const ran = this.runDue(s, sc.steps, now);
    return { kind: 'scenario', what: `start ${sc.name}${ran ? ` (step ${run.step}/${run.total})` : ''}`, p };
  }

  /**
   * Pause, resume, run the next step now (skip a countdown, or answer a tap), or stop.
   * @param {RoomState} s
   * @param {string} t message type
   * @param {import('../shared/scenario.js').ScenarioStep[]} steps
   * @param {number} now
   */
  doScenarioControl(s, t, steps, now) {
    const run = /** @type {import('../shared/scenario.js').ScenarioRun} */ (s.scenario);
    const p = run.p;
    if (t === 'scenarioStop') { delete s.scenario; return { kind: 'scenario', what: `stop ${run.name}`, p }; }
    if (run.done) throw new BadPatch('the scenario has finished');
    if (t === 'scenarioPause') {
      if (!run.pausedAt) run.pausedAt = now;
      return { kind: 'scenario', what: 'pause', p };
    }
    if (t === 'scenarioResume') {
      if (run.pausedAt) {
        if (run.nextAt) run.nextAt += now - run.pausedAt;
        if (run.baseAt) run.baseAt += now - run.pausedAt;
        run.pausedAt = 0;
        this.runDue(s, steps, now);
      }
      return { kind: 'scenario', what: 'resume', p };
    }
    this.runNext(s, steps, now, run.pausedAt || now);
    return { kind: 'scenario', what: `step ${run.step}/${run.total} (tap)`, p };
  }

  /**
   * Run the next step of the scenario now, then plan the one after it (`base` = the time its delay counts from).
   * @param {RoomState} s
   * @param {import('../shared/scenario.js').ScenarioStep[]} steps
   * @param {number} now
   * @param {number} base
   * @param {boolean} [instant] land every glide at once (Finish now)
   */
  runNext(s, steps, now, base, instant = false) {
    const run = /** @type {import('../shared/scenario.js').ScenarioRun} */ (s.scenario);
    const step = steps[run.step];
    if (!step) { run.done = true; run.nextAt = 0; run.waiting = false; return; }
    const k = instant ? 0 : 1 / (run.tempo ?? 1);
    /** @type {Record<string, any>} */
    const msg = { patch: step.patch, p: run.p, glideMs: Math.round(step.glideMs * k) };
    if (step.glideMsBy && !instant) msg.glideMsBy = Object.fromEntries(Object.entries(step.glideMsBy).map(([f, ms]) => [f, Math.round(ms * k)]));
    this.doSet(s, msg, now);
    run.step++;
    if (step.note) run.note = step.note; else delete run.note; // teaching cue of the step that just ran (phone only)
    // the log keeps the cue for the debrief as a `note` row; `state.events` does not, and monitors never get `note` rows (forMonitor)
    if (step.note) this.reached.push({ t: now, by: 'room', kind: 'note', p: run.p, what: `step ${run.step}/${run.total}: ${step.note}` });
    const next = steps[run.step];
    if (!next) { run.done = true; run.nextAt = 0; run.waiting = false; return; }
    planNext(run, next, base);
  }

  /**
   * Run every timed step that is due (a late alarm catches up in order, each delay counted from when its step was due).
   * @param {RoomState} s
   * @param {import('../shared/scenario.js').ScenarioStep[]} steps
   * @param {number} now
   * @returns {number} how many steps ran
   */
  runDue(s, steps, now) {
    let n = 0;
    for (let run = s.scenario; run && !run.done && !run.pausedAt && run.nextAt > 0 && run.nextAt <= now; run = s.scenario) {
      this.runNext(s, steps, now, run.nextAt);
      n++;
    }
    return n;
  }

  /**
   * Add one step to the queue on bed `p`: a new queue run when none is running (a running scenario or a queue on
   * another bed is replaced; the phone asks first), else the step goes on the end of the running queue.
   * @param {RoomState} s
   * @param {import('../shared/scenario.js').ScenarioStep[]} steps the queue's steps with the new one last
   * @param {string} p
   * @param {number} now
   */
  doQueueAdd(s, steps, p, now) {
    const cur = s.scenario;
    if (cur && !cur.done && cur.queue && cur.p === p) {
      cur.total = steps.length;
      cur.q = steps;
      return { kind: 'queue', what: `add (${steps.length} in queue)`, p };
    }
    this.doScenarioStart(s, { name: 'Queue', steps }, p, now);
    const run = /** @type {import('../shared/scenario.js').ScenarioRun} */ (s.scenario);
    run.queue = true;
    run.q = steps;
    return { kind: 'queue', what: 'start', p };
  }

  /**
   * Move (`dir` -1 or 1) or remove a step that has not run yet; `i` counts from the first step of the queue.
   * @param {RoomState} s
   * @param {any} msg `queueMove` { i, dir } or `queueRemove` { i }
   * @param {import('../shared/scenario.js').ScenarioStep[]} steps changed in place
   */
  doQueueEdit(s, msg, steps) {
    const run = /** @type {import('../shared/scenario.js').ScenarioRun} */ (s.scenario);
    const i = msg.i;
    if (!Number.isInteger(i) || i < run.step || i >= steps.length) throw new BadPatch('that step has already run or does not exist');
    if (msg.t === 'queueMove') {
      const j = i + (msg.dir === -1 ? -1 : msg.dir === 1 ? 1 : 0);
      if (j === i || j < run.step || j >= steps.length) throw new BadPatch('cannot move there');
      [steps[i], steps[j]] = [steps[j], steps[i]];
    } else {
      steps.splice(i, 1);
    }
    run.total = steps.length;
    run.q = steps;
    if (run.step >= steps.length) { run.done = true; run.nextAt = 0; run.waiting = false; } else if (i <= run.step) planNext(run, steps[run.step], run.baseAt ?? s.scenario?.startedAt ?? 0);
    return { kind: 'queue', what: msg.t === 'queueMove' ? `move ${i + 1}` : `skip ${i + 1}`, p: run.p };
  }

  /**
   * Live tempo for what is running on a bed: 0.5x, 1x or 2x rescale the time left of its glide and (when a scenario or
   * queue runs) of the runner's next step and of later steps; `finish` lands everything now. A glide alone is rescaled
   * once (x counts from the speed it has).
   * @param {RoomState} s
   * @param {any} msg `x` and optional `p`
   * @param {import('../shared/scenario.js').ScenarioStep[]} steps
   * @param {number} now
   */
  doTempo(s, msg, steps, now) {
    const run = s.scenario && !s.scenario.done ? s.scenario : null;
    const pt = pick(s, run ? run.p : msg.p);
    if (!pt) throw new BadPatch('unknown patient');
    if (msg.x === 'finish') {
      if (run) {
        run.pausedAt = 0;
        for (let guard = 0; !run.done && guard <= MAX_STEPS; guard++) this.runNext(s, steps, now, now, true);
      }
      pt.glide = { startedAt: now, durationMs: 0, from: numericsOf(pt) };
      return { kind: 'tempo', what: run ? `finish ${run.name}` : 'finish now', p: pt.id };
    }
    const f = run ? msg.x / (run.tempo ?? 1) : msg.x;
    if (run) { if (msg.x === 1) delete run.tempo; else run.tempo = msg.x; }
    if (f !== 1) {
      const left = remainingMs(pt, now);
      /** @type {Record<string, number>} */
      const times = {};
      for (const k of GLIDE_FIELDS) times[k] = left[k] / f;
      pt.glide = startGlide(pt, now, times);
      if (run && run.nextAt > 0) {
        const ref = run.pausedAt || now;
        run.nextAt = ref + (run.nextAt - ref) / f;
        const nxt = steps[run.step];
        if (nxt && !nxt.onTap) run.baseAt = run.nextAt - ((nxt.atSec ?? 0) * 1000) / (run.tempo ?? 1);
      }
    }
    return { kind: 'tempo', what: `${msg.x}x`, p: pt.id };
  }

  /**
   * A drug button: its relative change to the patient's targets, as one `set` with the drug's glide.
   * @param {RoomState} s
   * @param {import('../shared/scenario.js').Drug} drug
   * @param {string | undefined} id patient id
   * @param {number} now
   */
  doDrug(s, drug, id, now) {
    const pt = pick(s, id);
    if (!pt) throw new BadPatch('unknown patient');
    this.doSet(s, { patch: { patient: drugPatch(pt, drug.effects) }, p: pt.id, glideMs: drug.glideMs }, now);
    return { kind: 'drug', what: `drug ${drug.name}`, p: pt.id };
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
   * Storage alarm (one per room): runs scenario steps that are due, and deletes the room after 24 h of no changes.
   * @returns {Promise<{ expired: boolean, broadcast?: object }>}
   */
  async onAlarm() {
    const now = this.clock();
    const last = (await this.storage.get('last')) ?? 0;
    if (now - last >= IDLE_MS) {
      await this.storage.deleteAll();
      this.log.clear();
      this.cache = null;
      this.recent.clear();
      return { expired: true };
    }
    const s = await this.state();
    const run = s.scenario;
    if (run && !run.done && !run.pausedAt && run.nextAt > 0 && run.nextAt <= now) {
      const steps = (await this.storage.get('scenarioSteps')) ?? [];
      const out = await this.apply('server', now, {}, (st) => {
        const n = this.runDue(st, steps, now);
        const r = /** @type {import('../shared/scenario.js').ScenarioRun} */ (st.scenario);
        return { kind: 'scenario', what: `step ${r.step}/${r.total}${n > 1 ? ` (${n} due)` : ''}${r.done ? ' done' : ''}`, p: r.p };
      });
      return { expired: false, broadcast: out.broadcast };
    }
    await this.storage.setAlarm(alarmAt(s, last));
    return { expired: false };
  }
}

/**
 * When the room's one alarm should fire: the next timed scenario step, or the idle expiry, whichever is first.
 * @param {RoomState} s
 * @param {number} last server ms of the last change
 */
function alarmAt(s, last) {
  const run = s.scenario;
  const idle = last + IDLE_MS;
  return run && !run.done && !run.pausedAt && run.nextAt > 0 ? Math.min(idle, run.nextAt) : idle;
}

/**
 * Plan the step that runs after `base`: waits for a tap, or is due `atSec` later (shortened by the live tempo).
 * @param {import('../shared/scenario.js').ScenarioRun} run
 * @param {import('../shared/scenario.js').ScenarioStep} next
 * @param {number} base server ms the delay counts from
 */
function planNext(run, next, base) {
  run.waiting = !!next.onTap;
  run.baseAt = base;
  run.nextAt = next.onTap ? 0 : Math.round(base + ((next.atSec ?? 0) * 1000) / (run.tempo ?? 1));
}

class BadPatch extends Error {}

/**
 * Merge one screen's validated patch: `null` removes a field (follow the device / room again).
 * @param {RoomState} s
 * @param {string} id
 * @param {Record<string, any>} sp
 */
function applyScreen(s, id, sp) {
  const sc = s.screens?.[id];
  if (!sc || !SCREEN_ID.test(id)) throw new BadPatch(`unknown screen ${id}`);
  if (sp.p !== undefined && sp.p !== null && !s.patients.some((x) => x.id === sp.p)) throw new BadPatch('unknown patient');
  if (sp.kind !== undefined) sc.kind = sp.kind;
  for (const k of ['name', 'p', 'modules']) {
    if (sp[k] === null) delete sc[/** @type {'p'} */ (k)];
    else if (sp[k] !== undefined) /** @type {any} */ (sc)[k] = sp[k];
  }
  if (sp.themeJson && sp.theme === undefined) sp.theme = 'custom';
  if (sp.theme !== undefined) {
    if (sp.theme === null) { delete sc.theme; delete sc.themeJson; }
    else {
      sc.theme = sp.theme;
      if (sp.theme !== 'custom') delete sc.themeJson;
    }
  }
  if (sp.themeJson) sc.themeJson = sp.themeJson;
  if (sc.theme === 'custom' && !sc.themeJson) throw new BadPatch('a custom screen theme needs themeJson');
}

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
