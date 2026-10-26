// @ts-check
// Which named screen this monitor is (V2 S1, DESIGN.md section 4a). The id is server-made (`s1`, `s2`, ...) and kept per
// device and room in `sim.settings.screenId.<code>`; `?s=<id>` in the address overrides it. With no id the monitor asks
// for a name once per page load (a small card, never blocking the screen; "Not now" keeps following the room). It tells
// the room which screen it is and which device choices it has (`iam`), shows its name large on `identify`, and drops a
// device choice on `clearDevice`. All text goes in with textContent / value, never as markup.
import { SCREEN_ID } from '../shared/schema.js';

const CSS = `
.sid-card{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:40;background:#15171af0;color:#e6e6e6;
  font:14px system-ui,sans-serif;border:1px solid #3a404a;border-radius:8px;padding:10px 12px;display:flex;gap:8px;
  align-items:center;flex-wrap:wrap;max-width:calc(100vw - 24px)}
.sid-card[hidden],.sid-big[hidden]{display:none}
.sid-card input,.sid-card button{font:inherit;color:inherit;background:#242830;border:1px solid #3a404a;border-radius:6px;
  padding:6px 10px;min-height:36px}
.sid-card input{width:12em}.sid-card button{cursor:pointer}
.sid-big{position:fixed;inset:0;z-index:45;display:flex;align-items:center;justify-content:center;pointer-events:none;
  background:#000c;color:#fff;font:700 min(18vw,30vh)/1 system-ui,sans-serif;text-align:center;padding:4vw}
.sid-name{font-weight:600;letter-spacing:.02em}
`;

/**
 * @param {{
 *   client: import('../room/client.js').RoomClient, code: string, settings: import('./settings.js').Settings,
 *   param?: string | null, doc?: Document,
 *   deviceChoices: () => string[], onChange: () => void, onClear: (what: string) => void,
 * }} opts
 */
export function createIdentity(opts) {
  const { client, settings } = opts;
  const doc = opts.doc ?? document;
  const key = `screenId.${opts.code}`;
  const fromParam = typeof opts.param === 'string' && SCREEN_ID.test(opts.param) ? opts.param : null;
  /** @type {string | null} */
  let id = fromParam ?? cleanId(settings.get(key, null));
  let dismissed = false;
  let adding = false;
  /** an id the room just made for us: kept even if a state without it is drawn before the one with it arrives */
  let fresh = '';
  /** @type {any} */
  let timer = null;

  const style = doc.createElement('style');
  style.textContent = CSS;
  const card = doc.createElement('form');
  card.className = 'sid-card';
  card.hidden = true;
  card.dataset.testid = 'screen-name-card';
  const label = doc.createElement('label');
  label.textContent = 'Name this screen';
  const input = doc.createElement('input');
  input.maxLength = 24;
  input.dataset.testid = 'screen-name';
  label.htmlFor = input.id = 'sid-name-input';
  const save = doc.createElement('button');
  save.type = 'submit';
  save.textContent = 'Save';
  save.dataset.testid = 'screen-name-save';
  const later = doc.createElement('button');
  later.type = 'button';
  later.textContent = 'Not now';
  card.append(label, input, save, later);
  const big = doc.createElement('div');
  big.className = 'sid-big';
  big.hidden = true;
  big.dataset.testid = 'screen-identify';
  /** The screen's name for the tools bar (screen.js places it). */
  const nameEl = doc.createElement('span');
  nameEl.className = 'sid-name';
  nameEl.dataset.testid = 'screen-label';
  doc.body.append(style, card, big);

  card.addEventListener('submit', (e) => {
    e.preventDefault();
    if (client.status !== 'open') return;
    adding = true;
    card.hidden = true;
    client.send({ t: 'addScreen', name: input.value.trim() });
  });
  later.addEventListener('click', () => { dismissed = true; card.hidden = true; });

  /** Tell the room which screen this is and which device choices win over its settings. */
  function report() {
    client.send({ t: 'iam', s: id, dev: id ? opts.deviceChoices() : [] });
  }

  client.on('status', (s) => { if (s === 'open') report(); });
  client.on('screen', (/** @type {any} */ m) => {
    if (m.t === 'screenAdded' && adding) {
      adding = false;
      fresh = String(m.s);
      setId(fresh);
    } else if (m.t === 'identify' && id && m.s === id) {
      big.textContent = nameEl.textContent || id;
      big.hidden = false;
      clearTimeout(timer);
      timer = setTimeout(() => { big.hidden = true; }, Math.min(Number(m.ms) || 3000, 10000));
    } else if (m.t === 'clearDevice' && id && m.s === id) {
      opts.onClear(String(m.what));
      report();
    }
  });

  /** @param {string | null} next */
  function setId(next) {
    id = next;
    if (id) settings.set(key, id); else settings.remove(key);
    report();
    opts.onChange();
  }

  return {
    nameEl,
    report,
    /** @returns {string | null} */
    id: () => id,
    /**
     * This monitor's screen in the state, or null. A stored id the room no longer has (forgotten, or the room expired)
     * is dropped and the name card comes back.
     * @param {import('../shared/schema.js').RoomState} st
     * @returns {import('../shared/schema.js').Screen | null}
     */
    sync(st) {
      const sc = id ? st.screens?.[id] ?? null : null;
      if (sc && id === fresh) fresh = '';
      if (id && !sc && id !== fresh) { id = null; settings.remove(key); report(); }
      if (sc && id === fromParam) settings.set(key, id);
      nameEl.textContent = sc?.name ?? '';
      if (!id && !dismissed && !adding && card.hidden) {
        input.placeholder = `Screen ${nextNumber(st)}`;
        card.hidden = false;
      }
      if (id) card.hidden = true;
      return sc;
    },
  };
}

/** @param {unknown} v */
function cleanId(v) {
  return typeof v === 'string' && SCREEN_ID.test(v) ? v : null;
}

/** @param {import('../shared/schema.js').RoomState} st the number the next screen will get */
function nextNumber(st) {
  let n = 1;
  while (st.screens && `s${n}` in st.screens) n++;
  return n;
}
