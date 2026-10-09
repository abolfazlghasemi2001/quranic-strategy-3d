/**
 * World — owns everything that lives in the 3D scene:
 * lights, terrain, chunked decoration, sky dome and the tap markers.
 *
 * The build is asynchronous and reports progress so the loading screen can show
 * Persian step titles instead of freezing on a white screen.
 */
import * as THREE from 'three';
import { TerrainMap } from './TerrainMap.js';
import { generatePlacements, splitPlacementsByChunk } from './Placement.js';
import { Terrain } from './Terrain.js';
import { SkyDome } from './SkyDome.js';
import { Markers } from './Markers.js';
import { Chunk } from './Chunk.js';
import { DayNightCycle } from './DayNightCycle.js';
import { EVENTS } from '../core/EventBus.js';

const nextFrame = () => new Promise((resolve) => window.requestAnimationFrame(() => resolve()));

export class World {
  /**
   * @param {object} options
   * @param {import('../core/Config.js').Config} options.config
   * @param {import('../core/EventBus.js').EventBus} [options.bus]
   */
  constructor({ config, bus = null }) {
    this.config = config;
    this.bus = bus;

    this.group = new THREE.Group();
    this.group.name = 'world';

    this.map = new TerrainMap(config);
    /** @type {Map<string, Chunk>} */
    this.chunks = new Map();

    this.placements = { tree: [], rock: [], shrub: [] };
    this.placementStats = null;
    this.terrain = null;
    this.sky = null;
    this.markers = null;
    this.lights = {};
    this.built = false;
    this.dayNight = new DayNightCycle(config.world.lighting.dayCycle || {});
    this.dayNightState = this.dayNight.sample();
    this.reducedMotion = false;
    this.animationTime = 0;
    this._palette = this._createLightingPalette();
    this._cycleScratch = {
      sun: new THREE.Color(),
      hemisphereSky: new THREE.Color(),
      hemisphereGround: new THREE.Color(),
      ambient: new THREE.Color(),
      zenith: new THREE.Color(),
      horizon: new THREE.Color(),
      below: new THREE.Color(),
      glow: new THREE.Color(),
      fog: new THREE.Color(),
    };

    this._unsubscribers = [];
    this._disposed = false; this._engine = null; this.shadowRig = null; this.shadowPromise = null;
    this._shadowDirty = true; this._center = config.mapCenter;
    this._skyLighting = { sunDirection: null, zenith: this._cycleScratch.zenith, horizon: this._cycleScratch.horizon, below: this._cycleScratch.below, glow: this._cycleScratch.glow, glowStrength: 0 };
    if (bus) this._unsubscribers.push(...[EVENTS.CAMERA_CHANGED, EVENTS.RESIZE, EVENTS.QUALITY_CHANGED, EVENTS.BUILDING_ADDED, EVENTS.BUILDING_REMOVED, EVENTS.BUILDING_UPDATED].map((event) => bus.on(event, () => this.markShadowDirty())));
  }

  /* --------------------------------------------------------------- build */

  async build(onProgress = () => {}) {
    const report = (step, ratio) => onProgress(step, ratio);

    report('engine', 0.08);
    await nextFrame();

    this._buildLights();

    report('terrain', 0.2);
    await nextFrame();

    this.terrain = new Terrain({ config: this.config, map: this.map });
    this.group.add(this.terrain.build());

    report('decor', 0.55);
    await nextFrame();

    const { placements, stats } = generatePlacements({ config: this.config, map: this.map });
    this.placements = placements;
    this.placementStats = stats;
    this._buildChunks(placements);

    report('sky', 0.85);
    await nextFrame();

    this.sky = new SkyDome({ config: this.config });
    this.group.add(this.sky.mesh);

    this.markers = new Markers({ config: this.config, bus: this.bus });
    this.group.add(this.markers.group);

    if (this.bus) {
      this._unsubscribers.push(
        this.bus.on(EVENTS.CONTEXT_RESTORED, () => this.terrain && this.terrain.markTexturesForUpload()),
      );
    }

    this.built = true;
    report('done', 1);
    if (this.bus) this.bus.emit(EVENTS.WORLD_READY, this.describe());
    return this;
  }

  _buildLights() {
    const lighting = this.config.world.lighting;
    const center = this._center;
    const sunDirection = this.config.sunDirection;

    const sun = new THREE.DirectionalLight(new THREE.Color(lighting.sun.color), lighting.sun.intensity);
    sun.name = 'sun';
    sun.position.set(
      center.x + sunDirection.x * lighting.sun.distance,
      sunDirection.y * lighting.sun.distance,
      center.z + sunDirection.z * lighting.sun.distance,
    );
    sun.target.position.set(center.x, 0, center.z);
    sun.castShadow = Boolean(this.config.quality.shadows);
    // The solar direction changes continuously; refresh the map on a short,
    // explicit cadence instead of paying for a full shadow render every frame.
    sun.shadow.autoUpdate = false;

    { // Initialize even in low: a later quality switch must not inherit a tiny default frustum.
      const size = this.config.quality.shadowMapSize || 1024;
      const half = Math.max(this.config.worldWidth, this.config.worldDepth) * 0.5 + lighting.sun.shadowPadding;
      sun.shadow.mapSize.set(size, size);
      sun.shadow.camera.left = -half;
      sun.shadow.camera.right = half;
      sun.shadow.camera.top = half;
      sun.shadow.camera.bottom = -half;
      sun.shadow.camera.near = 1;
      sun.shadow.camera.far = lighting.sun.distance * 2.2;
      sun.shadow.bias = lighting.sun.shadowBias;
      sun.shadow.normalBias = lighting.sun.shadowNormalBias;
      sun.shadow.camera.updateProjectionMatrix();
    }

    const hemisphere = new THREE.HemisphereLight(
      new THREE.Color(lighting.hemisphere.skyColor),
      new THREE.Color(lighting.hemisphere.groundColor),
      lighting.hemisphere.intensity,
    );
    hemisphere.name = 'hemisphere';

    const ambient = new THREE.AmbientLight(new THREE.Color(lighting.ambient.color), lighting.ambient.intensity);
    ambient.name = 'ambient';

    this.group.add(sun, sun.target, hemisphere, ambient);
    this.lights = { sun, hemisphere, ambient };
  }

  _buildChunks(placements) {
    const buckets = splitPlacementsByChunk(placements, {
      tileSize: this.config.tileSize,
      chunkSizeTiles: this.config.chunkSizeTiles,
      cols: this.config.cols,
      rows: this.config.rows,
    });

    const chunkWorld = this.config.chunkSizeTiles * this.config.tileSize;

    for (const [key, bucket] of buckets) {
      const chunk = new Chunk({
        config: this.config,
        key,
        coord: { cx: bucket.cx, cz: bucket.cz },
        bounds: {
          minX: bucket.cx * chunkWorld,
          maxX: (bucket.cx + 1) * chunkWorld,
          minZ: bucket.cz * chunkWorld,
          maxZ: (bucket.cz + 1) * chunkWorld,
        },
        items: bucket.items,
      });
      chunk.build();
      this.group.add(chunk.group);
      this.chunks.set(key, chunk);
    }
  }

  /* --------------------------------------------------------------- frame */

  update(dt, engine) {
    this._engine = engine;
    if (!this.reducedMotion && Number.isFinite(dt) && dt > 0) this.animationTime += dt;
    this.dayNightState = this.dayNight.update(dt, { reducedMotion: this.reducedMotion });
    this._applyDayNight(this.dayNightState, engine);

    if (this.terrain) this.terrain.update(this.animationTime, this.dayNightState.daylight);
    for (const chunk of this.chunks.values()) chunk.decor?.update(this.animationTime);
    const animationDelta = this.reducedMotion ? 0 : dt;
    if (this.sky) this.sky.update(animationDelta, engine);
    if (this.markers) this.markers.update(animationDelta, engine);
  }

  setReducedMotion(enabled) {
    this.reducedMotion = Boolean(enabled);
    return this.reducedMotion;
  }

  _createLightingPalette() {
    const colors = this.config.world.lighting.dayCycle?.colors || {};
    const values = {
      sunDay: colors.sunDay || this.config.world.lighting.sun.color,
      sunTwilight: colors.sunTwilight || '#ffb46e',
      sunNight: colors.sunNight || '#a9c8ff',
      hemisphereSkyDay: colors.hemisphereSkyDay || this.config.world.lighting.hemisphere.skyColor,
      hemisphereSkyNight: colors.hemisphereSkyNight || '#263d68',
      hemisphereGroundDay: colors.hemisphereGroundDay || this.config.world.lighting.hemisphere.groundColor,
      hemisphereGroundNight: colors.hemisphereGroundNight || '#202738',
      ambientDay: colors.ambientDay || this.config.world.lighting.ambient.color,
      ambientNight: colors.ambientNight || '#8698c2',
      skyZenithDay: colors.skyZenithDay || this.config.world.sky.zenith,
      skyZenithNight: colors.skyZenithNight || '#101b39',
      skyHorizonDay: colors.skyHorizonDay || this.config.world.sky.horizon,
      skyHorizonNight: colors.skyHorizonNight || '#283b5c',
      skyHorizonTwilight: colors.skyHorizonTwilight || '#df886b',
      skyBelowDay: colors.skyBelowDay || this.config.world.sky.below,
      skyBelowNight: colors.skyBelowNight || '#18233e',
      skyGlowDay: colors.skyGlowDay || this.config.world.sky.glow,
      skyGlowNight: colors.skyGlowNight || '#7998c7',
      skyGlowTwilight: colors.skyGlowTwilight || '#ffc078',
      fogDay: colors.fogDay || this.config.world.fog.color,
      fogNight: colors.fogNight || '#18243a',
    };
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, new THREE.Color(value)]));
  }

  _applyDayNight(state, engine) {
    const cycle = this.config.world.lighting.dayCycle || {};
    const lighting = this.config.world.lighting;
    const palette = this._palette;
    const scratch = this._cycleScratch;
    const day = state.daylight;
    const dusk = state.twilight;
    const direction = state.sunDirection;

    if (this.lights.sun) {
      const center = this._center;
      const distance = lighting.sun.distance;
      this.lights.sun.position.set(
        center.x + direction.x * distance,
        direction.y * distance,
        center.z + direction.z * distance,
      );
      this.lights.sun.target.position.set(center.x, 0, center.z);
      scratch.sun.copy(palette.sunNight).lerp(palette.sunDay, day).lerp(palette.sunTwilight, dusk * 0.72);
      this.lights.sun.color.copy(scratch.sun);
      this.lights.sun.intensity = (cycle.sunIntensityNight ?? 0.1)
        + ((cycle.sunIntensityDay ?? lighting.sun.intensity) - (cycle.sunIntensityNight ?? 0.1)) * day
        + dusk * 0.1;

      this.lights.sun.castShadow = Boolean(engine?.renderer?.shadowMap?.enabled && state.elevation >= (lighting.sun.stableShadow?.minSunElevation || 0.08));
      const shadowsEnabled = this.lights.sun.castShadow;
      const refreshSeconds = Math.max(0.25, Number(cycle.shadowRefreshSeconds) || 1.5);
      if (shadowsEnabled && this.animationTime >= (this._nextShadowRefresh || 0)) {
        this.lights.sun.shadow.needsUpdate = true;
        engine.renderer.shadowMap.needsUpdate = true;
        this._nextShadowRefresh = this.animationTime + refreshSeconds;
      }
    }

    if (this.lights.hemisphere) {
      scratch.hemisphereSky.copy(palette.hemisphereSkyNight).lerp(palette.hemisphereSkyDay, day);
      scratch.hemisphereGround.copy(palette.hemisphereGroundNight).lerp(palette.hemisphereGroundDay, day);
      this.lights.hemisphere.color.copy(scratch.hemisphereSky);
      this.lights.hemisphere.groundColor.copy(scratch.hemisphereGround);
      this.lights.hemisphere.intensity = (cycle.hemisphereIntensityNight ?? 0.3)
        + ((cycle.hemisphereIntensityDay ?? lighting.hemisphere.intensity) - (cycle.hemisphereIntensityNight ?? 0.3)) * day;
    }

    if (this.lights.ambient) {
      scratch.ambient.copy(palette.ambientNight).lerp(palette.ambientDay, day);
      this.lights.ambient.color.copy(scratch.ambient);
      this.lights.ambient.intensity = (cycle.ambientIntensityNight ?? 0.22)
        + ((cycle.ambientIntensityDay ?? lighting.ambient.intensity) - (cycle.ambientIntensityNight ?? 0.22)) * day;
    }

    scratch.zenith.copy(palette.skyZenithNight).lerp(palette.skyZenithDay, day);
    scratch.horizon.copy(palette.skyHorizonNight).lerp(palette.skyHorizonDay, day).lerp(palette.skyHorizonTwilight, dusk * 0.74);
    scratch.below.copy(palette.skyBelowNight).lerp(palette.skyBelowDay, day);
    scratch.glow.copy(palette.skyGlowNight).lerp(palette.skyGlowDay, day).lerp(palette.skyGlowTwilight, dusk * 0.72);
    this._skyLighting.sunDirection = direction;
    this._skyLighting.glowStrength = (0.14 + day * 0.64 + dusk * 0.22) * (this.config.world.sky.glowStrength ?? 0.85);
    this._skyLighting.starsStrength = engine?.runtimeQualityTier === 'low' ? 0 : (1 - day) * (this.config.world.sky.starsStrength || 0.7);
    this.sky?.setLighting(this._skyLighting);

    if (engine?.scene?.fog) {
      scratch.fog.copy(palette.fogNight).lerp(palette.fogDay, day).lerp(palette.skyHorizonTwilight, dusk * 0.18);
      engine.scene.fog.color.copy(scratch.fog);
    }
  }

  markShadowDirty() { this._shadowDirty = true; this._engine?.markShadowDirty?.(); }

  beforeRender(engine) {
    const light = this.lights.sun;
    if (!light?.castShadow || !engine.renderer?.shadowMap?.enabled) return;
    if (!this.shadowRig && !this.shadowPromise) this.shadowPromise = import('./ShadowRig.js').then(({ ShadowRig }) => {
      if (this._disposed) return;
      this.shadowRig = new ShadowRig({ width: this.config.worldWidth, depth: this.config.worldDepth, settings: this.config.world.lighting.sun.stableShadow }); this.markShadowDirty();
    });
    if (!this.shadowRig || (!this._shadowDirty && !engine.renderer.shadowMap.needsUpdate)) return;
    const azimuth = (this.config.world.lighting.dayCycle.sunAzimuthDeg + this.dayNightState.phase * 360) * Math.PI / 180;
    this.shadowRig.fit(engine.camera, light, azimuth);
    light.shadow.needsUpdate = true; engine.renderer.shadowMap.needsUpdate = true; this._shadowDirty = false;
  }

  /* --------------------------------------------------------------- query */

  /** Flat terrain for now; later phases can raise terrain and this stays the single source. */
  getGroundHeight(_x, _z) {
    return 0;
  }

  /** Tile coordinates of a world position, or null when it is off the grid. */
  getCellAt(x, z) {
    if (!this.map.isInsideAt(x, z)) return null;
    const { col, row } = this.config.worldToTile(x, z);
    // clampTile = round(coord - 0.5) ≡ floor(coord): pass the continuous tile
    // coordinate as-is (adding 0.5 here shifted every tap by half a tile).
    return this.config.clampTile(col, row);
  }

  isInsideMap(x, z) {
    return this.map.isInsideAt(x, z);
  }

  setGridVisible(visible) {
    if (this.terrain) this.terrain.setGridVisible(visible);
  }

  get gridVisible() {
    return this.terrain ? this.terrain.gridVisible : false;
  }

  /** Summary used by the dev panel and the acceptance checklist. */
  describe() {
    const chunkList = Array.from(this.chunks.values());
    return {
      seed: this.config.seed,
      tiles: { cols: this.config.cols, rows: this.config.rows, tileSize: this.config.tileSize },
      worldSize: { width: this.config.worldWidth, depth: this.config.worldDepth },
      chunks: chunkList.length,
      props: {
        tree: this.placements.tree.length,
        rock: this.placements.rock.length,
        shrub: this.placements.shrub.length,
      },
      instancedMeshes: chunkList.reduce((sum, chunk) => sum + (chunk.decor ? chunk.decor.meshes.length : 0), 0),
      placementStats: this.placementStats,
      quality: this.config.quality.tier,
    };
  }

  /* ------------------------------------------------------------- dispose */

  dispose() {
    this._disposed = true;
    for (const unsubscribe of this._unsubscribers) unsubscribe();
    this._unsubscribers.length = 0;

    for (const chunk of this.chunks.values()) chunk.dispose();
    this.chunks.clear();

    if (this.terrain) {
      this.terrain.dispose();
      this.terrain = null;
    }
    if (this.sky) {
      this.sky.dispose();
      this.sky = null;
    }
    if (this.markers) {
      this.markers.dispose();
      this.markers = null;
    }
    for (const light of Object.values(this.lights)) {
      if (light.target) light.target.parent?.remove(light.target);
      light.parent?.remove(light);
      light.dispose?.();
    }
    this.lights = {};

    if (this.group.parent) this.group.parent.remove(this.group);
    this.built = false;
  }
}
