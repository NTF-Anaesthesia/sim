// @ts-check
// Home page: "New room" (code + QR) and join by code. No work on import.
import { qrcode } from '../vendor/qrcode.js';
import { isCode, normalizeCode } from '../shared/schema.js';

/**
 * @param {string} text
 * @returns {string} an SVG string
 */
export function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

/** @param {Document} doc */
export function mountHome(doc) {
  const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (doc.getElementById(id));
  $('new').addEventListener('click', async () => {
    const res = await fetch('api/room', { method: 'POST' });
    const { code } = await res.json();
    $('code').textContent = code;
    const controllerUrl = `${location.origin}/c/${code}`;
    $('qr').innerHTML = qrSvg(controllerUrl);
    /** @type {HTMLAnchorElement} */ ($('open-m')).href = `m/${code}`;
    /** @type {HTMLAnchorElement} */ ($('open-c')).href = `c/${code}`;
    $('room').hidden = false;
  });
  $('join').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = normalizeCode(/** @type {HTMLInputElement} */ ($('join-code')).value);
    const which = /** @type {SubmitEvent} */ (e).submitter?.getAttribute('data-join') ?? 'c';
    if (isCode(code)) location.href = `${which}/${code}`;
    else $('join-code').setAttribute('aria-invalid', 'true');
  });
}
