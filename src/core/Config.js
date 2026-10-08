/**
 * Config — the single source of truth, loaded from the JSON files in src/data.
 * Nothing in the codebase hardcodes gameplay/world numbers: systems read them from here.
 */
import worldData from '../data/world.json';
import terrainData from '../data/terrain.json';
import qualityData from '../data/quality.json';
import gameplayData from '../data/gameplay.json';
import stringsFa from '../data/strings.fa.json';
import economyData from '../data/economy.json';
import balanceData from '../data/balance.json';
import quranLearningData from '../data/quran-learning.json';
import campaignData from '../data/campaign.json';
import missionsData from '../data/missions.json';
import { hash2i } from './RNG.js';
import { clamp } from './MathUtils.js';

export const QUALITY_TIERS = Object.freeze(['low', 'medium', 'high']);

/** JSON based deep clone: works on every browser that runs the game (no structuredClone needed). */
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function deepFreeze(object) {
  if (object && typeof object === 'object' && !Object.isFrozen(object)) {
    Object.freeze(object);
    for (const value of Object.values(object)) deepFreeze(value);
  }
  return object;
}

/**
 * Auto quality detection. Runs before the renderer exists because
 * `antialias` and the pixel ratio cap must be decided at construction time.
 */
export function detectQualityTier(env = {}) {
  const detection = qualityData.detection;
  const coarsePointer =
    env.coarsePointer ??
    (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(pointer: coarse)').matches
      : false);
  const cores = env.cores ?? (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4);
  const memory = env.memory ?? (typeof navigator !== 'undefined' ? navigator.deviceMemory : undefined);

  if (coarsePointer && (cores <= detection.lowMaxCores || (typeof memory === 'number' && memory <= detection.lowMaxMemoryGb))) {
    return 'low';
  }
  if (coarsePointer) return 'medium';
  return cores >= detection.highMinCores ? 'high' : 'medium';
}

export class Config {
  /**
   * @param {object} [options]
   * @param {string} [options.search] - location.search, allows ?quality=low|medium|high
   * @param {object} [options.env] - overrides for tests ({ cores, memory, coarsePointer })
   */
  constructor({ search = '', env = {} } = {}) {
    this.sources = {
      world: worldData,
      terrain: terrainData,
      quality: qualityData,
      gameplay: gameplayData,
      strings: stringsFa,
      economy: economyData,
      balance: balanceData,
      quranLearning: quranLearningData,
      campaign: campaignData,
      missions: missionsData,
    };

    this.world = deepFreeze(clone(worldData));
    this.terrain = deepFreeze(clone(terrainData));
    this.gameplay = deepFreeze(clone(gameplayData));
    this.strings = deepFreeze(clone(stringsFa));
    this.economy = deepFreeze(clone(economyData));
    this.balance = deepFreeze(clone(balanceData));
    /** Phase 4 tuning — numbers only; no Quran text ever lives in code. */
    this.quranLearning = deepFreeze(clone(quranLearningData));
    /** Phase 6 campaign tuning (numbers, policy notes, labels) — no Quran text. */
    this.campaign = deepFreeze(clone(campaignData));
    /** Phase 6 mission definitions — narrative + verse *references* only. */
    this.missions = deepFreeze(clone(missionsData));

    const requested = new URLSearchParams(search).get('quality');
    this.tier = QUALITY_TIERS.includes(requested) ? requested : detectQualityTier(env);
    this.quality = deepFreeze({
      tier: this.tier,
      ...deepMerge(qualityData.defaults, qualityData.tiers[this.tier] || {}),
    });
    /** Acceptance budgets (fps / draw calls / triangles) — used by the dev panel. */
    this.targets = deepFreeze(clone(qualityData.targets || {}));

    this.seed = this.world.seed >>> 0;
  }

  /* ---------------------------------------------------------------- helpers */

  /** Text lookup with a dotted key: t('hud.cameraReset'). */
  t(key, fallback = '') {
    const parts = String(key).split('.');
    let node = this.strings;
    for (const part of parts) {
      if (node == null || typeof node !== 'object') return fallback;
      node = node[part];
    }
    return typeof node === 'string' ? node : fallback;
  }

  /* ------------------------------------------------------------- terrain */

  get tileSize() {
    return this.terrain.tileSize;
  }

  get cols() {
    return this.terrain.grid.cols;
  }

  get rows() {
    return this.terrain.grid.rows;
  }

  get worldWidth() {
    return this.cols * this.tileSize;
  }

  get worldDepth() {
    return this.rows * this.tileSize;
  }

  get mapCenter() {
    return { x: this.worldWidth * 0.5, z: this.worldDepth * 0.5 };
  }

  /** Number of tiles in one chunk (chunking is already in place for later phases). */
  get chunkSizeTiles() {
    return this.world.chunk.sizeTiles;
  }

  /** World position of the centre of a tile. */
  tileCenter(col, row) {
    return {
      x: (col + 0.5) * this.tileSize,
      z: (row + 0.5) * this.tileSize,
    };
  }

  /** Continuous tile coordinates of a world position (may be outside the grid). */
  worldToTile(x, z) {
    return { col: x / this.tileSize, row: z / this.tileSize };
  }

  /** Integer tile of a world position, clamped to the grid. */
  clampTile(col, row) {
    return {
      col: clamp(Math.round(col - 0.5), 0, this.cols - 1),
      row: clamp(Math.round(row - 0.5), 0, this.rows - 1),
    };
  }

  isInsideMap(x, z) {
    return x >= 0 && z >= 0 && x <= this.worldWidth && z <= this.worldDepth;
  }

  /** Deterministic per-tile seed — later phases use it for buildings/props/content. */
  seedAt(col, row, salt = 0) {
    return hash2i(col, row, (this.seed + salt) >>> 0);
  }

  /* -------------------------------------------------------------- camera */

  get camera() {
    return this.world.camera;
  }

  get focusBounds() {
    const padding = this.world.camera.focusPadding;
    return {
      minX: -padding,
      maxX: this.worldWidth + padding,
      minZ: -padding,
      maxZ: this.worldDepth + padding,
    };
  }

  get startFocus() {
    const start = this.world.camera.startFocus || {};
    const center = this.mapCenter;
    return {
      x: typeof start.x === 'number' ? start.x : center.x,
      z: typeof start.z === 'number' ? start.z : center.z,
    };
  }

  /* ------------------------------------------------------------ lighting */

  get sunDirection() {
    const { elevationDeg, azimuthDeg } = this.world.lighting.sun;
    const elevation = (elevationDeg * Math.PI) / 180;
    const azimuth = (azimuthDeg * Math.PI) / 180;
    const horizontal = Math.cos(elevation);
    return {
      x: Math.sin(azimuth) * horizontal,
      y: Math.sin(elevation),
      z: Math.cos(azimuth) * horizontal,
    };
  }

  get fogEnabled() {
    return Boolean(this.world.fog.enabled && this.quality.fog);
  }

  /* ---------------------------------------------------------------- perf */

  /** Ground area normalized to the 40x40 reference map, so counts scale with map size. */
  get areaScale() {
    return (this.cols * this.rows) / 1600;
  }
}
