// @ts-check
// Share link for one scenario: `<host>/c/#s=<payload>`. The payload is base64url of one version byte (1) followed by the
// scenario JSON compressed with DEFLATE (the browser's own `CompressionStream`, no library). Nothing is stored on a server;
// the whole scenario is in the link. A link is read with the same validator as a library file entry.
import { MAX_SCENARIO_CHARS, validateScenario } from '../shared/scenario.js';

export const SHARE_VERSION = 1;
/** Links up to this many characters get a QR code (about version 22 at level L, which a phone camera reads from a screen); longer ones show the link only. */
export const SAFE_QR_CHARS = 850;
const PREFIX = '#s=';

/** @param {Uint8Array} bytes */
function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** @param {string} text @returns {Uint8Array | null} */
function unb64url(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch { return null; }
}

/**
 * Run bytes through a (de)compression stream. Stops with null when the output passes `maxOut` bytes or the data is bad.
 * @param {'compress' | 'decompress'} mode @param {Uint8Array} input @param {number} maxOut
 * @returns {Promise<Uint8Array | null>}
 */
async function run(mode, input, maxOut) {
  const ts = mode === 'compress' ? new CompressionStream('deflate-raw') : new DecompressionStream('deflate-raw');
  const writer = ts.writable.getWriter();
  const written = writer.write(/** @type {BufferSource} */ (input)).then(() => writer.close());
  written.catch(() => {}); // a bad stream rejects the read below; this keeps the write error from being unhandled
  const reader = ts.readable.getReader();
  /** @type {Uint8Array[]} */
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxOut) { await reader.cancel(); return null; }
      parts.push(value);
    }
  } catch { return null; }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/**
 * The payload for one scenario (built-in flags and unknown fields are dropped).
 * @param {unknown} scenario
 * @returns {Promise<{ ok: true, payload: string } | { ok: false, msg: string }>}
 */
export async function encodeScenario(scenario) {
  const v = validateScenario(scenario);
  if (!v.ok) return v;
  const packed = await run('compress', new TextEncoder().encode(JSON.stringify(v.scenario)), 1 << 20);
  if (!packed) return { ok: false, msg: 'could not compress the scenario' };
  const bytes = new Uint8Array(packed.length + 1);
  bytes[0] = SHARE_VERSION;
  bytes.set(packed, 1);
  return { ok: true, payload: b64url(bytes) };
}

/**
 * Read a payload. A bad, damaged or too-new link is refused with a reason; nothing else happens.
 * @param {string} payload
 * @returns {Promise<{ ok: true, scenario: import('../shared/scenario.js').Scenario } | { ok: false, msg: string }>}
 */
export async function decodeScenario(payload) {
  const bytes = unb64url(payload.trim());
  if (!bytes || bytes.length < 2) return { ok: false, msg: 'this link is damaged' };
  if (bytes[0] > SHARE_VERSION) return { ok: false, msg: 'this link was made by a newer version of the app; reload this page or update, then open it again' };
  if (bytes[0] < 1) return { ok: false, msg: 'this link is damaged' };
  const raw = await run('decompress', bytes.subarray(1), MAX_SCENARIO_CHARS * 4);
  if (!raw) return { ok: false, msg: 'this link is damaged or too large' };
  /** @type {unknown} */
  let data;
  try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { return { ok: false, msg: 'this link is damaged' }; }
  const v = validateScenario(data);
  return v.ok ? v : { ok: false, msg: `this link does not hold a valid scenario: ${v.msg}` };
}

/** @param {string} origin e.g. `https://sim.anantf.com` @param {string} payload */
export const linkFor = (origin, payload) => `${origin}/c/${PREFIX}${payload}`;

/** The payload in a page's hash (`#s=...`), or null when the hash is not a share link. @param {string} hash */
export const payloadFromHash = (hash) => (hash.startsWith(PREFIX) && hash.length > PREFIX.length ? hash.slice(PREFIX.length) : null);

/** Whether a link of this length gets a QR code. @param {string} link */
export const qrFits = (link) => link.length <= SAFE_QR_CHARS;
