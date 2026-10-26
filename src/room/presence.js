// @ts-check
// Who is connected: counts of monitors and controllers, and the named screens that are online with the device choices
// each has (V2 S1), sent to every socket when someone joins, leaves or says which screen it is (`iam`).
// Not part of the room state (nothing stored); a client keeps the last message it got.

/**
 * @typedef {{ s: string, dev: string[] }} OnlineScreen
 * @param {Array<{ role?: string, s?: string | null, dev?: string[] } | null | undefined>} metas the per-socket
 *   attachments (`role`: monitor or controller; `s`, `dev` from the monitor's last `iam`)
 * @returns {{ t: 'presence', monitors: number, controllers: number, screens: OnlineScreen[] }}
 */
export function presenceMessage(metas) {
  let monitors = 0;
  let controllers = 0;
  /** @type {Map<string, Set<string>>} */
  const screens = new Map();
  for (const m of metas) {
    if (m?.role === 'monitor') {
      monitors++;
      if (m.s) {
        const dev = screens.get(m.s) ?? new Set();
        for (const d of m.dev ?? []) dev.add(d);
        screens.set(m.s, dev);
      }
    } else controllers++;
  }
  return { t: 'presence', monitors, controllers, screens: [...screens].map(([s, dev]) => ({ s, dev: [...dev] })) };
}
