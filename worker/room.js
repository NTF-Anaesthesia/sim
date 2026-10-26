// @ts-check
// The Room Durable Object (SQLite-backed, WebSocket Hibernation API). One object per room code. The logic is in
// src/room/hub.js; this file only does sockets. State is read from storage after a wake, never trusted in memory.
import { DurableObject } from 'cloudflare:workers';
import { RoomHub } from '../src/room/hub.js';
import { presenceMessage } from '../src/room/presence.js';

const MAX_SOCKETS = 20;

/** @extends {DurableObject<any>} */
export class Room extends DurableObject {
  /**
   * @param {DurableObjectState} ctx
   * @param {any} env
   */
  constructor(ctx, env) {
    super(ctx, env);
    this.hub = new RoomHub(ctx.storage);
  }

  /** @param {Request} request */
  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected a WebSocket', { status: 426 });
    const url = new URL(request.url);
    const role = url.searchParams.get('role') === 'monitor' ? 'monitor' : 'controller';
    const id = (url.searchParams.get('id') ?? '').replace(/[^a-z0-9-]/gi, '').slice(0, 12) || 'anon';
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      server.accept();
      server.close(4002, 'room full');
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, role });
    server.send(JSON.stringify(await this.hub.hello()));
    this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * @param {WebSocket} ws
   * @param {string | ArrayBuffer} message
   */
  async webSocketMessage(ws, message) {
    const meta = ws.deserializeAttachment() ?? { id: 'anon' };
    const out = await this.hub.onMessage(meta.id, typeof message === 'string' ? message : '');
    if (out.reply) ws.send(JSON.stringify(out.reply));
    if (out.iam && meta.role === 'monitor') {
      ws.serializeAttachment({ ...meta, s: out.iam.s, dev: out.iam.dev });
      this.broadcastPresence();
    }
    if (out.broadcast) {
      const text = JSON.stringify(out.broadcast);
      for (const peer of this.ctx.getWebSockets()) {
        try { peer.send(text); } catch { /* socket closing */ }
      }
    }
  }

  /**
   * Tell every socket how many monitors and controllers are connected and which named screens are online (not stored;
   * each client keeps the last one).
   * @param {WebSocket} [leaving] a socket that is closing and must not be counted
   */
  broadcastPresence(leaving) {
    const metas = this.ctx.getWebSockets().filter((w) => w !== leaving).map((w) => w.deserializeAttachment());
    const text = JSON.stringify(presenceMessage(metas));
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === leaving) continue;
      try { peer.send(text); } catch { /* socket closing */ }
    }
  }

  /**
   * @param {WebSocket} ws
   * @param {number} code
   */
  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code); } catch { /* already closed */ }
    this.broadcastPresence(ws);
  }

  /** @param {WebSocket} ws */
  async webSocketError(ws) {
    this.broadcastPresence(ws);
  }

  async alarm() {
    const { expired, broadcast } = await this.hub.onAlarm();
    if (expired) for (const ws of this.ctx.getWebSockets()) ws.close(4001, 'room expired');
    if (broadcast) {
      const text = JSON.stringify(broadcast);
      for (const peer of this.ctx.getWebSockets()) {
        try { peer.send(text); } catch { /* socket closing */ }
      }
    }
  }
}
