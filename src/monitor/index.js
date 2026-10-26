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
  const pick = new URLSearchParams(loc.search ?? '').get('p');
  mountScreen(root, { client, code: opts.code, pick });
  client.connect();
  return client;
}
