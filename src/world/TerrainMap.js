/**
 * TerrainMap — pure (non-rendering) description of the map layout.
 *
 * Holds the data driven terrain features (paths, soil patches, the reserved
 * centre plot) and answers the spatial questions every system asks:
 * "is this spot grass?", "how far is the nearest road?", "how dense is the
 * vegetation noise here?".
 *
 * No Three.js and no DOM: this module is unit-testable in plain Node.
 */
import { clamp, clamp01 } from '../core/MathUtils.js';
import { fbm2D } from '../core/Noise.js';

export const TILE_FLAGS = Object.freeze({
  PATH: 1 << 0,
  SOIL: 1 << 1,
  RESERVED: 1 << 2,
  OUTSIDE: 1 << 3,
});

export class TerrainMap {
  constructor(config) {
    this.config = config;
    this.cols = config.cols;
    this.rows = config.rows;
    this.tileSize = config.tileSize;
    this.width = config.worldWidth;
    this.depth = config.worldDepth;
    this.bounds = { minX: 0, minZ: 0, maxX: this.width, maxZ: this.depth };

    this.pathRects = (config.terrain.paths || []).map((rect) => this._toWorldRect(rect.from, rect.to));
    this.soilPatches = (config.terrain.soilPatches || []).map((patch) => ({
      x: (patch.center.col + 0.5) * this.tileSize,
      z: (patch.center.row + 0.5) * this.tileSize,
      radius: Math.max(0.5, patch.radiusTiles) * this.tileSize,
      blobs: Math.max(1, patch.blobs ?? 9),
      seed: patch.seed ?? 1,
    }));

    const reserveTiles = config.world.centerReserveTiles || 0;
    const centerCol = this.cols / 2;
    const centerRow = this.rows / 2;
    this.reserve = {
      minX: (centerCol - reserveTiles) * this.tileSize,
      maxX: (centerCol + reserveTiles) * this.tileSize,
      minZ: (centerRow - reserveTiles) * this.tileSize,
      maxZ: (centerRow + reserveTiles) * this.tileSize,
    };
  }

  _toWorldRect(from, to) {
    const minCol = Math.min(from.col, to.col);
    const maxCol = Math.max(from.col, to.col);
    const minRow = Math.min(from.row, to.row);
    const maxRow = Math.max(from.row, to.row);
    return {
      minX: minCol * this.tileSize,
      maxX: (maxCol + 1) * this.tileSize,
      minZ: minRow * this.tileSize,
      maxZ: (maxRow + 1) * this.tileSize,
    };
  }

  isInsideAt(x, z) {
    return x >= 0 && z >= 0 && x <= this.width && z <= this.depth;
  }

  /** Distance to the closest path; negative when the point sits on a road. */
  pathClearanceAt(x, z) {
    let best = Infinity;
    for (const rect of this.pathRects) {
      const dx = Math.max(rect.minX - x, 0, x - rect.maxX);
      const dz = Math.max(rect.minZ - z, 0, z - rect.maxZ);
      if (dx === 0 && dz === 0) {
        const penetration = Math.min(x - rect.minX, rect.maxX - x, z - rect.minZ, rect.maxZ - z);
        best = Math.min(best, -penetration);
      } else {
        best = Math.min(best, Math.hypot(dx, dz));
      }
    }
    return best;
  }

  isPathAt(x, z, margin = 0) {
    return this.pathClearanceAt(x, z) <= margin;
  }

  /** Soil influence in [0,1] — used to keep trees off the bare dirt patches. */
  soilAt(x, z) {
    let influence = 0;
    for (const patch of this.soilPatches) {
      const distance = Math.hypot(x - patch.x, z - patch.z) / patch.radius;
      if (distance > 1.65) continue;
      const wobble = fbm2D(x * 0.11, z * 0.11, { octaves: 2, seed: patch.seed }) - 0.5;
      influence = Math.max(influence, clamp01(1 - distance + wobble * 0.9));
    }
    return influence;
  }

  isReservedAt(x, z, margin = 0) {
    const r = this.reserve;
    return (
      x >= r.minX - margin && x <= r.maxX + margin && z >= r.minZ - margin && z <= r.maxZ + margin
    );
  }

  /** Vegetation / rock density field in [0,1] (clustered, not uniform). */
  densityAt(x, z, { scale = 0.075, octaves = 3, seed = 0 } = {}) {
    return fbm2D(x * scale, z * scale, { octaves, seed: (this.config.seed + seed) >>> 0 });
  }

  /** Distance in world units to the nearest border of the buildable grid. */
  edgeDistanceAt(x, z) {
    return Math.min(x, z, this.width - x, this.depth - z);
  }

  /** Can a building be placed here? (roads and the reserved centre are excluded) */
  isBuildableAt(x, z) {
    return this.isInsideAt(x, z) && !this.isPathAt(x, z) && this.soilAt(x, z) < 0.6 && !this.isReservedAt(x, z);
  }

  /** Tile grid flags — the future pathfinding/simulation grid. */
  toTileFlags() {
    const flags = new Uint8Array(this.cols * this.rows);
    for (let row = 0; row < this.rows; row += 1) {
      for (let col = 0; col < this.cols; col += 1) {
        const x = (col + 0.5) * this.tileSize;
        const z = (row + 0.5) * this.tileSize;
        let value = 0;
        if (this.pathClearanceAt(x, z) <= 0) value |= TILE_FLAGS.PATH;
        if (this.soilAt(x, z) > 0.55) value |= TILE_FLAGS.SOIL;
        if (this.isReservedAt(x, z)) value |= TILE_FLAGS.RESERVED;
        flags[row * this.cols + col] = value;
      }
    }
    return flags;
  }

  /** Clamp a world position into the grid (used by tap handling). */
  clampToMap(x, z) {
    return { x: clamp(x, 0, this.width), z: clamp(z, 0, this.depth) };
  }
}
