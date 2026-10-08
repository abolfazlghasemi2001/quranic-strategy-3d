/**
 * CharacterSystem — renderer-owned asset cache, entity pool and animation budget.
 * Its public inputs are plain IDs and presentation transforms; it never mutates gameplay state.
 */
import * as THREE from 'three';
import { EVENTS } from '../../core/EventBus.js';
import { CharacterRegistry } from './CharacterRegistry.js';
import { CharacterAssetLoader } from './CharacterAssetLoader.js';
import { CharacterEntity } from './CharacterEntity.js';

const FACTION_TINTS = Object.freeze({
  defender: new THREE.Color('#e4fff7'),
  raider: new THREE.Color('#ffe2c5'),
});

export class CharacterSystem {
  constructor({ parent, config, bus = null, engine = null, data, registry = null, loader = null } = {}) {
    if (!parent?.add) throw new TypeError('CharacterSystem requires a Three.js parent group');
    this.parent = parent;
    this.config = config;
    this.bus = bus;
    this.engine = engine;
    this.registry = registry || new CharacterRegistry(data);
    this.group = new THREE.Group();
    this.group.name = 'character-system';
    this.parent.add(this.group);

    this.loader = loader || new CharacterAssetLoader({
      registry: this.registry,
      onStatus: (status) => this._onAssetStatus(status),
      onError: (report) => this._reportAssetError(report),
    });
    // Injected loaders still report through the same event contract when they expose a callback.
    if (loader && typeof loader.setStatusListener === 'function') {
      loader.setStatusListener((status) => this._onAssetStatus(status));
    }

    this.active = new Map(); // unit/entity key -> CharacterEntity
    this.pools = new Map(); // model id + faction -> CharacterEntity[]
    this.materialVariants = new Map();
    this._preloadPromise = null;
    this._disposed = false;
    this._animationAccumulator = 0;
    this._renderStats = { visible: 0, animated: 0, fallback: 0, culled: 0 };
    this.qualityTier = engine?.runtimeQualityTier || config?.quality?.tier || 'medium';
    this.batterySaver = Boolean(engine?.batterySaver);
    this.reducedMotion = false;
    this.setQuality({ qualityTier: this.qualityTier, batterySaver: this.batterySaver });

    this._unsubscribers = [];
    if (bus) {
      this._unsubscribers.push(bus.on(EVENTS.QUALITY_CHANGED, (settings) => this.setQuality(settings)));
    }
  }

  get maxAnimatedUnits() {
    return this._maxAnimatedUnits;
  }

  get maxAnimationDistance() {
    return this._maxAnimationDistance;
  }

  setQuality({ qualityTier = this.qualityTier, batterySaver = this.batterySaver } = {}) {
    const tier = ['low', 'medium', 'high'].includes(qualityTier) ? qualityTier : 'medium';
    const profile = this.registry.data.quality?.tiers?.[tier] || this.registry.data.quality?.tiers?.medium || {};
    const battery = this.registry.data.quality?.batterySaver || {};
    this.qualityTier = tier;
    this.batterySaver = Boolean(batterySaver);
    this._maxAnimatedUnits = this.batterySaver
      ? Math.min(Number(profile.maxAnimatedUnits) || 0, Number(battery.maxAnimatedUnits) || 0)
      : Math.max(0, Number(profile.maxAnimatedUnits) || 0);
    this.animationStepSeconds = this.batterySaver
      ? Math.max(0.025, Number(battery.animationStepSeconds) || 0.05)
      : Math.max(0.01, Number(profile.animationStepSeconds) || 0.033333);
    this._maxAnimationDistance = Math.max(1, Number(profile.maxAnimationDistance) || 120);
    return { qualityTier: tier, batterySaver: this.batterySaver, maxAnimatedUnits: this._maxAnimatedUnits };
  }

  setReducedMotion(enabled) {
    this.reducedMotion = Boolean(enabled);
    for (const entity of this.active.values()) entity.setReducedMotion(this.reducedMotion);
  }

  /** Start loading in the background; callers should keep rendering the LOD fallback meanwhile. */
  preloadCharacters({ retryFailed = false } = {}) {
    if (this._disposed) return Promise.resolve(new Map());
    if (this._preloadPromise && !retryFailed) return this._preloadPromise;
    const modelIds = retryFailed
      ? this.registry.modelIds.filter((modelId) => this.loader.status(modelId) === 'fallback')
      : this.registry.modelIds;
    this._preloadPromise = this.loader.preload(modelIds, { retry: retryFailed });
    return this._preloadPromise.then((results) => {
      if (!this._disposed) this._attachReadyEntities();
      return results;
    }).finally(() => {
      if (retryFailed) this._preloadPromise = null;
    });
  }

  ensureAssets() {
    return this.preloadCharacters();
  }

  retryAsset(modelId) {
    if (this._disposed || typeof this.loader.retry !== 'function') return Promise.resolve(null);
    return this.loader.retry(modelId).then((asset) => {
      if (asset && !this._disposed) this._attachReadyEntities(modelId);
      return asset;
    });
  }

  acquire(key, profileId, faction = 0) {
    if (this._disposed) return null;
    const id = String(key);
    const profile = this.registry.getProfile(profileId);
    const model = profile ? this.registry.getModel(profile.modelId) : null;
    if (!profile || !model) return null;

    const previous = this.active.get(id);
    if (previous && previous.profile.id === profile.id && previous.faction === faction) return previous;
    if (previous) this.release(id);

    const poolKey = this._poolKey(model.id, faction);
    const pool = this.pools.get(poolKey);
    const entity = pool?.pop() || new CharacterEntity({ key: id, profile, faction, model });
    entity.key = id;
    entity.profile = profile;
    entity.model = model;
    entity.modelId = model.id;
    entity.faction = faction;
    entity.root.name = `character:${id}`;
    entity.root.userData.characterId = profile.id;
    entity.root.userData.faction = faction;
    entity.setReducedMotion(this.reducedMotion);
    this.group.add(entity.root);
    entity.resetForPool();
    this.active.set(id, entity);

    const asset = this.loader.getAsset(model.id);
    if (asset) this._attach(entity, asset);
    else if (this.loader.status(model.id) !== 'fallback') this.ensureAssets();
    return entity;
  }

  get(key) {
    return this.active.get(String(key)) || null;
  }

  release(key) {
    const id = String(key);
    const entity = this.active.get(id);
    if (!entity) return false;
    this.active.delete(id);
    entity.resetForPool();
    entity.root.removeFromParent();
    const poolKey = this._poolKey(entity.modelId, entity.faction);
    let pool = this.pools.get(poolKey);
    if (!pool) {
      pool = [];
      this.pools.set(poolKey, pool);
    }
    pool.push(entity);
    return true;
  }

  releaseExcept(keepKeys) {
    const keep = keepKeys instanceof Set ? keepKeys : new Set(keepKeys || []);
    for (const key of this.active.keys()) if (!keep.has(key)) this.release(key);
  }

  setRenderStats({ visible = 0, animated = 0, fallback = 0, culled = 0 } = {}) {
    this._renderStats.visible = visible;
    this._renderStats.animated = animated;
    this._renderStats.fallback = fallback;
    this._renderStats.culled = culled;
  }

  getDebugStats() {
    let pooled = 0;
    for (const pool of this.pools.values()) pooled += pool.length;
    let assetsReady = 0;
    let assetsFailed = 0;
    let textureBytesEstimate = 0;
    for (const id of this.registry.modelIds) {
      if (this.loader.status(id) === 'ready') {
        assetsReady += 1;
        textureBytesEstimate += this.loader.getMetadata(id)?.textureBytesEstimate || 0;
      } else if (this.loader.status(id) === 'fallback') assetsFailed += 1;
    }
    return {
      assetsTotal: this.registry.modelIds.length,
      assetsReady,
      assetsFailed,
      active: this.active.size,
      pooled,
      ...this._renderStats,
      textureBytesEstimate,
      estimatedCharacterDrawCalls: this._estimatedDrawCalls(),
    };
  }

  _estimatedDrawCalls() {
    let total = 0;
    for (const entity of this.active.values()) {
      if (entity.root.visible && entity.ready) total += entity.meshCount;
    }
    return total;
  }

  _poolKey(modelId, faction) {
    return `${modelId}:${faction}`;
  }

  _attach(entity, asset) {
    if (!asset || entity.ready) return false;
    const variants = this._materialsFor(entity.modelId, entity.faction, asset.scene);
    const attached = entity.attach(asset, variants, {
      castShadow: Boolean(this.engine?.runtimeQuality?.shadows && !this.batterySaver),
    });
    if (attached) {
      entity.setReducedMotion(this.reducedMotion);
      this.engine?.applyRuntimeSettingsTo?.(entity.root);
    }
    return attached;
  }

  _attachReadyEntities(modelId = null) {
    for (const entity of this.active.values()) {
      if (modelId && entity.modelId !== modelId) continue;
      if (!entity.ready) this._attach(entity, this.loader.getAsset(entity.modelId));
    }
    for (const [poolKey, pool] of this.pools) {
      if (modelId && !poolKey.startsWith(`${modelId}:`)) continue;
      for (const entity of pool) if (!entity.ready) this._attach(entity, this.loader.getAsset(entity.modelId));
    }
  }

  _materialsFor(modelId, faction, sourceScene) {
    const key = this._poolKey(modelId, faction);
    const cached = this.materialVariants.get(key);
    if (cached) return cached;
    const variants = new Map();
    const sourceMaterials = new Set();
    sourceScene.traverse((node) => {
      if (!node.isMesh) return;
      for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
        if (material) sourceMaterials.add(material);
      }
    });
    const tint = faction === 1 ? FACTION_TINTS.raider : FACTION_TINTS.defender;
    for (const source of sourceMaterials) {
      const material = source.clone();
      material.name = `${source.name || 'character-material'}:${key}`;
      if (material.color?.isColor) material.color.multiply(tint);
      material.needsUpdate = true;
      variants.set(source, material);
    }
    this.materialVariants.set(key, variants);
    return variants;
  }

  _onAssetStatus(status) {
    if (this._disposed) return;
    this.bus?.emit(EVENTS.CHARACTER_ASSET_STATUS, { ...status });
    if (status.status === 'ready') this._attachReadyEntities(status.modelId);
  }

  _reportAssetError(report) {
    // Detailed diagnostics stay in the console; no technical string reaches the player's UI.
    void report;
  }

  update(dt) {
    if (this._disposed || this.active.size === 0 || !(dt > 0)) return;
    this._animationAccumulator += Math.min(dt, 0.1);
    if (this._animationAccumulator < this.animationStepSeconds) return;
    const animationDelta = Math.min(this._animationAccumulator, 0.1);
    this._animationAccumulator = 0;
    for (const entity of this.active.values()) {
      if (entity.root.visible) entity.updateAnimation(animationDelta);
    }
  }

  dispose() {
    if (this._disposed) return;
    for (const off of this._unsubscribers) off();
    this._unsubscribers.length = 0;
    for (const key of [...this.active.keys()]) this.release(key);
    for (const pool of this.pools.values()) for (const entity of pool) entity.dispose();
    this.pools.clear();
    this.active.clear();
    for (const variants of this.materialVariants.values()) {
      for (const material of variants.values()) material.dispose();
    }
    this.materialVariants.clear();
    this.loader.dispose();
    this.group.removeFromParent();
    this._disposed = true;
  }
}
