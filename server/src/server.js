/**
 * GameServer — the authoritative reference for «شهر نور» multiplayer.
 *
 *   • resources and timers live here; the client only sends intents,
 *   • every action is validated (costs, caps, ownership, cooldowns),
 *   • the server clock is the only clock (clients never send time),
 *   • rate limits + chat filter + reports keep the jamaat friendly,
 *   • no attack/loot/plunder message exists — competition is friendly only.
 *
 * Transport is dependency-free (node:http + the minimal RFC 6455 layer in
 * ws.js). Persistence is a single JSON file (see JsonStore).
 */
import { createServer } from 'node:http';
import { handleUpgradeRequest } from './ws.js';
import { loadGameData, repoRoot } from './data.js';
import { issueToken, randomNameSuffix, sanitizeDisplayName } from './auth.js';
import { RateLimiter } from './rateLimit.js';
import { filterChat } from './chatFilter.js';
import { PlayerSim } from './player.js';
import { JamaatManager } from './jamaat.js';
import { JsonStore } from './store.js';
import { ERRORS, REQUEST_TYPES, asInt, asString, isPlainObject } from './protocol.js';

const SAVE_VERSION = 1;

export class GameServer {
  /**
   * @param {object} [options]
   * @param {number} [options.port] — 0 picks an ephemeral port (tests)
   * @param {string} [options.path] — websocket path
   * @param {string|null} [options.dataRoot] — repo root holding src/data
   * @param {string|null} [options.saveFile] — null disables disk persistence
   * @param {()=>number} [options.now]
   * @param {boolean} [options.quiet]
   */
  constructor({ port = 8081, path = '/social-ws', dataRoot = null, saveFile = null, now = null, quiet = false } = {}) {
    this.port = port;
    this.path = path;
    this.now = now || (() => Date.now());
    this.quiet = quiet;
    this.data = loadGameData(dataRoot || repoRoot());
    this.social = this.data.social;
    const serverTuning = this.social.server || {};
    this.jamaatId = serverTuning.jamaatId || 'jamaat-nur';
    this.completeGraceMs = serverTuning.completeGraceMs ?? 1500;
    this.presenceTimeoutMs = serverTuning.presenceTimeoutMs || 60000;
    this.tickMs = serverTuning.tickMs || 5000;
    this.rateTuning = this.social.rate || {};

    this.store = new JsonStore(saveFile);
    this.limiter = new RateLimiter({ now: this.now });
    this.jamaat = new JamaatManager({ data: this.data, getPlayer: (id) => this.players.get(id) || null });

    /** playerId -> player record */
    this.players = new Map();
    /** token -> playerId */
    this.tokens = new Map();
    /** playerId -> live connection */
    this.online = new Map();
    /** all live connections */
    this.conns = new Set();
    this.connectionsByIp = new Map();
    this.transport = this.social.server.transport;
    this.connSeq = 1;
    this.playerSeq = 1;
    /** moderation reports (persisted) */
    this.reports = [];
    this.reportSeq = 1;

    this.http = null;
    this.tickTimer = null;
    this.dirty = false;

    this._restore();
  }

  /* ------------------------------------------------------------ lifecycle */

  async start() {
    if (this.http) return { port: this.port };
    this.http = createServer((req, res) => this._onRequest(req, res));
    this.http.headersTimeout = this.transport.helloTimeoutMs;
    this.http.requestTimeout = this.transport.idleTimeoutMs;
    this.http.on('upgrade', (req, socket, head) => this._onUpgrade(req, socket, head));
    await new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.port, '0.0.0.0', () => {
        this.http.off('error', reject);
        resolve();
      });
    });
    this.port = this.http.address()?.port ?? this.port;
    this.tickTimer = setInterval(() => this._tick(), this.tickMs);
    this.tickTimer.unref?.();
    if (!this.quiet) {
      // eslint-disable-next-line no-console
      console.log(`[شهر نور] سرور جماعت روی پورت ${this.port} و مسیر ${this.path} بالا آمد.`);
    }
    return { port: this.port };
  }

  async stop() {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    this.store.flush();
    for (const conn of [...this.conns]) {
      try {
        conn.ws.close(1001, 'server-stopping');
      } catch {
        /* ignore */
      }
    }
    this.conns.clear();
    this.online.clear();
    this.connectionsByIp.clear();
    if (this.http) {
      await new Promise((resolve) => this.http.close(() => resolve()));
      this.http = null;
    }
  }

  /* -------------------------------------------------------------- http/ws */

  _onRequest(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
        const body = JSON.stringify({
          ok: true,
          game: 'shahr-nur',
          phase: 8,
          jamaat: this.jamaat.jamaatName,
          members: this.jamaat.members.size,
          online: this.online.size,
          event: { weekId: this.jamaat.event.weekId, points: this.jamaat.event.points, goal: this.jamaat.event.goal },
          now: this.now(),
        });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }
    } catch {
      /* fall through to 404 */
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }

  _onUpgrade(req, socket, head) {
    const ip = socket.remoteAddress || 'unknown';
    const reject = (code, text) => {
      socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (this.conns.size >= this.transport.maxConnections || (this.connectionsByIp.get(ip) || 0) >= this.transport.maxConnectionsPerIp) {
      reject(429, 'Too Many Requests'); return;
    }
    const origin = req.headers.origin;
    if (origin) {
      let allowed = false;
      try {
        const url = new URL(origin);
        allowed = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
          && (url.host === req.headers.host || this.transport.allowedOrigins.includes(url.origin));
      } catch { /* reject malformed Origin */ }
      if (!allowed) { reject(403, 'Forbidden'); return; }
    }
    const ws = handleUpgradeRequest(req, socket, head, { path: this.path, limits: this.transport });
    if (!ws) return;
    const conn = {
      id: `c-${this.connSeq++}`,
      ws,
      playerId: null,
      authed: false,
      connectedAt: this.now(),
      ip,
      helloTimer: setTimeout(() => ws.close(1008, 'hello-timeout'), this.transport.helloTimeoutMs),
    };
    conn.helloTimer.unref?.();
    this.conns.add(conn);
    this.connectionsByIp.set(ip, (this.connectionsByIp.get(ip) || 0) + 1);
    ws.onMessage = (text) => {
      this._onText(conn, text);
      if (conn.authed) { clearTimeout(conn.helloTimer); conn.helloTimer = null; }
    };
    ws.onClose = () => this._onConnClose(conn);
    ws.onError = () => {
      /* rate/validation errors are answered, not thrown */
    };
    ws.pushHead(head);
  }

  _onConnClose(conn) {
    if (!this.conns.delete(conn)) return;
    clearTimeout(conn.helloTimer);
    const remaining = (this.connectionsByIp.get(conn.ip) || 1) - 1;
    if (remaining > 0) this.connectionsByIp.set(conn.ip, remaining);
    else this.connectionsByIp.delete(conn.ip);
    for (const key of this.limiter.hits.keys()) if (key.startsWith(`${conn.id}:`)) this.limiter.reset(key);
    if (conn.playerId && this.online.get(conn.playerId) === conn) {
      this.online.delete(conn.playerId);
      const player = this.players.get(conn.playerId);
      if (player) player.lastSeen = this.now();
      this._broadcastPresence();
      this._markDirty();
    }
  }

  /* --------------------------------------------------------------- router */

  _rule(name, fallback) {
    const tuning = this.rateTuning;
    if (name === 'global') return { windowMs: 60000, max: tuning.globalPerMinute || fallback.max };
    if (name === 'hello') return { windowMs: 60000, max: tuning.helloPerMinute || 10 };
    if (name === 'report') return { windowMs: 3600_000, max: tuning.reportPerHour || 5 };
    if (name === 'chat') {
      return { windowMs: this.social.chat?.windowMs || 30000, max: this.social.chat?.maxPerWindow || 5 };
    }
    if (name === 'preset') {
      return { windowMs: this.social.chat?.presetWindowMs || 60000, max: this.social.chat?.maxPresetPerWindow || 12 };
    }
    const map = {
      sync: tuning.syncPerMinute || 10,
      pull: tuning.pullPerMinute || 20,
      ping: tuning.pingPerMinute || 60,
      enqueue: tuning.enqueuePerMinute || 10,
      complete: tuning.completePerMinute || 30,
      harvest: tuning.harvestPerMinute || 20,
      spend: tuning.spendPerMinute || 60,
      grant: tuning.grantPerMinute || 60,
      donate: tuning.donatePerMinute || 20,
      help: tuning.helpGivePerMinute || 6,
    };
    return { windowMs: 60000, max: map[name] || fallback?.max || 30 };
  }

  _limited(conn, rule, id) {
    const checked = this.limiter.check(`${conn.id}:${rule}`, this._rule(rule));
    if (!checked.ok) {
      conn.ws.sendJson({ id, ok: false, error: ERRORS.RATE_LIMITED, retryAfterMs: checked.retryAfterMs });
      return true;
    }
    return false;
  }

  _onText(conn, text) {
    let message;
    try {
      message = JSON.parse(String(text));
    } catch {
      conn.ws.sendJson({ id: null, ok: false, error: ERRORS.INVALID });
      return;
    }
    if (!isPlainObject(message) || typeof message.type !== 'string') {
      conn.ws.sendJson({ id: message?.id ?? null, ok: false, error: ERRORS.INVALID });
      return;
    }
    const { id = null, type, payload = {} } = message;
    if (!REQUEST_TYPES.has(type)) {
      conn.ws.sendJson({ id, ok: false, error: ERRORS.UNKNOWN_TYPE });
      return;
    }
    if (this._limited(conn, 'global', id)) return;
    if (type !== 'hello' && !conn.authed) {
      conn.ws.sendJson({ id, ok: false, error: ERRORS.UNAUTHENTICATED });
      return;
    }
    try {
      const handler = this[`_handle_${type.replace(':', '_')}`];
      const result = handler.call(this, conn, isPlainObject(payload) ? payload : {}, id);
      if (result && typeof result.then === 'function') {
        result.catch(() => conn.ws.sendJson({ id, ok: false, error: ERRORS.INVALID }));
      }
    } catch {
      conn.ws.sendJson({ id, ok: false, error: ERRORS.INVALID });
    }
  }

  _playerOf(conn) {
    return (conn.playerId && this.players.get(conn.playerId)) || null;
  }

  /* --------------------------------------------------------------- hello */

  _displayNameTaken(name, exceptId = null) {
    for (const player of this.players.values()) {
      if (player.id !== exceptId && player.displayName === name) return true;
    }
    return false;
  }

  _uniqueName(base, exceptId = null) {
    let name = base;
    let attempt = 2;
    while (this._displayNameTaken(name, exceptId) && attempt < 100) {
      name = `${base} ${attempt}`;
      attempt += 1;
    }
    return name;
  }

  _handle_hello(conn, payload, id) {
    if (this._limited(conn, 'hello', id)) return;
    const now = this.now();
    const token = asString(payload.token, { maxLength: 128 });
    let player = token ? this.players.get(this.tokens.get(token) || '') || null : null;

    if (!player) {
      // New player — a display name and a child flag are the ONLY inputs.
      const isChild = payload.isChild === true;
      const wanted = sanitizeDisplayName(payload.displayName);
      const base = wanted || `بازیکن ${randomNameSuffix()}`;
      const displayName = this._uniqueName(base);
      const cityLevel = asInt(payload.cityLevel, { min: 1, max: 10 }) || 1;
      const record = {
        id: `p-${this.playerSeq++}-${now.toString(36)}`,
        token: issueToken(),
        displayName,
        isChild,
        jamaatId: this.jamaatId,
        cityLevel,
        createdAt: now,
        lastSeen: now,
        sim: new PlayerSim({ data: this.data }),
      };
      const joined = this.jamaat.join(record.id);
      if (!joined.ok) {
        conn.ws.sendJson({ id, ok: false, error: joined.error });
        return;
      }
      player = record;
      this.players.set(player.id, player);
      this.tokens.set(player.token, player.id);
    } else {
      // Returning player — the child flag NEVER changes after creation.
      const wanted = typeof payload.displayName === 'string' ? sanitizeDisplayName(payload.displayName) : null;
      if (wanted) player.displayName = this._uniqueName(wanted, player.id);
      const cityLevel = asInt(payload.cityLevel, { min: 1, max: 10 });
      if (cityLevel) player.cityLevel = cityLevel;
      if (!this.jamaat.members.has(player.id)) {
        const joined = this.jamaat.join(player.id);
        if (!joined.ok) {
          conn.ws.sendJson({ id, ok: false, error: joined.error });
          return;
        }
      }
    }

    // Single session per player: the newest connection wins.
    const previous = this.online.get(player.id);
    if (previous && previous !== conn) {
      this.online.delete(player.id);
      try {
        previous.playerId = null;
        previous.authed = false;
        previous.ws.close(1000, 'replaced');
      } catch {
        /* ignore */
      }
    }
    conn.playerId = player.id;
    conn.authed = true;
    this.online.set(player.id, conn); // targeted pushes (ledger/notice) + presence
    player.lastSeen = now;

    conn.ws.sendJson({
      id,
      ok: true,
      player: { id: player.id, displayName: player.displayName, isChild: player.isChild },
      token: player.token,
      jamaat: { id: this.jamaatId, name: this.jamaat.jamaatName },
      ledger: player.sim.ledger(),
      jobs: player.sim.jobsSnapshot(),
      members: this.jamaat.roster((pid) => this.online.has(pid)),
      chat: this.jamaat.chatTail(50),
      help: this.jamaat.openRequests(),
      event: this.jamaat.eventSnapshot(),
      leaderboard: this.jamaat.leaderboard(),
      serverNow: now,
      config: this._publicConfig(),
    });
    this._broadcastPresence();
    this._markDirty();
  }

  _publicConfig() {
    const social = this.social;
    return {
      jamaatName: this.jamaat.jamaatName,
      help: { seconds: social.help?.seconds || 60, maxPerJob: social.help?.maxPerJob || 5 },
      chat: { maxLength: social.chat?.maxLength || 280 },
      quickChat: (social.quickChat || []).map((preset) => ({ ...preset })),
      event: {
        title: social.event?.title || '',
        description: social.event?.description || '',
        goal: social.event?.goal || 1000,
        weights: { ...(social.event?.weights || {}) },
        rewardGohar: social.event?.rewardGohar ?? 8,
      },
      reportReasons: (social.reportReasons || []).map((reason) => ({ ...reason })),
    };
  }

  /* ------------------------------------------------------------ city/ledger */

  _handle_city_sync(conn, payload, id) {
    if (this._limited(conn, 'sync', id)) return;
    const player = this._playerOf(conn);
    const adopted = player.sim.adoptBuildings(payload.buildings);
    if (!adopted.ok) {
      conn.ws.sendJson({ id, ok: false, error: adopted.error });
      return;
    }
    const cityLevel = asInt(payload.cityLevel, { min: 1, max: 10 });
    if (cityLevel) player.cityLevel = cityLevel;
    player.lastSeen = this.now();
    conn.ws.sendJson({ id, ok: true, count: adopted.count, ledger: player.sim.ledger(), serverNow: this.now() });
    this._markDirty();
  }

  _handle_ledger_harvest(conn, payload, id) {
    if (this._limited(conn, 'harvest', id)) return;
    const player = this._playerOf(conn);
    const result = player.sim.harvest(payload.resource, payload.amount, this.now());
    player.lastSeen = this.now();
    if (!result.ok) {
      conn.ws.sendJson({ id, ok: false, error: result.error });
      return;
    }
    conn.ws.sendJson({ id, ok: true, moved: result.moved, ledger: result.ledger, serverNow: this.now() });
    this._markDirty();
  }

  _handle_ledger_spend(conn, payload, id) {
    if (this._limited(conn, 'spend', id)) return;
    const player = this._playerOf(conn);
    const result = player.sim.spend(payload.cost);
    player.lastSeen = this.now();
    if (!result.ok) {
      conn.ws.sendJson({ id, ok: false, error: result.error, ledger: result.ledger || player.sim.ledger() });
      return;
    }
    conn.ws.sendJson({ id, ok: true, ledger: result.ledger, serverNow: this.now() });
    this._markDirty();
  }

  _handle_ledger_grant(conn, payload, id) {
    if (this._limited(conn, 'grant', id)) return;
    const player = this._playerOf(conn);
    const result = player.sim.grant(payload.resource, payload.amount, payload.source || 'other');
    player.lastSeen = this.now();
    if (!result.ok) {
      conn.ws.sendJson({ id, ok: false, error: result.error });
      return;
    }
    conn.ws.sendJson({
      id,
      ok: true,
      moved: result.moved,
      overflow: result.overflow,
      ledger: result.ledger,
      serverNow: this.now(),
    });
    this._markDirty();
  }

  /* ---------------------------------------------------------------- builds */

  _handle_build_enqueue(conn, payload, id) {
    if (this._limited(conn, 'enqueue', id)) return;
    const player = this._playerOf(conn);
    const result = player.sim.enqueue(
      {
        kind: payload.kind,
        entityId: payload.entityId,
        defId: payload.defId,
        level: payload.level,
        fromLevel: payload.fromLevel,
      },
      this.now(),
    );
    player.lastSeen = this.now();
    if (!result.ok) {
      conn.ws.sendJson({ id, ok: false, error: result.error, ledger: result.ledger || player.sim.ledger() });
      return;
    }
    conn.ws.sendJson({ id, ok: true, job: result.job, ledger: result.ledger, serverNow: this.now() });
    this._pushTo(player.id, 'ledger', this._ledgerPush(player));
    this._markDirty();
  }

  _handle_build_complete(conn, payload, id) {
    if (this._limited(conn, 'complete', id)) return;
    const player = this._playerOf(conn);
    const now = this.now();
    const result = player.sim.complete(payload.jobId, now, { graceMs: this.completeGraceMs });
    player.lastSeen = now;
    if (!result.ok) {
      conn.ws.sendJson({
        id,
        ok: false,
        error: result.error,
        job: result.job || null,
        serverNow: now,
      });
      return;
    }
    this.jamaat.closeRequestsForJob(player.id, result.job.id);
    conn.ws.sendJson({
      id,
      ok: true,
      job: result.job,
      promotions: result.promotions,
      ledger: result.ledger,
      serverNow: now,
    });
    this._pushTo(player.id, 'ledger', this._ledgerPush(player));
    this._broadcastHelp();
    this._markDirty();
  }

  _handle_build_speedup(conn, payload, id) {
    if (this._limited(conn, 'enqueue', id)) return;
    const player = this._playerOf(conn);
    const result = player.sim.speedup(payload.jobId, this.now());
    player.lastSeen = this.now();
    if (!result.ok) {
      conn.ws.sendJson({ id, ok: false, error: result.error, ledger: result.ledger || player.sim.ledger() });
      return;
    }
    this.jamaat.closeRequestsForJob(player.id, result.job.id);
    conn.ws.sendJson({
      id,
      ok: true,
      cost: result.cost,
      job: result.job,
      promotions: result.promotions,
      ledger: result.ledger,
      serverNow: this.now(),
    });
    this._pushTo(player.id, 'ledger', this._ledgerPush(player));
    this._broadcastHelp();
    this._markDirty();
  }

  /* ------------------------------------------------------------------ help */

  _handle_help_request(conn, payload, id) {
    if (this._limited(conn, 'help', id)) return;
    const player = this._playerOf(conn);
    const jobId = asString(payload.jobId, { maxLength: 64 });
    if (!jobId) {
      conn.ws.sendJson({ id, ok: false, error: ERRORS.INVALID });
      return;
    }
    const result = this.jamaat.requestHelp(player.id, jobId, (pid, jid) => this.players.get(pid)?.sim.findJob(jid) || null);
    player.lastSeen = this.now();
    if (!result.ok) {
      conn.ws.sendJson({ id, ok: false, error: result.error });
      return;
    }
    conn.ws.sendJson({ id, ok: true, request: result.request });
    this._broadcastHelp();
    this._markDirty();
  }

  _handle_help_give(conn, payload, id) {
    if (this._limited(conn, 'help', id)) return;
    const player = this._playerOf(conn);
    const requestId = asString(payload.requestId, { maxLength: 64 });
    if (!requestId) {
      conn.ws.sendJson({ id, ok: false, error: ERRORS.INVALID });
      return;
    }
    const now = this.now();
    const result = this.jamaat.giveHelp(player.id, requestId, now, {
      ownerJob: (pid, jid) => this.players.get(pid)?.sim.findJob(jid) || null,
      applyReduction: (pid, jid, at) => {
        const owner = this.players.get(pid);
        const tuning = this.jamaat.helpTuning;
        return owner.sim.applyHelpReduction(
          jid,
          { helpMs: tuning.helpMs, maxPerJob: tuning.maxPerJob, maxReductionFrac: tuning.maxReductionFrac, minRemainingMs: tuning.minRemainingMs },
          at,
        );
      },
    });
    player.lastSeen = now;
    if (!result.ok) {
      conn.ws.sendJson({ id, ok: false, error: result.error, retryAfterMs: result.retryAfterMs || 0 });
      return;
    }
    conn.ws.sendJson({ id, ok: true, reductionMs: result.reductionMs, endsAt: result.endsAt, request: result.request });
    // The owner sees the shorter timer immediately (authoritative push).
    const owner = this.players.get(result.request.playerId);
    if (owner) {
      this._pushTo(owner.id, 'ledger', this._ledgerPush(owner));
      this._pushTo(owner.id, 'notice', {
        kind: 'help-received',
        params: { name: player.displayName, seconds: Math.round(result.reductionMs / 1000) },
      });
    }
    this._broadcastHelp();
    this._markDirty();
  }

  _handle_help_cancel(conn, payload, id) {
    if (this._limited(conn, 'help', id)) return;
    const player = this._playerOf(conn);
    const result = this.jamaat.cancelHelp(player.id, payload.requestId);
    if (!result.ok) {
      conn.ws.sendJson({ id, ok: false, error: result.error });
      return;
    }
    conn.ws.sendJson({ id, ok: true });
    this._broadcastHelp();
    this._markDirty();
  }

  /* ------------------------------------------------------------------ chat */

  _handle_chat_send(conn, payload, id) {
    if (this._limited(conn, 'chat', id)) return;
    const player = this._playerOf(conn);
    player.lastSeen = this.now();
    if (player.isChild) {
      conn.ws.sendJson({ id, ok: false, error: ERRORS.CHILD_RESTRICTED });
      return;
    }
    const filtered = filterChat(payload.text, {
      wordlist: this.social.chat?.profanity || [],
      mask: this.social.chat?.mask || '⁂',
      maxLength: this.social.chat?.maxLength || 280,
    });
    if (!filtered.text) {
      conn.ws.sendJson({ id, ok: false, error: ERRORS.INVALID });
      return;
    }
    const message = this.jamaat.postChat({ playerId: player.id, name: player.displayName, text: filtered.text, preset: false });
    conn.ws.sendJson({ id, ok: true, message });
    this._broadcast('chat', { message }, null);
  }

  _handle_chat_preset(conn, payload, id) {
    if (this._limited(conn, 'preset', id)) return;
    const player = this._playerOf(conn);
    player.lastSeen = this.now();
    const preset = (this.social.quickChat || []).find((entry) => entry.id === payload.presetId);
    if (!preset) {
      conn.ws.sendJson({ id, ok: false, error: ERRORS.INVALID });
      return;
    }
    const message = this.jamaat.postChat({ playerId: player.id, name: player.displayName, text: preset.text, preset: true });
    conn.ws.sendJson({ id, ok: true, message });
    this._broadcast('chat', { message }, null);
  }

  _handle_chat_report(conn, payload, id) {
    if (this._limited(conn, 'report', id)) return;
    const player = this._playerOf(conn);
    player.lastSeen = this.now();
    const reasons = new Set((this.social.reportReasons || []).map((reason) => reason.id));
    if (!reasons.has(payload.reason)) {
      conn.ws.sendJson({ id, ok: false, error: ERRORS.INVALID });
      return;
    }
    const messageId = asString(payload.messageId, { maxLength: 64 });
    if (!messageId) {
      conn.ws.sendJson({ id, ok: false, error: ERRORS.INVALID });
      return;
    }
    const snapshot = this.jamaat.findMessage(messageId);
    const report = {
      id: `r-${this.reportSeq++}`,
      messageId,
      reason: payload.reason,
      reporterId: player.id,
      reporterName: player.displayName,
      snapshot: snapshot ? { from: { ...snapshot.from }, text: snapshot.text, at: snapshot.at } : null,
      at: this.now(),
      status: 'open',
    };
    this.reports.push(report);
    while (this.reports.length > 500) this.reports.shift();
    conn.ws.sendJson({ id, ok: true, reportId: report.id });
    this._markDirty();
  }

  /* ----------------------------------------------------------------- event */

  _handle_event_donate(conn, payload, id) {
    if (this._limited(conn, 'donate', id)) return;
    const player = this._playerOf(conn);
    player.lastSeen = this.now();
    this.jamaat.rollover(this.now());
    const result = this.jamaat.donate(player.id, payload.resource, payload.amount);
    if (!result.ok) {
      conn.ws.sendJson({ id, ok: false, error: result.error, ledger: result.ledger || player.sim.ledger() });
      return;
    }
    conn.ws.sendJson({
      id,
      ok: true,
      points: result.points,
      total: result.total,
      completed: result.completed,
      ledger: result.ledger,
      serverNow: this.now(),
    });
    this._pushTo(player.id, 'ledger', this._ledgerPush(player));
    this._broadcastEvent();
    if (result.completed) {
      this._broadcast('notice', {
        kind: 'event-completed',
        params: { reward: this.jamaat.eventTuning.rewardGohar, title: this.jamaat.event.title },
      }, null);
      // Rewarded contributors get their fresh ledger.
      for (const pid of result.rewarded) {
        const contributor = this.players.get(pid);
        if (contributor) this._pushTo(pid, 'ledger', this._ledgerPush(contributor));
      }
    }
    this._markDirty();
  }

  /* --------------------------------------------------------------- utility */

  _handle_presence_ping(conn, _payload, id) {
    if (this._limited(conn, 'ping', id)) return;
    const player = this._playerOf(conn);
    player.lastSeen = this.now();
    conn.ws.sendJson({ id, ok: true, serverNow: this.now() });
  }

  _handle_state_pull(conn, _payload, id) {
    if (this._limited(conn, 'pull', id)) return;
    const player = this._playerOf(conn);
    player.lastSeen = this.now();
    conn.ws.sendJson({
      id,
      ok: true,
      ledger: player.sim.ledger(),
      jobs: player.sim.jobsSnapshot(),
      members: this.jamaat.roster((pid) => this.online.has(pid)),
      help: this.jamaat.openRequests(),
      event: this.jamaat.eventSnapshot(),
      leaderboard: this.jamaat.leaderboard(),
      serverNow: this.now(),
    });
  }

  /* --------------------------------------------------------------- pushes */

  _ledgerPush(player) {
    return { ledger: player.sim.ledger(), jobs: player.sim.jobsSnapshot(), serverNow: this.now() };
  }

  _pushTo(playerId, push, payload) {
    const conn = this.online.get(playerId);
    if (conn) conn.ws.sendJson({ push, payload });
  }

  _broadcast(push, payload, exceptConn) {
    for (const conn of this.conns) {
      if (conn === exceptConn || !conn.authed) continue;
      conn.ws.sendJson({ push, payload });
    }
  }

  _broadcastPresence() {
    this._broadcast('presence', { members: this.jamaat.roster((pid) => this.online.has(pid)) }, null);
  }

  _broadcastHelp() {
    this._broadcast('help', { requests: this.jamaat.openRequests() }, null);
  }

  _broadcastEvent() {
    this._broadcast(
      'event',
      { event: this.jamaat.eventSnapshot(), leaderboard: this.jamaat.leaderboard() },
      null,
    );
  }

  /* ------------------------------------------------------------------ tick */

  _tick() {
    const now = this.now();
    let presenceChanged = false;
    for (const [playerId, conn] of [...this.online]) {
      const player = this.players.get(playerId);
      if (!player || now - (player.lastSeen || 0) > this.presenceTimeoutMs) {
        this.online.delete(playerId);
        presenceChanged = true;
        try {
          conn.ws.close(1000, 'idle');
        } catch {
          /* ignore */
        }
      } else {
        conn.ws.ping();
      }
    }
    if (presenceChanged) this._broadcastPresence();

    const rolled = this.jamaat.rollover(now);
    if (rolled) {
      this._broadcastEvent();
      this._markDirty();
    }

    // Close help requests whose job already finished.
    let swept = false;
    for (const request of this.jamaat.openRequests()) {
      const owner = this.players.get(request.playerId);
      const job = owner?.sim.findJob(request.jobId);
      if (!job || job.status !== 'active') {
        this.jamaat.closeRequestsForJob(request.playerId, request.jobId);
        swept = true;
      }
    }
    if (swept) this._broadcastHelp();

    this.limiter.sweep();
    if (this.dirty) {
      this.dirty = false;
      this.store.saveSoon(this._snapshot());
    }
  }

  _markDirty() {
    this.dirty = true;
  }

  /* ----------------------------------------------------------- persistence */

  _snapshot() {
    return {
      version: SAVE_VERSION,
      savedAt: this.now(),
      playerSeq: this.playerSeq,
      reportSeq: this.reportSeq,
      players: [...this.players.values()].map((player) => ({
        id: player.id,
        token: player.token,
        displayName: player.displayName,
        isChild: player.isChild,
        jamaatId: player.jamaatId,
        cityLevel: player.cityLevel,
        createdAt: player.createdAt,
        lastSeen: player.lastSeen,
        sim: player.sim.serialize(),
      })),
      jamaat: this.jamaat.serialize(),
      reports: this.reports.slice(-500),
    };
  }

  _restore() {
    const saved = this.store.load();
    if (!saved || saved.version !== SAVE_VERSION || !Array.isArray(saved.players)) return;
    this.playerSeq = saved.playerSeq || saved.players.length + 1;
    this.reportSeq = saved.reportSeq || (saved.reports?.length || 0) + 1;
    for (const record of saved.players) {
      if (!record || typeof record.id !== 'string' || typeof record.token !== 'string') continue;
      try {
        const player = {
          id: record.id,
          token: record.token,
          displayName: typeof record.displayName === 'string' ? record.displayName : 'بازیکن',
          isChild: record.isChild === true,
          jamaatId: this.jamaatId,
          cityLevel: Number.isInteger(record.cityLevel) ? record.cityLevel : 1,
          createdAt: record.createdAt || this.now(),
          lastSeen: 0, // everyone starts offline after a restart
          sim: new PlayerSim({ data: this.data, saved: record.sim }),
        };
        this.players.set(player.id, player);
        this.tokens.set(player.token, player.id);
      } catch {
        /* skip corrupt records */
      }
    }
    this.jamaat.restore(saved.jamaat);
    // Drop roster entries whose player record is gone.
    for (const memberId of [...this.jamaat.members]) {
      if (!this.players.has(memberId)) this.jamaat.members.delete(memberId);
    }
    if (Array.isArray(saved.reports)) {
      this.reports = saved.reports.filter((report) => report && typeof report.id === 'string').slice(-500);
    }
  }

  /** Test/debug helper: how many moderation reports are stored. */
  get reportCount() {
    return this.reports.length;
  }
}
