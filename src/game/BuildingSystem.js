import * as THREE from 'three';
import buildingData from '../data/buildings.json';
import { BuildingFactory } from '../world/BuildingFactory.js';
import { EVENTS } from '../core/EventBus.js';

export class BuildingSystem {
  constructor({ config, world, rig, input, bus, state }) {
    Object.assign(this, { config, world, rig, input, bus, state });
    this.definitions = buildingData.buildings;
    this.byId = new Map(this.definitions.map((d) => [d.id, d]));
    this.factory = new BuildingFactory(config.tileSize);
    this.group = new THREE.Group(); this.group.name = 'buildings'; world.group.add(this.group);
    this.occupancy = new Map();
    this.entities = state.entities;
    this.resources = { ...buildingData.economy.resources };
    this.level = buildingData.economy.level;
    this.builders = { ...buildingData.economy.builders };
    this.nextId = 1;
    this.placing = null;
    this.selected = null;
    this.dragging = false;
    this.highlightMaterial = new THREE.MeshBasicMaterial({ color: 0x43d17a, transparent: true, opacity: .38, depthWrite: false });
    this.highlightGeometry = new THREE.PlaneGeometry(1, 1);
    this.highlight = new THREE.Mesh(this.highlightGeometry, this.highlightMaterial);
    this.highlight.rotation.x = -Math.PI / 2; this.highlight.position.y = .08; this.highlight.visible = false; this.group.add(this.highlight);
    input.onWorldPointer = (type, e) => this._placementPointer(type, e);
    this.unsubscribe = bus.on(EVENTS.TILE_TAP, (p) => this.selectAt(p.col, p.row));
    this._seedTown();
    this._emitState();
  }

  _seedTown() {
    const def = this.byId.get('town-center');
    const col = Math.floor(this.config.cols / 2) - 1, row = Math.floor(this.config.rows / 2) - 1;
    if (this.canPlace(def, col, row)) this._commit(def, col, row, false);
  }

  startPlacement(id) {
    const def = this.byId.get(id);
    if (!def || !this.canAfford(def.cost)) { this.bus.emit(EVENTS.UI_TOAST, 'منابع کافی نیست.'); return false; }
    this.cancelPlacement(); this.clearSelection();
    const preview = this.factory.create(def);
    preview.traverse((o) => { if (o.isMesh) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = .72; } });
    this.placing = { def, preview, col: 0, row: 0, valid: false };
    this.group.add(preview); this.highlight.visible = true; this.input.interactionMode = 'placement';
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
    const p = this.placing; if (!p) return;
    const maxCol = this.config.cols - p.def.size[0], maxRow = this.config.rows - p.def.size[1];
    p.col = Math.max(0, Math.min(maxCol, Math.floor(col)));
    p.row = Math.max(0, Math.min(maxRow, Math.floor(row)));
    p.valid = this.canPlace(p.def, p.col, p.row);
    const x = (p.col + p.def.size[0] / 2) * this.config.tileSize;
    const z = (p.row + p.def.size[1] / 2) * this.config.tileSize;
    p.preview.position.set(x, 0, z);
    this.highlight.position.set(x, .08, z);
    this.highlight.scale.set(p.def.size[0] * this.config.tileSize * .96, p.def.size[1] * this.config.tileSize * .96, 1);
    this.highlightMaterial.color.setHex(p.valid ? 0x35d978 : 0xe34b4b);
    this.bus.emit(EVENTS.PLACEMENT_CHANGED, { active: true, def: p.def, valid: p.valid });
  }

  confirmPlacement() {
    const p = this.placing;
    if (!p || !p.valid || !this.canAfford(p.def.cost)) { this.bus.emit(EVENTS.UI_TOAST, 'این محل قابل ساخت نیست.'); return false; }
    const { def, col, row } = p;
    this._spend(def.cost); this._commit(def, col, row, true);
    if (def.id === 'wall' && this.canAfford(def.cost)) {
      this.group.remove(p.preview); this._disposePreview(p.preview); this.placing = null;
      this.startPlacement('wall');
      this._movePreview(Math.min(col + 1, this.config.cols - 1), row);
    } else this.cancelPlacement();
    return true;
  }

  cancelPlacement() {
    if (this.placing) { this.group.remove(this.placing.preview); this._disposePreview(this.placing.preview); }
    this.placing = null; this.highlight.visible = false; this.input.interactionMode = 'camera'; this.world.setGridVisible(false);
    this.bus.emit(EVENTS.PLACEMENT_CHANGED, { active: false });
  }

  _disposePreview(root) { root.traverse((o) => { if (o.isMesh) { o.geometry?.dispose(); o.material?.dispose(); } }); }
  canAfford(cost) { return Object.entries(cost).every(([k, v]) => (this.resources[k] || 0) >= v); }
  _spend(cost) { for (const [k, v] of Object.entries(cost)) this.resources[k] -= v; this._emitState(); }
  canPlace(def, col, row) {
    if (col < 0 || row < 0 || col + def.size[0] > this.config.cols || row + def.size[1] > this.config.rows) return false;
    for (let r = row; r < row + def.size[1]; r++) for (let c = col; c < col + def.size[0]; c++) if (this.occupancy.has(`${c}:${r}`)) return false;
    return true;
  }

  _commit(def, col, row, notify) {
    const root = this.factory.create(def), id = `b${this.nextId++}`;
    root.position.set((col + def.size[0] / 2) * this.config.tileSize, 0, (row + def.size[1] / 2) * this.config.tileSize);
    root.userData.entityId = id; root.userData.buildingRoot = root; this.group.add(root);
    const entity = { id, type: def.id, name: def.name, col, row, size: [...def.size], level: 1, root };
    this.entities.set(id, entity);
    for (let r = row; r < row + def.size[1]; r++) for (let c = col; c < col + def.size[0]; c++) this.occupancy.set(`${c}:${r}`, id);
    if (notify) { this.select(entity); this.bus.emit(EVENTS.UI_TOAST, `${def.name} ساخته شد.`); }
    return entity;
  }

  selectAt(col, row) { const id = this.occupancy.get(`${col}:${row}`); id ? this.select(this.entities.get(id)) : this.clearSelection(); }
  select(entity) { this.selected = entity; this.bus.emit(EVENTS.BUILDING_SELECTED, entity ? { entity, def: this.byId.get(entity.type) } : null); }
  clearSelection() { if (this.selected) { this.selected = null; this.bus.emit(EVENTS.BUILDING_SELECTED, null); } }
  upgradeSelected() { if (!this.selected) return; this.selected.level += 1; this.bus.emit(EVENTS.UI_TOAST, `ارتقا به سطح ${this.selected.level} انجام شد.`); this.select(this.selected); }
  _emitState() { this.bus.emit(EVENTS.ECONOMY_CHANGED, { resources: { ...this.resources }, level: this.level, builders: { ...this.builders } }); }

  dispose() {
    this.unsubscribe(); this.cancelPlacement(); this.input.onWorldPointer = null;
    for (const e of this.entities.values()) {
      e.root.traverse((o) => { if (o.isMesh) o.geometry?.dispose(); });
      this.group.remove(e.root);
    }
    this.entities.clear(); this.highlightGeometry.dispose(); this.highlightMaterial.dispose(); this.factory.dispose(); this.group.removeFromParent();
  }
}
