// @ts-check
// Phone feedback when a change does not reach the room: the offline banner under the header and one toast line above
// the tabs. DOM-free so node can test it; timers are injected. No work on import. Nothing is ever resent from here
// (a drug's relative change sent twice would double).

/** Before the first connection, the banner waits this long (ms) so a normal page load does not flash it. */
export const LOAD_GRACE_MS = 3000;
/** "Reconnected" stays this long (ms) after the link comes back, then the banner hides. */
export const RECONNECTED_MS = 3000;
/** A toast line clears itself after this long (ms). */
export const TOAST_MS = 5000;

/** @typedef {{ show: false } | { show: true, kind: 'wait' | 'ok' | 'full' | 'expired', text: string, reload: boolean }} Banner */

/**
 * What a server `error` message says in the toast; null for the ones shown elsewhere ('schema' keeps its full-page
 * message).
 * @param {{ code?: string, msg?: string } | null | undefined} e
 * @returns {string | null}
 */
export function errorText(e) {
  if (!e || e.code === 'schema') return null;
  return `Refused: ${e.msg || e.code || 'the room did not accept that'}`;
}

/** Label of the Apply button: n pending changes, and whether they can go now. @param {number} n @param {string} status */
export function applyLabel(n, status) {
  return status === 'open' ? `Apply ${n} change${n === 1 ? '' : 's'}` : 'Apply when connected';
}

/**
 * Banner and toast state. Call `status(s)` on every client status change and `say(text)` for a toast; `onChange` runs
 * whenever what is shown may have changed (including when a timer fires).
 * @param {{ now: () => number, setTimer: (fn: () => void, ms: number) => any, clearTimer: (id: any) => void, onChange: () => void }} o
 */
export function createFeedback({ now, setTimer, clearTimer, onChange }) {
  const loadedAt = now();
  let st = 'connecting';
  let everOpen = false;
  let wasShown = false; // the waiting banner was on screen since the last open
  let okUntil = 0;
  let toast = '';
  /** @type {any} */ let okTimer = null;
  /** @type {any} */ let toastTimer = null;
  // before the first connection, look again once the load grace is over
  /** @type {any} */ let graceTimer = setTimer(() => { graceTimer = null; onChange(); }, LOAD_GRACE_MS);

  /** @returns {Banner} */
  function banner() {
    if (st === 'expired') return { show: true, kind: 'expired', text: 'Room expired', reload: true };
    if (st === 'full') return { show: true, kind: 'full', text: 'Room full', reload: true };
    if (st === 'open') return okUntil > now() ? { show: true, kind: 'ok', text: 'Reconnected', reload: false } : { show: false };
    if (st === 'connecting' || st === 'reconnecting') {
      if (everOpen || now() - loadedAt >= LOAD_GRACE_MS) return { show: true, kind: 'wait', text: 'Reconnecting… your changes are kept', reload: false };
    }
    return { show: false }; // 'closed' = this page shut the link itself
  }

  /** @param {string} s */
  function status(s) {
    const shownBefore = banner();
    if (shownBefore.show && shownBefore.kind !== 'ok') wasShown = true;
    st = s;
    if (s === 'open') {
      if (wasShown && everOpen) {
        okUntil = now() + RECONNECTED_MS;
        if (okTimer !== null) clearTimer(okTimer);
        okTimer = setTimer(() => { okTimer = null; okUntil = 0; onChange(); }, RECONNECTED_MS);
      }
      everOpen = true;
      wasShown = false;
    } else {
      okUntil = 0;
      if (okTimer !== null) { clearTimer(okTimer); okTimer = null; }
    }
    onChange();
  }

  /** One toast line; replaces the one shown. @param {string} text */
  function say(text) {
    toast = text;
    if (toastTimer !== null) clearTimer(toastTimer);
    toastTimer = setTimer(() => { toastTimer = null; toast = ''; onChange(); }, TOAST_MS);
    onChange();
  }

  function stop() {
    for (const t of [okTimer, toastTimer, graceTimer]) if (t !== null) clearTimer(t);
    okTimer = toastTimer = graceTimer = null;
  }

  return { status, say, banner, toast: () => toast, stop };
}
