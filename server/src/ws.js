/** Bounded RFC6455 text transport. No extensions; client frames MUST be masked. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TextDecoder } from 'node:util';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const TRANSPORT_LIMITS = Object.freeze(JSON.parse(readFileSync(new URL('../../src/data/social.json', import.meta.url), 'utf8')).server.transport);
const utf8 = new TextDecoder('utf-8', { fatal: true });
const protocolError = (message, code = 1002) => Object.assign(new Error(message), { code });
const validCloseCode = (code) => (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999);
export function acceptKey(key) { return createHash('sha1').update(String(key) + WS_GUID).digest('base64'); }

export class WSConnection {
  constructor(socket, limits = {}) {
    this.socket = socket;
    this.limits = { ...TRANSPORT_LIMITS, ...limits };
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmented = false;
    this.closed = false;
    this._closeFired = false;
    this.isAlive = true;
    this.onMessage = null; this.onClose = null; this.onError = null;
    this._frameTimer = null; this._closeTimer = null;
    this._rateWindow = 0; this._framesInWindow = 0;
    socket.on('data', (chunk) => this.pushHead(chunk));
    socket.on('close', () => this._closed(1006, 'tcp-closed'));
    socket.on('error', (error) => { this.onError?.(error); this.close(1011, 'socket-error'); });
    socket.setTimeout?.(this.limits.idleTimeoutMs, () => this.close(1001, 'idle-timeout'));
  }

  pushHead(chunk) {
    if (this.closed || !chunk?.length) return;
    try { this._onData(chunk); }
    catch (error) {
      this.onError?.(error);
      this.close(error.code || 1002, error.message || 'protocol-error');
    }
  }

  _onData(chunk) {
    // Consume coalesced valid frames in bounded pieces, rather than rejecting a
    // healthy TCP packet containing several frames or allocating an unlimited buffer.
    const ceiling = this.limits.maxFrameBytes + 14;
    let cursor = 0;
    while (cursor < chunk.length && !this.closed) {
      const take = Math.min(ceiling - this.buffer.length, chunk.length - cursor);
      if (take <= 0) throw protocolError('frame-too-large', 1009);
      const part = chunk.subarray(cursor, cursor + take);
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, part], this.buffer.length + take) : part;
      cursor += take;
      while (!this.closed && this._parseFrame()) { /* consume */ }
    }
    this._updateDeadline();
  }

  _updateDeadline() {
    if (!this.buffer.length && !this.fragmented) {
      clearTimeout(this._frameTimer); this._frameTimer = null;
    } else if (!this._frameTimer) {
      // Absolute deadline for a partial frame/message; trickle bytes do NOT extend it.
      this._frameTimer = setTimeout(() => this.close(1002, 'frame-timeout'), this.limits.frameTimeoutMs);
      this._frameTimer.unref?.();
    }
  }

  _parseFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return false;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    if ((buf[0] & 0x70) || !masked || ![0, 1, 8, 9, 10].includes(opcode)) throw protocolError('invalid-frame-header');
    const control = opcode >= 8;
    let length = buf[1] & 0x7f;
    let offset = 2;
    if (control && (!fin || length > 125)) throw protocolError('invalid-control-frame');
    if (opcode === 0 && !this.fragmented) throw protocolError('unexpected-continuation');
    if (opcode === 1 && this.fragmented) throw protocolError('interleaved-message');
    if (length === 126) {
      if (buf.length < 4) return false;
      length = buf.readUInt16BE(2); offset = 4;
      if (length < 126) throw protocolError('noncanonical-length');
    } else if (length === 127) {
      if (buf.length < 10) return false;
      const high = buf.readUInt32BE(2), low = buf.readUInt32BE(6);
      if (high !== 0 || low > this.limits.maxFrameBytes) throw protocolError('frame-too-large', 1009);
      if (low < 65536) throw protocolError('noncanonical-length');
      length = low; offset = 10;
    }
    if (length > this.limits.maxFrameBytes) throw protocolError('frame-too-large', 1009);
    if (!control && this.fragmentBytes + length > this.limits.maxMessageBytes) throw protocolError('message-too-large', 1009);
    if (buf.length < offset + 4 + length) return false;
    const payload = Buffer.allocUnsafe(length), key = buf.subarray(offset, offset + 4);
    for (let i = 0; i < length; i += 1) payload[i] = buf[offset + 4 + i] ^ key[i & 3];
    this.buffer = buf.subarray(offset + 4 + length);
    const now = Date.now(); // transport only; never used in the deterministic battle simulator
    if (now - this._rateWindow >= 1000) { this._rateWindow = now; this._framesInWindow = 0; }
    if (++this._framesInWindow > this.limits.maxFramesPerSecond) throw protocolError('frame-rate-limit', 1008);
    this._handleFrame(fin, opcode, payload);
    return true;
  }

  _decode(payload) {
    try { return utf8.decode(payload); } catch { throw protocolError('invalid-utf8', 1007); }
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === 8) {
      if (payload.length === 1) throw protocolError('invalid-close');
      const code = payload.length ? payload.readUInt16BE(0) : 1000;
      if (!validCloseCode(code)) throw protocolError('invalid-close-code');
      const reason = payload.length > 2 ? this._decode(payload.subarray(2)) : '';
      this.close(code, reason); return;
    }
    if (opcode === 9) { this._sendFrame(10, payload); return; }
    if (opcode === 10) { this.isAlive = true; return; }
    if (opcode === 1 && fin) {
      if (payload.length > this.limits.maxMessageBytes) throw protocolError('message-too-large', 1009);
      this.onMessage?.(this._decode(payload)); return;
    }
    if (opcode === 1) this.fragmented = true;
    this.fragments.push(payload); this.fragmentBytes += payload.length;
    if (this.fragments.length > this.limits.maxFragments) throw protocolError('too-many-fragments', 1009);
    if (fin) {
      const text = this._decode(Buffer.concat(this.fragments, this.fragmentBytes));
      this.fragments.length = 0; this.fragmentBytes = 0; this.fragmented = false;
      this.onMessage?.(text);
    }
  }

  send(text) {
    if (this.closed) return false;
    const payload = Buffer.from(String(text), 'utf8');
    if (payload.length > this.limits.maxMessageBytes) { this.close(1009, 'outbound-too-large'); return false; }
    if (this.socket.writableLength + payload.length + 10 > this.limits.maxBufferedBytes) {
      this.close(1008, 'backpressure'); return false;
    }
    try { this._sendFrame(1, payload); return true; }
    catch { this.close(1011, 'send-failed'); return false; }
  }
  sendJson(value) { return this.send(JSON.stringify(value)); }

  _sendFrame(opcode, payload) {
    if (this.socket.writableLength + payload.length + 10 > this.limits.maxBufferedBytes) throw protocolError('backpressure', 1008);
    const length = payload.length;
    let header;
    if (length < 126) header = Buffer.from([0x80 | opcode, length]);
    else if (length < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(length, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(length, 6); }
    // A false write means Node accepted the bytes into its bounded queue. Never retry them.
    this.socket.write(Buffer.concat([header, payload]));
  }
  ping() { if (!this.closed) { try { this._sendFrame(9, Buffer.alloc(0)); } catch { this.close(1008, 'backpressure'); } } }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this._frameTimer); this._frameTimer = null;
    this.buffer = Buffer.alloc(0); this.fragments.length = 0; this.fragmentBytes = 0; this.fragmented = false;
    try {
      const reasonBytes = Buffer.from(String(reason), 'utf8');
      let end = Math.min(123, reasonBytes.length);
      while (end > 0) { try { utf8.decode(reasonBytes.subarray(0, end)); break; } catch { end -= 1; } }
      const body = Buffer.alloc(2 + end); body.writeUInt16BE(validCloseCode(code) ? code : 1002, 0); reasonBytes.copy(body, 2, 0, end);
      this._sendFrame(8, body);
    } catch { /* slow/failed peers are destroyed by the deadline */ }
    this._closeTimer = setTimeout(() => { this._closeTimer = null; this.socket.destroy(); }, this.limits.closeTimeoutMs);
    this._closeTimer.unref?.();
    try { this.socket.end(); } catch { this.socket.destroy(); }
    this._closed(code, reason);
  }

  _closed(code, reason) {
    if (this.socket.destroyed) { clearTimeout(this._closeTimer); this._closeTimer = null; }
    clearTimeout(this._frameTimer); this._frameTimer = null;
    this.closed = true;
    if (this._closeFired) return;
    this._closeFired = true; this.onClose?.(code, String(reason || ''));
  }
}

/** Caller installs handlers BEFORE feeding upgrade head; no first-frame loss. */
export function handleUpgradeRequest(req, socket, _head, { path, limits = {} }) {
  const fail = (code, message) => {
    try { socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* ignore */ }
    socket.destroy(); return null;
  };
  let pathname;
  try { pathname = new URL(req.url || '/', 'http://localhost').pathname; } catch { return fail(400, 'Bad Request'); }
  if (pathname !== path) return fail(404, 'Not Found');
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !String(req.headers.connection || '').toLowerCase().split(',').map((s) => s.trim()).includes('upgrade')) return fail(400, 'Bad Request');
  const key = req.headers['sec-websocket-key'];
  if (req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key) || Buffer.from(key, 'base64').length !== 16) return fail(400, 'Bad Request');
  try { socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`); }
  catch { socket.destroy(); return null; }
  return new WSConnection(socket, limits);
}
