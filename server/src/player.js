/**
 * PlayerSim — the AUTHORITATIVE per-player ledger and build timers.
 *
 * Rules (mirroring the client's EconomySystem/BuildQueue exactly):
 *   - costs, durations and production rates come from balance.json via GameData;
 *   - `endsAt` is stamped with the SERVER clock only — the client never sends time;
 *   - harvests are capped by a per-resource budget that refills from the
 *     production of validated buildings (a tampered client cannot print resources);
 *   - grants are only accepted from allow-listed sources with per-intent caps.
 *
 * Jobs created here carry `srv-` ids; local-only jobs (mission timers,
 * not-yet-acknowledged placements) never reach the server.
 */
import { asCostMap } from './protocol.js';

const HOUR_MS = 3600 * 1000;

function clampResources(resources) {
  const out = {};
  for (const key of ['rizq', 'nur', 'hekmat', 'gohar']) {
    const value = Number(resources?.[key]);
    out[key] = Number.isFinite(value) ? Math.min(1e9, Math.max(0, value)) : 0;
  }
  return out;
}

export class PlayerSim {
  /**
   * @param {object} options
   * @param {import('./data.js').GameData} options.data
   * @param {object} [options.saved] — restored record from disk
   */
  constructor({ data, saved = null }) {
    this.data = data;
    const social = data.social?.ledger || {};
    this.grantCaps = { ...(social.grantCaps || {}) };
    this.allowedSources = new Set(social.allowedGrantSources || ['other']);
    this.maxCostTotal = social.maxCostTotal || 1_000_000;
    this.maxBuildings = social.maxBuildingsAdopted || 60;
    this.seedHours = social.linkSeedBudgetHours ?? 8;
    this.harvestSlack = social.harvestSlack ?? 1.0;

    this.resources = clampResources(saved?.resources || data.startingResources);
    this.jobs = Array.isArray(saved?.jobs) ? saved.jobs.filter((job) => job && typeof job.id === 'string') : [];
    this.buildings = Array.isArray(saved?.buildings) ? saved.buildings : [];
    this.nextJob = Number.isInteger(saved?.nextJob) && saved.nextJob > 0 ? saved.nextJob : 1;
    this.budgets = { rizq: 0, nur: 0, hekmat: 0, ...(saved?.budgets || {}) };
    this.lastBudgetAt = Number.isFinite(saved?.lastBudgetAt) ? saved.lastBudgetAt : null;
    this.budgetSeeded = saved?.budgetSeeded === true;
    this.contributions = { ...(saved?.contributions || {}) }; // weekId -> points
    this.helpsGiven = saved?.helpsGiven || 0;
    this.helpsReceived = saved?.helpsReceived || 0;
  }

  /* ------------------------------------------------------------- capacity */

  capacity() {
    return this.data.capacityFor(this.buildings);
  }

  freeCapacity(resource) {
    return Math.max(0, (this.capacity()[resource] || 0) - (this.resources[resource] || 0));
  }

  /* ------------------------------------------------- buildings (adopted) */

  /**
   * Adopt the client's building list (link/relink). Every entry is validated
   * against buildings.json/balance.json and the list is capped — amounts and
   * timers are NEVER adopted, only `{type, level}` pairs for capacity and
   * harvest budgets.
   */
  adoptBuildings(list) {
    if (!Array.isArray(list)) return { ok: false, error: 'invalid' };
    if (list.length > this.maxBuildings) return { ok: false, error: 'invalid' };
    const adopted = [];
    for (const entry of list) {
      const type = entry?.type;
      const level = Math.floor(entry?.level);
      if (!this.data.knownDef(type)) return { ok: false, error: 'invalid' };
      if (!Number.isInteger(level) || level < 1 || level > this.data.maxLevel) {
        return { ok: false, error: 'invalid' };
      }
      adopted.push({ type, level });
    }
    this.buildings = adopted;
    // One-time seed: pending production from before the first link is honoured
    // up to `linkSeedBudgetHours` of the adopted production (never more).
    if (!this.budgetSeeded) {
      this.budgetSeeded = true;
      const rates = this.data.hourlyRates(adopted);
      for (const resource of Object.keys(this.budgets)) {
        this.budgets[resource] = Math.max(0, (rates[resource] || 0) * this.seedHours);
      }
    }
    return { ok: true, count: adopted.length };
  }

  /* ------------------------------------------------- harvest (budgeted) */

  refillBudgets(now) {
    if (this.lastBudgetAt == null) {
      this.lastBudgetAt = now;
      return;
    }
    let elapsed = now - this.lastBudgetAt;
    if (elapsed <= 0) {
      this.lastBudgetAt = now;
      return;
    }
    if (elapsed > 72 * HOUR_MS) elapsed = 72 * HOUR_MS; // same offline ceiling as the client
    this.lastBudgetAt = now;
    const rates = this.data.hourlyRates(this.buildings);
    const bufferHours = this.data.economy.production?.bufferHours || 8;
    for (const resource of Object.keys(this.budgets)) {
      const rate = rates[resource] || 0;
      if (rate <= 0) continue;
      const cap = rate * bufferHours;
      this.budgets[resource] = Math.min(cap, this.budgets[resource] + (rate * this.harvestSlack * elapsed) / HOUR_MS);
    }
  }

  /**
   * A harvest intent only says «I gathered X of R». The server grants at most
   * the budgeted production (plus storage ceiling) — never the raw claim.
   */
  harvest(resource, amount, now) {
    if (!['rizq', 'nur', 'hekmat'].includes(resource)) return { ok: false, error: 'invalid' };
    const claim = Number(amount);
    if (!Number.isFinite(claim) || claim <= 0 || claim > 1e9) return { ok: false, error: 'invalid' };
    this.refillBudgets(now);
    const moved = Math.min(claim, this.budgets[resource] || 0, this.freeCapacity(resource));
    if (moved > 0) {
      this.resources[resource] += moved;
      this.budgets[resource] -= moved;
    }
    return { ok: true, moved, claimed: claim, ledger: this.ledger() };
  }

  /* ---------------------------------------------------------- spend/grant */

  canAfford(cost) {
    return Object.entries(cost).every(([key, value]) => (this.resources[key] || 0) >= value);
  }

  spend(cost) {
    const valid = asCostMap(cost, { maxTotal: 1e12 });
    if (!valid) return { ok: false, error: 'invalid' };
    const total = Object.values(valid).reduce((sum, value) => sum + value, 0);
    if (total > this.maxCostTotal) return { ok: false, error: 'invalid' };
    if (!this.canAfford(valid)) return { ok: false, error: 'insufficient', ledger: this.ledger() };
    for (const [key, value] of Object.entries(valid)) this.resources[key] -= value;
    return { ok: true, ledger: this.ledger() };
  }

  grant(resource, amount, source = 'other') {
    if (!['rizq', 'nur', 'hekmat', 'gohar'].includes(resource)) return { ok: false, error: 'invalid' };
    if (!this.allowedSources.has(source)) return { ok: false, error: 'invalid' };
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) return { ok: false, error: 'invalid' };
    const cap = Number(this.grantCaps[source] ?? this.grantCaps.other ?? 100);
    const allowed = Math.min(value, Math.max(0, cap));
    if (allowed <= 0) return { ok: true, moved: 0, overflow: value, ledger: this.ledger() };
    if (resource === 'gohar') {
      this.resources.gohar = Math.min(1e9, this.resources.gohar + allowed);
      return { ok: true, moved: allowed, overflow: value - allowed, ledger: this.ledger() };
    }
    const moved = Math.min(allowed, this.freeCapacity(resource));
    this.resources[resource] += moved;
    return { ok: true, moved, overflow: value - moved, ledger: this.ledger() };
  }

  /* ---------------------------------------------------------------- jobs */

  activeJobs() {
    return this.jobs.filter((job) => job.status === 'active');
  }

  freeBuilders() {
    return Math.max(0, this.data.builders - this.activeJobs().length);
  }

  findJob(jobId) {
    return this.jobs.find((job) => job.id === jobId) || null;
  }

  _promote(now) {
    const promoted = [];
    for (const job of this.jobs) {
      if (job.status !== 'queued') continue;
      if (this.freeBuilders() <= 0) break;
      job.status = 'active';
      job.startedAt = now;
      job.endsAt = now + job.durationMs;
      promoted.push(this.publicJob(job));
    }
    return promoted;
  }

  publicJob(job) {
    return {
      id: job.id,
      kind: job.kind,
      entityId: job.entityId,
      defId: job.defId,
      level: job.level,
      durationMs: job.durationMs,
      startedAt: job.startedAt,
      endsAt: job.endsAt,
      status: job.status,
      helps: job.helps || 0,
    };
  }

  /**
   * Atomic spend + enqueue. The client sends NO cost and NO duration — both
   * are recomputed from balance.json, and `endsAt` uses the server clock.
   */
  enqueue({ kind, entityId, defId, level, fromLevel }, now) {
    if (kind !== 'build' && kind !== 'upgrade') return { ok: false, error: 'invalid' };
    if (!this.data.knownDef(defId)) return { ok: false, error: 'invalid' };
    if (!Number.isInteger(entityId) || entityId < 0) return { ok: false, error: 'invalid' };
    if (!Number.isInteger(level) || level < 1 || level > this.data.maxLevel) return { ok: false, error: 'invalid' };
    if (kind === 'build' && level !== 1) return { ok: false, error: 'invalid' };
    if (kind === 'upgrade') {
      if (!Number.isInteger(fromLevel) || level !== fromLevel + 1) return { ok: false, error: 'invalid' };
      const existing = this.buildings.find((entry) => entry.type === defId && entry.level === fromLevel);
      if (!existing) return { ok: false, error: 'invalid' };
    }
    if (this.jobs.length >= this.data.maxJobs) return { ok: false, error: 'queue-full' };
    if (this.jobs.some((job) => job.entityId === entityId)) return { ok: false, error: 'entity-busy' };

    const cost = this.data.costOf(defId, level);
    if (!cost) return { ok: false, error: 'invalid' };
    if (!this.canAfford(cost)) return { ok: false, error: 'insufficient', ledger: this.ledger() };
    const seconds = this.data.secondsOf(defId, level);
    if (!(seconds > 0)) return { ok: false, error: 'invalid' };

    for (const [key, value] of Object.entries(cost)) this.resources[key] -= value;
    const job = {
      id: `srv-${this.nextJob++}`,
      kind,
      entityId,
      defId,
      level,
      durationMs: Math.round(seconds * 1000),
      startedAt: null,
      endsAt: null,
      status: 'queued',
      helps: 0,
      helpedMs: 0,
      helpedBy: [],
    };
    this.jobs.push(job);
    this._promote(now);
    return { ok: true, job: this.publicJob(job), ledger: this.ledger() };
  }

  _applyBuildingEffect(job) {
    if (job.kind === 'build') {
      this.buildings.push({ type: job.defId, level: job.level });
    } else if (job.kind === 'upgrade') {
      const entry = this.buildings.find((item) => item.type === job.defId && item.level === job.level - 1);
      if (entry) entry.level = job.level;
      else this.buildings.push({ type: job.defId, level: job.level });
    }
  }

  /**
   * Completion is valid only when the SERVER clock has passed `endsAt`
   * (minus a small grace for network delay — never the client's clock).
   */
  complete(jobId, now, { graceMs = 1500 } = {}) {
    const job = this.findJob(jobId);
    if (!job) return { ok: false, error: 'missing' };
    if (job.status !== 'active') return { ok: false, error: 'not-active' };
    if (now < job.endsAt - graceMs) {
      return { ok: false, error: 'too-early', job: this.publicJob(job), serverNow: now };
    }
    this.jobs.splice(this.jobs.indexOf(job), 1);
    this._applyBuildingEffect(job);
    const promotions = this._promote(now);
    return { ok: true, job: this.publicJob(job), promotions, ledger: this.ledger() };
  }

  speedup(jobId, now) {
    const job = this.findJob(jobId);
    if (!job) return { ok: false, error: 'missing' };
    if (job.status !== 'active') return { ok: false, error: 'not-active' };
    const remaining = Math.max(0, job.endsAt - now);
    const perMinute = this.data.economy.speedup?.goharPerMinute || 1;
    const minGohar = this.data.economy.speedup?.minGohar || 1;
    const cost = Math.max(minGohar, Math.ceil(remaining / 60000) * perMinute);
    if ((this.resources.gohar || 0) < cost) return { ok: false, error: 'insufficient', ledger: this.ledger() };
    this.resources.gohar -= cost;
    job.endsAt = now;
    const finished = this.complete(jobId, now, { graceMs: 60_000 });
    return { ok: true, cost, job: finished.job, promotions: finished.promotions || [], ledger: this.ledger() };
  }

  /**
   * Apply one validated help reduction. Returns the milliseconds actually cut.
   * Caps: per-job help count, total reduction fraction and a minimum tail.
   */
  applyHelpReduction(jobId, { helpMs, maxPerJob, maxReductionFrac, minRemainingMs }, now) {
    const job = this.findJob(jobId);
    if (!job || job.status !== 'active') return { ok: false, error: 'not-active' };
    if ((job.helps || 0) >= maxPerJob) return { ok: false, error: 'exhausted' };
    const totalAllowed = Math.floor(job.durationMs * maxReductionFrac);
    const already = job.helpedMs || 0;
    const remaining = Math.max(0, job.endsAt - now);
    const cut = Math.min(helpMs, Math.max(0, totalAllowed - already), Math.max(0, remaining - minRemainingMs));
    if (cut <= 0) return { ok: false, error: 'exhausted' };
    job.endsAt -= cut;
    job.helps = (job.helps || 0) + 1;
    job.helpedMs = already + cut;
    return { ok: true, reductionMs: cut, job: this.publicJob(job) };
  }

  /* ------------------------------------------------------------ snapshot */

  ledger() {
    return {
      resources: { ...this.resources },
      capacity: this.capacity(),
      builders: { free: this.freeBuilders(), total: this.data.builders },
    };
  }

  jobsSnapshot() {
    return this.jobs.map((job) => this.publicJob(job));
  }

  addContribution(weekId, points) {
    this.contributions[weekId] = (this.contributions[weekId] || 0) + points;
    return this.contributions[weekId];
  }

  serialize() {
    return {
      resources: { ...this.resources },
      jobs: this.jobs.map((job) => ({ ...job, helpedBy: [...(job.helpedBy || [])] })),
      buildings: this.buildings.map((entry) => ({ ...entry })),
      nextJob: this.nextJob,
      budgets: { ...this.budgets },
      lastBudgetAt: this.lastBudgetAt,
      budgetSeeded: this.budgetSeeded,
      contributions: { ...this.contributions },
      helpsGiven: this.helpsGiven,
      helpsReceived: this.helpsReceived,
    };
  }
}
