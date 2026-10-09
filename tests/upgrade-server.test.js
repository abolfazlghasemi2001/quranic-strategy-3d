import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameServer } from '../server/src/server.js';
class Socket extends EventEmitter {
  remoteAddress = '127.0.0.1'; writableLength = 0; writes = []; destroyed = false;
  write(bytes) { this.writes.push(bytes); return true; }
  end(bytes) { if (bytes) this.write(bytes); }
  destroy() { this.destroyed = true; this.emit('close'); }
  setTimeout() {}
}
const request = (origin) => ({ url: '/social-ws', headers: { host: 'localhost', origin, upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' } });
let server;
beforeEach(() => {
  vi.useFakeTimers(); server = new GameServer({ port: 0, saveFile: null, quiet: true });
  server.transport = { ...server.social.server.transport, maxConnectionsPerIp: 1, helloTimeoutMs: 100 };
});
afterEach(() => { [...server.conns].forEach((conn) => conn.ws.close()); vi.runAllTimers(); vi.useRealTimers(); });
describe('WS-03: connection admission and authentication deadlines', () => {
  it('refuses a second connection from one IP, and releases the slot on close', () => {
    const first = new Socket(), second = new Socket();
    server._onUpgrade(request(), first, Buffer.alloc(0)); server._onUpgrade(request(), second, Buffer.alloc(0));
    expect(second.destroyed).toBe(true); expect(server.conns.size).toBe(1);
    [...server.conns][0].ws.close(); expect(server.connectionsByIp.size).toBe(0);
    const third = new Socket(); server._onUpgrade(request(), third, Buffer.alloc(0)); expect(server.conns.size).toBe(1);
  });
  it('rejects a browser Origin outside the same host / explicit configured allowlist', () => {
    const socket = new Socket(); server._onUpgrade(request('https://foreign.invalid'), socket, Buffer.alloc(0));
    expect(socket.destroyed).toBe(true); expect(server.conns.size).toBe(0);
  });
  it('closes a socket that never sends authenticated hello', () => {
    const socket = new Socket(); server._onUpgrade(request(), socket, Buffer.alloc(0));
    vi.advanceTimersByTime(101); expect(server.conns.size).toBe(0);
    vi.advanceTimersByTime(1001); expect(socket.destroyed).toBe(true);
  });
});
