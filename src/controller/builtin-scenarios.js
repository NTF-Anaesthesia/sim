// @ts-check
// Curated teaching scenarios (sim-train S4): generic, synthetic and teaching values only, never doses. Each starts from a
// normal baseline so it can be run on its own. `objectives` and the step `note` (cue and expected actions) show on the
// phone only. SpO2 falls slower than the rest through `glideMsBy`, as a finger probe does,
// and recovers at the step's own speed (faster than it fell).
// Every scenario is for clinical review before release; the audience tag of each is in SCENARIO_AUDIENCE.

/** @typedef {import('../shared/scenario.js').Scenario & { builtin?: boolean }} LibScenario */

const BASE = { rhythm: 'sinus', hr: 76, spo2: 98, rr: 12, etco2: 38, etco2Shape: 'normal', spo2Quality: 'good', temp: 36.8, pulse: true, nibp: { sys: 122, dia: 74 }, abp: { sys: 122, dia: 74 } };

/** Who the scenario is written for: the facilitator picks by audience. Tags: 'anaesthetist', 'nurse-OT'. */
export const SCENARIO_AUDIENCE = /** @type {Record<string, readonly string[]>} */ ({
  'Slow bleed': ['anaesthetist', 'nurse-OT'],
  'Apnoea on tap': ['anaesthetist'],
  'Rhythm to arrest': ['anaesthetist', 'nurse-OT'],
  'Induction desaturation': ['anaesthetist'],
  'Anaphylaxis': ['anaesthetist', 'nurse-OT'],
  'Insufflation bradycardia': ['anaesthetist', 'nurse-OT'],
  'LA toxicity': ['anaesthetist'],
  'Malignant hyperthermia': ['anaesthetist', 'nurse-OT'],
  'PACU hypotension': ['nurse-OT'],
  'High spinal': ['anaesthetist'],
  'Bronchospasm': ['anaesthetist'],
  'Witnessed VF arrest': ['anaesthetist', 'nurse-OT'],
  'False alarm: poor trace': ['nurse-OT'],
});

/** @type {LibScenario[]} */
export const CURATED_SCENARIOS = [
  {
    name: 'Induction desaturation', builtin: true,
    objectives: 'For anaesthetists. Recognise apnoea after induction, call for help, oxygenate before intubating. Teaching values, not dosing.',
    steps: [
      { atSec: 0, glideMs: 5000, note: 'Pre-oxygenated, awake. Baseline.', patch: { patient: BASE } },
      { atSec: 15, glideMs: 8000, glideMsBy: { spo2: 150000 }, note: 'Induced. No breath, EtCO2 flat. Cue: ask for the airway plan; expect mask ventilation and jaw thrust.', patch: { patient: { rr: 0, etco2: 0, etco2Shape: 'none', spo2: 80, hr: 88 } } },
      { atSec: 90, glideMs: 30000, glideMsBy: { spo2: 90000 }, note: 'Still desaturating. Expect: call for help, 100% oxygen, airway adjuncts, second operator, consider the difficult airway plan.', patch: { patient: { spo2: 66, hr: 62, rhythm: 'sinus_brady' } } },
      { onTap: true, glideMs: 20000, note: 'Tap when the airway is secured and ventilation confirmed by EtCO2.', patch: { patient: { rr: 12, etco2: 38, etco2Shape: 'normal', spo2: 98, hr: 80, rhythm: 'sinus' } } },
    ],
  },
  {
    name: 'Anaphylaxis', builtin: true,
    objectives: 'For anaesthetists and nurse/OT. Spot the triad of low pressure, fast pulse and high airway pressure early; stop the trigger, call for help, treat the shock. Not dosing.',
    steps: [
      { atSec: 0, glideMs: 5000, note: 'Stable, just after a new drug or latex exposure.', patch: { patient: BASE } },
      { atSec: 20, glideMs: 40000, glideMsBy: { spo2: 120000 }, note: 'Pressure falling, heart rate up, EtCO2 shape changes. Cue: what is new in the last few minutes? Stop the suspect agent.', patch: { patient: { hr: 128, rhythm: 'sinus_tachy', nibp: { sys: 70, dia: 35 }, abp: { sys: 70, dia: 35 }, spo2: 91, etco2: 32, etco2Shape: 'obstructive' } } },
      { atSec: 90, glideMs: 40000, glideMsBy: { spo2: 120000 }, note: 'Worsening. Expect: call for help, 100% oxygen, lie flat, rapid fluids, adrenaline per local protocol, note times.', patch: { patient: { hr: 142, nibp: { sys: 55, dia: 25 }, abp: { sys: 55, dia: 25 }, spo2: 86, etco2: 26 } } },
      { onTap: true, glideMs: 90000, note: 'Tap when treatment is under way: improving over minutes. Discuss tryptase sample and referral.', patch: { patient: { hr: 105, nibp: { sys: 105, dia: 62 }, abp: { sys: 105, dia: 62 }, spo2: 96, etco2: 36, etco2Shape: 'normal' } } },
    ],
  },
  {
    name: 'Insufflation bradycardia', builtin: true,
    objectives: 'For anaesthetists and nurse/OT. Link a slow heart rate to peritoneal stretch; ask the surgeon to release, then treat if needed. Teaching values, not dosing.',
    steps: [
      { atSec: 0, glideMs: 5000, note: 'Laparoscopy, about to insufflate. Baseline.', patch: { patient: BASE } },
      { atSec: 20, glideMs: 25000, note: 'Insufflation under way: rate falling, pressure drifting down. Cue: what changed just now? Tell the surgeon.', patch: { patient: { rhythm: 'sinus_brady', hr: 42, nibp: { sys: 92, dia: 52 }, abp: { sys: 92, dia: 52 }, etco2: 42 } } },
      { atSec: 40, glideMs: 15000, note: 'Lower still. Expect: stop insufflation and release, 100% oxygen, check depth, anticholinergic if it persists.', patch: { patient: { hr: 32, nibp: { sys: 78, dia: 42 }, abp: { sys: 78, dia: 42 } } } },
      { onTap: true, glideMs: 30000, note: 'Tap when insufflation is released or treatment given: heart rate recovers.', patch: { patient: { rhythm: 'sinus', hr: 72, nibp: { sys: 116, dia: 70 }, abp: { sys: 116, dia: 70 }, etco2: 38 } } },
    ],
  },
  {
    name: 'LA toxicity', builtin: true,
    objectives: 'For anaesthetists. Recognise early agitation after a block, then slowing and arrest; call for help, stop injecting, airway, lipid rescue per local protocol. Not dosing.',
    steps: [
      { atSec: 0, glideMs: 5000, note: 'Awake patient, regional block being performed. Baseline.', patch: { patient: BASE } },
      { atSec: 20, glideMs: 20000, note: 'Patient is agitated, reports a metallic taste and tingling around the mouth. Heart rate and pressure rise. Cue: stop injecting; what is happening?', patch: { patient: { rhythm: 'sinus_tachy', hr: 112, nibp: { sys: 158, dia: 94 }, abp: { sys: 158, dia: 94 } } } },
      { atSec: 40, glideMs: 40000, note: 'Seizure then slowing, pressure falling. Expect: call for help, airway and oxygen, control seizure, lipid emulsion rescue per protocol.', patch: { patient: { rhythm: 'sinus_brady', hr: 44, rr: 4, spo2: 90, etco2: 55, nibp: { sys: 70, dia: 38 }, abp: { sys: 70, dia: 38 } } } },
      { onTap: true, glideMs: 0, note: 'Tap to progress to cardiac arrest: start compressions, continue lipid rescue, prolonged resuscitation.', patch: { patient: { rhythm: 'vt', pulse: false, hr: 180, spo2: 60, etco2: 12, nibp: { sys: 0, dia: 0 }, abp: { sys: 0, dia: 0 } } } },
    ],
  },
  {
    name: 'Malignant hyperthermia', builtin: true,
    objectives: 'For anaesthetists and nurse/OT. Pick up rising EtCO2 and heart rate before the temperature; stop triggers, call for help, hyperventilate with oxygen, cool. Not dosing.',
    steps: [
      { atSec: 0, glideMs: 5000, note: 'Volatile agent in use, ventilated. Baseline.', patch: { patient: BASE } },
      { atSec: 30, glideMs: 90000, glideMsBy: { temp: 480000 }, note: 'EtCO2 and heart rate creep up despite unchanged ventilation. Cue: what are the causes of a rising EtCO2? Is the patient getting warm or rigid?', patch: { patient: { etco2: 62, hr: 118, rhythm: 'sinus_tachy', temp: 38.2 } } },
      { atSec: 120, glideMs: 90000, glideMsBy: { temp: 480000 }, note: 'Worsening. Expect: stop the agent, call for help, 100% oxygen with high flow, change the circuit, get the specific antidote and cooling.', patch: { patient: { etco2: 84, hr: 148, spo2: 93, temp: 40.1, nibp: { sys: 150, dia: 90 }, abp: { sys: 150, dia: 90 } } } },
      { onTap: true, glideMs: 180000, glideMsBy: { temp: 480000 }, note: 'Tap when treatment is under way: slow improvement over minutes. Discuss ICU, blood tests, referral.', patch: { patient: { etco2: 48, hr: 100, spo2: 97, temp: 38.0, nibp: { sys: 125, dia: 76 }, abp: { sys: 125, dia: 76 } } } },
    ],
  },
  {
    name: 'PACU hypotension', builtin: true,
    objectives: 'For nurse/OT. Notice falling pressure and rising pulse in recovery, check the wound and drains, escalate early, use a structured call for help. Teaching values, not dosing.',
    steps: [
      { atSec: 0, glideMs: 5000, note: 'Awake and comfortable after surgery. Baseline.', patch: { patient: { ...BASE, hr: 84, nibp: { sys: 118, dia: 72 }, abp: { sys: 118, dia: 72 } } } },
      { atSec: 30, glideMs: 120000, note: 'Pressure drifting down, pulse creeping up. Cue: check the dressing, drains and abdomen; is the patient pale or sweaty?', patch: { patient: { rhythm: 'sinus_tachy', hr: 108, nibp: { sys: 92, dia: 52 }, abp: { sys: 92, dia: 52 }, rr: 18 } } },
      { atSec: 120, glideMs: 90000, glideMsBy: { spo2: 180000 }, note: 'Falling further. Expect: call the anaesthetist, oxygen, lie flat and legs up, IV access check, ask the surgeon to review.', patch: { patient: { hr: 124, nibp: { sys: 74, dia: 40 }, abp: { sys: 74, dia: 40 }, rr: 22, spo2: 94 } } },
      { onTap: true, glideMs: 120000, note: 'Tap when the team is treating the cause: pressure comes back.', patch: { patient: { rhythm: 'sinus', hr: 92, nibp: { sys: 110, dia: 66 }, abp: { sys: 110, dia: 66 }, rr: 14, spo2: 98 } } },
    ],
  },
  {
    name: 'High spinal', builtin: true,
    objectives: 'For anaesthetists. Recognise a block that has risen too high (low pressure, slow pulse, weak breathing) and support airway, breathing and circulation. Not dosing.',
    steps: [
      { atSec: 0, glideMs: 5000, note: 'Awake patient, spinal just placed for a caesarean-style case. Baseline.', patch: { patient: { ...BASE, hr: 88 } } },
      { atSec: 30, glideMs: 60000, note: 'Pressure falling fast with a slow pulse. Patient says their arms feel heavy and breathing is hard to do. Cue: how high is the block?', patch: { patient: { rhythm: 'sinus_brady', hr: 48, nibp: { sys: 72, dia: 40 }, abp: { sys: 72, dia: 40 }, rr: 8 } } },
      { atSec: 60, glideMs: 40000, glideMsBy: { spo2: 120000 }, note: 'Breathing failing, patient drowsy. Expect: call for help, 100% oxygen, vasopressor and anticholinergic per protocol, tilt, prepare to secure the airway.', patch: { patient: { rr: 2, spo2: 90, etco2: 58, hr: 42, nibp: { sys: 62, dia: 32 }, abp: { sys: 62, dia: 32 } } } },
      { onTap: true, glideMs: 60000, note: 'Tap when airway and circulation are supported: block settles over time.', patch: { patient: { rhythm: 'sinus', hr: 82, rr: 12, spo2: 98, etco2: 38, nibp: { sys: 108, dia: 64 }, abp: { sys: 108, dia: 64 } } } },
    ],
  },
  {
    name: 'Bronchospasm', builtin: true,
    objectives: 'For anaesthetists. Tell bronchospasm from other causes of high airway pressure (blocked tube, pneumothorax, anaphylaxis); deepen, give oxygen and bronchodilator per protocol. Not dosing.',
    steps: [
      { atSec: 0, glideMs: 5000, note: 'Light anaesthetic, airway stimulated by the surgery. Baseline.', patch: { patient: BASE } },
      { atSec: 20, glideMs: 25000, glideMsBy: { spo2: 90000 }, note: 'EtCO2 trace takes a shark-fin shape, saturation drifts down, airway pressure rises. Cue: check the tube, circuit and chest; is the patient too light?', patch: { patient: { etco2Shape: 'obstructive', etco2: 52, spo2: 92, hr: 108, rhythm: 'sinus_tachy', nibp: { sys: 148, dia: 88 }, abp: { sys: 148, dia: 88 } } } },
      { atSec: 70, glideMs: 40000, glideMsBy: { spo2: 120000 }, note: 'Worsening. Expect: 100% oxygen, hand ventilate, deepen the anaesthetic, bronchodilator per protocol, think anaphylaxis if shocked.', patch: { patient: { etco2: 66, spo2: 84, hr: 124 } } },
      { onTap: true, glideMs: 90000, note: 'Tap when the airway improves: trace and saturation recover.', patch: { patient: { etco2Shape: 'normal', etco2: 40, spo2: 97, hr: 88, rhythm: 'sinus', nibp: { sys: 125, dia: 75 }, abp: { sys: 125, dia: 75 } } } },
    ],
  },
  {
    name: 'Witnessed VF arrest', builtin: true,
    objectives: 'For anaesthetists and nurse/OT. Recognise a shockable rhythm, call for help and start compressions, shock early and give clear roles. Teaching values, not dosing.',
    steps: [
      { atSec: 0, glideMs: 5000, note: 'Stable patient under care. Baseline.', patch: { patient: BASE } },
      { atSec: 20, glideMs: 0, note: 'Sudden collapse: chaotic trace, no pulse, no blood pressure. Cue: check the patient, call the arrest team, start compressions.', patch: { patient: { rhythm: 'vf', pulse: false, hr: 0, spo2: 70, etco2: 18, nibp: { sys: 0, dia: 0 }, abp: { sys: 0, dia: 0 } } } },
      { onTap: true, glideMs: 0, note: 'Tap after the shock is delivered and compressions resume: still pulseless, EtCO2 low.', patch: { patient: { rhythm: 'vf', etco2: 14 } } },
      { onTap: true, glideMs: 20000, note: 'Tap for return of circulation: post-arrest care, oxygen targets, 12-lead, cause search.', patch: { patient: { rhythm: 'sinus_tachy', pulse: true, hr: 110, spo2: 92, etco2: 40, nibp: { sys: 96, dia: 56 }, abp: { sys: 96, dia: 56 } } } },
    ],
  },
  {
    name: 'False alarm: poor trace', builtin: true,
    objectives: 'For nurse/OT. Check the patient before trusting the numbers: a bad trace can look like a crisis. Confirm with a second source (EtCO2, pulse, pressure). Teaching values.',
    steps: [
      { atSec: 0, glideMs: 5000, note: 'Stable, awake in recovery. Baseline.', patch: { patient: BASE } },
      { atSec: 20, glideMs: 5000, glideMsBy: { spo2: 15000 }, note: 'SpO2 alarm sounds: reading falls but the pulse and EtCO2 are unchanged. Cue: look at the patient, then the probe and the trace quality.', patch: { patient: { spo2Quality: 'poor', spo2: 72 } } },
      { onTap: true, glideMs: 5000, note: 'Tap when the probe is repositioned or warmed: the true reading returns. Discuss what to check first.', patch: { patient: { spo2Quality: 'good', spo2: 98 } } },
    ],
  },
];
