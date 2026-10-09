import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../src/core/Config.js';
import { QuranDatasetLoader } from '../src/game/quran/QuranDataset.js';
import { WSConnection, handleUpgradeRequest } from '../server/src/ws.js';
import { filterChat } from '../server/src/chatFilter.js';
import sample from '../src/data/quran-sample.json';
import learning from '../src/data/quran-learning.json';
import social from '../src/data/social.json';

class Socket extends EventEmitter {
  writableLength = 0;
  writes = [];
  destroyed = false;
  write(bytes) { this.writes.push(bytes); return true; }
  end() { this.ended = true; }
  destroy() { this.destroyed = true; this.emit('close'); }
  setTimeout() {}
}
function frame(opcode = 1, text = 'hello', { fin = true, masked = true, rsv = 0 } = {}) {
  const body = Buffer.from(text);
  const mask = Buffer.from([1, 2, 3, 4]);
  let header;
  if (body.length < 126) header = Buffer.from([(fin ? 128 : 0) | rsv | opcode, (masked ? 128 : 0) | body.length]);
  else {
    header = Buffer.alloc(4);
    header[0] = (fin ? 128 : 0) | rsv | opcode;
    header[1] = (masked ? 128 : 0) | 126;
    header.writeUInt16BE(body.length, 2);
  }
  if (masked) for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i % 4];
  return Buffer.concat([header, ...(masked ? [mask] : []), body]);
}
const setup = (options) => {
  const socket = new Socket();
  const ws = new WSConnection(socket, options);
  const received = [];
  ws.onMessage = (text) => received.push(text);
  return { socket, ws, received, feed: (bytes) => socket.emit('data', bytes) };
};
afterEach(() => vi.useRealTimers());

describe('untrusted query endpoints', () => {
  it.each(['wss://external.invalid/social-ws', 'ws://external.invalid/', 'wss://user:pw@localhost/social-ws'])('rejects automatic credential forwarding to %s', (url) => {
    const config = new Config({ search: `?social=${encodeURIComponent(url)}`, env: { baseUrl: 'https://localhost/' } });
    expect(config.socialUrl).toBeNull();
  });
  it('retains a same-origin secure websocket endpoint', () => {
    const config = new Config({ search: '?social=wss://localhost/social-ws', env: { baseUrl: 'https://localhost/' } });
    expect(config.socialUrl).toBe('wss://localhost/social-ws');
  });
  it.each(['https://external.invalid/quran.json', '//external.invalid/quran.json', 'data:application/json,{}', '../outside.json', './quran/%2e%2e/other.json'])('ignores unsafe Quran override %s', (url) => {
    const loader = new QuranDatasetLoader({ sample, learning, search: `?quran=${encodeURIComponent(url)}`, baseUrl: 'https://localhost/' });
    expect(loader.resolveUrl()).toBe('./quran/quran.json');
  });
});

describe('RFC6455 negative / split-frame regression matrix', () => {
  it.each([
    ['unmasked', [frame(1, 'hello', { masked: false })]],
    ['RSV1', [frame(1, 'hello', { rsv: 64 })]],
    ['orphan FIN continuation', [frame(0)]],
    ['interleaved text fragments', [frame(1, 'first', { fin: false }), frame(1, 'second')]],
    ['fragmented ping', [frame(9, 'ping', { fin: false })]],
    ['oversized control', [frame(9, 'x'.repeat(126))]],
    ['invalid UTF-8', [frame(1, Buffer.from([0xc0, 0x80]))]],
    ['one-byte close', [frame(8, Buffer.from([1]))]],
    ['reserved opcode', [frame(3)]],
  ])('rejects %s without delivering a message', (_name, bytes) => {
    const { feed, ws, received } = setup();
    bytes.forEach(feed);
    expect(ws.closed).toBe(true);
    expect(received).toEqual([]);
  });
  it('accepts every TCP split point and a control frame interleaved with valid fragmentation', () => {
    const wire = Buffer.concat([frame(1, 'سلام ', { fin: false }), frame(9, 'ping'), frame(0, 'نور')]);
    for (let i = 1; i < wire.length; i += 1) {
      const { feed, ws, received } = setup();
      feed(wire.subarray(0, i)); feed(wire.subarray(i));
      expect(received).toEqual(['سلام نور']); expect(ws.closed).toBe(false);
      ws.close();
    }
  });
  it('enforces the cumulative message limit across fragments', () => {
    const { ws, feed, received } = setup({ maxMessageBytes: 12, maxFrameBytes: 12 });
    feed(frame(1, 'a'.repeat(8), { fin: false })); feed(frame(0, 'b'.repeat(8)));
    expect(ws.closed).toBe(true); expect(received).toEqual([]);
  });
  it('times out a partial header and force-destroys a peer that never closes', () => {
    vi.useFakeTimers();
    const { ws, socket, feed } = setup({ frameTimeoutMs: 100, closeTimeoutMs: 50 });
    feed(Buffer.from([0x81]));
    vi.advanceTimersByTime(101);
    expect(ws.closed).toBe(true);
    vi.advanceTimersByTime(51);
    expect(socket.destroyed).toBe(true);
    expect(ws.buffer.length).toBe(0);
  });
  it('bounds a slow reader instead of growing the TCP write queue', () => {
    const { ws, socket } = setup({ maxBufferedBytes: 100 });
    socket.writableLength = 101;
    expect(ws.send('message')).toBe(false);
    expect(ws.closed).toBe(true);
  });
  it('rejects an invalid handshake key/version', () => {
    const socket = new Socket();
    const req = { url: '/social-ws', headers: { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'not-a-base64-key', 'sec-websocket-version': '12' } };
    expect(handleUpgradeRequest(req, socket, Buffer.alloc(0), { path: '/social-ws' })).toBeNull();
  });
});

describe('moderation normalization', () => {
  it.each([' ', '\u200c', '\u200d', '\u064e', '\u0640', '.', '\u2060', '\u200b'])('matches a blocked word separated by %j', (separator) => {
    const word = social.chat.profanity[0];
    const result = filterChat(`سلام ${[...word].join(separator)} پایان`, { wordlist: social.chat.profanity, mask: social.chat.mask });
    expect(result.blocked).toBe(true);
    expect(result.text).toContain('سلام'); expect(result.text).toContain('پایان');
  });
  it('preserves innocent Persian and does not join whole unrelated words', () => {
    expect(filterChat('سلام، شهر نور زیباست', { wordlist: social.chat.profanity }).blocked).toBe(false);
    expect(filterChat('ab cd', { wordlist: ['bc'] }).blocked).toBe(false);
  });
});

export { Socket, frame };


describe('CSP and transport fuzz', () => {
  it('declares a restrictive application CSP without inline script permission', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("default-src 'self'");
    expect(html).toContain("object-src 'none'");
    expect(html).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });
  it('bounds buffers and deadlines in 1024 deterministic malformed/split inputs', () => {
    vi.useFakeTimers();
    let seed = 0x20261009;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    for (let i = 0; i < 1024; i += 1) {
      const { ws, feed, received } = setup({ maxFrameBytes: 64, maxMessageBytes: 64, maxFragments: 8, frameTimeoutMs: 100, closeTimeoutMs: 10 });
      const wire = Buffer.alloc(1 + random() % 200);
      for (let j = 0; j < wire.length; j += 1) wire[j] = random() & 255;
      const split = 1 + random() % wire.length;
      feed(wire.subarray(0, split)); feed(wire.subarray(split));
      expect(ws.buffer.length).toBeLessThanOrEqual(78);
      expect(ws.fragmentBytes).toBeLessThanOrEqual(64);
      if (ws.buffer.length || ws.fragmented) { vi.advanceTimersByTime(101); expect(ws.closed).toBe(true); }
      expect(received.every((text) => !text.includes('\ufffd'))).toBe(true);
      ws.close(); vi.advanceTimersByTime(11);
    }
  });
});
