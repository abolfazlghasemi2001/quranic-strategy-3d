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
 *   - Gohar (premium-ish currency) is earned ONLY from in-game paths:
 *     daily bonus + town-center level rewards. No purchases, no chance.
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

  /** Global storage capacity per stored resource (ready warehouses only). */
  capacity() {
    const cap = { ...this.data.storage.base };
    for (const entity of this.state.entities.values()) {
      if (entity.type !== 'warehouse' || entity.status !== 'ready') continue;
      for (const res of Object.keys(cap)) {
        cap[res] += entity.level * this.data.storage.perWarehouseLevel[res];
      }
    }
    return cap;
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

      const produced = Math.min(room, (rate * elapsed) / HOUR_MS);
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
    return true;
  }

  earnGohar(amount) {
    const before = this.resources.gohar || 0;
    this.resources.gohar = before + amount;
    return this.resources.gohar - before;
  }

  spendGohar(amount) {
    if ((this.resources.gohar || 0) < amount) return false;
    this.resources.gohar -= amount;
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
   * Daily visit bonus — deterministic, once per calendar day (local time),
   * derived purely from the stored timestamp. No randomness, no purchase.
   */
  grantDailyBonus(now = Date.now()) {
    const dayKey = this.dayKey(now);
    if (this.state.lastDailyAt && this.dayKey(this.state.lastDailyAt) === dayKey) return 0;
    this.state.lastDailyAt = now;
    if (!this.state.dailyGranted) {
      // First day is covered by the starting grant; only later days pay out.
      this.state.dailyGranted = true;
      return 0;
    }
    return this.earnGohar(this.data.goharSources.dailyBonus);
  }

  dayKey(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  /** Reward granted when the town center finishes an upgrade. */
  townCenterReward() {
    return this.data.goharSources.townCenterLevelReward;
  }

  /* ------------------------------------------------------------ serialize */

  toJSON() {
    return {
      resources: { ...this.resources },
      lastDailyAt: this.state.lastDailyAt,
      dailyGranted: this.state.dailyGranted,
    };
  }
}
