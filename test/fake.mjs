// Test helpers: in-memory storage and a manual clock for RoomHub.
import { RoomHub } from '../src/room/hub.js';

export function fakeStorage() {
  const data = new Map();
  const s = {
    data,
    alarm: null,
    async get(k) { return data.has(k) ? structuredClone(data.get(k)) : undefined; },
    async put(k, v) { data.set(k, structuredClone(v)); },
    async setAlarm(ms) { s.alarm = ms; },
    async deleteAll() { data.clear(); s.alarm = null; },
  };
  return s;
}

export function makeHub(start = 1_000_000) {
  const clock = { t: start };
  const storage = fakeStorage();
  const hub = new RoomHub(storage, () => clock.t);
  return { hub, storage, clock };
}

export const msg = (o) => JSON.stringify(o);
