// @ts-check
// Worker entry: new-room API, WebSocket to the room object, pretty room URLs, then static files.
import { isCode, newCode, normalizeCode } from '../src/shared/schema.js';

export { Room } from './room.js';

/** @param {Response} res */
function withHeaders(res) {
  const r = new Response(res.body, res);
  r.headers.set('X-Content-Type-Options', 'nosniff');
  r.headers.set('Referrer-Policy', 'no-referrer');
  return r;
}

export default {
  /**
   * @param {Request} request
   * @param {{ ROOM: DurableObjectNamespace, ASSETS: Fetcher }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/room' && request.method === 'POST') {
      return withHeaders(Response.json({ code: newCode() }, { headers: { 'Cache-Control': 'no-store' } }));
    }

    const ws = path.match(/^\/ws\/([^/]+)$/);
    if (ws) {
      const code = normalizeCode(decodeURIComponent(ws[1]));
      if (!isCode(code)) return new Response('bad room code', { status: 400 });
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected a WebSocket', { status: 426 });
      return env.ROOM.get(env.ROOM.idFromName(code)).fetch(request);
    }

    // /m/<code> is the monitor, /c/<code> the controller: both serve the page, which reads the code from the address
    const page = path.match(/^\/([mc])(?:\/([^/]*))?$/);
    if (page) {
      if (page[2] && !isCode(normalizeCode(decodeURIComponent(page[2])))) return withHeaders(new Response('bad room code', { status: 404 }));
      return withHeaders(await env.ASSETS.fetch(new Request(`${url.origin}/${page[1]}/index.html`, request)));
    }

    const file = path === '/' ? '/index.html' : path;
    return withHeaders(await env.ASSETS.fetch(new Request(`${url.origin}${file}`, request)));
  },
};
