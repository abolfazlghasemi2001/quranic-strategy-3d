/**
 * SocialSystem — the bridge between the offline city and the جماعت server.
 *
 * Design (phase 8):
 *   • offline (default): nothing changes — the city plays exactly like phase 7;
 *   • online: the server ledger is the reference. Local economy mutations are
 *     mirrored as validated intents, build/upgrade/speedup go through atomic
 *     server intents (optimistic UI + rollback), and server snapshots always
 *     win over local values — so client-side tampering can never stick.
 *   • timers: server-tracked jobs (`srv-…`) complete only after the server
 *     confirms its own clock has passed `endsAt` (help shortens that clock).
 */
import { SocialClient } from './SocialClient.js';
import { EVENTS } from '../../core/EventBus.js';
import { socialEndpoint } from '../../core/EndpointPolicy.js';

const SERVER_JOB = 'srv-';
const PULL_SECONDS = 20;
const DRAIN_FLUSH_SECONDS = 5;

function isServerJob(job) {
  return !!job && typeof job.id === 'string' && job.id.startsWith(SERVER_JOB);
}

export class SocialSystem {
  /**
   * @param {object} options
   * @param {import('../../core/Config.js').Config} options.config
   * @param {import('../../core/EventBus.js').EventBus} options.bus
   * @param {import('../GameState.js').GameState} options.state
   * @param {import('../EconomySystem.js').EconomySystem} options.economy
   * @param {import('../BuildQueue.js').BuildQueue} options.queue
   * @param {import('../Game.js').Game} options.game
   * @param {string|null} [options.url] — endpoint override (e.g. ?social=…)
   */
  constructor({ config, bus, state, economy, queue, game, url = null }) {
    Object.assign(this, { config, bus, state, economy, queue, game });
    this.urlOverride = url;
    this.baseUrl = config.appUrl;
    this.client = null;
    this.status = 'offline'; // offline | connecting | online | error
    this.statusDetail = '';
    this.playerId = null;
    this.serverConfig = null;
    this.members = [];
    this.chat = [];
    this.helpRequests = [];
    this.event = null;
    this.leaderboard = [];
    this.unread = 0;
    this.panelOpen = false;
    this.serverNowOffset = 0;
    this._pullAcc = 0;
    this._drainAcc = 0;
    this._completing = new Set(); // srv job ids awaiting build:complete
    this._finishing = new Set(); // srv job ids mid-finish (no double finish)
    this._disposed = false;
  }

  get prefs() {
    return this.state.social;
  }

  isOnline() {
    return this.status === 'online' && !!this.client?.connected;
  }

  defaultUrl() {
    if (this.urlOverride) return this.urlOverride;
    return socialEndpoint(this.config.social.client?.defaultPath || '/social-ws', { baseUrl: this.baseUrl });
  }

  /* -------------------------------------------------------------- connect */

  /**
   * Connect to the jamaat server and link the city (adopts server ledger).
   * @returns {Promise<object>} snapshot
   */
  async connect({ displayName, isChild, url } = {}) {
    if (this.isOnline()) return this.snapshot();
    if (this.status === 'connecting') throw { error: 'busy' }; // eslint-disable-line no-throw-literal
    const target = socialEndpoint(url || this.defaultUrl(), { baseUrl: this.baseUrl, allowedOrigins: this.config.social.client?.allowedOrigins || [] });
    if (!target) {
      this.bus.emit(EVENTS.UI_TOAST, this.config.t('security.socialRejected'));
      throw { error: 'invalid-endpoint' };
    }
    const prefs = this.prefs;
    if (displayName !== undefined) prefs.displayName = String(displayName).slice(0, 16);
    if (isChild !== undefined) prefs.isChild = isChild === true;
    this.game.persist();

    this._setStatus('connecting');
    const client = new SocialClient({
      url: target,
      onPush: (push) => this._onPush(push),
      onStatus: (status, detail) => this._onClientStatus(status, detail),
    });
    this.client = client;
    try {
      const hello = await client.connect({
        token: prefs.token || null,
        displayName: prefs.displayName || null,
        isChild: !!prefs.isChild,
        cityLevel: this.state.cityLevel(),
        clientVersion: '0.3.0',
      });
      prefs.token = hello.token || prefs.token;
      prefs.jamaatId = hello.jamaat?.id || prefs.jamaatId;
      if (hello.player?.displayName) prefs.displayName = hello.player.displayName;
      this.playerId = hello.player?.id || null;
      this.serverConfig = hello.config || null;
      this._applySnapshot(hello);
      this._setStatus('online');
      this.queue.online = true;
      this.economy.setMirror((intent) => this._onMirror(intent));
      await this.syncCity();
      await this.pull().catch(() => null);
      this.game.persist();
      this.bus.emit(EVENTS.UI_TOAST, this.t('connected', 'به جماعت وصل شدی 🤝'));
      return this.snapshot();
    } catch (error) {
      this._teardownClient();
      const code = error?.error || 'connect-failed';
      this._setStatus(code === 'unsupported' ? 'error' : 'offline', code);
      this.bus.emit(EVENTS.UI_TOAST, this.errorText(code));
      throw error;
    }
  }

  disconnect(silent = false) {
    this._teardownClient();
    this.queue.online = false;
    this.economy.setMirror(null);
    this._completing.clear();
    this._finishing.clear();
    // Placements the server never acknowledged are rolled back with a refund.
    try {
      this.game.buildings?.rollbackAllOnlinePending?.();
    } catch {
      /* ignore */
    }
    if (this.status !== 'offline') {
      this._setStatus('offline');
      if (!silent) this.bus.emit(EVENTS.UI_TOAST, this.t('disconnected', 'از جماعت جدا شدی؛ بازی تک‌نفره ادامه دارد.'));
    }
    this.game.emitQueue();
  }

  _teardownClient() {
    if (this.client) {
      try {
        this.client.close();
      } catch {
        /* ignore */
      }
      this.client = null;
    }
  }

  _onClientStatus(status, detail) {
    if (this._disposed) return;
    if (status === 'closed' && this.status === 'online') {
      // Unexpected drop → clean offline fallback (never a crash, never a hang).
      this._teardownClient();
      this.queue.online = false;
      this.economy.setMirror(null);
      this._completing.clear();
      this._finishing.clear();
      try {
        this.game.buildings?.rollbackAllOnlinePending?.();
      } catch {
        /* ignore */
      }
      this._setStatus('offline', detail || 'dropped');
      this.bus.emit(EVENTS.UI_TOAST, this.t('dropped', 'ارتباط با جماعت قطع شد؛ بازی تک‌نفره ادامه دارد.'));
      this.game.emitQueue();
    }
  }

  _setStatus(status, detail = '') {
    this.status = status;
    this.statusDetail = detail;
    this.bus.emit(EVENTS.SOCIAL_STATUS, this.snapshot());
  }

  /* -------------------------------------------------------------- intents */

  /** Raw authenticated request (used by the gated build flows). */
  request(type, payload = {}) {
    if (!this.isOnline()) return Promise.reject({ error: 'offline' });
    return this.client.request(type, payload);
  }

  /** Introduce the city's buildings to the server (validated `{type, level}` only). */
  async syncCity() {
    const buildings = [...this.state.entities.values()]
      .filter((entity) => entity.status === 'ready')
      .map((entity) => ({ type: entity.type, level: entity.level }))
      .slice(0, 60);
    const answer = await this.request('city:sync', { buildings, cityLevel: this.state.cityLevel() });
    if (answer?.ok) this._adoptLedger(answer.ledger, answer.serverNow);
    return answer;
  }

  async pull() {
    const answer = await this.request('state:pull', {});
    if (answer?.ok) this._applySnapshot(answer);
    return answer;
  }

  async requestHelp(jobId) {
    const answer = await this.request('help:request', { jobId });
    if (!answer?.ok) this.bus.emit(EVENTS.UI_TOAST, this.errorText(answer?.error));
    return answer;
  }

  async giveHelp(requestId) {
    const answer = await this.request('help:give', { requestId });
    if (answer?.ok) {
      this.bus.emit(EVENTS.UI_TOAST, this.t('helpSent', 'کمکت ثبت شد؛ خدا قوت! 🤝'));
    } else {
      this.bus.emit(EVENTS.UI_TOAST, this.errorText(answer?.error));
    }
    return answer;
  }

  async cancelHelp(requestId) {
    return this.request('help:cancel', { requestId });
  }

  async sendChat(text) {
    const answer = await this.request('chat:send', { text });
    if (!answer?.ok) this.bus.emit(EVENTS.UI_TOAST, this.errorText(answer?.error));
    return answer;
  }

  async sendPreset(presetId) {
    const answer = await this.request('chat:preset', { presetId });
    if (!answer?.ok) this.bus.emit(EVENTS.UI_TOAST, this.errorText(answer?.error));
    return answer;
  }

  async reportMessage(messageId, reason) {
    const answer = await this.request('chat:report', { messageId, reason });
    this.bus.emit(EVENTS.UI_TOAST, answer?.ok
      ? this.t('reportThanks', 'گزارش ثبت شد؛ ممنون که کمک می‌کنی جماعت امن بماند.')
      : this.errorText(answer?.error));
    return answer;
  }

  async donate(resource, amount) {
    const answer = await this.request('event:donate', { resource, amount });
    if (answer?.ok) {
      this._adoptLedger(answer.ledger, answer.serverNow);
      this.game.persist();
    } else {
      this.bus.emit(EVENTS.UI_TOAST, this.errorText(answer?.error));
    }
    return answer;
  }

  /* ---------------------------------------------------------- mirror (up) */

  /** Local economy mutations become validated server intents. */
  _onMirror(intent) {
    if (!this.isOnline() || !intent) return;
    if (intent.kind === 'spend' && intent.cost) {
      this.request('ledger:spend', { cost: intent.cost }).then(
        (answer) => {
          if (answer?.ledger) this._adoptLedger(answer.ledger, answer.serverNow);
          if (answer && !answer.ok && answer.error === 'insufficient') {
            this.bus.emit(EVENTS.UI_TOAST, this.t('serverInsufficient', 'سرور: منابع کافی نیست؛ مقادیر با سرور یکسان شد.'));
          }
        },
        () => {},
      );
    } else if (intent.kind === 'grant') {
      this.request('ledger:grant', { resource: intent.resource, amount: intent.amount, source: intent.source || 'other' }).then(
        (answer) => {
          if (answer?.ledger) this._adoptLedger(answer.ledger, answer.serverNow);
        },
        () => {},
      );
    } else if (intent.kind === 'harvest') {
      this.request('ledger:harvest', { resource: intent.resource, amount: intent.amount }).then(
        (answer) => {
          if (answer?.ledger) this._adoptLedger(answer.ledger, answer.serverNow);
          if (answer?.ok && answer.moved < intent.amount * 0.5 && intent.amount >= 10) {
            this.bus.emit(EVENTS.UI_TOAST, this.t('harvestCapped', 'بخشی از برداشت در سرور سقف خورد.'));
          }
        },
        () => {},
      );
    }
  }

  _flushDrains() {
    const cost = this.economy.takeDrainLedger();
    if (!cost) return;
    this.request('ledger:spend', { cost }).then(
      (answer) => {
        if (answer?.ledger) this._adoptLedger(answer.ledger, answer.serverNow);
      },
      () => {},
    );
  }

  /* -------------------------------------------------------- adopt (down) */

  /** Public alias for the gated build flows (adopts the server ledger). */
  adoptLedger(ledger, serverNow) {
    this._adoptLedger(ledger, serverNow);
  }

  _adoptLedger(ledger, serverNow) {
    if (!ledger?.resources) return;
    if (Number.isFinite(serverNow)) this.serverNowOffset = serverNow - Date.now();
    this.economy.applyLedger(ledger.resources);
    this.game.markEconomyDirty();
    this.game.emitState(Date.now(), false);
    this.bus.emit(EVENTS.SOCIAL_LEDGER, { resources: { ...this.state.resources } });
  }

  _adoptJobs(serverJobs) {
    if (!Array.isArray(serverJobs)) return;
    const byId = new Map(serverJobs.map((job) => [job.id, job]));
    for (const remote of serverJobs) {
      const local = this.queue.jobs.find((job) => job.id === remote.id);
      if (local) {
        local.status = remote.status;
        local.startedAt = remote.startedAt;
        local.endsAt = remote.endsAt;
        local.durationMs = remote.durationMs;
      } else {
        // A server job we have never seen (reconnect race) — adopt, never invent.
        this.queue.jobs.push({
          id: remote.id,
          kind: remote.kind,
          entityId: remote.entityId,
          type: remote.defId,
          targetLevel: remote.level,
          durationMs: remote.durationMs,
          startedAt: remote.startedAt,
          endsAt: remote.endsAt,
          status: remote.status,
        });
      }
    }
    // The server dropped a job we still hold and we are not completing it →
    // it finished on the server side (e.g. speedup ack race): finish locally.
    for (const local of [...this.queue.jobs]) {
      if (!isServerJob(local) || byId.has(local.id)) continue;
      if (this._completing.has(local.id) || this._finishing.has(local.id)) continue;
      this._finishServerJob(local);
    }
    this.game.markQueueDirty();
    this.game.emitQueue();
  }

  _applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    if (snapshot.ledger) this._adoptLedger(snapshot.ledger, snapshot.serverNow);
    if (snapshot.jobs) this._adoptJobs(snapshot.jobs);
    if (Array.isArray(snapshot.members)) {
      this.members = snapshot.members;
      this.bus.emit(EVENTS.SOCIAL_PRESENCE, { members: this.members });
    }
    if (Array.isArray(snapshot.chat)) {
      this.chat = snapshot.chat.slice(-50);
      this.bus.emit(EVENTS.SOCIAL_CHAT, { messages: this.chat, unread: this.unread });
    }
    if (Array.isArray(snapshot.help)) {
      this.helpRequests = snapshot.help;
      this.bus.emit(EVENTS.SOCIAL_HELP, { requests: this.helpRequests });
    }
    if (snapshot.event) {
      this.event = snapshot.event;
      this.leaderboard = Array.isArray(snapshot.leaderboard) ? snapshot.leaderboard : [];
      this.bus.emit(EVENTS.SOCIAL_EVENT, { event: this.event, leaderboard: this.leaderboard });
    }
  }

  _onPush(message) {
    const { push } = message || {};
    // The server sends pushes flat ({ push, ledger, … }); accept a wrapped
    // { push, payload } shape too so both stay compatible.
    const payload = message?.payload && typeof message.payload === 'object' ? message.payload : (message || {});
    if (this._disposed) return;
    switch (push) {
      case 'ledger':
        this._adoptLedger(payload.ledger, payload.serverNow);
        this._adoptJobs(payload.jobs);
        break;
      case 'chat':
        if (payload.message) {
          this.chat = [...this.chat, payload.message].slice(-50);
          if (!this.panelOpen || payload.message.from?.id !== this.playerId) {
            if (!this.panelOpen) this.unread += 1;
          }
          this.bus.emit(EVENTS.SOCIAL_CHAT, { messages: this.chat, unread: this.unread, latest: payload.message });
          this.bus.emit(EVENTS.SOCIAL_STATUS, this.snapshot());
        }
        break;
      case 'presence':
        this.members = Array.isArray(payload.members) ? payload.members : [];
        this.bus.emit(EVENTS.SOCIAL_PRESENCE, { members: this.members });
        break;
      case 'help':
        this.helpRequests = Array.isArray(payload.requests) ? payload.requests : [];
        this.bus.emit(EVENTS.SOCIAL_HELP, { requests: this.helpRequests });
        this.bus.emit(EVENTS.SOCIAL_STATUS, this.snapshot());
        break;
      case 'event':
        this.event = payload.event || this.event;
        this.leaderboard = Array.isArray(payload.leaderboard) ? payload.leaderboard : [];
        this.bus.emit(EVENTS.SOCIAL_EVENT, { event: this.event, leaderboard: this.leaderboard });
        break;
      case 'notice':
        this.bus.emit(EVENTS.UI_TOAST, this.noticeText(payload));
        this.bus.emit(EVENTS.SOCIAL_NOTICE, payload);
        break;
      default:
        break;
    }
  }

  /* --------------------------------------------------------------- timers */

  /** Ask the server to confirm every due server-tracked job (server clock rules). */
  tickJobs(now) {
    if (!this.isOnline()) return;
    for (const job of this.queue.jobs) {
      if (!isServerJob(job) || job.status !== 'active') continue;
      if (!Number.isFinite(job.endsAt) || job.endsAt > now) continue;
      if (this._completing.has(job.id) || this._finishing.has(job.id)) continue;
      this._completing.add(job.id);
      this.request('build:complete', { jobId: job.id }).then(
        (answer) => {
          this._completing.delete(job.id);
          if (answer?.ok) {
            this._adoptLedger(answer.ledger, answer.serverNow);
            const local = this.queue.jobs.find((item) => item.id === job.id);
            if (local) this._finishServerJob(local);
            this.game.persist();
          } else if (answer?.error === 'too-early' && answer.job) {
            // Local clock drift or tampered endsAt → adopt the truth, no penalty.
            const local = this.queue.jobs.find((item) => item.id === job.id);
            if (local) {
              local.endsAt = answer.job.endsAt;
              local.status = answer.job.status;
              this.game.markQueueDirty();
              this.game.emitQueue();
            }
          }
        },
        () => {
          this._completing.delete(job.id);
        },
      );
    }
  }

  _finishServerJob(localJob) {
    if (this._finishing.has(localJob.id)) return;
    this._finishing.add(localJob.id);
    const index = this.queue.jobs.indexOf(localJob);
    if (index >= 0) this.queue.jobs.splice(index, 1);
    try {
      this.game._finishJob(localJob, Date.now());
    } finally {
      this._finishing.delete(localJob.id);
    }
  }

  /* ----------------------------------------------------------------- tick */

  update(dt) {
    if (!this.isOnline() || this._disposed) return;
    this._pullAcc += dt;
    if (this._pullAcc >= PULL_SECONDS) {
      this._pullAcc = 0;
      this.pull().catch(() => {});
    }
    this._drainAcc += dt;
    if (this._drainAcc >= DRAIN_FLUSH_SECONDS) {
      this._drainAcc = 0;
      this._flushDrains();
    }
  }

  markRead() {
    if (this.unread === 0) return;
    this.unread = 0;
    this.bus.emit(EVENTS.SOCIAL_STATUS, this.snapshot());
  }

  setPanelOpen(open) {
    this.panelOpen = !!open;
    if (open) this.markRead();
  }

  openHelpForMe() {
    return this.helpRequests.filter((request) => request.playerId !== this.playerId);
  }

  myOpenRequests() {
    return this.helpRequests.filter((request) => request.playerId === this.playerId);
  }

  snapshot() {
    return {
      status: this.status,
      detail: this.statusDetail,
      playerId: this.playerId,
      online: this.isOnline(),
      displayName: this.prefs.displayName,
      isChild: !!this.prefs.isChild,
      members: this.members,
      chat: this.chat,
      helpRequests: this.helpRequests,
      event: this.event,
      leaderboard: this.leaderboard,
      unread: this.unread,
      serverConfig: this.serverConfig,
      rttMs: this.client?.rttMs ?? null,
    };
  }

  /* ------------------------------------------------------------------ i18n */

  t(key, fallback) {
    return this.config.t(`social.${key}`, fallback);
  }

  errorText(code) {
    const map = {
      offline: this.t('errors.offline', 'به جماعت وصل نیستی.'),
      'connect-failed': this.t('errors.connectFailed', 'اتصال به سرور جماعت ناموفق بود.'),
      unsupported: this.t('errors.unsupported', 'مرورگر از اتصال زنده پشتیبانی نمی‌کند.'),
      busy: this.t('errors.busy', 'در حال اتصال… کمی صبر کن.'),
      invalid: this.t('errors.invalid', 'درخواست نامعتبر بود.'),
      'unknown-type': this.t('errors.unknown', 'درخواست شناخته نشد.'),
      'rate-limited': this.t('errors.rateLimited', 'خیلی تند می‌روی؛ کمی صبر کن ⏳'),
      unauthenticated: this.t('errors.auth', 'نشست منقضی شد؛ دوباره وصل شو.'),
      'jamaat-full': this.t('errors.full', 'جماعت پر است؛ بعداً تلاش کن.'),
      insufficient: this.t('errors.insufficient', 'منابع کافی نیست.'),
      'too-early': this.t('errors.tooEarly', 'هنوز زمانش نرسیده است.'),
      missing: this.t('errors.missing', 'پیدا نشد؛ شاید تمام شده باشد.'),
      'not-active': this.t('errors.notActive', 'این کار فعال نیست.'),
      'queue-full': this.t('errors.queueFull', 'صف ساخت پر است.'),
      'entity-busy': this.t('errors.entityBusy', 'این ساختمان در صف ساخت است.'),
      cooldown: this.t('errors.cooldown', 'کمی صبر کن بعد دوباره تلاش کن.'),
      exhausted: this.t('errors.exhausted', 'سهم این کار تمام شده است.'),
      forbidden: this.t('errors.forbidden', 'این کار مجاز نیست.'),
      'child-restricted': this.t('errors.child', 'حساب کودک فقط پیام آماده می‌فرستد.'),
      completed: this.t('errors.completed', 'این رویداد کامل شده است.'),
      timeout: this.t('errors.timeout', 'پاسخ سرور دیر رسید؛ دوباره تلاش کن.'),
    };
    return map[code] || this.t('errors.generic', 'خطایی رخ داد؛ دوباره تلاش کن.');
  }

  noticeText({ kind, params = {} } = {}) {
    const fill = (template, values) => String(template).replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
    if (kind === 'help-received') {
      return fill(this.t('noticeHelp', '«{name}» به ساخت کمک کرد (−{seconds} ثانیه) 🤝'), params);
    }
    if (kind === 'event-completed') {
      return fill(this.t('noticeEvent', 'هدف «{title}» کامل شد! +{reward} گوهر برای هم‌سهم‌ها 🎉'), params);
    }
    return this.t('noticeGeneric', 'خبر تازه از جماعت رسید.');
  }

  dispose() {
    this._disposed = true;
    this._teardownClient();
    this.queue.online = false;
    this.economy.setMirror(null);
  }
}
