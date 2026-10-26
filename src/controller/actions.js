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
   */
  function act(patch, glideMs, p) {
    /** @type {Record<string, any>} */
    const msg = { t: 'set', patch, p: p ?? currentPatient() };
    if (glideMs !== undefined) msg.glideMs = glideMs;
    return client.send(msg);
  }
  return {
    act,
    /** Measure now. @param {string} [p] */
    nibpNow: (p) => client.send({ t: 'nibp', p: p ?? currentPatient() }),
    /** Flush test of an art line. @param {'abp' | 'abp2'} line @param {string} [p] */
    flush: (line, p) => client.send({ t: 'flush', line, p: p ?? currentPatient() }),
    silence: () => client.send({ t: 'silence' }),
    /** @param {string} [label] */
    addPatient: (label) => client.send(label ? { t: 'addPatient', label } : { t: 'addPatient' }),
    /** @param {string} p */
    removePatient: (p) => client.send({ t: 'removePatient', p }),
  };
}
