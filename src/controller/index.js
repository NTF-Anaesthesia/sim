// @ts-check
// Entry `controller`: the phone controller. S1 shell: joins the room and sends a test value. No work on import.
import { RoomClient, newClientId, roomUrl } from '../room/client.js';

/**
 * @param {HTMLElement} root
 * @param {{ code: string, location?: { protocol: string, host: string } }} opts
 * @returns {RoomClient}
 */
export function mountController(root, opts) {
  const loc = opts.location ?? window.location;
  const client = new RoomClient({ url: roomUrl(loc, opts.code, 'controller', newClientId('controller')) });
  root.innerHTML = `
    <p class="chip" id="status" data-status="connecting">connecting</p>
    <p class="code">Room <b id="code"></b></p>
    <label class="label" for="input">Test value</label>
    <input id="input" data-testid="input" type="text" inputmode="numeric" autocomplete="off" maxlength="20">
    <button id="send" data-testid="send" type="button">Send</button>
    <p class="label">Current: <span id="current">--</span></p>`;
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (root.querySelector(`#${id}`));
  $('code').textContent = opts.code;
  const input = /** @type {HTMLInputElement} */ ($('input'));
  const send = () => client.send({ t: 'test', value: input.value });
  $('send').addEventListener('click', send);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  client.on('status', (s) => { $('status').textContent = s === 'open' ? 'live' : s; $('status').dataset.status = s; });
  client.on('state', (state) => {
    const v = /** @type {any} */ (state).test;
    $('current').textContent = v === undefined ? '--' : String(v);
  });
  client.connect();
  return client;
}
