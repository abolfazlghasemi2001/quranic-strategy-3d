/**
 * BattleSystem — پیوند شبیه‌ساز نبرد با بازی (منطق خالص: بدون Three.js، بدون DOM).
 *
 * وظیفه‌ها:
 *   • ساخت آرایش نبرد از چیدمان واقعی شهر بازیکن (BattleScenario)
 *   • اجرای شبیه‌ساز قطعی با گام ثابت و سرعت قابل‌تنظیم (×۱/×۲/×۴)
 *   • پذیرش دستورهای بازیکن (استقرار نیرو، عقب‌نشینی) و ثبت آن‌ها برای بازپخش
 *   • نوشتن نتیجه روی شهر: آسیب سازه‌ها، سپاه بازمانده، پاداش‌ها
 *   • نگه‌داری سابقهٔ نبردها و بازپخش و اعتبارسنجی آن
 *
 * هیچ متنی — و به‌ویژه هیچ متن قرآنی — در این لایه وجود ندارد؛ فقط اعداد،
 * شناسه‌ها و رویدادهای ساختاری برای لایهٔ رندر.
 */
import { EVENTS } from '../../core/EventBus.js';
import { BattleSim, BATTLE_EVENT, BATTLE_RESULT } from './BattleSim.js';
import {
  buildScenario,
  defenseDefsFrom,
  deriveBattleSeed,
  encounterById,
  scenarioHasDefenders,
  structureModifiersFrom,
} from './BattleScenario.js';
import { createRecord, replayRecord } from './BattleRecorder.js';
import { FACTION } from './Unit.js';

export const BATTLE_MODE = Object.freeze({ LIVE: 'live', REPLAY: 'replay' });

export class BattleSystem {
  /**
   * @param {object} options
   * @param {object} options.config
   * @param {import('../GameState.js').GameState} options.state
   * @param {import('../EconomySystem.js').EconomySystem} options.economy
   * @param {import('../barracks/BarracksSystem.js').BarracksSystem} options.barracks
   * @param {object} options.battleData — battle.json
   * @param {object} options.unitsData — units.json
   * @param {object} options.defensesData — defenses.json
   * @param {object} options.structureStats — createStructureStats(...)
   * @param {import('../../core/EventBus.js').EventBus} options.bus
   * @param {(() => string|null)|null} [options.externalBlocker] — قید بیرونی
   *        (فاز ۶: مأموریت فعال) که دلیل جلوگیری از شروع نبرد را برمی‌گرداند
   */
  constructor({ config, state, economy, barracks, battleData, unitsData, defensesData, structureStats, bus, externalBlocker = null }) {
    this.config = config;
    this.state = state;
    this.economy = economy;
    this.barracks = barracks;
    this.battleData = battleData;
    this.unitsData = unitsData;
    this.defensesData = defensesData;
    this.structureStats = structureStats;
    this.bus = bus;

    this.defenseDefs = defenseDefsFrom(defensesData);
    this.structureModifiers = structureModifiersFrom(defensesData);
    /** مأموریت فعال اجازهٔ شروع نبرد نمی‌دهد (و نه برعکس: مأموریت‌ها نبرد نمی‌خواهند). */
    this.externalBlocker = typeof externalBlocker === 'function' ? externalBlocker : null;
    this.session = null;
    this.lastReport = null;
    this.lastVerification = null;
    this._progressTimer = 0;
  }

  /* ------------------------------------------------------------------ query */

  get active() {
    return this.session != null;
  }

  get mode() {
    return this.session ? this.session.mode : null;
  }

  get sim() {
    return this.session ? this.session.sim : null;
  }

  get running() {
    return this.active && !this.session.paused && !this.session.sim.done;
  }

  get speed() {
    return this.session ? this.session.speed : 1;
  }

  encounters() {
    return (this.battleData.encounters || []).map((encounter) => ({
      id: encounter.id,
      name: encounter.name,
      threat: encounter.threat,
      units: encounter.waves.reduce((sum, wave) => sum + wave.count, 0),
      waves: encounter.waves.length,
      seconds: Math.max(...encounter.waves.map((wave) => wave.atSeconds), 0),
    }));
  }

  /** آیا می‌توان نبرد تازه شروع کرد؟ */
  canStart() {
    if (this.active) return { ok: false, reason: 'busy' };
    if (this.state.entities.size === 0) return { ok: false, reason: 'empty-city' };
    if (this.externalBlocker) {
      const reason = this.externalBlocker();
      if (reason) return { ok: false, reason };
    }
    return { ok: true };
  }

  /** پیش‌نمایش آرایش نبرد بدون شروع آن (برای پنل). */
  preview(encounterId = null) {
    const encounter = encounterById(this.battleData, encounterId || this.battleData.encounters[0]?.id);
    if (!encounter) return null;
    const scenario = this._buildScenario(encounter.id, deriveBattleSeed({
      worldSeed: this.config.seed,
      seedOffset: encounter.seedOffset,
      battleSeq: this.state.battles.seq + 1,
    }));
    const readiness = scenarioHasDefenders(scenario);
    return {
      encounter: { id: encounter.id, name: encounter.name, threat: encounter.threat },
      seed: scenario.seed,
      raiders: scenario.spawns.length,
      structures: scenario.structures.length,
      walls: scenario.structures.filter((s) => s.kind === 'wall').length,
      defenses: readiness.defenses,
      army: readiness.army,
      ready: readiness.ready,
    };
  }

  /* ------------------------------------------------------------------ start */

  _buildScenario(encounterId, seed) {
    return buildScenario({
      config: this.config,
      state: this.state,
      defensesData: this.defensesData,
      battleData: this.battleData,
      structureStats: this.structureStats,
      encounterId,
      seed,
    });
  }

  /**
   * آغاز یک نبرد PvE روی چیدمان شهر بازیکن.
   * @param {object} [options]
   * @param {string} [options.encounterId]
   * @param {number} [options.seed] — بذر صریح (تست‌ها و اعتبارسنجی)
   * @returns {{ok:boolean, reason?:string, seed?:number, scenario?:object}}
   */
  start({ encounterId = null, seed = null } = {}) {
    const allowed = this.canStart();
    if (!allowed.ok) return allowed;
    const encounter = encounterById(this.battleData, encounterId || this.battleData.encounters[0]?.id);
    if (!encounter) return { ok: false, reason: 'no-encounter' };
    const battleSeq = this.state.battles.seq + 1;
    const battleSeed = seed == null
      ? deriveBattleSeed({ worldSeed: this.config.seed, seedOffset: encounter.seedOffset, battleSeq })
      : seed >>> 0;
    const scenario = this._buildScenario(encounter.id, battleSeed);
    const sim = new BattleSim({
      scenario,
      rules: this.battleData,
      units: this.unitsData,
      defenseDefs: this.defenseDefs,
      structureModifiers: this.structureModifiers,
    });
    this.session = {
      mode: BATTLE_MODE.LIVE,
      sim,
      scenario,
      encounterId: encounter.id,
      encounterName: encounter.name,
      accumulator: 0,
      speed: 1,
      paused: false,
      startedTick: 0,
      recorded: null,
      settled: false,
    };
    this._progressTimer = 0;
    this.bus.emit(EVENTS.BATTLE_STARTED, {
      mode: BATTLE_MODE.LIVE,
      encounter: { id: encounter.id, name: encounter.name, threat: encounter.threat },
      seed: battleSeed,
      scenarioHash: scenario.scenarioHash,
      summary: {
        raiders: scenario.spawns.length,
        structures: scenario.structures.length,
        army: Object.values(scenario.garrison).reduce((sum, value) => sum + value, 0),
      },
    });
    return { ok: true, seed: battleSeed, scenario };
  }

  /**
   * بازپخش یک نبرد ضبط‌شده (همان آرایش + همان دستورها).
   * @param {number} [index] — ۰ = آخرین نبرد
   */
  startReplay(index = 0) {
    if (this.active) return { ok: false, reason: 'busy' };
    const history = this.state.battles.history;
    const record = history[history.length - 1 - Math.max(0, index)];
    if (!record) return { ok: false, reason: 'no-record' };
    const verification = replayRecord(record, {
      rules: this.battleData,
      units: this.unitsData,
      defenseDefs: this.defenseDefs,
      structureModifiers: this.structureModifiers,
    });
    this.lastVerification = {
      ok: verification.ok,
      mismatches: verification.mismatches,
      result: verification.result,
      ticks: verification.ticks,
      expectedHash: record.report.stateHash,
      actualHash: verification.report.stateHash,
      at: Date.now(),
    };
    this.session = {
      mode: BATTLE_MODE.REPLAY,
      sim: verification.sim,
      scenario: record.scenario,
      encounterId: record.encounterId,
      encounterName: record.scenario?.encounter?.name || record.encounterId,
      accumulator: 0,
      speed: 1,
      paused: false,
      recorded: record,
      verification: this.lastVerification,
      settled: false,
      // بازپخش از ابتدا اجرا می‌شود: شبیه‌ساز را از نو می‌سازیم و گام‌به‌گام جلو می‌بریم.
      replaySim: verification.sim,
    };
    // برای پخش تصویری، یک شبیه‌ساز تازه در گام صفر می‌سازیم و دستورها را می‌دهیم.
    const sim = new BattleSim({
      scenario: { ...record.scenario, commands: record.commands, scenarioHash: record.scenarioHash },
      rules: this.battleData,
      units: this.unitsData,
      defenseDefs: this.defenseDefs,
      structureModifiers: this.structureModifiers,
    });
    this.session.sim = sim;
    this.bus.emit(EVENTS.BATTLE_REPLAY_STARTED, {
      encounterId: record.encounterId,
      seed: record.seed,
      verified: verification.ok,
      expectedHash: record.report.stateHash,
      mismatchKinds: verification.mismatches.map((item) => item.kind),
    });
    this.bus.emit(EVENTS.BATTLE_REPLAY_VERIFIED, this.lastVerification);
    return { ok: verification.ok, verification, record };
  }

  /* ------------------------------------------------------------- commands */

  /** استقرار یک واحد از سپاه روی نقشه (world units). */
  deploy(unitType, x, z) {
    if (!this.session || this.session.mode !== BATTLE_MODE.LIVE) return { ok: false, reason: 'no-live-battle' };
    const result = this.session.sim.deploy(unitType, x, z);
    if (!result.ok) {
      this.bus.emit(EVENTS.UI_TOAST, this._deployMessage(result.reason));
      return result;
    }
    this.bus.emit(EVENTS.BATTLE_COMMAND, { type: 'deploy', unit: unitType, x, z, tick: result.command.tick });
    return result;
  }

  _deployMessage(reason) {
    const t = (key, fallback) => this.config.t(key, fallback);
    switch (reason) {
      case 'no-troops': return t('battle.deployEmpty', 'از این گونه در پادگان باقی نمانده است.');
      case 'limit': return t('battle.deployLimit', 'سقف استقرار در این نبرد پر شده است.');
      case 'cooldown': return t('battle.deployCooldown', 'چند لحظه صبر کنید.');
      case 'too-close': return t('battle.deployBlocked', 'استقرار در این نقطه ممکن نیست.');
      case 'outside': return t('battle.deployBlocked', 'استقرار در این نقطه ممکن است');
      default: return t('battle.deployBlocked', 'استقرار در این نقطه ممکن نیست.');
    }
  }

  withdraw() {
    if (!this.session || this.session.mode !== BATTLE_MODE.LIVE) return { ok: false, reason: 'no-live-battle' };
    const command = this.session.sim.withdraw();
    if (command) this.bus.emit(EVENTS.BATTLE_COMMAND, { type: 'withdraw', tick: command.tick });
    return { ok: !!command };
  }

  setSpeed(speed) {
    if (!this.session) return this.speed;
    this.session.speed = Math.max(0.5, Math.min(4, speed));
    this.bus.emit(EVENTS.BATTLE_PROGRESS, this.status());
    return this.session.speed;
  }

  togglePause(force = null) {
    if (!this.session) return false;
    const next = force == null ? !this.session.paused : !!force;
    this.session.paused = next;
    this.bus.emit(EVENTS.BATTLE_PROGRESS, this.status());
    return next;
  }

  /** بستن صحنهٔ نبرد پس از دیدن نتیجه (وضعیت شهر دست‌نخورده می‌ماند). */
  closeSession() {
    if (!this.session) return false;
    const mode = this.session.mode;
    this.session = null;
    this._progressTimer = 0;
    this.bus.emit(EVENTS.BATTLE_SESSION_CLOSED, { mode });
    return true;
  }

  /* ------------------------------------------------------------------- loop */

  update(dt) {
    const session = this.session;
    if (!session) return;
    const sim = session.sim;

    // رویدادهای نبرد → گذرگاه رویداد (لایهٔ رندر و رابط کاربری مصرف می‌کنند).
    const events = sim.drainEvents();
    if (events.length) this.bus.emit(EVENTS.BATTLE_EVENTS, { mode: session.mode, events });

    if (session.paused) return;

    const step = sim.stepSeconds;
    session.accumulator += dt * session.speed;
    let steps = 0;
    const maxSteps = this.battleData.sim.maxStepsPerFrame ?? 10;
    while (session.accumulator >= step && steps < maxSteps && !sim.done) {
      sim.tick();
      session.accumulator -= step;
      steps += 1;
    }
    if (steps >= maxSteps) session.accumulator = 0;

    if (sim.done && !session.settled) this._settle(session);

    this._progressTimer += dt;
    if (this._progressTimer >= 0.2) {
      this._progressTimer = 0;
      this.bus.emit(EVENTS.BATTLE_PROGRESS, this.status());
    }
  }

  /** نسبت پیشرفت درون‌گامی برای درون‌یابی حرکت واحدها در لایهٔ رندر. */
  get alpha() {
    if (!this.session) return 0;
    return Math.max(0, Math.min(1, this.session.accumulator / this.session.sim.stepSeconds));
  }

  status() {
    const session = this.session;
    if (!session) return null;
    const sim = session.sim;
    return {
      mode: session.mode,
      encounterId: session.encounterId,
      encounterName: session.encounterName,
      paused: session.paused,
      speed: session.speed,
      done: sim.done,
      result: sim.result,
      tick: sim.tickIndex,
      seconds: Math.round((sim.tickIndex / sim.stepHz) * 10) / 10,
      progress: sim.progress,
      raidersAlive: sim.countAlive(FACTION.RAIDER),
      defendersAlive: sim.countAlive(FACTION.DEFENDER),
      raidersSpawned: sim.stats.raidersSpawned,
      raidersTotal: sim.spawnQueue.length,
      damaged: sim.damagedStructureCount(),
      destroyed: sim.destroyedStructureCount(),
      wallsBreached: sim.stats.wallsBreached,
      garrison: { ...sim.garrison },
      verification: session.verification || null,
      commands: sim.appliedCommands.length,
    };
  }

  /* ---------------------------------------------------------------- settle */

  _settle(session) {
    session.settled = true;
    const sim = session.sim;
    const report = sim.report();
    this.lastReport = report;

    if (session.mode === BATTLE_MODE.REPLAY) {
      const expected = session.record?.report || null;
      const match = !!expected
        && expected.stateHash === report.stateHash
        && expected.eventHash === report.eventHash
        && expected.result === report.result;
      this.lastVerification = {
        ok: match,
        result: report.result,
        ticks: report.ticks,
        expectedHash: expected ? expected.stateHash : 0,
        actualHash: report.stateHash,
        mismatches: match ? [] : [{ kind: 'replay', expected: expected ? expected.stateHash : null, got: report.stateHash }],
        at: Date.now(),
      };
      this.bus.emit(EVENTS.BATTLE_REPLAY_VERIFIED, this.lastVerification);
      this.bus.emit(EVENTS.BATTLE_ENDED, { mode: BATTLE_MODE.REPLAY, report, rewards: null, verification: this.lastVerification });
      return;
    }

    // ------------------------------------------------ نوشتن نتیجه روی شهر
    const damage = [];
    for (const structure of sim.structures) {
      if (structure.hp >= structure.maxHp) continue;
      const entity = structure.sourceId != null ? this.state.getEntity(structure.sourceId) : null;
      if (!entity) continue;
      entity.hp = Math.max(0, Math.round(structure.hp));
      entity.maxHp = structure.maxHp;
      entity.damaged = entity.hp < entity.maxHp;
      damage.push({ entity, destroyed: structure.destroyed });
      this.bus.emit(EVENTS.STRUCTURE_DAMAGED, { entityId: entity.id, type: entity.type, hp: entity.hp, maxHp: entity.maxHp, destroyed: structure.destroyed });
    }

    // سپاه بازمانده = استقرارنیافته‌ها + بازماندگان میدان + زخمی‌هایی که
    // عقب کشیدند. تنها واحدهای «رانده‌شده از میدان» (hp صفر) از دست می‌روند.
    const retreatReturnsHome = this.battleData.end?.retreatReturnsHome !== false;
    const survivors = { ...sim.garrison };
    for (const unit of sim.units) {
      if (unit.faction !== FACTION.DEFENDER) continue;
      if (unit.defeated && retreatReturnsHome) continue;
      survivors[unit.type] = (survivors[unit.type] || 0) + 1;
    }
    this.barracks.setGarrison(survivors);
    this.state.army.deployed += report.defendersDeployed;

    // پاداش‌ها (همیشه داده می‌شود؛ بدون جریمه و بدون قفل)
    const rewardTable = this.battleData.rewards?.[report.result] || {};
    const rewards = {};
    for (const [resource, amount] of Object.entries(rewardTable)) {
      if (resource === 'note' || !(amount > 0)) continue;
      const granted = this.economy.grant(resource, amount, { source: 'battle' });
      rewards[resource] = granted.moved;
    }
    if (Object.keys(rewards).length) {
      this.bus.emit(EVENTS.BATTLE_REWARD, { result: report.result, rewards });
    }

    // ضبط نبرد برای بازپخش و سابقهٔ شهر
    const record = createRecord({
      scenario: session.scenario,
      sim,
      encounterId: session.encounterId,
      createdAt: Date.now(),
    });
    session.recorded = record;
    const keep = this.battleData.history?.keep ?? 3;
    this.state.battles.seq += 1;
    this.state.battles.lastSeed = record.seed;
    this.state.battles.lastResult = report.result;
    this.state.battles.history.push(record);
    while (this.state.battles.history.length > keep) this.state.battles.history.shift();
    if (report.result === BATTLE_RESULT.VICTORY) this.state.battles.wins += 1;
    else if (report.result === BATTLE_RESULT.DEFEAT) this.state.battles.losses += 1;

    this.bus.emit(EVENTS.BATTLE_ENDED, {
      mode: BATTLE_MODE.LIVE,
      report,
      rewards,
      damage: damage.map((item) => ({ entityId: item.entity.id, type: item.entity.type, destroyed: item.destroyed })),
      record: {
        seed: record.seed,
        ticks: record.ticks,
        commands: record.commands.length,
        scenarioHash: record.scenarioHash,
        stateHash: record.report.stateHash,
      },
    });
  }

  /** بازپخش یک ضبط مشخص بدون تغییر صحنهٔ نبرد (اعتبارسنجی سرورمانند). */
  verify(record) {
    const target = record || this.state.battles.history[this.state.battles.history.length - 1];
    if (!target) return { ok: false, mismatches: [{ kind: 'no-record' }] };
    const verification = replayRecord(target, {
      rules: this.battleData,
      units: this.unitsData,
      defenseDefs: this.defenseDefs,
      structureModifiers: this.structureModifiers,
    });
    return {
      ok: verification.ok,
      result: verification.result,
      ticks: verification.ticks,
      report: verification.report,
      mismatches: verification.mismatches,
    };
  }

  /** تاریخچهٔ خلاصه‌شده برای رابط کاربری. */
  history() {
    return this.state.battles.history.map((record) => ({
      encounterId: record.encounterId,
      encounterName: record.scenario?.encounter?.name || record.encounterId,
      result: record.result,
      seed: record.seed,
      ticks: record.ticks,
      commands: record.commands.length,
      createdAt: record.createdAt,
      stateHash: record.report?.stateHash ?? 0,
      checkpoints: (record.checkpoints || []).length,
    }));
  }

  /** سازهٔ آسیب‌دیده را تعمیر می‌کند (هزینه و زمان از defenses.json). */
  repair(entity, now = Date.now()) {
    if (!entity) return { ok: false, reason: 'missing' };
    const maxHp = entity.maxHp ?? this.structureStats.maxHpFor(entity);
    entity.maxHp = maxHp;
    if (entity.hp == null) entity.hp = maxHp;
    if (entity.hp >= maxHp) return { ok: false, reason: 'healthy' };
    const cost = this.structureStats.repairCost(entity);
    if (cost && !this.economy.canAfford(cost)) return { ok: false, reason: 'resources' };
    if (cost) this.economy.spend(cost);
    entity.hp = maxHp;
    entity.damaged = false;
    void now;
    this.bus.emit(EVENTS.STRUCTURE_REPAIRED, { entityId: entity.id, type: entity.type, cost: cost || null });
    return { ok: true, cost, seconds: this.structureStats.repairSeconds(entity) };
  }

  /** سازه‌های آسیب‌دیده (برای رابط کاربری و گزارش). */
  damagedStructures() {
    const out = [];
    for (const entity of this.state.entities.values()) {
      const maxHp = entity.maxHp ?? this.structureStats.maxHpFor(entity);
      if (!entity.damaged && (entity.hp == null || entity.hp >= maxHp)) continue;
      out.push({
        entityId: entity.id,
        type: entity.type,
        hp: entity.hp ?? maxHp,
        maxHp,
        cost: this.structureStats.repairCost({ ...entity, maxHp, hp: entity.hp ?? maxHp }),
      });
    }
    return out;
  }

  dispose() {
    this.session = null;
    this._progressTimer = 0;
  }
}

export { BATTLE_RESULT, BATTLE_EVENT };
