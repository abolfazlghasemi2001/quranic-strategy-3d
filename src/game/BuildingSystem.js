import buildingData from '../data/buildings.json';
import { EVENTS } from '../core/EventBus.js';
import { formatFa } from '../core/Format.js';

/**
 * BuildingSystem — deterministic, render-independent placement and economy rules.
 * World-space previews/meshes are owned by src/world/BuildingView.js and are
 * synchronized only through the event bus.
 */
export class BuildingSystem {
  /** @param {object} options */
  constructor({ config, bus, state, economy, queue, game, persist }) {
    Object.assign(this, { config, bus, state, economy, queue, game });
    if (game) game.buildings = this; // SocialSystem rolls optimistic actions back through this facade.
    this._onlinePending = new Map();
    this.persist = persist || null;
    this.definitions = buildingData.buildings;
    this.byId = new Map(this.definitions.map((definition) => [definition.id, definition]));
    this.occupancy = new Map(); // "col:row" -> entity id (pure gameplay index)
    this.placing = null; // { def, col, row, valid } — no render objects
    this.selected = null;
    this._unsubscribers = [
      bus.on(EVENTS.TILE_TAP, (payload) => this.onTileTap(payload)),
      bus.on(EVENTS.JOB_FINISHED, (payload) => this.onJobFinished(payload)),
      bus.on(EVENTS.PLACEMENT_POINTER, (payload) => this.onPlacementPointer(payload)),
    ];
    this._syncFromState();
  }

  _syncFromState() {
    if (this.state.entities.size === 0) {
      const def = this.byId.get('town-center');
      const col = Math.floor(this.config.cols / 2) - 1;
      if (def && this.canPlace(def, col, col)) {
        this.state.createEntity({ type: def.id, name: def.name, col, row: col, size: def.size, level: 1, status: 'ready', lastAccrualAt: Date.now() });
      }
    }
    for (const entity of this.state.entities.values()) {
      this._ensureHealth(entity);
      this._occupy(entity);
    }
  }

  _occupy(entity) {
    for (let row = entity.row; row < entity.row + entity.size[1]; row += 1) {
      for (let col = entity.col; col < entity.col + entity.size[0]; col += 1) this.occupancy.set(`${col}:${row}`, entity.id);
    }
  }

  _free(entity) {
    for (let row = entity.row; row < entity.row + entity.size[1]; row += 1) {
      for (let col = entity.col; col < entity.col + entity.size[0]; col += 1) this.occupancy.delete(`${col}:${row}`);
    }
  }

  /** Building hit points are gameplay state; visual roots are not stored here. */
  _ensureHealth(entity) {
    const stats = this.game?.structureStats;
    if (!stats) return null;
    const maxHp = stats.maxHpFor(entity);
    const previous = entity.maxHp;
    entity.maxHp = maxHp;
    if (entity.hp == null) entity.hp = maxHp;
    if (previous != null && maxHp > previous && entity.hp > previous) entity.hp = maxHp;
    if (entity.hp > maxHp) entity.hp = maxHp;
    entity.damaged = entity.hp < maxHp;
    return maxHp;
  }

  onTileTap({ col, row }) {
    if (col == null || row == null) return;
    const id = this.occupancy.get(`${col}:${row}`);
    const entity = id != null ? this.state.entities.get(id) : null;
    if (!entity) {
      this.clearSelection();
      return;
    }
    const def = this.byId.get(entity.type);
    // Phase 4: دارالقرآن is the lesson gateway — tapping it opens دارالقرآن
    // (the lesson UI) instead of auto-harvesting; harvesting stays available
    // from the selection menu below.
    if (def?.lesson) {
      this.select(entity);
      this.bus.emit(EVENTS.QURAN_LESSON_REQUESTED, {
        entityId: entity.id,
        type: entity.type,
        name: def.name,
        at: Date.now(),
      });
      return;
    }
    // Tap a ready producer => harvest AND keep it selected.
    if (def?.produces && entity.status === 'ready' && entity.pending >= this.economy.readyThreshold(entity)) {
      this.harvest(entity);
    }
    this.select(entity);
  }

  harvest(entity) {
    const result = this.economy.harvest(entity, Date.now());
    const meta = this.economy.data.resources[result.resource] || null;
    if (result.moved > 0) {
      this.bus.emit(EVENTS.RESOURCE_HARVESTED, {
        entityId: entity.id,
        type: entity.type,
        resource: result.resource,
        moved: result.moved,
        at: Date.now(),
        source: 'player',
      });
      this.bus.emit(EVENTS.UI_TOAST, `+${formatFa(Math.round(result.moved))} ${meta ? meta.name : ''}`.trim());
      this._afterEconomyChange();
      return true;
    }
    if (result.full) {
      this.bus.emit(EVENTS.UI_TOAST, this.config.t('economy.storageFull', 'انبار پر است'));
    }
    return false;
  }

  harvestSelected() {
    if (!this.selected) return false;
    const def = this.byId.get(this.selected.type);
    if (!def?.produces) return false;
    return this.harvest(this.selected);
  }

  /* ------------------------------------------------------------- placement */

  startPlacement(id) {
    const def = this.byId.get(id);
    const cost = def ? this.economy.costOf(def.id, 1) : null;
    if (!def || !cost || !this.economy.canAfford(cost)) {
      this.bus.emit(EVENTS.UI_TOAST, this.config.t('economy.notEnough', 'منابع کافی نیست.'));
      return false;
    }
    if (this.queue.jobs.length >= this.queue.maxJobs) {
      this.bus.emit(EVENTS.UI_TOAST, this.config.t('economy.queueFull', 'صف ساخت پر است'));
      return false;
    }
    this.cancelPlacement();
    this.clearSelection();
    const focus = this.config.startFocus || this.config.mapCenter || {
      x: this.config.worldWidth / 2,
      z: this.config.worldDepth / 2,
    };
    const tile = this.config.worldToTile?.(focus.x, focus.z) || {
      col: this.config.cols / 2,
      row: this.config.rows / 2,
    };
    this.placing = { def, col: 0, row: 0, valid: false };
    this._movePreview(tile.col, tile.row);
    return true;
  }

  /** A world-owned pointer adapter sends tile coordinates; gameplay never raycasts. */
  onPlacementPointer({ col, row } = {}) {
    if (!this.placing || !Number.isFinite(Number(col)) || !Number.isFinite(Number(row))) return;
    this._movePreview(Number(col), Number(row));
  }

  _movePreview(col, row) {
    const placement = this.placing;
    if (!placement) return;
    const maxCol = this.config.cols - placement.def.size[0];
    const maxRow = this.config.rows - placement.def.size[1];
    placement.col = Math.max(0, Math.min(maxCol, Math.floor(col)));
    placement.row = Math.max(0, Math.min(maxRow, Math.floor(row)));
    placement.valid = this.canPlace(placement.def, placement.col, placement.row);
    this.bus.emit(EVENTS.PLACEMENT_CHANGED, {
      active: true,
      def: placement.def,
      valid: placement.valid,
      col: placement.col,
      row: placement.row,
    });
  }

  confirmPlacement() {
    const placement = this.placing;
    if (!placement || !placement.valid) {
      this.bus.emit(EVENTS.UI_TOAST, this.config.t('economy.notPlace', 'این محل قابل ساخت نیست.'));
      return false;
    }
    const { def, col, row } = placement;
    if (this.queue.jobs.length >= this.queue.maxJobs) {
      this.bus.emit(EVENTS.UI_TOAST, this.config.t('economy.queueFull', 'صف ساخت پر است'));
      return false;
    }
    const cost = this.economy.costOf(def.id, 1);
    if (!this.economy.canAfford(cost)) {
      this.bus.emit(EVENTS.UI_TOAST, this.config.t('economy.notEnough', 'منابع کافی نیست.'));
      return false;
    }
    if (this.isOnline()) return this._confirmPlacementOnline(placement, def, col, row, cost);
    this.economy.spend(cost);

    const entity = this.state.createEntity({
      type: def.id,
      name: def.name,
      col,
      row,
      size: [...def.size],
      level: 1,
      status: 'building',
      pending: 0,
      lastAccrualAt: null,
    });
    this._ensureHealth(entity);
    this._occupy(entity);
    const durationMs = this.economy.secondsOf(def.id, 1) * 1000;
    const result = this.queue.enqueue(
      { kind: 'build', entityId: entity.id, type: def.id, targetLevel: 1, durationMs },
      Date.now(),
    );
    if (!result.ok) {
      for (const [key, value] of Object.entries(cost || {})) this.economy.resources[key] += value;
      this._removeEntity(entity);
      this.bus.emit(EVENTS.UI_TOAST, this.config.t('economy.queueFull', 'صف ساخت پر است'));
      this._afterEconomyChange();
      return false;
    }

    this.bus.emit(EVENTS.BUILDING_ADDED, { entity });
    this.bus.emit(EVENTS.BUILDING_QUEUED, { job: result.job, entity });
    this.bus.emit(EVENTS.UI_TOAST, `${def.name} در صف ساخت قرار گرفت.`);
    this.select(entity);

    if (def.id === 'wall' && this.economy.canAfford(cost) && this.queue.jobs.length < this.queue.maxJobs) {
      this.cancelPlacement();
      this.startPlacement('wall');
      this._movePreview(Math.min(col + 1, this.config.cols - 1), row);
    } else {
      this.cancelPlacement();
    }
    this._afterEconomyChange();
    return true;
  }

  cancelPlacement() {
    this.placing = null;
    this.bus.emit(EVENTS.PLACEMENT_CHANGED, { active: false });
  }

  canPlace(def, col, row) {
    if (col < 0 || row < 0 || col + def.size[0] > this.config.cols || row + def.size[1] > this.config.rows) return false;
    for (let r = row; r < row + def.size[1]; r += 1) {
      for (let c = col; c < col + def.size[0]; c += 1) if (this.occupancy.has(`${c}:${r}`)) return false;
    }
    return true;
  }

  _removeEntity(entity) {
    if (!entity) return;
    this._free(entity);
    this.state.entities.delete(entity.id);
    this.bus.emit(EVENTS.BUILDING_REMOVED, { entityId: entity.id });
  }

  /* ------------------------------------------------------------ selection */

  select(entity) {
    this.selected = entity;
    this.bus.emit(EVENTS.BUILDING_SELECTED, entity ? { entity, def: this.byId.get(entity.type) } : null);
  }

  clearSelection() {
    if (this.selected) {
      this.selected = null;
      this.bus.emit(EVENTS.BUILDING_SELECTED, null);
    }
  }

  /* -------------------------------------------------------------- upgrade */

  upgradeSelected() {
    const entity = this.selected;
    if (!entity) return false;
    if (entity.status !== 'ready') {
      this.bus.emit(EVENTS.UI_TOAST, this.config.t('economy.building', 'در حال ساخت…'));
      return false;
    }
    if (this.queue.isEntityBusy(entity.id)) {
      this.bus.emit(EVENTS.UI_TOAST, this.config.t('economy.entityBusy', 'این ساختمان در صف ساخت است.'));
      return false;
    }
    const nextLevel = entity.level + 1;
    if (nextLevel > this.economy.maxLevel) {
      this.bus.emit(EVENTS.UI_TOAST, this.config.t('economy.maxLevel', 'حداکثر سطح'));
      return false;
    }
    if (this.queue.jobs.length >= this.queue.maxJobs) {
      this.bus.emit(EVENTS.UI_TOAST, this.config.t('economy.queueFull', 'صف ساخت پر است'));
      return false;
    }
    const cost = this.economy.costOf(entity.type, nextLevel);
    if (!this.economy.canAfford(cost)) {
      this.bus.emit(EVENTS.UI_TOAST, this.config.t('economy.notEnough', 'منابع کافی نیست.'));
      return false;
    }
    // Phase 8: online upgrades are validated by the server (atomic intent).
    if (this.isOnline()) return this._upgradeSelectedOnline(entity, nextLevel, cost);
    this.economy.spend(cost);
    const durationMs = this.economy.secondsOf(entity.type, nextLevel) * 1000;
    const result = this.queue.enqueue(
      { kind: 'upgrade', entityId: entity.id, type: entity.type, targetLevel: nextLevel, durationMs },
      Date.now(),
    );
    if (!result.ok) {
      for (const [key, value] of Object.entries(cost || {})) this.economy.resources[key] += value;
      this.bus.emit(EVENTS.UI_TOAST, this.config.t('economy.queueFull', 'صف ساخت پر است'));
      this._afterEconomyChange();
      return false;
    }
    this.bus.emit(EVENTS.UI_TOAST, `${entity.name || this.byId.get(entity.type)?.name} — ارتقا به سطح ${formatFa(nextLevel)} در صف قرار گرفت.`);
    this.select(entity);
    this._afterEconomyChange();
    return true;
  }

  /** Speed up an active job with gohar (the only in-game currency spend path). */
  speedup(jobId) {
    if (this.isOnline()) {
      const job = this.queue.jobs.find((j) => j.id === jobId);
      if (job?.hold || (job && this._onlinePending.has(job.id))) {
        this.bus.emit(EVENTS.UI_TOAST, this.config.t('social.pending', 'در انتظار تأیید سرور…'));
        return false;
      }
      if (job && typeof job.id === 'string' && job.id.startsWith('srv-')) {
        return this._speedupOnline(job);
      }
      // Local-only jobs (mission timers) keep the local path even when online.
    }
    const result = this.queue.speedup(jobId, Date.now());
    if (result.ok) {
      this.bus.emit(EVENTS.UI_TOAST, `${this.config.t('economy.speedup', 'سرعت‌بخشی')}: −${formatFa(result.cost)} 💎`);
      this._afterEconomyChange();
      if (this.selected) this.select(this.selected); // refresh menu timers
      return true;
    }
    if (result.reason === 'gohar') this.bus.emit(EVENTS.UI_TOAST, this.config.t('economy.goharShort', 'گوهر کافی نیست.'));
    else if (result.reason === 'not-active') this.bus.emit(EVENTS.UI_TOAST, this.config.t('economy.queued', 'در انتظار بنّا'));
    return false;
  }

  /* --------------------------------------------- online (server-validated) */

  isOnline() {
    return !!this.game?.social?.isOnline();
  }

  /**
   * Optimistic placement: the scaffold shows instantly, the server validates
   * cost + slot atomically, and a rejection rolls everything back with a
   * full refund. No cost or duration is sent — the server recomputes both.
   */
  _confirmPlacementOnline(p, def, col, row, cost) {
    const social = this.game.social;
    const applied = this.economy.suppressMirror(() => {
      if (!this.economy.spend(cost)) return null;
      const entity = this.state.createEntity({
        type: def.id,
        name: def.name,
        col,
        row,
        size: [...def.size],
        level: 1,
        status: 'building',
        pending: 0,
        lastAccrualAt: null,
      });
      this._ensureHealth(entity);
      this._occupy(entity);
      const durationMs = this.economy.secondsOf(def.id, 1) * 1000;
      const result = this.queue.enqueue(
        { kind: 'build', entityId: entity.id, type: def.id, targetLevel: 1, durationMs },
        Date.now(),
      );
      if (!result.ok) {
        for (const [key, value] of Object.entries(cost || {})) this.economy.resources[key] += value;
        this._removeEntity(entity);
        return { queued: false };
      }
      // Parked until the server acknowledges (the local tick never runs it).
      result.job.hold = true;
      result.job.status = 'queued';
      result.job.startedAt = null;
      result.job.endsAt = null;
      return { queued: true, entity, job: result.job };
    });
    if (!applied || !applied.queued) {
      this.bus.emit(EVENTS.UI_TOAST, this.config.t('economy.queueFull', 'صف ساخت پر است'));
      this._afterEconomyChange();
      return false;
    }
    const { entity, job } = applied;
    this._onlinePending.set(job.id, { kind: 'build', entityId: entity.id, cost: { ...cost } });
    this.bus.emit(EVENTS.BUILDING_ADDED, { entity });
    this.select(entity);
    this.bus.emit(EVENTS.UI_TOAST, this.config.t('social.pending', 'در انتظار تأیید سرور…'));

    if (def.id === 'wall' && this.economy.canAfford(cost) && this.queue.jobs.length < this.queue.maxJobs) {
      this.cancelPlacement();
      this.startPlacement('wall');
      this._movePreview(Math.min(col + 1, this.config.cols - 1), row);
    } else {
      this.cancelPlacement();
    }
    this._afterEconomyChange();

    social.request('build:enqueue', { kind: 'build', entityId: entity.id, defId: def.id, level: 1 }).then(
      (answer) => {
        if (!this._onlinePending.has(job.id)) return; // rolled back meanwhile
        if (answer?.ok && answer.job) {
          this._onlinePending.delete(job.id);
          Object.assign(job, {
            id: answer.job.id,
            status: answer.job.status,
            startedAt: answer.job.startedAt,
            endsAt: answer.job.endsAt,
            durationMs: answer.job.durationMs,
            hold: false,
          });
          social.adoptLedger(answer.ledger, answer.serverNow);
          this.bus.emit(EVENTS.BUILDING_QUEUED, { job, entity });
          this.bus.emit(EVENTS.UI_TOAST, `${def.name} در صف ساخت قرار گرفت.`);
          this.game.markQueueDirty();
          this.game.emitQueue();
          this._afterEconomyChange();
        } else {
          this.rollbackOnlineJob(job.id, answer?.error || 'invalid');
        }
      },
      () => this.rollbackOnlineJob(job.id, 'timeout'),
    );
    return true;
  }

  _upgradeSelectedOnline(entity, nextLevel, cost) {
    const social = this.game.social;
    const applied = this.economy.suppressMirror(() => {
      if (!this.economy.spend(cost)) return null;
      const durationMs = this.economy.secondsOf(entity.type, nextLevel) * 1000;
      const result = this.queue.enqueue(
        { kind: 'upgrade', entityId: entity.id, type: entity.type, targetLevel: nextLevel, durationMs },
        Date.now(),
      );
      if (!result.ok) {
        for (const [key, value] of Object.entries(cost || {})) this.economy.resources[key] += value;
        return { queued: false };
      }
      result.job.hold = true;
      result.job.status = 'queued';
      result.job.startedAt = null;
      result.job.endsAt = null;
      return { queued: true, job: result.job };
    });
    if (!applied || !applied.queued) {
      this.bus.emit(EVENTS.UI_TOAST, this.config.t('economy.queueFull', 'صف ساخت پر است'));
      this._afterEconomyChange();
      return false;
    }
    const { job } = applied;
    this._onlinePending.set(job.id, { kind: 'upgrade', entityId: entity.id, cost: { ...cost } });
    this.bus.emit(EVENTS.UI_TOAST, this.config.t('social.pending', 'در انتظار تأیید سرور…'));
    this.select(entity);
    this._afterEconomyChange();

    social.request('build:enqueue', {
      kind: 'upgrade',
      entityId: entity.id,
      defId: entity.type,
      level: nextLevel,
      fromLevel: entity.level,
    }).then(
      (answer) => {
        if (!this._onlinePending.has(job.id)) return;
        if (answer?.ok && answer.job) {
          this._onlinePending.delete(job.id);
          Object.assign(job, {
            id: answer.job.id,
            status: answer.job.status,
            startedAt: answer.job.startedAt,
            endsAt: answer.job.endsAt,
            durationMs: answer.job.durationMs,
            hold: false,
          });
          social.adoptLedger(answer.ledger, answer.serverNow);
          this.bus.emit(EVENTS.UI_TOAST, `${entity.name || this.byId.get(entity.type)?.name} — ارتقا به سطح ${formatFa(nextLevel)} در صف قرار گرفت.`);
          this.game.markQueueDirty();
          this.game.emitQueue();
          this._afterEconomyChange();
        } else {
          this.rollbackOnlineJob(job.id, answer?.error || 'invalid');
        }
      },
      () => this.rollbackOnlineJob(job.id, 'timeout'),
    );
    return true;
  }

  _speedupOnline(job) {
    const social = this.game.social;
    social.request('build:speedup', { jobId: job.id }).then(
      (answer) => {
        if (answer?.ok) {
          social.adoptLedger(answer.ledger, answer.serverNow);
          const index = this.queue.jobs.indexOf(job);
          if (index >= 0) this.queue.jobs.splice(index, 1);
          this.game._finishJob(job, Date.now());
          this.bus.emit(EVENTS.UI_TOAST, `${this.config.t('economy.speedup', 'سرعت‌بخشی')}: −${formatFa(answer.cost)} 💎`);
          this._afterEconomyChange();
          if (this.selected) this.select(this.selected);
        } else {
          this.bus.emit(EVENTS.UI_TOAST, social.errorText(answer?.error));
        }
      },
      () => this.bus.emit(EVENTS.UI_TOAST, social.errorText('timeout')),
    );
    return true;
  }

  /** Remove a never-acknowledged placement and refund it in full. */
  rollbackOnlineJob(jobId, errorCode, { silent = false } = {}) {
    const pending = this._onlinePending.get(jobId);
    const job = this.queue.jobs.find((item) => item.id === jobId);
    this._onlinePending.delete(jobId);
    if (job) this.queue.jobs.splice(this.queue.jobs.indexOf(job), 1);
    if (pending) {
      this.economy.suppressMirror(() => {
        for (const [key, value] of Object.entries(pending.cost || {})) this.economy.resources[key] += value;
      });
      if (pending.kind === 'build') {
        const entity = this.state.getEntity(pending.entityId);
        if (entity) {
          if (this.selected?.id === entity.id) this.clearSelection();
          this._removeEntity(entity);
        }
      }
    }
    if (!silent) {
      const social = this.game?.social;
      this.bus.emit(EVENTS.UI_TOAST, social ? social.errorText(errorCode) : this.config.t('economy.notEnough', 'منابع کافی نیست.'));
    }
    this.game.markEconomyDirty();
    this.game.markQueueDirty();
    this.game.emitState(Date.now(), false);
    this.game.emitQueue();
  }

  /** Drop every unacknowledged placement (disconnect path) with one toast. */
  rollbackAllOnlinePending() {
    const ids = [...this._onlinePending.keys()];
    if (ids.length === 0) return;
    for (const jobId of ids) this.rollbackOnlineJob(jobId, 'offline', { silent: true });
    this.bus.emit(EVENTS.UI_TOAST, this.config.t('social.rolledBack', 'ساخت‌های تأییدنشده لغو و هزینه برگشت.'));
  }

  /* ---------------------------------------------------------- job finished */

  onJobFinished({ job, entity }) {
    if (!entity) return;
    const def = this.byId.get(entity.type);
    if (!def) return;
    this._ensureHealth(entity);
    this.bus.emit(EVENTS.BUILDING_UPDATED, { entity, jobKind: job?.kind || null });
    if (job?.kind === 'build') this.bus.emit(EVENTS.UI_TOAST, `${def.name} ساخته شد.`);
    else if (job?.kind === 'upgrade') this.bus.emit(EVENTS.UI_TOAST, `${def.name} — سطح ${formatFa(entity.level)}`);
    if (this.selected && this.selected.id === entity.id) this.select(entity);
  }

  /* -------------------------------------------------------------- helpers */

  _afterEconomyChange() {
    this.game?.emitState?.(Date.now(), true);
    this.game?.emitQueue?.(); // enqueue/complete must refresh the queue panel immediately
    this.game?.markEconomyDirty?.();
    this.game?.markQueueDirty?.();
    this.persist?.();
  }

  dispose() {
    for (const off of this._unsubscribers) off();
    this._unsubscribers.length = 0;
    this.cancelPlacement();
    this.occupancy.clear();
    this.selected = null;
  }
}
