// @ts-check
// The running scenario strip above the tabs (every tab but Scenarios, which shows the full card). Pure: builds the
// strip's markup and a key; the caller rebuilds the element only when the key changes, so a button is never replaced
// under a finger, and updates the countdown (#scnbar-count) on its own timer.

const esc = (/** @type {unknown} */ s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/**
 * @param {import('../shared/scenario.js').ScenarioRun | undefined | null} run
 * @param {{ tab: string, bed?: string, line: string }} o `bed` = the run's bed label (only when the room has more than one bed), `line` = the countdown text
 * @returns {{ show: false } | { show: true, key: string, waiting: boolean, html: string }}
 */
export function scenarioBar(run, o) {
  if (!run || run.done || o.tab === 'scenarios') return { show: false };
  const waiting = !!run.waiting;
  const paused = !!run.pausedAt;
  const note = run.note ?? '';
  const key = [run.name, run.step, run.total, waiting, paused, note, o.bed ?? '', o.tab].join('|');
  const html = `<div class="scnbar-main">
      <p class="scnbar-head"><b data-testid="scnbar-name">${esc(run.name)}</b>${o.bed ? ` · ${esc(o.bed)}` : ''} · <span data-testid="scnbar-step">${run.step}/${run.total} done</span></p>
      <p class="scnbar-count" id="scnbar-count" data-testid="scnbar-count">${esc(o.line)}</p>
    </div>
    <div class="scnbar-btns">
      <button type="button" data-act="scn-pause" data-testid="scnbar-pause">${paused ? 'Resume' : 'Pause'}</button>
      <button type="button" class="scnbar-next" data-act="scn-next" data-testid="scnbar-next">${waiting ? 'Next step' : 'Skip wait'}</button>
    </div>
    ${note ? `<button type="button" class="scnbar-cue" data-act="scnbar-cue" data-testid="scnbar-cue" aria-expanded="false"><b>Cue:</b> ${esc(note)}</button>` : ''}`;
  return { show: true, key, waiting, html };
}
