// @ts-check
// Entry `monitor`: the monitor screen. S1 shell: joins the room and shows the test value live. No work on import.
import { RoomClient, newClientId, roomUrl } from '../room/client.js';

/**
 * @param {HTMLElement} root
 * @param {{ code: string, location?: { protocol: string, host: string } }} opts
 * @returns {RoomClient}
 */
export function mountMonitor(root, opts) {
  const loc = opts.location ?? window.location;
  const client = new RoomClient({ url: roomUrl(loc, opts.code, 'monitor', newClientId('monitor')) });
  root.innerHTML = `
    <p class="chip" id="status" data-status="connecting">connecting</p>
    <p class="code">Room <b id="code"></b></p>
    <p class="label">Test value</p>
    <p class="value" id="value" data-testid="value">--</p>`;
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (root.querySelector(`#${id}`));
  $('code').textContent = opts.code;
  client.on('status', (s) => { $('status').textContent = s === 'open' ? 'live' : s; $('status').dataset.status = s; });
  client.on('state', (state) => {
    const v = /** @type {any} */ (state).test;
    $('value').textContent = v === undefined ? '--' : String(v);
  });
  client.connect();
  return client;
}
