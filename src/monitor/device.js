// @ts-check
// Per-device Sound and Keep awake: what the Keep awake button says, when to show the "tap to turn sound on" prompt, and
// asking for a screen wake lock. Pure and DOM-free so node can test it. No work on import.

/** Title on the Keep awake button when the browser cannot hold a wake lock. */
export const WAKE_UNSUPPORTED_TITLE = 'This browser cannot keep the screen on: turn off the sleep timer in the device settings';

/**
 * Keep awake button text. 'Awake on' only while a lock is held; a wish the browser cannot honour says so.
 * @param {{ wanted: boolean, held: boolean, supported: boolean, failed: boolean }} s
 * @returns {{ text: string, title: string }}
 */
export function wakeLabel({ wanted, held, supported, failed }) {
  if (!wanted) return { text: 'Keep awake', title: '' };
  if (!supported || failed) return { text: 'Awake: not supported', title: WAKE_UNSUPPORTED_TITLE };
  if (held) return { text: 'Awake on', title: '' };
  return { text: 'Keep awake…', title: '' };
}

/**
 * Show "Tap anywhere to turn sound on" when sound was turned on on this device (or before the page was hidden) but
 * the browser has not let it play yet.
 * @param {{ soundWanted: boolean, running: boolean }} s
 */
export function soundPrompt({ soundWanted, running }) {
  return soundWanted && !running;
}

/**
 * Ask for a screen wake lock. Never throws.
 * @param {{ wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinel> } } | null | undefined} nav
 * @returns {Promise<{ state: 'held', sentinel: WakeLockSentinel } | { state: 'unsupported' } | { state: 'failed' }>}
 */
export async function requestWake(nav) {
  const wl = nav?.wakeLock;
  if (!wl || typeof wl.request !== 'function') return { state: 'unsupported' };
  try {
    const sentinel = await wl.request('screen');
    return sentinel ? { state: 'held', sentinel } : { state: 'failed' };
  } catch {
    return { state: 'failed' };
  }
}
