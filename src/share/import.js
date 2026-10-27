// @ts-check
// "Someone shared a scenario": the card the controller page shows when it is opened from a share link (`/c/#s=...` or
// `/c/<code>#s=...`). It reads the link with the library's own validator and changes nothing until Import is tapped; a bad
// or too-new link only shows why it was refused.
import { LibraryStore } from '../controller/library.js';
import { decodeScenario, payloadFromHash } from './link.js';

const esc = (/** @type {string} */ s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/** A free name for the copy: "Name", then "Name 2", "Name 3" ... within the 24-character limit. @param {string} name @param {string[]} taken */
export function freeName(name, taken) {
  if (!taken.includes(name)) return name;
  for (let n = 2; n < 100; n++) {
    const c = `${name.slice(0, 24 - String(n).length - 1)} ${n}`;
    if (!taken.includes(c)) return c;
  }
  return name;
}

/**
 * @param {HTMLElement} host where the card goes
 * @param {{ hash: string, storage: Storage | null, onDone: (imported: boolean) => void, waitForRoom: boolean }} opts
 * @returns {Promise<boolean>} true when the hash was a share link (the card is shown). `onDone` runs after Import or Skip, only when
 *   `waitForRoom` (the page holds the room back until then); without a room the card stays and the page carries on.
 */
export async function mountShareImport(host, opts) {
  const payload = payloadFromHash(opts.hash);
  if (payload === null) return false;
  const r = await decodeScenario(payload);
  const kv = opts.storage;
  host.dataset.testid = 'share-import';
  if (!r.ok) {
    host.innerHTML = `<div class="share"><h2>Shared scenario</h2><p class="hint" data-testid="share-refused">Nothing was imported: ${esc(r.msg)}.</p></div>`;
    if (opts.waitForRoom) opts.onDone(false); // the room still opens, under the message
    return true;
  }
  const lib = new LibraryStore(kv);
  const sc = r.scenario;
  const objectives = sc.objectives ? `<p class="obj"><b>Objectives:</b> ${esc(sc.objectives)}</p>` : '';
  host.innerHTML = `<div class="share"><h2>Shared scenario</h2>
    <p><b data-testid="share-name">${esc(sc.name)}</b> <small>${sc.steps.length} step${sc.steps.length === 1 ? '' : 's'}</small></p>${objectives}
    <div class="row"><input id="share-as" maxlength="24" value="${esc(freeName(sc.name, lib.allScenarios().map((x) => x.name)))}" aria-label="Save as" data-testid="share-as">
      <button type="button" data-testid="share-import-go">Import</button>${opts.waitForRoom ? '<button type="button" data-testid="share-skip">Skip</button>' : ''}</div>
    <p class="hint" data-testid="share-import-note">Saved on this phone only. Nothing is sent anywhere.</p></div>`;
  const note = /** @type {HTMLElement} */ (host.querySelector('[data-testid=share-import-note]'));
  host.querySelector('[data-testid=share-import-go]')?.addEventListener('click', () => {
    const name = /** @type {HTMLInputElement} */ (host.querySelector('#share-as')).value;
    const out = lib.addScenario({ ...sc, name });
    if (!out.ok) { note.textContent = `Refused: ${out.msg}.`; return; }
    host.innerHTML = `<div class="share"><p data-testid="share-done">Imported "${esc(name.trim())}".</p></div>`;
    if (opts.waitForRoom) opts.onDone(true);
  });
  host.querySelector('[data-testid=share-skip]')?.addEventListener('click', () => { host.innerHTML = ''; opts.onDone(false); });
  return true;
}
