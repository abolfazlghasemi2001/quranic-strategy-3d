import * as THREE from 'three';
import buildingData from '../data/buildings.json';
import { BuildingFactory } from '../world/BuildingFactory.js';
import { EVENTS } from '../core/EventBus.js';
import { formatFa } from '../ui/dom.js';

/**
 * BuildingSystem — placement, selection, harvest and upgrade actions.
 *
 * Phase 3: buildings are no longer instant. Paying the level-1 cost enqueues a
 * job in the shared 2-builder queue; the entity shows a scaffold until the job
 * finishes (JOB_FINISHED swaps it for the real model). Producers accrue
 * `pending` (see EconomySystem) and are harvested with a tap when the ready
 * marker shows. All numbers come from balance.json / economy.json.
 */
export class BuildingSystem {
  /**
   * @param {object} options
   * @param {object} options.game — the Game (for state broadcasts + persistence hook)
   */
  constructor({ config, world, rig, input, bus, state, economy, queue, game, persist }) {
    Object.assign(this, { config, world, rig, input, bus, state, economy, queue, game });
    this.persist = persist || null;
    this.definitions = buildingData.buildings;
    this.byId = new Map(this.definitions.map((d) => [d.id, d]));
    this.factory = new BuildingFactory(config.tileSize);
    this.group = new THREE.Group();
    this.group.name = 'buildings';
    world.group.add(this.group);
    this.occupancy = new Map(); // "col:row" -> entity id
    this.placing = null;
    this.selected = null;
    this.dragging = false;

    this.highlightMaterial = new THREE.MeshBasicMaterial({ color: 0x43d17a, transparent: true, opacity: 0.38, depthWrite: false });
    this.highlightGeometry = new THREE.PlaneGeometry(1, 1);
    this.highlight = new THREE.Mesh(this.highlightGeometry, this.highlightMaterial);
    this.highlight.rotation.x = -Math.PI / 2;
    this.highlight.position.y = 0.08;
    this.highlight.visible = false;
    this.group.add(this.highlight);

    // Ready-to-harvest billboards, one per producer (pooled per entity).
    this.indicators = new Map(); // entity id -> THREE.Sprite
    this.indicatorTextures = this._createIndicatorTextures();

    input.onWorldPointer = (type, e) => this._placementPointer(type, e);
    this._unsubscribers = [
      bus.on(EVENTS.TILE_TAP, (p) => this.onTileTap(p)),
      bus.on(EVENTS.JOB_FINISHED, (p) => this.onJobFinished(p)),
    ];

    // Rebuild visuals from state (fresh seed or hydrated save).
    this._syncFromState();
  }

  /* ------------------------------------------------------------- visuals */

  _syncFromState() {
    if (this.state.entities.size === 0) {
      // Fallback: Game.bootstrap always seeds a town center; keep this safe.
      const def = this.byId.get('town-center');
      const col = Math.floor(this.config.cols / 2) - 1;
      if (def && this.canPlace(def, col, col)) {
        this.state.createEntity({ type: def.id, name: def.name, col, row: col, size: def.size, level: 1, status: 'ready', lastAccrualAt: Date.now() });
      }
    }
    for (const entity of this.state.entities.values()) {
      this._attachVisual(entity);
    }
  }

  _attachVisual(entity) {
    const def = this.byId.get(entity.type);
    if (!def || entity.root) return;
    const ready = entity.status === 'ready';
    const root = ready ? this.factory.create(def) : this.factory.createScaffold(def);
    this._placeRoot(root, entity, ready ? entity.level : 1);
    entity.root = root;
    this.group.add(root);
    for (let r = entity.row; r < entity.row + entity.size[1]; r += 1) {
      for (let c = entity.col; c < entity.col + entity.size[0]; c += 1) this.occupancy.set(`${c}:${r}`, entity.id);
    }
  }

  _placeRoot(root, entity, level) {
    root.position.set(
      (entity.col + entity.size[0] / 2) * this.config.tileSize,
      0,
      (entity.row + entity.size[1] / 2) * this.config.tileSize,
    );
    root.scale.setScalar(1 + 0.035 * (level - 1)); // subtle per-level growth
    root.userData.entityId = entity.id;
    root.userData.buildingRoot = root;
  }

  _createIndicatorTextures() {
    const textures = {};
    for (const [key, meta] of Object.entries(this.economy.data.resources)) {
      if (!meta.stored) continue;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const c = canvas.getContext('2d');
      c.clearRect(0, 0, 64, 64);
      c.beginPath();
      c.arc(32, 32, 26, 0, Math.PI * 2);
      c.fillStyle = 'rgba(8,20,24,0.9)';
      c.fill();
      c.lineWidth = 4;
      c.strokeStyle = meta.color;
      c.stroke();
      c.fillStyle = meta.color;
      c.font = 'bold 30px sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(meta.icon === '❖' ? '❖' : meta.icon === '✦' ? '✦' : '◆', 32, 34);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      textures[key] = texture;
    }
    return textures;
  }

  _indicator(entity) {
    let sprite = this.indicators.get(entity.id);
    if (sprite) return sprite;
    const def = this.byId.get(entity.type);
    const resource = def?.produces;
    if (!resource || !this.indicatorTextures[resource]) return null;
    const material = new THREE.SpriteMaterial({ map: this.indicatorTextures[resource], transparent: true, depthTest: true, depthWrite: false });
    sprite = new THREE.Sprite(material);
    sprite.scale.setScalar(0.85);
    sprite.visible = false;
    sprite.renderOrder = 6;
    this.group.add(sprite);
    this.indicators.set(entity.id, sprite);
    return sprite;
  }

  /* ---------------------------------------------------------------- taps */

  onTileTap({ col, row }) {
    if (col == null || row == null) return;
    const id = this.occupancy.get(`${col}:${row}`);
    const entity = id != null ? this.state.entities.get(id) : null;
    if (!entity) {
      this.clearSelection();
      return;
    }
    const def = this.byId.get(entity.type);
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
    const preview = this.factory.create(def);
    preview.traverse((o) => {
      if (o.isMesh) {
        o.material = o.material.clone();
        o.material.transparent = true;
        o.material.opacity = 0.72;
      }
    });
    this.placing = { def, preview, col: 0, row: 0, valid: false };
    this.group.add(preview);
    this.highlight.visible = true;
    this.input.interactionMode = 'placement';
    this.world.setGridVisible(true);
    const center = this.world.getCellAt(this.rig.focus.x, this.rig.focus.z) || { col: 2, row: 2 };
    this._movePreview(center.col, center.row);
    this.bus.emit(EVENTS.PLACEMENT_CHANGED, { active: true, def, valid: this.placing.valid });
    return true;
  }

  _placementPointer(type, event) {
    if (!this.placing) return;
    const point = this.rig.screenToGround(event.clientX, event.clientY, { width: window.innerWidth, height: window.innerHeight });
    if (point) {
      const tile = this.config.worldToTile(point.x, point.z);
      this._movePreview(tile.col, tile.row);
    }
    if (type === 'down') this.dragging = true;
    if (type === 'up') this.dragging = false;
  }

  _movePreview(col, row) {
    const p = this.placing;
    if (!p) return;
    const maxCol = this.config.cols - p.def.size[0];
    const maxRow = this.config.rows - p.def.size[1];
    p.col = Math.max(0, Math.min(maxCol, Math.floor(col)));
    p.row = Math.max(0, Math.min(maxRow, Math.floor(row)));
    p.valid = this.canPlace(p.def, p.col, p.row);
    const x = (p.col + p.def.size[0] / 2) * this.config.tileSize;
    const z = (p.row + p.def.size[1] / 2) * this.config.tileSize;
    p.preview.position.set(x, 0, z);
    this.highlight.position.set(x, 0.08, z);
    this.highlight.scale.set(p.def.size[0] * this.config.tileSize * 0.96, p.def.size[1] * this.config.tileSize * 0.96, 1);
    this.highlightMaterial.color.setHex(p.valid ? 0x35d978 : 0xe34b4b);
    this.bus.emit(EVENTS.PLACEMENT_CHANGED, { active: true, def: p.def, valid: p.valid });
  }

  confirmPlacement() {
    const p = this.placing;
    if (!p || !p.valid) {
      this.bus.emit(EVENTS.UI_TOAST, this.config.t('economy.notPlace', 'این محل قابل ساخت نیست.'));
      return false;
    }
    const { def, col, row } = p;
    // Queue capacity is checked BEFORE any payment.
    if (this.queue.jobs.length >= this.queue.maxJobs) {
      this.bus.emit(EVENTS.UI_TOAST, this.config.t('economy.queueFull', 'صف ساخت پر است'));
      return false;
    }
    const cost = this.economy.costOf(def.id, 1);
    if (!this.economy.canAfford(cost)) {
      this.bus.emit(EVENTS.UI_TOAST, this.config.t('economy.notEnough', 'منابع کافی نیست.'));
      return false;
    }
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
    const scaffold = this.factory.createScaffold(def);
    this._placeRoot(scaffold, entity, 1);
    entity.root = scaffold;
    this.group.add(scaffold);
    for (let r = row; r < row + def.size[1]; r += 1) {
      for (let c = col; c < col + def.size[0]; c += 1) this.occupancy.set(`${c}:${r}`, entity.id);
    }

    const durationMs = this.economy.secondsOf(def.id, 1) * 1000;
    const result = this.queue.enqueue(
      { kind: 'build', entityId: entity.id, type: def.id, targetLevel: 1, durationMs },
      Date.now(),
    );
    if (!result.ok) {
      // Refund — never take resources without a job slot.
      for (const [key, value] of Object.entries(cost || {})) this.economy.resources[key] += value;
      this._removeEntity(entity);
      this.bus.emit(EVENTS.UI_TOAST, this.config.t('economy.queueFull', 'صف ساخت پر است'));
      this._afterEconomyChange();
      return false;
    }

    this.bus.emit(EVENTS.UI_TOAST, `${def.name} در صف ساخت قرار گرفت.`);
    this.select(entity);

    // Wall chain: keep placement mode when the row can continue.
    if (def.id === 'wall' && this.economy.canAfford(cost) && this.queue.jobs.length < this.queue.maxJobs) {
      this.group.remove(p.preview);
      this._disposePreview(p.preview);
      this.placing = null;
      this.startPlacement('wall');
      this._movePreview(Math.min(col + 1, this.config.cols - 1), row);
    } else {
      this.cancelPlacement();
    }
    this._afterEconomyChange();
    return true;
  }

  cancelPlacement() {
    if (this.placing) {
      this.group.remove(this.placing.preview);
      this._disposePreview(this.placing.preview);
    }
    this.placing = null;
    this.highlight.visible = false;
    this.input.interactionMode = 'camera';
    this.world.setGridVisible(false);
    this.bus.emit(EVENTS.PLACEMENT_CHANGED, { active: false });
  }

  _disposePreview(root) {
    root.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose();
        o.material?.dispose();
      }
    });
  }

  canPlace(def, col, row) {
    if (col < 0 || row < 0 || col + def.size[0] > this.config.cols || row + def.size[1] > this.config.rows) return false;
    for (let r = row; r < row + def.size[1]; r += 1) {
      for (let c = col; c < col + def.size[0]; c += 1) if (this.occupancy.has(`${c}:${r}`)) return false;
    }
    return true;
  }

  _removeEntity(entity) {
    if (entity.root) {
      this.group.remove(entity.root);
      entity.root.traverse((o) => {
        if (o.isMesh) o.geometry?.dispose();
      });
      entity.root = null;
    }
    const sprite = this.indicators.get(entity.id);
    if (sprite) {
      this.group.remove(sprite);
      sprite.material.dispose();
      this.indicators.delete(entity.id);
    }
    for (let r = entity.row; r < entity.row + entity.size[1]; r += 1) {
      for (let c = entity.col; c < entity.col + entity.size[0]; c += 1) this.occupancy.delete(`${c}:${r}`);
    }
    this.state.entities.delete(entity.id);
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

  /* ---------------------------------------------------------- job finished */

  onJobFinished({ job, entity }) {
    if (!entity || !entity.root) return;
    const def = this.byId.get(entity.type);
    if (!def) return;

    if (job.kind === 'build') {
      // Swap the scaffold for the finished model.
      this.group.remove(entity.root);
      entity.root.traverse((o) => {
        if (o.isMesh) o.geometry?.dispose();
      });
      const root = this.factory.create(def);
      this._placeRoot(root, entity, entity.level);
      entity.root = root;
      this.group.add(root);
      this.bus.emit(EVENTS.UI_TOAST, `${def.name} ساخته شد.`);
    } else if (job.kind === 'upgrade') {
      entity.root.scale.setScalar(1 + 0.035 * (entity.level - 1));
      this.bus.emit(EVENTS.UI_TOAST, `${def.name} — سطح ${formatFa(entity.level)}`);
    }
    if (this.selected && this.selected.id === entity.id) this.select(entity); // refresh menu
  }

  /* ------------------------------------------------------------------ tick */

  update(dt) {
    const now = performance.now();
    for (const entity of this.state.entities.values()) {
      const def = this.byId.get(entity.type);
      if (!def?.produces || entity.status !== 'ready') continue;
      const sprite = this._indicator(entity);
      if (!sprite) continue;
      const ready = entity.pending >= this.economy.readyThreshold(entity);
      if (entity.pending < 1) {
        sprite.visible = false;
        continue;
      }
      sprite.visible = true;
      const baseY = 3.1;
      const bob = Math.sin(now * 0.004 + entity.id) * 0.12;
      sprite.position.set(entity.root ? entity.root.position.x : 0, baseY + bob, entity.root ? entity.root.position.z : 0);
      const pulse = ready ? 1 + Math.sin(now * 0.006 + entity.id) * 0.08 : 0.7;
      sprite.scale.setScalar(0.85 * pulse);
      sprite.material.opacity = ready ? 1 : 0.55;
    }
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
    for (const fn of this._unsubscribers) fn();
    this._unsubscribers.length = 0;
    this.cancelPlacement();
    this.input.onWorldPointer = null;
    for (const entity of this.state.entities.values()) {
      if (entity.root) {
        entity.root.traverse((o) => {
          if (o.isMesh) o.geometry?.dispose();
        });
        this.group.remove(entity.root);
        entity.root = null;
      }
    }
    for (const sprite of this.indicators.values()) {
      this.group.remove(sprite);
      sprite.material.dispose();
    }
    this.indicators.clear();
    for (const texture of Object.values(this.indicatorTextures)) texture.dispose();
    this.occupancy.clear();
    this.highlightGeometry.dispose();
    this.highlightMaterial.dispose();
    this.factory.dispose();
    this.group.removeFromParent();
  }
}
