/**
 * BarracksSystem — پادگان: آموزش نیرو، ظرفیت سپاه و نگه‌داری سپاه آماده.
 *
 * منطق خالص (بدون Three.js و بدون DOM). همهٔ اعداد از JSON می‌آید:
 *   • هزینه، زمان آموزش، جای سپاه و توان رزمی → src/data/units.json
 *   • ظرفیت پایه/هر سطح، شمار خطوط آموزش و سقف صف → src/data/battle.json
 *
 * صف آموزش تایم‌استمپ‌محور است (مثل صف ساخت): با یک/چند خط آموزش، پس از هر
 * تکمیل، کار بعدی روی همان زمان سوار می‌شود؛ بنابراین بازگشت پس از غیبت هم
 * دقیقاً همان‌طور پیش می‌رود که اگر بازی باز بود.
 *
 * هیچ متنی در این لایه ساخته نمی‌شود؛ پیام‌ها در رابط کاربری از strings.fa.json
 * خوانده می‌شوند.
 */

import { EVENTS } from '../../core/EventBus.js';

export class BarracksSystem {
  /**
   * @param {object} options
   * @param {object} options.config
   * @param {import('../GameState.js').GameState} options.state
   * @param {import('../EconomySystem.js').EconomySystem} options.economy
   * @param {object} options.unitsData — src/data/units.json
   * @param {object} options.battleData — src/data/battle.json
   * @param {import('../../core/EventBus.js').EventBus} [options.bus]
   */
  constructor({ config, state, economy, unitsData, battleData, bus = null }) {
    this.config = config;
    this.state = state;
    this.economy = economy;
    this.unitsData = unitsData;
    this.battleData = battleData;
    this.bus = bus;
    this.ensureGarrisonKeys();
  }

  /* --------------------------------------------------------------- data view */

  get units() {
    return this.unitsData.units;
  }

  get defaults() {
    return this.unitsData.defaults || {};
  }

  defOf(type) {
    return this.units.find((unit) => unit.id === type) || null;
  }

  get garrison() {
    return this.state.army.garrison;
  }

  get training() {
    return this.state.army.training;
  }

  /** همهٔ گونه‌ها باید کلید داشته باشند تا رابط کاربری ساده بماند. */
  ensureGarrisonKeys() {
    for (const unit of this.units) {
      if (typeof this.garrison[unit.id] !== 'number') this.garrison[unit.id] = 0;
    }
    return this.garrison;
  }

  /* -------------------------------------------------------------- ظرفیت سپاه */

  /** بزرگ‌ترین سطح پادگان آمادهٔ شهر (۰ = پادگانی نیست). */
  barracksLevel() {
    let level = 0;
    for (const entity of this.state.entities.values()) {
      if (entity.type !== 'barracks') continue;
      if (entity.status !== 'ready') continue;
      level = Math.max(level, entity.level);
    }
    return level;
  }

  hasBarracks() {
    return this.barracksLevel() > 0;
  }

  /** ظرفیت سپاه = پایه + هر سطح پادگان. */
  capacity() {
    const army = this.battleData.army || {};
    const level = this.barracksLevel();
    if (level <= 0) return 0;
    const perLevel = army.capacityPerBarracksLevel ?? army.capacityPerLevel ?? 0;
    return (army.baseCapacity || 0) + perLevel * (level - 1);
  }

  housingOf(type) {
    return this.defOf(type)?.housing ?? 1;
  }

  /** مجموع «جای سپاه» مصرف‌شده (سپاه آماده + نیروهای در آموزش). */
  used() {
    let total = 0;
    for (const unit of this.units) {
      const count = this.garrison[unit.id] || 0;
      total += count * (unit.housing ?? 1);
    }
    for (const job of this.training) {
      if (job.status === 'cancelled') continue;
      total += this.housingOf(job.unit);
    }
    return total;
  }

  free() {
    return Math.max(0, this.capacity() - this.used());
  }

  /** شمار سپاه آمادهٔ یک گونه. */
  countOf(type) {
    return this.garrison[type] || 0;
  }

  total() {
    let total = 0;
    for (const unit of this.units) total += this.garrison[unit.id] || 0;
    return total;
  }

  /** خطوط آموزش: در battle.json تعیین می‌شود. */
  slots() {
    return Math.max(1, this.battleData.army?.trainingSlots ?? 1);
  }

  maxQueue() {
    return Math.max(1, this.battleData.army?.trainingQueueMax ?? 5);
  }

  activeJobs() {
    return this.training.filter((job) => job.status === 'active');
  }

  queuedJobs() {
    return this.training.filter((job) => job.status === 'queued');
  }

  freeSlots() {
    return Math.max(0, this.slots() - this.activeJobs().length);
  }

  jobFor(unitType) {
    return this.training.find((job) => job.unit === unitType && job.status !== 'cancelled') || null;
  }

  /** سقف شمار هر گونهٔ واحد (از battle.json). */
  maxPerType() {
    return Math.max(1, this.battleData.army?.maxPerType ?? 30);
  }

  costOf(type) {
    return { ...(this.defOf(type)?.cost || {}) };
  }

  secondsOf(type) {
    return this.defOf(type)?.trainSeconds || 0;
  }

  /* ------------------------------------------------------------------ آموزش */

  /**
   * بررسی امکان آموزش (بدون تغییر حالت).
   * @returns {{ok:boolean, reason?:string}}
   */
  canTrain(type) {
    if (!this.defOf(type)) return { ok: false, reason: 'unknown-unit' };
    if (!this.hasBarracks()) return { ok: false, reason: 'no-barracks' };
    if (this.training.length >= this.maxQueue()) return { ok: false, reason: 'queue-full' };
    const inTraining = this.training.filter((job) => job.unit === type).length;
    if (this.countOf(type) + inTraining >= this.maxPerType()) return { ok: false, reason: 'type-limit' };
    if (this.used() + this.housingOf(type) > this.capacity()) return { ok: false, reason: 'capacity-full' };
    if (!this.economy.canAfford(this.costOf(type))) return { ok: false, reason: 'cost' };
    return { ok: true };
  }

  /**
   * افزودن یک نیرو به صف آموزش (هزینه همان‌جا کسر می‌شود).
   * @param {string} type
   * @param {number} now
   * @returns {{ok:boolean, reason?:string, job?:object}}
   */
  startTraining(type, now = Date.now()) {
    const allowed = this.canTrain(type);
    if (!allowed.ok) return allowed;
    const cost = this.costOf(type);
    this.economy.spend(cost);
    const durationMs = Math.max(0, this.secondsOf(type) * 1000);
    const job = {
      id: `train-${this.state.army.nextJobId++}`,
      unit: type,
      status: 'queued',
      startedAt: null,
      endsAt: null,
      durationMs,
    };
    this.training.push(job);
    this._promote(now);
    this.emitChanged();
    return { ok: true, job };
  }

  /** کارهای در انتظار را روی خط‌های آزاد می‌نشاند (FIFO). */
  _promote(at) {
    for (const job of this.training) {
      if (job.status !== 'queued') continue;
      if (this.freeSlots() <= 0) break;
      job.status = 'active';
      job.startedAt = at;
      job.endsAt = at + job.durationMs;
    }
  }

  /**
   * پیش‌بردن صف تا `now`؛ کارهای سررسیده به سپاه اضافه می‌شوند.
   * @returns {object[]} نیروهای آموزش‌دیده در این فراخوانی
   */
  tick(now = Date.now()) {
    if (this.training.length === 0) return [];
    const finished = [];
    let guard = 0;
    for (;;) {
      guard += 1;
      if (guard > 64) break;
      const due = this.training
        .filter((job) => job.status === 'active' && job.endsAt != null && job.endsAt <= now)
        .sort((a, b) => (a.endsAt - b.endsAt) || (a.id < b.id ? -1 : 1));
      if (due.length === 0) break;
      const job = due[0];
      const at = job.endsAt;
      this.state.army.training = this.training.filter((item) => item !== job);
      this.garrison[job.unit] = (this.garrison[job.unit] || 0) + 1;
      this.state.army.trained += 1;
      finished.push({ ...job, finishedAt: at });
      this._promote(at);
    }
    if (finished.length) this.emitChanged();
    return finished;
  }

  /** هزینهٔ گوهر برای پایان فوری آموزش فعال. */
  speedupCost(job, now = Date.now()) {
    return this.economy.speedupCost(job, now);
  }

  /** پایان فوری یک کار فعال با گوهر (بدون هیچ خرید واقعی). */
  speedup(jobId, now = Date.now()) {
    const job = this.training.find((item) => item.id === jobId);
    if (!job) return { ok: false, reason: 'not-found' };
    if (job.status !== 'active') return { ok: false, reason: 'not-active' };
    const cost = this.speedupCost(job, now);
    if (!this.economy.spendGohar(cost)) return { ok: false, reason: 'no-gohar' };
    job.endsAt = now;
    this.tick(now);
    return { ok: true };
  }

  /** لغو یک کار؛ نیمی از هزینه بازگردانده می‌شود (بدون جریمهٔ سنگین). */
  cancel(jobId) {
    const job = this.training.find((item) => item.id === jobId);
    if (!job) return { ok: false, reason: 'not-found' };
    this.state.army.training = this.training.filter((item) => item !== job);
    const refund = {};
    for (const [key, value] of Object.entries(this.costOf(job.unit))) {
      const half = Math.floor(value / 2);
      if (half > 0) refund[key] = half;
    }
    if (Object.keys(refund).length) this.economy.grant(refund);
    this._promote(Date.now());
    this.emitChanged();
    return { ok: true, refund };
  }

  /* ------------------------------------------------------------------ سپاه */

  /** سپاه آماده به‌صورت {type: count} برای رابط کاربری و استقرار در نبرد. */
  available() {
    const out = {};
    for (const unit of this.units) {
      const count = this.garrison[unit.id] || 0;
      if (count > 0) out[unit.id] = count;
    }
    return out;
  }

  /** نوشتن سپاه بازمانده (پس از نبرد) — پیام ARMY_CHANGED می‌دهد. */
  setGarrison(next, { silent = false } = {}) {
    const cleaned = {};
    for (const unit of this.units) {
      const value = Math.max(0, Math.floor(Number(next?.[unit.id]) || 0));
      cleaned[unit.id] = value;
    }
    this.state.army.garrison = cleaned;
    if (!silent) this.emitChanged();
    return cleaned;
  }

  /** خلاصهٔ آمادگی برای پنل نبرد. */
  readiness() {
    const byType = this.units.map((unit) => ({
      type: unit.id,
      name: unit.name,
      role: unit.role,
      icon: unit.icon,
      count: this.countOf(unit.id),
      housing: unit.housing ?? 1,
      cost: this.costOf(unit.id),
      seconds: this.secondsOf(unit.id),
      canTrain: this.canTrain(unit.id),
      training: this.jobFor(unit.id),
    }));
    return {
      level: this.barracksLevel(),
      capacity: this.capacity(),
      used: this.used(),
      free: this.free(),
      total: this.total(),
      slots: this.slots(),
      freeSlots: this.freeSlots(),
      maxQueue: this.maxQueue(),
      byType,
    };
  }

  emitChanged() {
    this.bus?.emit(EVENTS.ARMY_CHANGED, this.readiness());
  }

  toJSON() {
    return {
      garrison: { ...this.garrison },
      training: this.training.map((job) => ({ ...job })),
      nextJobId: this.state.army.nextJobId,
      trained: this.state.army.trained,
      deployed: this.state.army.deployed,
      lost: this.state.army.lost,
    };
  }
}
