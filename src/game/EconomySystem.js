/**
 * EconomySystem — pure game logic (no Three.js, no DOM).
 *
 * Rules (phase 3):
 *   - Three stored resources (rizq, nur, hekmat) with warehouse capacity:
 *       capacity = base + Σ (warehouseLevel × perWarehouseLevel)
 *   - Producers accrue `pending` at ratePerHour(level) into their own buffer,
 *     capped by bufferHours of production.
 *   - Production HALTS while the global storage of that resource is full
 *     ("انبار پر می‌شود و تولید در سقف متوقف می‌شود").
 *   - Harvest (tap) moves min(pending, freeCapacity) into storage.
 *   - Offline progress uses wall-clock timestamps (lastAccrualAt per producer),
 *     clamped to offline.maxHours and never below zero (clock moved back).
 *   - Gohar (in-game currency) is earned from town-center level rewards and
 *     other explicit gameplay rewards. There is no login/day-visit payout or purchase path.
 *
 * All time math is timestamp-driven so closing/reopening the page and manual
 * system-clock changes behave deterministically.
 */

const HOUR_MS = 3600 * 1000;

export class EconomySystem {
  /**
   * @param {object} options
   * @param {object} options.economy  — src/data/economy.json contents
   * @param {object} options.balance  — src/data/balance.json contents
   * @param {object[]} options.defs   — building definitions (id, produces, ...)
   * @param {import('./GameState.js').GameState} options.state
   */
  constructor({ economy, balance, defs, state }) {
    this.data = economy;
    this.balance = balance;
    this.state = state;
    this.defsById = new Map(defs.map((d) => [d.id, d]));
    /**
     * ضریب‌های موقت مأموریت (فاز ۶): تولید و مصرف هر منبع.
     * پیش‌فرض خالی است تا رفتار شهر در حالت عادی هیچ تغییری نکند.
     */
    this.modifiers = { production: {}, consumption: {} };
    /**
     * Phase 8 server mirror (null while offline — zero behaviour change).
     * When online, every local mutation emits an intent so the authoritative
     * server ledger can validate and adopt it; snapshots from the server are
     * applied through `applyLedger` (which never re-emits).
     */
    this.mirror = null;
    this._mirrorDepth = 0;
    /** Mission consumption accumulates here and flushes every few seconds. */
    this._drainPending = {};
  }

  /* ------------------------------------------------- server mirror (ph.8) */

  /** Install/remove the online intent hook (owned by SocialSystem). */
  setMirror(fn) {
    this.mirror = typeof fn === 'function' ? fn : null;
    if (!this.mirror) this._drainPending = {};
  }

  /** Run `fn` without emitting mirror intents (optimistic/rollback paths). */
  suppressMirror(fn) {
    this._mirrorDepth += 1;
    try {
      return fn();
    } finally {
      this._mirrorDepth = Math.max(0, this._mirrorDepth - 1);
    }
  }

  _emitMirror(intent) {
    if (!this.mirror || this._mirrorDepth > 0) return;
    try {
      this.mirror(intent);
    } catch {
      /* the game never breaks because the network did */
    }
  }

  /**
   * Adopt the authoritative server resources (server always wins).
   * No mirror intent is emitted — this IS the server speaking.
   */
  applyLedger(resources) {
    if (!resources || typeof resources !== 'object') return;
    for (const key of ['rizq', 'nur', 'hekmat', 'gohar']) {
      const value = Number(resources[key]);
      if (Number.isFinite(value)) this.resources[key] = Math.min(1e9, Math.max(0, value));
    }
  }

  /** Take and clear accumulated mission consumption (SocialSystem flushes it). */
  takeDrainLedger() {
    const pending = this._drainPending;
    this._drainPending = {};
    const cost = {};
    for (const [resource, amount] of Object.entries(pending)) {
      if (amount > 0.0001) cost[resource] = amount;
    }
    return Object.keys(cost).length > 0 ? cost : null;
  }

  /* ----------------------------------------------------- mission modifiers */

  /**
   * ضریب تولید/مصرف را از مأموریت فعال می‌گیرد (EconomySystem خودش هیچ
   * مأموریتی نمی‌شناسد؛ فقط ضریب‌ها را اعمال می‌کند).
   * @param {{production?:Record<string,number>, consumption?:Record<string,number>}} modifiers
   */
  setModifiers(modifiers = {}) {
    this.modifiers = {
      production: { ...(modifiers.production || {}) },
      consumption: { ...(modifiers.consumption || {}) },
    };
    return this.modifiers;
  }

  clearModifiers() {
    this.modifiers = { production: {}, consumption: {} };
  }

  productionMultiplier(resource) {
    const value = Number(this.modifiers.production?.[resource]);
    return Number.isFinite(value) && value >= 0 ? value : 1;
  }

  /** کسر امن یک منبع (بدون منفی‌شدن). مقدار واقعاً کسرشده برمی‌گردد. */
  drain(resource, amount) {
    const value = Math.max(0, Number(amount) || 0);
    if (value <= 0) return 0;
    const current = Number(this.resources[resource]) || 0;
    const moved = Math.min(current, value);
    this.resources[resource] = current - moved;
    if (moved > 0 && this.mirror && this._mirrorDepth === 0) {
      this._drainPending[resource] = (this._drainPending[resource] || 0) + moved;
    }
    return moved;
  }

  /** اعمال مصرف ثانیه‌ای ضریب‌ها (مأموریت‌ها؛ در حالت عادی صفر است). */
  applyConsumption(seconds) {
    const dt = Math.max(0, Number(seconds) || 0);
    if (dt <= 0) return 0;
    let total = 0;
    for (const [resource, perSecond] of Object.entries(this.modifiers.consumption || {})) {
      total += this.drain(resource, (Number(perSecond) || 0) * dt);
    }
    return total;
  }

  /* ------------------------------------------------------------- helpers */

  get resources() {
    return this.state.resources;
  }

  def(defId) {
    return this.defsById.get(defId) || null;
  }

  /** Balance entry for a target level (levels[0] = level 1 = initial build). */
  levelEntry(defId, level) {
    const table = this.balance.buildings[defId];
    if (!table) return null;
    return table.levels[level - 1] || null;
  }

  costOf(defId, level) {
    return this.levelEntry(defId, level)?.cost || null;
  }

  secondsOf(defId, level) {
    return this.levelEntry(defId, level)?.seconds || 0;
  }

  rateOf(entity) {
    if (!entity || entity.status !== 'ready') return 0;
    const entry = this.levelEntry(entity.type, entity.level);
    return entry && entry.ratePerHour ? entry.ratePerHour : 0;
  }

  get maxLevel() {
    return this.balance.maxLevel;
  }

  /**
   * ظرفیت انبار هر منبع = پایه + پاداش هر سازهٔ انباردار آماده.
   *   • «انبار» (warehouse) هر سطح، هر سه منبع را بالا می‌برد.
   *   • سازه‌هایی با `storageFor` (مثل «انبار غله») فقط منبع‌های خودشان را
   *     بالا می‌برند و ضریب هر سطح از economy.storage.perStorageLevel می‌آید.
   */
  capacity() {
    const cap = { ...this.data.storage.base };
    for (const entity of this.state.entities.values()) {
      if (entity.status !== 'ready') continue;
      const def = this.def(entity.type);
      if (!def) continue;
      const bonus = this.storageBonus(def);
      for (const [res, amount] of Object.entries(bonus)) {
        cap[res] = (cap[res] || 0) + amount * entity.level;
      }
    }
    return cap;
  }

  /** پاداش ظرفیت هر سطح از یک سازهٔ انباردار (بدون وابستگی به نمونهٔ سازه). */
  storageBonus(def) {
    const bonus = {};
    if (!def) return bonus;
    if (def.storagePerLevel === true) {
      for (const res of Object.keys(this.data.storage.base)) {
        bonus[res] = this.data.storage.perWarehouseLevel[res] || 0;
      }
      return bonus;
    }
    if (Array.isArray(def.storageFor)) {
      const table = this.data.storage.perStorageLevel || {};
      for (const res of def.storageFor) {
        const amount = Number(table[res]);
        if (Number.isFinite(amount) && amount > 0) bonus[res] = amount;
        else if (this.data.storage.perWarehouseLevel[res]) bonus[res] = this.data.storage.perWarehouseLevel[res];
      }
    }
    return bonus;
  }

  freeCapacity(resource) {
    const cap = this.capacity()[resource];
    return Math.max(0, cap - (this.resources[resource] || 0));
  }

  /** Amount of production (in resource units) a producer can buffer. */
  bufferCap(entity) {
    const rate = this.rateOf(entity);
    if (rate <= 0) return 0;
    return rate * this.data.production.bufferHours;
  }

  /** Pending amount that counts as "ready to harvest" (readySeconds of production). */
  readyThreshold(entity) {
    const rate = this.rateOf(entity);
    if (rate <= 0) return Infinity;
    return Math.max(1, (rate * this.data.production.readySeconds) / 3600);
  }

  isReady(entity) {
    return entity && entity.status === 'ready' && entity.pending >= this.readyThreshold(entity);
  }

  /* ----------------------------------------------------------- production */

  /**
   * Accrue pending production for every producer since its lastAccrualAt.
   * Safe against clock skew: negative deltas reset the timestamp, deltas are
   * clamped to offline.maxHours (so a wildly forwarded clock cannot overflow).
   *
   * @param {number} now — epoch ms
   * @returns {number} total units accrued (for callers that want a signal)
   */
  accrue(now) {
    const maxMs = (this.data.offline?.maxHours || 72) * HOUR_MS;
    let accrued = 0;
    for (const entity of this.state.entities.values()) {
      if (entity.status !== 'ready') continue;
      const rate = this.rateOf(entity);
      if (rate <= 0) continue;
      // ضریب مأموریت (فراوانی/قحطی/شکرانه) روی نرخ همان لحظه اثر می‌گذارد.
      const multiplier = this.productionMultiplier(this.def(entity.type)?.produces);

      if (entity.lastAccrualAt == null || now < entity.lastAccrualAt) {
        // First sight of the entity or the clock moved backwards: resync.
        entity.lastAccrualAt = now;
        continue;
      }
      let elapsed = now - entity.lastAccrualAt;
      if (elapsed <= 0) continue;
      if (elapsed > maxMs) elapsed = maxMs;
      entity.lastAccrualAt = now;

      // Storage full => production stops at the ceiling.
      const resource = this.def(entity.type)?.produces;
      if (!resource || this.freeCapacity(resource) <= 0) continue;

      const room = this.bufferCap(entity) - entity.pending;
      if (room <= 0) continue;

      const produced = Math.min(room, (rate * multiplier * elapsed) / HOUR_MS);
      entity.pending += produced;
      accrued += produced;
    }
    return accrued;
  }

  /**
   * Offline progress: accrue from each producer's own timestamp.
   * Returns a summary used by the "welcome back" toast.
   */
  catchUp(now) {
    const before = {};
    for (const entity of this.state.entities.values()) {
      if (entity.status === 'ready' && this.rateOf(entity) > 0) {
        const res = this.def(entity.type).produces;
        before[res] = (before[res] || 0) + entity.pending;
      }
    }
    const accrued = this.accrue(now);
    const gained = {};
    for (const entity of this.state.entities.values()) {
      if (entity.status === 'ready' && this.rateOf(entity) > 0) {
        const res = this.def(entity.type).produces;
        gained[res] = (gained[res] || 0) + entity.pending - (before[res] || 0);
      }
    }
    // Give the player the produced goods directly (capped by storage, since
    // accrual itself halts at the ceiling): auto-harvest during absence.
    let harvested = {};
    for (const entity of this.state.entities.values()) {
      const result = this.harvest(entity, now, { silent: true });
      if (result.moved > 0) harvested[result.resource] = (harvested[result.resource] || 0) + result.moved;
    }
    return { accrued, gained, harvested, autoHarvested: harvested };
  }

  /* ------------------------------------------------------------- harvest */

  /**
   * Move pending production into global storage (up to free capacity).
   * @returns {{moved:number, resource:string|null, full:boolean}}
   */
  harvest(entity, now = Date.now(), { silent = false } = {}) {
    if (!entity || entity.status !== 'ready') return { moved: 0, resource: null, full: false };
    this.accrue(now); // make sure pending is current before harvesting
    const resource = this.def(entity.type)?.produces;
    if (!resource) return { moved: 0, resource: null, full: false };

    const free = this.freeCapacity(resource);
    const moved = Math.min(entity.pending, free);
    if (moved > 0) {
      entity.pending -= moved;
      this.resources[resource] += moved;
      this._emitMirror({ kind: 'harvest', resource, amount: moved });
    }
    void silent;
    // "full" = this harvest hit the ceiling while something is still pending.
    return { moved, resource, full: free - moved <= 0 && entity.pending > 0 };
  }

  /* --------------------------------------------------------------- spend */

  canAfford(cost) {
    if (!cost) return false;
    return Object.entries(cost).every(([key, value]) => (this.resources[key] || 0) >= value);
  }

  spend(cost) {
    if (!this.canAfford(cost)) return false;
    for (const [key, value] of Object.entries(cost)) this.resources[key] -= value;
    this._emitMirror({ kind: 'spend', cost: { ...cost } });
    return true;
  }

  /**
   * افزودن منبع از مسیرهای غیرتولیدی (پاداش درس/مرور).
   * هرگز از ظرفیت انبار رد نمی‌شود؛ سرریز برگردانده می‌شود تا رابط کاربری
   * بتواند پیام «انبار پر است» بدهد. هیچ‌گاه مقدار منفی اعمال نمی‌کند.
   *
   * @param {string} resource — rizq | nur | hekmat | gohar
   * @param {number} amount
   * @param {{clampToCapacity?: boolean, source?: string}} [options]
   * @returns {{moved:number, overflow:number, resource:string}}
   */
  grant(resource, amount, { clampToCapacity = true, source = 'other' } = {}) {
    const value = Math.max(0, Number(amount) || 0);
    if (!resource || value <= 0) return { moved: 0, overflow: 0, resource };
    if (!this.data.resources[resource]) return { moved: 0, overflow: value, resource };
    if (this.data.resources[resource].stored === false) {
      this.resources[resource] = (this.resources[resource] || 0) + value;
      this._emitMirror({ kind: 'grant', resource, amount: value, source });
      return { moved: value, overflow: 0, resource };
    }
    const free = clampToCapacity ? this.freeCapacity(resource) : Infinity;
    const moved = Math.min(value, free);
    this.resources[resource] = (this.resources[resource] || 0) + moved;
    if (moved > 0) this._emitMirror({ kind: 'grant', resource, amount: value, source });
    return { moved, overflow: value - moved, resource };
  }

  earnGohar(amount, { source = 'other' } = {}) {
    const before = this.resources.gohar || 0;
    this.resources.gohar = before + amount;
    if (amount > 0) this._emitMirror({ kind: 'grant', resource: 'gohar', amount, source });
    return this.resources.gohar - before;
  }

  spendGohar(amount) {
    if ((this.resources.gohar || 0) < amount) return false;
    this.resources.gohar -= amount;
    this._emitMirror({ kind: 'spend', cost: { gohar: amount } });
    return true;
  }

  /** Gohar cost to finish an active job right now (in-game currency only). */
  speedupCost(job, now = Date.now()) {
    if (!job || job.status !== 'active') return null;
    const remaining = Math.max(0, job.endsAt - now);
    const minutes = Math.ceil(remaining / 60000);
    return Math.max(this.data.speedup.minGohar, minutes * this.data.speedup.goharPerMinute);
  }

  /* -------------------------------------------------- gohar (in-game only) */

  /**
   * Deprecated compatibility hook. Phase 7 removes login/day-visit payouts so
   * returning after a break never grants or withholds progression.
   */
  grantDailyBonus(_now = Date.now()) {
    return 0;
  }


  /** Reward granted when the town center finishes an upgrade. */
  townCenterReward() {
    return this.data.goharSources.townCenterLevelReward;
  }

  /* ------------------------------------------------------------ serialize */

  toJSON() {
    // Keep legacy fields so older save readers/migrations remain compatible;
    // phase 7 never interprets them as a reward timer.
    return {
      resources: { ...this.resources },
      lastDailyAt: this.state.lastDailyAt,
      dailyGranted: this.state.dailyGranted,
    };
  }
}
