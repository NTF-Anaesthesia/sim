// @ts-check
// Phone header bits seen on every tab: the Silence button (with its countdown and cancel) and the bed chips' dot for
// unapplied changes. Pure, so the unit tests check them without a browser.

const esc = (/** @type {unknown} */ s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/** m:ss for a time left, rounded up so it never shows 0:00 while still silenced. @param {number} ms */
export function clockLeft(ms) {
  const sec = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/**
 * The header's Silence button for the room's alarm settings at server time `now`.
 * off = alarms switched off (tapping opens the Alarms tab); silenced = tapping cancels; ready = tapping silences.
 * @param {{ enabled: boolean, silencedUntil: number } | undefined | null} alarms
 * @param {number} now server ms
 * @returns {{ state: 'off' | 'silenced' | 'ready', text: string, title: string, leftMs: number }}
 */
export function silenceButton(alarms, now) {
  if (alarms && !alarms.enabled) return { state: 'off', text: 'Alarms off', title: 'Alarms are switched off: open the Alarms tab', leftMs: 0 };
  const left = alarms ? alarms.silencedUntil - now : 0;
  if (left > 0) return { state: 'silenced', text: `Silenced ${clockLeft(left)}`, title: 'Alarms silenced: tap to cancel the silence', leftMs: left };
  return { state: 'ready', text: 'Silence', title: 'Silence alarms for 2 min', leftMs: 0 };
}

/** The Alarms tab's own button: the same choice as the header's. @param {{ silencedUntil: number }} alarms @param {number} now */
export function alarmsTabSilence(alarms, now) {
  const left = alarms.silencedUntil - now;
  return left > 0 ? { cancel: true, text: `Cancel silence (${Math.ceil(left / 1000)} s left)` } : { cancel: false, text: 'Silence 2 min' };
}

/** aria-label of a bed chip: its name, plus a note when it has unapplied changes. @param {string} label @param {boolean} pending */
export const bedLabel = (label, pending) => (pending ? `${label}, unapplied changes` : label);

/**
 * The bed chips (and the add button).
 * @param {{ id: string, label: string }[]} patients
 * @param {string | undefined} curId
 * @param {(id: string) => boolean} pendingFor true when that bed has unapplied changes
 */
export function bedsHtml(patients, curId, pendingFor) {
  return patients.map((x) => {
    const p = pendingFor(x.id);
    return `<button type="button" class="bed" data-bed="${esc(x.id)}" aria-pressed="${x.id === curId}"${p ? ` data-pending="true" aria-label="${esc(bedLabel(x.label, true))}"` : ''}>${esc(x.label)}</button>`;
  }).join('') + '<button type="button" class="bed add" data-act="add" aria-label="Add patient">+</button>';
}

/** The toast line after a bookmark is saved. @param {Date} d */
export const markNote = (d) => `Bookmarked at ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`;
