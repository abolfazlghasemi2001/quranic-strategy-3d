import { GameState } from './GameState.js';
import { EconomySystem } from './EconomySystem.js';
import { BuildQueue } from './BuildQueue.js';
import { EVENTS } from '../core/EventBus.js';
import buildingData from '../data/buildings.json';

/**
 * Game — fixed-timestep logic layer. Owns GameState and the pure game
 * systems (economy, build queue, offline catch-up). Rendering stays in
 * Engine/World, UI in HUD — the game only reads input intents and emits events.
 */
export class Game {
  /**
   * @param {object} options
   * @param {import('../core/Config.js').Config} options.config
   * @param {import('../world/World.js').World} options.world
   * @param {import('../core/OrbitCameraRig.js').OrbitCameraRig} options.rig
   * @param {import('../core/InputManager.js').InputManager} options.input
   * @param {import('../core/EventBus.js').EventBus} options.bus
   * @param {object|null} [options.record] — migrated save payload from SaveSystem
   */
  constructor({ config, world, rig, input, bus, record = null }) {
    this.config = config;
    this.world = world;
    this.rig = rig;
    this.input = input;
    this.bus = bus;
    this.record = record;

    this.logicHz = config.gameplay?.logicHz || 15;
    this.maxSteps = config.gameplay?.maxStepsPerFrame || 5;
    this.step = 1 / this.logicHz;
    this.accumulator = 0;
    this.state = new GameState(config);

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
    /** Summary of offline progress, consumed by the HUD toast after boot. */
    this.offlineReport = null;

    this._economyDirty = false;
    this._queueDirty = false;
    this._lastEmit = 0;

    // Screen tap -> tile:tap (keeps phase-1/2 contract: pixels never reach systems).
    this.onTap = (payload) => this.handleTap(payload);
    this.input.onTap = this.onTap;

    this._on = [
      [EVENTS.GAME_PAUSED, ({ paused }) => this.state.setPaused(paused)],
    ];
    for (const [ev, fn] of this._on) bus.on(ev, fn);
  }

  /* --------------------------------------------------------------- taps */

  /**
   * Screen tap -> world point -> tile. Emits `tile:tap` with both the world
   * position and the tile coordinates (selection / harvest / markers listen).
   */
  handleTap(payload) {
    const viewport = payload && payload.viewport
      ? payload.viewport
      : { width: window.innerWidth, height: window.innerHeight };
    const point = this.rig.screenToGround(payload.clientX ?? payload.x, payload.clientY ?? payload.y, viewport);
    if (!point) return null;

    const inside = this.world.isInsideMap(point.x, point.z);
    const cell = this.world.getCellAt(point.x, point.z);
    const now = Date.now();
    this.state.lastTap = { x: point.x, z: point.z, cell, inside, time: this.state.elapsed };
    this.state.tapCount += 1;

    if (inside) {
      this._haptic();
      this.bus.emit(EVENTS.TILE_TAP, {
        x: point.x,
        z: point.z,
        col: cell ? cell.col : null,
        row: cell ? cell.row : null,
        at: now,
        tile: cell,
        source: payload.pointerType || 'unknown',
      });
    }
    return this.state.lastTap;
  }

  _haptic() {
    if (!this.config.gameplay.haptics.enabled) return;
    if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
    try {
      navigator.vibrate(this.config.gameplay.haptics.tapMs || 8);
    } catch {
      /* vibration is optional */
    }
  }

  /* ------------------------------------------------------------ lifecycle */

  /**
   * Boot hook: hydrate from the save payload (if any), run offline catch-up,
   * seed a fresh town when there is nothing to restore.
   *
   * @returns {{fresh:boolean, secondsAway:number, jobsDone:number, goharDaily:number}}
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
    let goharDaily = 0;

    if (fresh) {
      this._seedTown(now);
      this.economy.grantDailyBonus(now);
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
      goharDaily = this.economy.grantDailyBonus(now);

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
      this.offlineReport = { secondsAway, jobsDone, goharDaily, gained, pending };
    }

    this.markEconomyDirty();
    this.markQueueDirty();
    this.emitState(now, true);
    this.emitQueue();
    return { fresh, secondsAway, jobsDone, goharDaily };
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

  update(realDt) {
    if (this.state.paused) return;
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

    const daily = this.economy.grantDailyBonus(now);
    if (daily > 0) {
      this.markEconomyDirty();
      this.bus.emit(EVENTS.UI_TOAST, { message: `پاداش روزانه: +${daily} گوهر`, type: 'info' });
    }

    const finished = this.queue.tick(now);
    if (finished.length) this.markQueueDirty();
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
    this.bus.emit(EVENTS.ECONOMY_CHANGED, {
      resources: { ...this.state.resources },
      capacity: this.economy.capacity(),
      cityLevel: this.state.cityLevel(),
      builders: { free: this.queue.freeBuilders(), total: this.queue.builderCount },
      jobs: this.queue.jobs.map((j) => ({ id: j.id, status: j.status })),
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
    const entity = this.state.getEntity(job.entityId);
    if (entity) {
      entity.level = job.targetLevel;
      entity.status = 'ready';
      entity.lastAccrualAt = at;
      if (job.kind === 'upgrade' && job.type === 'town-center') {
        const reward = this.economy.townCenterReward();
        if (reward > 0) {
          this.economy.earnGohar(reward);
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
    this.state.lastDailyAt = realNow; // the simulation must not grant/steal the daily bonus

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

  serialize() {
    return this.state.serialize();
  }

  dispose() {
    for (const [ev, fn] of this._on) this.bus.off(ev, fn);
    this._on.length = 0;
    if (this.input) this.input.onTap = null;
  }
}
