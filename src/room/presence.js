// @ts-check
// Who is connected: counts of monitors and controllers, sent to every socket when someone joins or leaves.
// Not part of the room state (nothing stored); a client keeps the last message it got.

/**
 * @param {Array<{ role?: string } | null | undefined>} metas the per-socket attachments (`role`: monitor or controller)
 * @returns {{ t: 'presence', monitors: number, controllers: number }}
 */
export function presenceMessage(metas) {
  let monitors = 0;
  let controllers = 0;
  for (const m of metas) {
    if (m?.role === 'monitor') monitors++;
    else controllers++;
  }
  return { t: 'presence', monitors, controllers };
}
