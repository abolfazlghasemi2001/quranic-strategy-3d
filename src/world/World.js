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

    this._unsubscribers = [];
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
    const center = this.config.mapCenter;
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

    if (sun.castShadow) {
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
    if (this.sky) this.sky.update(dt, engine);
    if (this.markers) this.markers.update(dt, engine);
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
