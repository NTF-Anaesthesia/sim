// @ts-check
// The room's full history (DESIGN.md section 5a): every event and every glide start, as SQLite rows in the Durable
// Object. `state.events` still carries the last 20 for the controller's log. Trends are rebuilt from these rows
// (seam 8): there is no separate trend store. A memory log with the same interface stands in when storage has no SQL
// (the fake storage in unit tests).

export const MAX_LOG_ROWS = 5000;

/**
 * @typedef {{ id?: number, t: number, by: string, kind: string, p?: string, what: string }} LogEvent
 * @typedef {{ t: number, p: string, dur: number, from: Record<string, any>, to: Record<string, any> }} LogGlide
 *   `from` and `to` are the numerics at the start and the targets after the change (same shape as `numericsOf`)
 * @typedef {{
 *   addEvent(e: LogEvent): void,
 *   addGlide(g: LogGlide): void,
 *   events(sinceT: number, limit: number): LogEvent[],
 *   glides(sinceT: number): LogGlide[],
 *   clear(): void
 * }} RoomLog
 * @typedef {{ exec(query: string, ...bindings: any[]): { toArray(): any[] } }} SqlStorage
 */

/**
 * @param {{ sql?: SqlStorage }} storage
 * @returns {RoomLog}
 */
export function makeLog(storage) {
  return storage.sql ? sqlLog(storage.sql) : memoryLog();
}

/** @param {SqlStorage} sql @returns {RoomLog} */
export function sqlLog(sql) {
  let ready = false;
  const ensure = () => {
    if (ready) return;
    sql.exec('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, by TEXT NOT NULL, kind TEXT NOT NULL, p TEXT, what TEXT NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS events_t ON events (t)');
    sql.exec('CREATE TABLE IF NOT EXISTS glides (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER NOT NULL, p TEXT NOT NULL, dur INTEGER NOT NULL, from_json TEXT NOT NULL, to_json TEXT NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS glides_t ON glides (t)');
    ready = true;
  };
  return {
    addEvent(e) {
      ensure();
      sql.exec('INSERT INTO events (t, by, kind, p, what) VALUES (?, ?, ?, ?, ?)', e.t, e.by, e.kind, e.p ?? null, e.what);
      sql.exec('DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?', MAX_LOG_ROWS);
    },
    addGlide(g) {
      ensure();
      sql.exec('INSERT INTO glides (t, p, dur, from_json, to_json) VALUES (?, ?, ?, ?, ?)', g.t, g.p, g.dur, JSON.stringify(g.from), JSON.stringify(g.to));
      sql.exec('DELETE FROM glides WHERE id <= (SELECT MAX(id) FROM glides) - ?', MAX_LOG_ROWS);
    },
    events(sinceT, limit) {
      ensure();
      // the newest `limit` rows at or after sinceT, oldest first
      const rows = sql.exec('SELECT id, t, by, kind, p, what FROM events WHERE t >= ? ORDER BY id DESC LIMIT ?', sinceT, limit).toArray();
      return rows.reverse().map((r) => ({ id: Number(r.id), t: Number(r.t), by: String(r.by), kind: String(r.kind), ...(r.p ? { p: String(r.p) } : {}), what: String(r.what) }));
    },
    glides(sinceT) {
      ensure();
      // everything from sinceT, plus each patient's last start before it (the value in force when the window opens)
      const rows = sql.exec(
        'SELECT t, p, dur, from_json, to_json FROM glides WHERE t >= ? OR id IN (SELECT MAX(id) FROM glides WHERE t < ? GROUP BY p) ORDER BY id',
        sinceT, sinceT).toArray();
      return rows.map((r) => ({ t: Number(r.t), p: String(r.p), dur: Number(r.dur), from: JSON.parse(String(r.from_json)), to: JSON.parse(String(r.to_json)) }));
    },
    clear() {
      sql.exec('DROP TABLE IF EXISTS events');
      sql.exec('DROP TABLE IF EXISTS glides');
      ready = false;
    },
  };
}

/** @returns {RoomLog} */
export function memoryLog() {
  /** @type {LogEvent[]} */ let ev = [];
  /** @type {LogGlide[]} */ let gl = [];
  let nextId = 1;
  return {
    addEvent(e) { ev.push({ ...e, id: nextId++ }); if (ev.length > MAX_LOG_ROWS) ev = ev.slice(-MAX_LOG_ROWS); },
    addGlide(g) { gl.push(structuredClone(g)); if (gl.length > MAX_LOG_ROWS) gl = gl.slice(-MAX_LOG_ROWS); },
    events(sinceT, limit) { return ev.filter((e) => e.t >= sinceT).slice(-limit).map((e) => ({ ...e })); },
    glides(sinceT) {
      const last = new Map();
      for (const g of gl) if (g.t < sinceT) last.set(g.p, g);
      const keep = new Set(last.values());
      return gl.filter((g) => g.t >= sinceT || keep.has(g)).map((g) => structuredClone(g));
    },
    clear() { ev = []; gl = []; nextId = 1; },
  };
}
