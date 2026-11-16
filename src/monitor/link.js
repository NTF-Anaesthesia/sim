// @ts-check
// Link state for the monitor: when to show the "connection lost" banner, and waking the socket when the page comes
// back (laptop lid opened, Wi-Fi changed). Pure and DOM-free so node can test it. No work on import.

/** A link that has been down this long (ms) shows the banner; shorter blips only change the chip. */
export const LINK_GRACE_MS = 5000;

/** @param {number} ms local clock @returns {string} hh:mm:ss */
export function clockText(ms) {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/**
 * What the banner says now. `downSince` is when the status last left 'open' (or the page load, before the first
 * connection); `lastStateAt` the local time of the last state message (0 = none yet). A room that is full or expired
 * will not come back by waiting, so those show at once; anything else only after `LINK_GRACE_MS`.
 * @param {{ status: string, downSince: number, lastStateAt: number, now: number }} o
 * @returns {{ show: false } | { show: true, kind: 'lost' | 'full' | 'expired', text: string, sub: string }}
 */
export function linkBanner({ status, downSince, lastStateAt, now }) {
  if (status === 'open') return { show: false };
  if (status === 'expired') return { show: true, kind: 'expired', text: 'This room has expired', sub: '' };
  if (status === 'full') return { show: true, kind: 'full', text: 'Room is full', sub: 'Too many devices are joined. Close one, then reload this page.' };
  const down = now - downSince;
  if (down < LINK_GRACE_MS) return { show: false };
  const sub = lastStateAt > 0 ? `last update ${clockText(lastStateAt)}` : `not connected for ${Math.floor(down / 1000)} s`;
  return { show: true, kind: 'lost', text: 'Connection lost: values may be out of date', sub };
}

/**
 * Call `client.wake()` when the page is shown again, the window gets focus or the network returns, and `onVisible`
 * when the document becomes visible. Returns a function that removes the listeners.
 * @param {{ wake: () => void }} client
 * @param {{ doc: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>, win: Pick<Window, 'addEventListener' | 'removeEventListener'>, onVisible?: () => void }} o
 */
export function watchWake(client, { doc, win, onVisible }) {
  const wake = () => { if (doc.visibilityState !== 'hidden') client.wake(); };
  const vis = () => {
    if (doc.visibilityState === 'hidden') return;
    client.wake();
    onVisible?.();
  };
  doc.addEventListener('visibilitychange', vis);
  for (const ev of ['pageshow', 'online', 'focus']) win.addEventListener(ev, wake);
  return () => {
    doc.removeEventListener('visibilitychange', vis);
    for (const ev of ['pageshow', 'online', 'focus']) win.removeEventListener(ev, wake);
  };
}
