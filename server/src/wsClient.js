/**
 * Minimal WebSocket client (RFC 6455) over node:net — zero dependencies.
 *
 * Used by the automated acceptance tests (tools/check.mjs) so two real
 * clients can talk to a real server over real sockets without any package.
 * Browsers use the native WebSocket instead (see src/game/social/SocialClient.js).
 */
import { connect } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class WsTestClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;
    this.onMessage = null;
    this.onClose = null;
    this.waiters = [];
    socket.on('data', (chunk) => {
      try {
        this._onData(chunk);
      } catch {
        this.close();
      }
    });
    socket.on('close', () => {
      this.closed = true;
      this.onClose?.();
      for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('socket-closed'));
    });
    socket.on('error', () => {
      /* close event follows */
    });
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
      if (high !== 0 || low > 4 * 1024 * 1024) throw new Error('frame-too-large');
      length = low;
      offset = 10;
    }
    if (buf.length < offset + length) return false;
    const payload = buf.subarray(offset, offset + length);
    this.buffer = buf.subarray(offset + length);

    if (opcode === 0x8) {
      this.close();
      return true;
    }
    if (opcode === 0x9) {
      this._sendFrame(0xa, payload); // ping → pong
      return true;
    }
    if (opcode === 0xa) return true; // pong
    if (opcode !== 0x0 && opcode !== 0x1) throw new Error('unsupported-opcode');
    if (opcode === 0x1) this.fragments = [Buffer.from(payload)];
    else this.fragments.push(Buffer.from(payload));
    if (fin) {
      const text = Buffer.concat(this.fragments).toString('utf8');
      this.fragments = [];
      this._deliver(text);
    }
    return true;
  }

  _deliver(text) {
    this.onMessage?.(text);
    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(text);
    }
  }

  /** Resolve with the next incoming text message. */
  next(timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.resolve === resolve);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('ws-timeout'));
      }, timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  sendText(text) {
    const data = Buffer.from(String(text), 'utf8');
    const mask = randomBytes(4);
    const masked = Buffer.alloc(data.length);
    for (let i = 0; i < data.length; i += 1) masked[i] = data[i] ^ mask[i % 4];
    let header;
    if (data.length < 126) {
      header = Buffer.from([0x81, 0x80 | data.length]);
    } else if (data.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(data.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(data.length, 6);
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  send(value) {
    this.sendText(typeof value === 'string' ? value : JSON.stringify(value));
  }

  _sendFrame(opcode, payload) {
    const mask = randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
    this.socket.write(Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, masked]));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {string} url — e.g. ws://127.0.0.1:8081/social-ws
 * @returns {Promise<WsTestClient>}
 */
export function connectWs(url, { timeoutMs = 5000 } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    return Promise.reject(new Error('only ws:// urls are supported by the test client'));
  }
  if (parsed.protocol === 'wss:') return Promise.reject(new Error('tls is not supported by the test client'));
  const key = randomBytes(16).toString('base64');
  const expected = createHash('sha1').update(key + WS_GUID).digest('base64');
  return new Promise((resolve, reject) => {
    const socket = connect({ host: parsed.hostname, port: Number(parsed.port) || 80 }, () => {
      const target = `${parsed.pathname || '/'}${parsed.search || ''}`;
      socket.write(
        `GET ${target} HTTP/1.1\r\n` +
          `Host: ${parsed.hostname}:${parsed.port || 80}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${key}\r\n` +
          'Sec-WebSocket-Version: 13\r\n' +
          '\r\n',
      );
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('ws-connect-timeout'));
    }, timeoutMs);
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (head.length > 16 * 1024) {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error('handshake-too-large'));
        }
        return;
      }
      const headerText = head.subarray(0, end).toString('latin1');
      const rest = head.subarray(end + 4);
      socket.off('data', onData);
      clearTimeout(timer);
      if (!/^HTTP\/1\.1 101 /m.test(headerText)) {
        socket.destroy();
        reject(new Error(`handshake-rejected: ${headerText.split('\r\n')[0]}`));
        return;
      }
      const accept = (headerText.match(/^Sec-WebSocket-Accept:\s*(.+)$/im) || [])[1]?.trim();
      if (accept !== expected) {
        socket.destroy();
        reject(new Error('handshake-accept-mismatch'));
        return;
      }
      const client = new WsTestClient(socket);
      if (rest.length > 0) client._onData(rest);
      resolve(client);
    };
    socket.on('data', onData);
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
