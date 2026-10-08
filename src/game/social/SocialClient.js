/**
 * SocialClient — thin request/response wrapper over the native WebSocket.
 *
 * DOM-free (works in browsers, Node 22 and jsdom alike). No auto-reconnect:
 * the SocialSystem surfaces connection state and the player reconnects with
 * one tap — predictable on flaky mobile networks, no background surprises.
 *
 * Requests resolve with the server answer `{ id, ok, ... }`; pushes arrive
 * through `onPush({ push, payload })`.
 */
export class SocialClient {
  /**
   * @param {object} options
   * @param {string} options.url — ws(s)://… endpoint
   * @param {(push:{push:string, payload:object})=>void} [options.onPush]
   * @param {(status:string, detail:string)=>void} [options.onStatus] — connecting|online|closed|error
   */
  constructor({ url, onPush = null, onStatus = null } = {}) {
    this.url = url;
    this.onPush = onPush;
    this.onStatus = onStatus;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.connected = false; // hello acknowledged
    this.manualClose = false;
    this.status = 'offline';
    this.rttMs = null;
    this._hbTimer = 0;
    this._hbMisses = 0;
  }

  _setStatus(status, detail = '') {
    this.status = status;
    try {
      this.onStatus?.(status, detail);
    } catch {
      /* listener errors must not break the socket */
    }
  }

  _socketClass() {
    const WS = globalThis.WebSocket;
    return typeof WS === 'function' ? WS : null;
  }

  /**
   * Open the socket and authenticate. Resolves with the `hello` answer.
   * @param {object} hello — { token?, displayName?, isChild?, cityLevel?, clientVersion? }
   */
  connect(hello = {}) {
    if (this.ws) throw { error: 'busy' }; // eslint-disable-line no-throw-literal
    const WS = this._socketClass();
    if (!WS) return Promise.reject({ error: 'unsupported' });
    this.manualClose = false;
    this._setStatus('connecting');
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WS(this.url);
      } catch {
        this._setStatus('error', 'connect-failed');
        reject({ error: 'connect-failed' });
        return;
      }
      this.ws = ws;
      const fail = (error) => {
        if (settled) return;
        settled = true;
        this._cleanupSocket();
        this._setStatus('error', error);
        reject({ error });
      };
      const openTimer = setTimeout(() => fail('connect-failed'), 10000);
      ws.onopen = () => {
        clearTimeout(openTimer);
        this._attach();
        this.request('hello', hello, { timeoutMs: 10000 }).then(
          (answer) => {
            if (settled) return;
            settled = true;
            if (!answer || answer.ok !== true) {
              this._cleanupSocket();
              this._setStatus('error', answer?.error || 'connect-failed');
              reject({ error: answer?.error || 'connect-failed' });
              return;
            }
            this.connected = true;
            this._setStatus('online');
            this._startHeartbeat();
            resolve(answer);
          },
          () => fail('connect-failed'),
        );
      };
      ws.onerror = () => fail('connect-failed');
      ws.onclose = () => fail('connect-failed');
    });
  }

  _attach() {
    const ws = this.ws;
    if (!ws) return;
    ws.onopen = null;
    ws.onerror = null;
    ws.onclose = (event) => this._onSocketClose(event);
    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!message || typeof message !== 'object') return;
      if (message.push) {
        try {
          this.onPush?.({ push: message.push, payload: message.payload || {} });
        } catch {
          /* ignore listener errors */
        }
        return;
      }
      if (message.id != null && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        entry.resolve(message);
      }
    };
  }

  _onSocketClose(event) {
    const wasOnline = this.connected;
    const manual = this.manualClose;
    this._cleanupSocket();
    this._setStatus('closed', manual ? 'manual' : `code-${event?.code || 1006}`);
    // Surface unexpected drops so the system can fall back to offline play.
    void wasOnline;
  }

  _cleanupSocket() {
    this.connected = false;
    if (this._hbTimer) {
      clearTimeout(this._hbTimer);
      this._hbTimer = 0;
    }
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject({ error: 'offline' });
    }
    this.pending.clear();
    if (this.ws) {
      try {
        this.ws.onopen = null;
        this.ws.onmessage = null;
        this.ws.onerror = null;
        this.ws.onclose = null;
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  /**
   * @returns {Promise<object>} — the server answer (ok or error-shaped).
   */
  request(type, payload = {}, { timeoutMs = 8000 } = {}) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject({ error: 'offline' });
    const id = `q-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject({ error: 'timeout' });
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, type, payload }));
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject({ error: 'offline' });
      }
    });
  }

  _startHeartbeat() {
    if (this._hbTimer) clearTimeout(this._hbTimer);
    const beat = () => {
      this._hbTimer = 0;
      if (!this.connected) return;
      const started = Date.now();
      this.request('presence:ping', {}, { timeoutMs: 6000 }).then(
        () => {
          this.rttMs = Date.now() - started;
          this._hbMisses = 0;
          this._hbTimer = setTimeout(beat, 20000);
        },
        () => {
          this._hbMisses += 1;
          if (this._hbMisses >= 2) {
            try {
              this.ws?.close(1000, 'heartbeat-lost');
            } catch {
              /* ignore */
            }
            return;
          }
          this._hbTimer = setTimeout(beat, 5000);
        },
      );
    };
    this._hbTimer = setTimeout(beat, 20000);
  }

  /** Manual close — never triggers a reconnect. */
  close(reason = 'manual') {
    this.manualClose = true;
    try {
      this.ws?.close(1000, reason);
    } catch {
      /* ignore */
    }
    this._cleanupSocket();
    this._setStatus('closed', 'manual');
  }
}
