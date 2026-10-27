// @ts-check
// QR code for a share link, at the lowest error-correction level so the code stays as small as possible.
import { qrcode } from '../vendor/qrcode.js';

/** @param {string} text @returns {string | null} an SVG string, or null when the text does not fit a QR code */
export function qrSvgLow(text) {
  try {
    const qr = qrcode(0, 'L');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } catch { return null; }
}
