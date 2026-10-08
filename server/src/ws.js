/**
 * Minimal WebSocket (RFC 6455) server transport — zero dependencies.
 *
 * Only what «شهر نور» needs: text messages (fragmentation supported),
 * ping/pong and close. Binary frames are rejected. Client frames are
 * expected masked (per spec); server frames are never masked.
 */
import { createHash } from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 1024 * 1024; // 1 MiB — chat/ledger payloads are tiny

export function acceptKey(key) {
  return createHash('sha1').update(String(key) + WS_GUID).digest('base64');
}

export class WSConnection {
  /**
   * @param {import('node:net').Socket} socket — already hijacked from HTTP upgrade
   */
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;
    this._closeFired = false;
    this.isAlive = true;
    this.onMessage = null;
    this.onClose = null;
    this.onError = null;

    socket.on('data', (chunk) => {
      try {
        this._onData(chunk);
      } catch (error) {
        this.onError?.(error);
        this.close(1002, 'protocol-error');
      }
    });
    socket.on('close', () => this._closed(1006, 'tcp-closed'));
    socket.on('error', (error) => {
      this.onError?.(error);
    });
  }

  /** Feed leftover bytes from the HTTP upgrade parser (usually empty). */
  pushHead(head) {
    if (head && head.length > 0) this._onData(head);
  }

  _onData(chunk) {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this._parseFrame()) {
      if (this.closed) break;
    }
  }

  _parseFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return false;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < 4) return false;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) return false;
      const high = buf.readUInt32BE(2);
      const low = buf.readUInt32BE(6);
      if (high !== 0 || low > MAX_MESSAGE) throw new Error('frame-too-large');
      length = low;
      offset = 10;
    }
    if (length > MAX_MESSAGE) throw new Error('frame-too-large');
    const maskBytes = masked ? 4 : 0;
    if (buf.length < offset + maskBytes + length) return false;

    let payload = buf.subarray(offset + maskBytes, offset + maskBytes + length);
    if (masked) {
      const mask = buf.subarray(offset, offset + 4);
      const out = Buffer.alloc(length);
      for (let i = 0; i < length; i += 1) out[i] = payload[i] ^ mask[i % 4];
      payload = out;
    }
    this.buffer = buf.subarray(offset + maskBytes + length);
    this._handleFrame(fin, opcode, payload);
    return true;
  }

  _handleFrame(fin, opcode, payload) {
    if (opcode === 0x8) {
      // Close.
      let code = 1005;
      let reason = '';
      if (payload.length >= 2) {
        code = payload.readUInt16BE(0);
        reason = payload.subarray(2).toString('utf8');
      }
      try {
        this._sendFrame(0x8, Buffer.alloc(0));
      } catch {
        /* ignore */
      }
      this.closed = true;
      try {
        this.socket.end();
      } catch {
        /* ignore */
      }
      this._closed(code, reason);
      return;
    }
    if (opcode === 0x9) {
      // Ping → pong (payload echoed).
      this._sendFrame(0xa, payload);
      return;
    }
    if (opcode === 0xa) {
      // Pong.
      this.isAlive = true;
      return;
    }
    if (opcode !== 0x0 && opcode !== 0x1) throw new Error('unsupported-opcode');
    if (opcode === 0x1) this.fragments = [payload];
    else {
      if (this.fragments.length === 0 && !fin) throw new Error('unexpected-continuation');
      this.fragments.push(payload);
    }
    const total = this.fragments.reduce((n, part) => n + part.length, 0);
    if (total > MAX_MESSAGE) throw new Error('message-too-large');
    if (fin) {
      const text = Buffer.concat(this.fragments).toString('utf8');
      this.fragments = [];
      this.onMessage?.(text);
    }
  }

  send(text) {
    if (this.closed) return false;
    try {
      this._sendFrame(0x1, Buffer.from(String(text), 'utf8'));
      return true;
    } catch {
      return false;
    }
  }

  sendJson(value) {
    return this.send(JSON.stringify(value));
  }

  _sendFrame(opcode, payload) {
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(length, 6);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  ping() {
    if (!this.closed) {
      try {
        this._sendFrame(0x9, Buffer.alloc(0));
      } catch {
        /* ignore */
      }
    }
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    try {
      const reasonBytes = Buffer.from(String(reason), 'utf8').subarray(0, 120);
      const body = Buffer.alloc(2 + reasonBytes.length);
      body.writeUInt16BE(code, 0);
      reasonBytes.copy(body, 2);
      this._sendFrame(0x8, body);
    } catch {
      /* ignore */
    }
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
    this._closed(code, reason);
  }

  _closed(code, reason) {
    if (this._closeFired) return;
    this._closeFired = true;
    this.closed = true;
    this.onClose?.(code, String(reason || ''));
  }
}

/**
 * Validate an HTTP upgrade request and hijack the socket.
 * @returns {WSConnection|null} — null when the request was rejected (socket destroyed).
 */
export function handleUpgradeRequest(req, socket, head, { path }) {
  const fail = (code, message) => {
    try {
      socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } catch {
      /* ignore */
    }
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
    return null;
  };
  let pathname = '';
  try {
    pathname = new URL(req.url || '/', 'http://localhost').pathname;
  } catch {
    return fail(400, 'Bad Request');
  }
  if (pathname !== path) return fail(404, 'Not Found');
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return fail(400, 'Bad Request');
  if (!String(req.headers.connection || '').toLowerCase().split(',').map((s) => s.trim()).includes('upgrade')) {
    return fail(400, 'Bad Request');
  }
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || key.length < 8) return fail(400, 'Bad Request');
  try {
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
        'Sec-WebSocket-Version: 13\r\n' +
        '\r\n',
    );
  } catch {
    return null;
  }
  const connection = new WSConnection(socket);
  connection.pushHead(head);
  return connection;
}
