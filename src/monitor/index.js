// @ts-check
// Entry `monitor`: the monitor screen for a room. No work on import; `mountMonitor` joins the room and draws.
import { RoomClient, newClientId, roomUrl } from '../room/client.js';
import { mountScreen } from './screen.js';

/**
 * @param {HTMLElement} root
 * @param {{ code: string, location?: { protocol: string, host: string, search?: string } }} opts
 * @returns {RoomClient}
 */
export function mountMonitor(root, opts) {
  const loc = opts.location ?? window.location;
  const client = new RoomClient({ url: roomUrl(loc, opts.code, 'monitor', newClientId('monitor')) });
  const q = new URLSearchParams(loc.search ?? '');
  // `?p=` picks the bed on this device, `?s=` which named screen it is; the phone can clear `?p=` (it shadows the screen's bed)
  const onClearPick = () => {
    if (loc !== window.location) return;
    try { const u = new URL(location.href); u.searchParams.delete('p'); history.replaceState(null, '', u); } catch { /* no history here */ }
  };
  mountScreen(root, { client, code: opts.code, pick: q.get('p'), screenParam: q.get('s'), onClearPick });
  client.connect();
  return client;
}
