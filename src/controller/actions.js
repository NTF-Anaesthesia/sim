// @ts-check
// The one action path (plan seam 6): every controller change reaches the room through `act(patch, glideMs, p)`.
// Presets, steppers, switches and limit edits all call it; timed scenarios later only add steps in front of it.

/** @typedef {{ send(msg: object): boolean }} Sender */

/**
 * @param {Sender} client
 * @param {() => string | undefined} currentPatient id of the patient the controller is looking at
 */
export function makeActions(client, currentPatient) {
  /**
   * Send a `set`. `p` defaults to the patient being controlled; room-wide patches (modules, alarms) ignore it.
   * @param {object} patch allowed paths only (DESIGN.md section 5)
   * @param {number} [glideMs]
   * @param {string} [p]
   * @param {Record<string, number>} [glideMsBy] glide time per field, for the fields that differ from `glideMs`
   */
  function act(patch, glideMs, p, glideMsBy) {
    /** @type {Record<string, any>} */
    const msg = { t: 'set', patch, p: p ?? currentPatient() };
    if (glideMs !== undefined) msg.glideMs = glideMs;
    if (glideMsBy && Object.keys(glideMsBy).length) msg.glideMsBy = glideMsBy;
    return client.send(msg);
  }
  return {
    act,
    /** Measure now. @param {string} [p] */
    nibpNow: (p) => client.send({ t: 'nibp', p: p ?? currentPatient() }),
    /** TOF reading now. @param {string} [p] */
    tofNow: (p) => client.send({ t: 'tof', p: p ?? currentPatient() }),
    /** Flush test of an art line. @param {'abp' | 'abp2'} line @param {string} [p] */
    flush: (line, p) => client.send({ t: 'flush', line, p: p ?? currentPatient() }),
    silence: () => client.send({ t: 'silence' }),
    /** Start a scenario on a patient; the room runs it. @param {object} scenario @param {string} [p] */
    scenarioStart: (scenario, p) => client.send({ t: 'scenarioStart', scenario, p: p ?? currentPatient() }),
    /** @param {'scenarioPause' | 'scenarioResume' | 'scenarioNext' | 'scenarioStop'} t */
    scenarioControl: (t) => client.send({ t }),
    /** A drug button: its relative change on a patient. @param {object} drug @param {string} [p] */
    drug: (drug, p) => client.send({ t: 'drug', drug, p: p ?? currentPatient() }),
    /** Add a step to the room's queue. @param {object} step @param {string} [p] @param {boolean} [replace] stop a running scenario */
    queueAdd: (step, p, replace) => client.send({ t: 'queueAdd', step, p: p ?? currentPatient(), ...(replace ? { replace: true } : {}) }),
    /** @param {number} i step index @param {-1 | 1} dir */
    queueMove: (i, dir) => client.send({ t: 'queueMove', i, dir }),
    /** @param {number} i step index */
    queueRemove: (i) => client.send({ t: 'queueRemove', i }),
    /** Live tempo for what is running. @param {0.5 | 1 | 2 | 'finish'} x @param {string} [p] */
    tempo: (x, p) => client.send({ t: 'tempo', x, p: p ?? currentPatient() }),
    /** @param {string} [label] */
    addPatient: (label) => client.send(label ? { t: 'addPatient', label } : { t: 'addPatient' }),
    /** @param {string} p */
    removePatient: (p) => client.send({ t: 'removePatient', p }),
  };
}
