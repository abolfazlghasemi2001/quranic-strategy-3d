import { GameState } from './GameState.js';
import { EconomySystem } from './EconomySystem.js';
import { BuildQueue } from './BuildQueue.js';
import { EVENTS } from '../core/EventBus.js';
import { createStructureStats } from './battle/StructureStats.js';
import { MetaSystem } from './meta/MetaSystem.js';
import buildingData from '../data/buildings.json';
import defensesData from '../data/defenses.json';

/**
 * Game — fixed-timestep logic layer. Owns GameState and the pure game
 * systems (economy, build queue, offline catch-up). Rendering stays in
 * Engine/World, UI in HUD — the game only reads input intents and emits events.
 */
export class GameRuntime {
  /**
   * @param {object} options
   * @param {import('../core/Config.js').Config} options.config
   * @param {import('../core/EventBus.js').EventBus} options.bus
   * @param {object|null} [options.record] — migrated save payload from SaveSystem
   * @param {{dataset:object, validation:object, loadReport:object}|null} [options.quran]
   *        — phase 4: the normalised Quran dataset (loaded by main.js, never by the world/render layers)
   */
  constructor({ config, bus, record = null, quran = null, features = {} }) {
    this.config = config;
    this.bus = bus;
    this.record = record;
    this.quran = quran;

    this.logicHz = config.gameplay?.logicHz || 15;
    this.maxSteps = config.gameplay?.maxStepsPerFrame || 5;
    this.step = 1 / this.logicHz;
    this.accumulator = 0;
    this.state = new GameState(config);

    // --- phase 7: player progression, optional FTUE, daily mission and settings ---
    this.meta = new MetaSystem({
      state: this.state,
      bus,
      metaData: config.meta,
      ftueData: config.ftue,
      qualityTier: config.quality.tier,
    });

    // --- phase 3 systems (pure logic, JSON driven) ---
    this.economy = new EconomySystem({
      economy: config.economy,
      balance: config.balance,
      defs: buildingData.buildings,
      state: this.state,
    });
    this.queue = new BuildQueue({
      economyData: config.economy,
      economy: this.economy,
      state: this.state,
      onFinished: (job, at) => this._finishJob(job, at),
    });
    // --- phase 4: Quran learning layer (lessons, spaced repetition, rewards) ---
    this.learning = null;
    if (quran?.dataset && features.LearningSystem) this.enableLearning(features.LearningSystem, quran);

    // --- phase 5: army, defence and the deterministic battle simulator ---
    /** Single source of truth for structure health (defenses.json). */
    this.structureStats = createStructureStats({ defenses: defensesData, config });
    this.barracks = null; this.armyData = null;
    if (features.BarracksSystem) this.enableArmy(features.BarracksSystem, features.armyData);
    this.battle = null;
    if (features.BattleSystem) this.enableBattle(features.BattleSystem);

    // --- phase 6: کمپین داستانی (قصص) — مأموریت‌ها، ستاره‌ها و قواعد هر قصه ---
    /** فهرست نرمال‌شدهٔ مأموریت‌ها (فقط ارجاع آیه؛ هیچ متن قرآنی در دادهٔ مأموریت نیست). */
    this.missions = null; this.missionValidation = null; this.campaign = null;
    if (features.CampaignSystem) this.enableCampaign(features);

    // --- phase 8: social / multiplayer — offline-first, server-authoritative when linked ---
    this.social = null;
    if (features.SocialSystem) this.enableSocial(features.SocialSystem);

    /** Injected by main.js once the save helpers exist (debounced autosave). */
    this._persistFn = null;

    /** Summary of offline progress, consumed by the HUD toast after boot. */
    this.offlineReport = null;

    this._economyDirty = false;
    this._queueDirty = false;
    this._lastEmit = 0;

    this._on = [
      [EVENTS.GAME_PAUSED, ({ paused }) => this.state.setPaused(paused)],
      [EVENTS.WORLD_TAP, (intent) => this.handleTap(intent)],
    ];
    for (const [ev, fn] of this._on) bus.on(ev, fn);
  }

  enableArmy(BarracksSystem, data) {
    if (this.barracks) return this.barracks;
    const { config, bus } = this; const { unitsData, battleData } = data;
    this.armyData = data;
    this.barracks = new BarracksSystem({
      config,
      state: this.state,
      economy: this.economy,
      unitsData,
      battleData,
      bus,
    });
    if (this.bootstrapped) this.barracks.emitChanged();
    return this.barracks;
  }

  enableSocial(SocialSystem) {
    if (this.social) return this.social;
    const { config, bus } = this;
    this.social = new SocialSystem({
      config,
      bus,
      state: this.state,
      economy: this.economy,
      queue: this.queue,
      game: this,
      url: config.socialUrl || null,
    });
    return this.social;
  }

  enableBattle(BattleSystem) {
    if (this.battle) return this.battle;
    const { config, bus } = this; const { unitsData, battleData } = this.armyData;
    this.battle = new BattleSystem({
      config,
      state: this.state,
      economy: this.economy,
      barracks: this.barracks,
      battleData,
      unitsData,
      defensesData,
      structureStats: this.structureStats,
      bus,
      // مأموریت فعال اجازهٔ شروع نبرد نمی‌دهد (کمپین هیچ نبردی نمی‌خواهد).
      externalBlocker: () => (this.campaign && this.campaign.activeRun ? 'mission-active' : null),
    });
    return this.battle;
  }

  enableCampaign({ CampaignSystem, normalizeMissions, validateMissions }) {
    if (this.campaign) return this.campaign;
    const { config, bus, quran } = this;
    this.missions = normalizeMissions(config.missions);
    this.missionValidation = validateMissions(this.missions);
    this.campaign = new CampaignSystem({
      config,
      campaignData: config.campaign,
      missions: this.missions,
      state: this.state,
      economy: this.economy,
      queue: this.queue,
      bus,
      game: this,
      dataset: quran?.dataset || null,
      applySpeedup: (seconds, at) => (this.learning ? this.learning.applySpeedup(seconds, at) : null),
      isBattleActive: () => !!this.battle?.active,
    });
    if (this.bootstrapped) this.campaign.onBoot(Date.now());
    return this.campaign;
  }

  enableLearning(LearningSystem, quran) {
    if (this.learning) return this.learning;
    this.quran = quran;
    this.learning = new LearningSystem({ dataset: quran.dataset, learning: this.config.quranLearning, state: this.state, economy: this.economy, queue: this.queue, bus: this.bus, game: this, seed: this.config.seed });
    if (this.campaign) this.campaign.dataset = quran.dataset;
    return this.learning;
  }

  /* --------------------------------------------------------------- taps */

  /**
   * Consume a plain world-tap intent from WorldInputAdapter. Pixels and Three.js
   * objects never enter the gameplay layer; this only updates game state/events.
   */
  handleTap(intent = {}) {
    const x = Number(intent.x);
    const z = Number(intent.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const inside = Boolean(intent.inside);
    const cell = intent.cell || null;
    const now = Number(intent.at) || Date.now();
    const source = intent.pointerType || 'unknown';
    this.state.lastTap = { x, z, cell, inside, time: this.state.elapsed };
    this.state.tapCount += 1;

    // During a live battle, a map tap is a deploy intent rather than selection.
    const battlefield = inside && this.battle && this.battle.active && this.battle.mode === 'live';
    if (inside && battlefield) {
      this._haptic();
      this.bus.emit(EVENTS.BATTLE_TAP, {
        x,
        z,
        col: cell ? cell.col : null,
        row: cell ? cell.row : null,
        at: now,
        source,
      });
      return this.state.lastTap;
    }

    if (inside) {
      this._haptic();
      this.bus.emit(EVENTS.TILE_TAP, {
        x,
        z,
        col: cell ? cell.col : null,
        row: cell ? cell.row : null,
        at: now,
        tile: cell,
        source,
      });
    }
    return this.state.lastTap;
  }

  _haptic() {
    if (this.config.gameplay.haptics.enabled) this.bus.emit(EVENTS.HAPTIC_REQUESTED, { milliseconds: this.config.gameplay.haptics.tapMs });
  }

  /* ------------------------------------------------------------ lifecycle */

  /**
   * Boot hook: hydrate from the save payload (if any), run offline catch-up,
   * seed a fresh town when there is nothing to restore.
   *
   * @returns {{fresh:boolean, secondsAway:number, jobsDone:number}}
   */
  bootstrap() {
    const now = Date.now();
    const payload = this.record;
    let fresh = true;

    if (payload && Array.isArray(payload.entities) && payload.entities.length > 0) {
      this.state.hydrate(payload);
      fresh = false;
    }

    let secondsAway = 0;
    let jobsDone = 0;

    if (fresh) {
      this._seedTown(now);
    } else {
      // Offline progress: pure wall-clock timestamp math (acceptance ⑤).
      // savedAt is injected by SaveSystem on every save → exactly "time since
      // the player last closed"; lastAccrualAt (set once at boot) is fallback.
      const stamp = payload.savedAt || payload.lastAccrualAt || now;
      secondsAway = now >= stamp ? Math.floor((now - stamp) / 1000) : 0;
      const before = { ...this.state.resources };

      this.economy.catchUp(now); // accrue production from timestamps
      const finished = this.queue.tick(now); // fast-forward the builders
      jobsDone = finished.length;

      const gained = {};
      for (const key of Object.keys(this.state.resources)) {
        const delta = Math.round(this.state.resources[key] - before[key]);
        if (delta > 0) gained[key] = delta;
      }
      const pending = {};
      for (const entity of this.state.entities.values()) {
        if (entity.status === 'ready' && entity.pending > 0) {
          const res = this.economy.def(entity.type)?.produces;
          if (res) pending[res] = (pending[res] || 0) + entity.pending;
        }
      }
      this.offlineReport = { secondsAway, jobsDone, gained, pending };
    }

    this.meta.onBoot(now);
    this.syncStructureHealth();
    this.barracks?.emitChanged();
    this.markEconomyDirty();
    this.markQueueDirty();
    this.emitState(now, true);
    this.emitQueue();
    // Phase 4: surface dataset + spaced-repetition status right after boot.
    if (this.learning) {
      this.learning.leitner.store = this.state.learning.reviews;
      this.bus.emit(EVENTS.QURAN_DATASET_READY, {
        dataset: this.quran.dataset.stats,
        validation: this.quran.validation,
        loadReport: this.quran.loadReport,
        learning: this.learning.stats(now),
      });
      this.learning.tick(now);
    }
    // Phase 6: مأموریت نیمه‌کاره در بوت «موقتاً متوقف» می‌شود تا در غیبت بازیکن
    // قحطی/سیل پیش نرود؛ ادامه با دکمهٔ همان پنل است.
    if (this.campaign) {
      this.campaign.onBoot(now);
      if (!this.missionValidation.ok) {
        console.warn('[شهر نور] خطاهای اعتبارسنجی مأموریت‌ها:', this.missionValidation.issues.filter((issue) => issue.level === 'error'));
      }
    }
    this.bootstrapped = true;
    return { fresh, secondsAway, jobsDone };
  }

  /** Place the initial town center (fresh game only). */
  _seedTown(now) {
    const def = buildingData.buildings.find((b) => b.id === 'town-center');
    if (!def) return;
    const col = Math.floor(this.config.cols / 2) - 1;
    const row = Math.floor(this.config.rows / 2) - 1;
    this.state.createEntity({
      type: def.id,
      name: def.name,
      col,
      row,
      size: def.size,
      level: 1,
      status: 'ready',
      pending: 0,
      lastAccrualAt: now,
    });
  }

  /* ---------------------------------------------------------------- tick */

  update(realDt, engine = null) {
    if (this.state.paused) return;
    this.meta.update(realDt);
    // شبیه‌ساز نبرد با زمان واقعی گام می‌خورد، ولی منطقش فقط با گام‌های ثابت
    // جلو می‌رود؛ بنابراین نتیجهٔ نبرد به نرخ فریم وابسته نیست.
    this.battle?.update(engine?.frameDelta ?? realDt);
    this.accumulator += realDt;
    let steps = 0;
    const now = Date.now();
    while (this.accumulator >= this.step && steps < this.maxSteps) {
      this.fixedUpdate(this.step, now);
      this.accumulator -= this.step;
      steps += 1;
    }
    if (steps === this.maxSteps) this.accumulator = 0;

    // Throttled state broadcast (~4 Hz) so HUD timers/resources stay live.
    if (now - this._lastEmit > 250) {
      this._lastEmit = now;
      if (this._economyDirty) {
        this._economyDirty = false;
        this.emitState(now, false);
      }
      if (this._queueDirty) {
        this._queueDirty = false;
        this.emitQueue();
      }
    }
  }

  fixedUpdate(dt, now) {
    this.state.update(dt);

    // Wall-clock production; timestamp math keeps offline/idle correct.
    const accrued = this.economy.accrue(now);
    if (accrued > 0) this.markEconomyDirty();

    // No daily-login payout: returning after a break never changes progression.

    // مأموریت فعال (فاز ۶): فصل‌ها، موج‌ها و آبادانی — پیش از مصرف عمومی.
    if (this.campaign) this.campaign.tick(dt, now);
    const consumed = this.economy.applyConsumption(dt);
    if (consumed > 0) this.markEconomyDirty();

    // Phase 8: while online, server-tracked timers complete only through
    // server validation (their clock rules); the local tick skips them and
    // still fast-forwards every local-only job (mission timers, etc.).
    const online = this.social?.isOnline() || false;
    this.queue.online = online;
    if (online) this.social.tickJobs(now);

    const finished = this.queue.tick(now);
    if (finished.length) this.markQueueDirty();

    // آموزش سپاه (تایم‌استمپ‌محور، مثل بنّاها).
    const trained = this.barracks?.tick(now);
    if (trained?.length) {
      this.barracks?.emitChanged();
      const last = trained[trained.length - 1];
      const name = this.armyData.unitsData.units.find((unit) => unit.id === last.unit)?.name || last.unit;
      this.bus.emit(EVENTS.UI_TOAST, `${name} آموزش دید.`);
      this.markEconomyDirty();
      this.persist();
    }

    // Spaced-repetition due counters (~1 Hz is plenty; the map is tiny).
    if (this.learning && now - (this._lastLearningTick || 0) > 1000) {
      this._lastLearningTick = now;
      this.learning.tick(now);
    }
  }

  /* --------------------------------------------------------------- events */

  markEconomyDirty() {
    this._economyDirty = true;
  }

  markQueueDirty() {
    this._queueDirty = true;
  }

  /** Broadcast resources + capacity + city level + builders. */
  emitState(now, force) {
    void force;
    const producers = [];
    for (const entity of this.state.entities.values()) {
      if (!this.economy.def(entity.type)?.produces) continue;
      producers.push({
        entityId: entity.id,
        pending: Math.max(0, Number(entity.pending) || 0),
        ready: this.economy.isReady(entity),
        status: entity.status,
      });
    }
    this.bus.emit(EVENTS.ECONOMY_CHANGED, {
      resources: { ...this.state.resources },
      capacity: this.economy.capacity(),
      cityLevel: this.state.cityLevel(),
      builders: { free: this.queue.freeBuilders(), total: this.queue.builderCount },
      jobs: this.queue.jobs.map((j) => ({ id: j.id, status: j.status })),
      producers,
      at: now || Date.now(),
    });
  }

  emitQueue() {
    this.bus.emit(EVENTS.BUILD_QUEUE_CHANGED, {
      jobs: this.queue.jobs.map((j) => ({
        id: j.id,
        kind: j.kind,
        entityId: j.entityId,
        type: j.type,
        targetLevel: j.targetLevel,
        missionId: j.missionId ?? null,
        actionId: j.actionId ?? null,
        label: j.label ?? null,
        icon: j.icon ?? null,
        status: j.status,
        startedAt: j.startedAt,
        endsAt: j.endsAt,
        durationMs: j.durationMs,
      })),
      free: this.queue.freeBuilders(),
      total: this.queue.builderCount,
    });
  }

  /** Called by BuildQueue whenever a job completes. */
  _finishJob(job, at) {
    // کار بنّای مأموریت (ساخت بخش سد، جوی، باغ) پایان یافت.
    if (job.kind === 'mission') {
      this.campaign?.onJobFinished(job, at);
      this.markQueueDirty();
      this.bus.emit(EVENTS.JOB_FINISHED, { job, entity: null });
      this.emitQueue();
      return;
    }
    const entity = this.state.getEntity(job.entityId);
    if (entity) {
      entity.level = job.targetLevel;
      entity.status = 'ready';
      entity.lastAccrualAt = at;
      if (job.kind === 'upgrade' && job.type === 'town-center') {
        const reward = this.economy.townCenterReward();
        if (reward > 0) {
          this.economy.earnGohar(reward, { source: 'town' });
          this.bus.emit(EVENTS.UI_TOAST, {
            message: `ارتقای مرکز شهر +${reward} گوهر`,
            type: 'success',
          });
        }
      }
    }
    this.markEconomyDirty();
    this.markQueueDirty();
    this.bus.emit(EVENTS.JOB_FINISHED, { job, entity });
    this.emitState(at, false);
    this.emitQueue();
  }

  /* ------------------------------------------------ dev simulation helpers */

  /**
   * Dev tool: pretend `ms` of wall-clock time passed while away —
   * accrues production (auto-harvest), fast-forwards builders, then pulls
   * timestamps back so the real clock stays the source of truth.
   * @returns {{gained: Record<string, number>, jobsDone: number}}
   */
  simulateOffline(ms) {
    const realNow = Date.now();
    const fake = realNow + Math.max(0, ms);
    const before = { ...this.state.resources };

    this.economy.accrue(fake);
    for (const entity of this.state.entities.values()) {
      this.economy.harvest(entity, fake, { silent: true });
      if (entity.lastAccrualAt != null && entity.lastAccrualAt > realNow) entity.lastAccrualAt = realNow;
    }

    const finished = this.queue.tick(fake);
    // Pull every still-active job back to the real clock: one hour of work
    // "happened", so both ends move back by ms (duration stays intact).
    for (const job of this.queue.jobs) {
      if (job.status !== 'active') continue;
      if (job.startedAt != null) job.startedAt -= Math.max(0, ms);
      if (job.endsAt != null) job.endsAt -= Math.max(0, ms);
    }
    const gained = {};
    for (const key of Object.keys(this.state.resources)) {
      const delta = Math.round(this.state.resources[key] - before[key]);
      if (delta > 0) gained[key] = delta;
    }
    this.markEconomyDirty();
    this.markQueueDirty();
    this.emitState(realNow, true);
    this.emitQueue();
    return { gained, jobsDone: finished.length };
  }

  /* ------------------------------------------------------------ serialize */

  /** main.js injects the debounced save function (learning layer asks for saves). */
  attachPersist(fn) {
    this._persistFn = typeof fn === 'function' ? fn : null;
    this.meta.persist = this._persistFn;
  }

  /** Debounced save request — used by systems that live in the logic layer. */
  persist() {
    if (this._persistFn) this._persistFn();
  }

  serialize() {
    return this.state.serialize();
  }

  /** Convenience snapshot for HUD/panels (dataset + progress + speedup pool). */
  quranStatus(now = Date.now()) {
    if (!this.learning) return null;
    return {
      dataset: this.quran?.dataset?.stats || null,
      validation: this.quran?.validation || null,
      loadReport: this.quran?.loadReport || null,
      progress: this.learning.stats(now),
    };
  }

  /**
   * همهٔ سازه‌ها باید جان داشته باشند. برای ذخیره‌های قدیمی (فاز ۳ و ۴) جان را
   * از defenses.json می‌سازیم؛ ساختمان‌های تازه هم هنگام ساخت مقدار می‌گیرند.
   */
  syncStructureHealth() {
    for (const entity of this.state.entities.values()) {
      const maxHp = this.structureStats.maxHpFor(entity);
      if (entity.maxHp !== maxHp) entity.maxHp = maxHp;
      if (entity.hp == null || entity.hp > maxHp) entity.hp = maxHp;
      if (entity.hp < 0) entity.hp = 0;
      entity.damaged = entity.hp < maxHp;
    }
    return this.state.entities.size;
  }

  /** تعمیر سازهٔ آسیب‌دیده (هزینه از defenses.json، انجام فوری). */
  repairEntity(entity) {
    const result = this.battle.repair(entity);
    if (result.ok) {
      this.bus.emit(EVENTS.UI_TOAST, `${this.config.t('defense.repaired', 'سازه تعمیر شد.')}`);
      this.markEconomyDirty();
      this.persist();
    }
    return result;
  }

  /** استقرار یک واحد از سپاه روی نقشه (پل رابط کاربری → شبیه‌ساز). */
  deployUnit(unitType, x, z) {
    return this.battle.deploy(unitType, x, z);
  }

  dispose() {
    this.social?.dispose();
    this.meta?.dispose();
    this.campaign?.dispose();
    this.battle?.dispose();
    for (const [ev, fn] of this._on) this.bus.off(ev, fn);
    this._on.length = 0;
  }
}
