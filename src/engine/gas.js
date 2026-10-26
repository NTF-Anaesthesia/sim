// @ts-check
// Gas numerics: age-adjusted MAC (minimum alveolar concentration) for the volatile agents and nitrous oxide. Pure.
//
// Source: Nickalls RWD, Mapleson WW. Age-related iso-MAC charts for isoflurane, sevoflurane and desflurane in man.
// Br J Anaesth 2003;91:170-4 (MAC40 values in % at age 40, N2O 104 %), built on Mapleson WW, Effect of age on MAC in
// humans: a meta-analysis, Br J Anaesth 1996;76:179-85. MAC(age) = MAC40 * 10^(-0.00269 * (age - 40)), about 6 % less
// per decade. MACs of agent and nitrous oxide add. Teaching numbers only.

export const AGENT_IDS = ['none', 'sevo', 'des', 'iso'];
/** MAC at age 40, volume %. */
export const MAC40 = { sevo: 1.8, des: 6.6, iso: 1.17, n2o: 104 };
export const AGENT_NAMES = { none: '', sevo: 'Sevo', des: 'Des', iso: 'Iso' };
export const MAC_PER_YEAR = 0.00269;

/**
 * @param {'sevo' | 'des' | 'iso' | 'n2o'} gas
 * @param {number} age years
 * @returns {number} MAC in %
 */
export function macAt(gas, age) {
  const a = Number.isFinite(age) ? Math.min(110, Math.max(0, age)) : 40;
  return MAC40[gas] * 10 ** (-MAC_PER_YEAR * (a - 40));
}

/**
 * Age-adjusted MAC fraction of the expired agent and nitrous oxide together.
 * @param {{ agent: string, age: number }} p patient
 * @param {number} etag expired agent %
 * @param {number} etn2o expired nitrous oxide %
 * @returns {number}
 */
export function macFraction(p, etag, etn2o) {
  const ag = p.agent === 'sevo' || p.agent === 'des' || p.agent === 'iso' ? etag / macAt(p.agent, p.age) : 0;
  return ag + etn2o / macAt('n2o', p.age);
}
