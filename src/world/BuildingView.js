/**
 * BuildingView — Three.js presentation for buildings and placement previews.
 * Gameplay sends small snapshots/events; this class never changes economy or save state.
 */
import * as THREE from 'three';
import economyData from '../data/economy.json';
import buildingData from '../data/buildings.json';
import { EVENTS } from '../core/EventBus.js';
import { BuildingFactory } from './BuildingFactory.js';
import { BuildingBatches } from './BuildingBatches.js';

export class BuildingView {
  constructor({ config, world, rig, input, bus, state, engine = null }) {
    Object.assign(this, { config, world, rig, input, bus, state, engine });
    this.factory = new BuildingFactory(config.tileSize, { tier: config.quality.tier, anisotropy: Math.min(config.quality.textureAnisotropy || 1, engine?.renderer?.capabilities?.getMaxAnisotropy?.() || 1) });
    this._definitions = new Map(buildingData.buildings.map((definition) => [definition.id, definition]));
    this.group = new THREE.Group();
    this.group.name = 'buildings';
    world.group.add(this.group);
    this.batches = new BuildingBatches({ parent: this.group, factory: this.factory, engine, initialCapacity: config.sources?.quality?.batching?.initialCapacity || 4 });
    this.roots = new Map();
    this.indicators = new Map();
    this.producerStates = new Map();
    this.preview = null;
    this.previewDef = null;
    this.reducedMotion = false;
    this.elapsed = 0;

    this.highlightMaterial = new THREE.MeshBasicMaterial({ color: 0x35d978, transparent: true, opacity: 0.38, depthWrite: false });
    this.highlightGeometry = new THREE.PlaneGeometry(1, 1);
    this.highlight = new THREE.Mesh(this.highlightGeometry, this.highlightMaterial);
    this.highlight.rotation.x = -Math.PI / 2;
    this.highlight.position.y = 0.08;
    this.highlight.visible = false;
    this.group.add(this.highlight);
    this.indicatorTextures = this._createIndicatorTextures();

    this._pointerHandler = (type, event) => this._onWorldPointer(type, event);
    this.input.onWorldPointer = this._pointerHandler;
    this._unsubscribers = [
      bus.on(EVENTS.BUILDING_ADDED, ({ entity } = {}) => entity && this._attachVisual(entity)),
      bus.on(EVENTS.BUILDING_UPDATED, ({ entity, jobKind } = {}) => entity && this._updateVisual(entity, jobKind)),
      bus.on(EVENTS.BUILDING_REMOVED, ({ entityId } = {}) => this._removeVisual(entityId)),
      bus.on(EVENTS.PLACEMENT_CHANGED, (state) => this._renderPlacement(state)),
      bus.on(EVENTS.ECONOMY_CHANGED, (state) => this._syncProducerStates(state?.producers)),
    ];

    this._syncFromState();
  }

  _syncFromState() {
    for (const entity of this.state.entities.values()) this._attachVisual(entity);
    for (const entity of this.state.entities.values()) {
      if (entity.pending > 0) this.producerStates.set(entity.id, { pending: entity.pending, ready: false, status: entity.status });
    }
  }

  _attachVisual(entity) {
    if (!entity || this.roots.has(entity.id)) return this.roots.get(entity?.id) || null;
    const definition = this._definition(entity.type);
    if (!definition) return null;
    const ready = entity.status === 'ready';
    const root = new THREE.Group();
    root.name = `${ready ? 'building' : 'scaffold'}:${entity.type}`;
    this._placeRoot(root, entity, ready ? entity.level : 1);
    this.roots.set(entity.id, root);
    this.group.add(root);
    this.batches.add(root, definition, { ready, level: ready ? entity.level : 1 });
    this.batches.flush();
    this.engine?.applyRuntimeSettingsTo?.(root);
    return root;
  }

  _definition(id) {
    return this._definitions.get(id) || null;
  }

  _placeRoot(root, entity, level) {
    const x = (entity.col + entity.size[0] / 2) * this.config.tileSize;
    const z = (entity.row + entity.size[1] / 2) * this.config.tileSize;
    root.position.set(x, this.world.getGroundHeight?.(x, z) || 0, z);
    root.scale.setScalar(1 + 0.035 * (level - 1));
    root.userData.entityId = entity.id;
    root.userData.buildingRoot = root;
  }

  getEntityRoot(entityId) {
    return this.roots.get(entityId) || null;
  }

  _updateVisual(entity, jobKind = null) {
    const definition = this._definition(entity.type);
    if (!definition) return;
    if (jobKind === 'build' || jobKind === 'upgrade' || !this.roots.has(entity.id)) {
      this._removeVisual(entity.id);
      this._attachVisual(entity);
      return;
    }
    const root = this.roots.get(entity.id);
    if (root) root.scale.setScalar(1 + 0.035 * (entity.level - 1));
  }

  _removeVisual(entityId) {
    const root = this.roots.get(entityId);
    if (root) {
      this.batches.remove(root);
      root.removeFromParent();
      this._disposeRootGeometry(root);
      this.roots.delete(entityId);
    }
    const sprite = this.indicators.get(entityId);
    if (sprite) {
      sprite.removeFromParent();
      sprite.material.dispose();
      this.indicators.delete(entityId);
    }
    this.producerStates.delete(entityId);
  }

  _disposeRootGeometry(root) {
    root.traverse((node) => {
      if (node.isMesh) node.geometry?.dispose();
    });
  }

  _renderPlacement(state = {}) {
    if (!state.active) {
      this._clearPreview();
      this.input.interactionMode = 'camera';
      this.world.setGridVisible(false);
      return;
    }

    const enteringPlacement = this.input.interactionMode !== 'placement';
    this.input.interactionMode = 'placement';
    this.world.setGridVisible(true);
    if (!state.def) return;
    if (!this.preview || this.previewDef?.id !== state.def.id) this._createPreview(state.def);
    this.highlight.visible = true;
    this.highlightMaterial.color.setHex(state.valid ? 0x35d978 : 0xe34b4b);

    const col = Number.isFinite(state.col) ? state.col : Math.floor(this.config.cols / 2);
    const row = Number.isFinite(state.row) ? state.row : Math.floor(this.config.rows / 2);
    this._positionPreview(col, row, state.def);

    // Keep the original UX: a new placement starts near the current camera focus.
    // This is a presentation-to-game intent carrying tile coordinates, not a render object.
    if (enteringPlacement && this.rig?.focus) {
      const tile = this.world.getCellAt(this.rig.focus.x, this.rig.focus.z);
      if (tile) this.bus.emit(EVENTS.PLACEMENT_POINTER, { col: tile.col, row: tile.row, type: 'focus' });
    }
  }

  _createPreview(definition) {
    this._clearPreview();
    this.preview = this.factory.create(definition);
    this.preview.traverse((node) => {
      if (!node.isMesh) return;
      node.material = Array.isArray(node.material)
        ? node.material.map((material) => this._previewMaterial(material))
        : this._previewMaterial(node.material);
    });
    this.previewDef = definition;
    this.group.add(this.preview);
    this.engine?.applyRuntimeSettingsTo?.(this.preview);
  }

  _previewMaterial(material) {
    const clone = material.clone();
    clone.transparent = true;
    clone.opacity = 0.72;
    return clone;
  }

  _positionPreview(col, row, definition) {
    if (!this.preview || !this.previewDef) return;
    const size = definition.size;
    const x = (col + size[0] / 2) * this.config.tileSize;
    const z = (row + size[1] / 2) * this.config.tileSize;
    this.preview.position.set(x, this.world.getGroundHeight?.(x, z) || 0, z);
    this.highlight.position.set(x, 0.08, z);
    this.highlight.scale.set(size[0] * this.config.tileSize * 0.96, size[1] * this.config.tileSize * 0.96, 1);
  }

  _clearPreview() {
    if (this.preview) {
      this.preview.removeFromParent();
      this.preview.traverse((node) => {
        if (!node.isMesh) return;
        node.geometry?.dispose();
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) material?.dispose();
      });
    }
    this.preview = null;
    this.previewDef = null;
    this.highlight.visible = false;
  }

  _onWorldPointer(type, event) {
    if (this.input.interactionMode !== 'placement' || !event) return;
    const point = this.rig.screenToGround(event.clientX, event.clientY, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    if (!point) return;
    const tile = this.world.getCellAt(point.x, point.z);
    if (tile) this.bus.emit(EVENTS.PLACEMENT_POINTER, { col: tile.col, row: tile.row, type });
  }

  _createIndicatorTextures() {
    const textures = {};
    for (const [key, meta] of Object.entries(economyData.resources || {})) {
      if (!meta.stored) continue;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 64;
      const context = canvas.getContext('2d');
      context.clearRect(0, 0, 64, 64);
      context.beginPath();
      context.arc(32, 32, 26, 0, Math.PI * 2);
      context.fillStyle = 'rgba(8,20,24,0.9)';
      context.fill();
      context.lineWidth = 4;
      context.strokeStyle = meta.color;
      context.stroke();
      context.fillStyle = meta.color;
      context.font = 'bold 30px sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillText(meta.icon === '❖' ? '❖' : meta.icon === '✦' ? '✦' : '◆', 32, 34);
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      textures[key] = texture;
    }
    return textures;
  }

  _getIndicator(entity) {
    let sprite = this.indicators.get(entity.id);
    if (sprite) return sprite;
    const definition = this._definition(entity.type);
    const resource = definition?.produces;
    const texture = resource ? this.indicatorTextures[resource] : null;
    if (!texture) return null;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true, depthWrite: false });
    sprite = new THREE.Sprite(material);
    sprite.scale.setScalar(0.85);
    sprite.visible = false;
    sprite.renderOrder = 6;
    this.group.add(sprite);
    this.indicators.set(entity.id, sprite);
    return sprite;
  }

  _syncProducerStates(producers) {
    if (!Array.isArray(producers)) return;
    this.producerStates.clear();
    for (const producer of producers) {
      if (producer?.entityId == null) continue;
      this.producerStates.set(producer.entityId, {
        pending: Math.max(0, Number(producer.pending) || 0),
        ready: Boolean(producer.ready),
        status: producer.status || 'ready',
      });
    }
  }

  setReducedMotion(enabled) {
    this.reducedMotion = Boolean(enabled);
  }

  update(dt) {
    if (Number.isFinite(dt) && dt > 0 && !this.reducedMotion) this.elapsed += dt;
    for (const [entityId, producer] of this.producerStates) {
      const entity = this.state.entities.get(entityId);
      if (!entity) continue;
      const sprite = this._getIndicator(entity);
      if (!sprite) continue;
      if (producer.status !== 'ready' || producer.pending < 1) {
        sprite.visible = false;
        continue;
      }
      const root = this.roots.get(entityId);
      const x = root?.position.x ?? (entity.col + entity.size[0] / 2) * this.config.tileSize;
      const z = root?.position.z ?? (entity.row + entity.size[1] / 2) * this.config.tileSize;
      const bob = this.reducedMotion ? 0 : Math.sin(this.elapsed * 2.4 + entityId) * 0.12;
      const pulse = producer.ready && !this.reducedMotion ? 1 + Math.sin(this.elapsed * 3.6 + entityId) * 0.08 : 1;
      sprite.visible = true;
      sprite.position.set(x, 3.1 + bob, z);
      sprite.scale.setScalar(0.85 * pulse);
      sprite.material.opacity = producer.ready ? 1 : 0.55;
    }
  }

  beforeRender() { this.factory.setQuality(this.engine?.governor?.scale < 1 ? 'low' : this.engine?.runtimeQualityTier || this.config.quality.tier); this.factory.setDaylight(this.world.dayNightState?.daylight ?? 1); this.batches.flush(); }

  dispose() {
    for (const off of this._unsubscribers) off();
    this._unsubscribers.length = 0;
    if (this.input.onWorldPointer === this._pointerHandler) this.input.onWorldPointer = null;
    this._clearPreview();
    for (const entityId of [...this.roots.keys()]) this._removeVisual(entityId);
    for (const sprite of this.indicators.values()) {
      sprite.removeFromParent();
      sprite.material.dispose();
    }
    this.indicators.clear();
    for (const texture of Object.values(this.indicatorTextures)) texture.dispose();
    this.highlightGeometry.dispose();
    this.highlightMaterial.dispose();
    this.batches.dispose();
    this.factory.dispose();
    this.group.removeFromParent();
  }
}
