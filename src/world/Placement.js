/**
 * Placement — deterministic scattering of props (trees, rocks, shrubs).
 *
 * Pure logic: it produces plain data ({x, z, scale, yaw, ...}), the renderer
 * (world/Decor.js) only turns that data into InstancedMeshes.
 * Same seed + same data files => identical world on every device.
 */
import { Rng } from '../core/RNG.js';
import { degToRad, smoothstep, TAU } from '../core/MathUtils.js';

/** Uniform spatial hash used to enforce minimum distances cheaply. */
class SpatialHash {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.cells = new Map();
  }

  _key(cx, cz) {
    return `${cx}:${cz}`;
  }

  insert(x, z) {
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    const key = this._key(cx, cz);
    let bucket = this.cells.get(key);
    if (!bucket) {
      bucket = [];
      this.cells.set(key, bucket);
    }
    bucket.push({ x, z });
  }

  /** true when any stored point is closer than `radius`. */
  hasWithin(x, z, radius) {
    const reach = Math.ceil(radius / this.cellSize);
    const cx = Math.floor(x / this.cellSize);
    const cz = Math.floor(z / this.cellSize);
    const radiusSq = radius * radius;
    for (let dz = -reach; dz <= reach; dz += 1) {
      for (let dx = -reach; dx <= reach; dx += 1) {
        const bucket = this.cells.get(this._key(cx + dx, cz + dz));
        if (!bucket) continue;
        for (const point of bucket) {
          const ddx = point.x - x;
          const ddz = point.z - z;
          if (ddx * ddx + ddz * ddz < radiusSq) return true;
        }
      }
    }
    return false;
  }
}

function makeItem(kind, x, z, rng, spec) {
  return {
    kind,
    x,
    z,
    scale: rng.range(spec.scaleRange[0], spec.scaleRange[1]),
    yaw: rng.range(0, TAU),
    tiltX: kind === 'tree' ? rng.centered(degToRad(spec.tiltDeg ?? 0)) : rng.centered(degToRad(6)),
    tiltZ: kind === 'tree' ? rng.centered(degToRad(spec.tiltDeg ?? 0)) : rng.centered(degToRad(6)),
    stretch: kind === 'rock' ? { x: rng.range(0.75, 1.3), y: rng.range(0.7, 1.25), z: rng.range(0.75, 1.3) } : null,
    colorSeed: rng.int(1, 0x7fff),
    colorJitter: spec.colorJitter ?? 0.12,
    variant: rng.chance(spec.variantChance ?? 0),
  };
}

/**
 * @param {object} options
 * @param {import('../core/Config.js').Config} options.config
 * @param {import('./TerrainMap.js').TerrainMap} options.map
 */
export function generatePlacements({ config, map }) {
  const decor = config.terrain.decor;
  const placement = decor.placement;
  const tileSize = config.tileSize;
  const areaScale = config.areaScale;
  const qualityScale = config.quality.decorScale;
  const seed = (config.seed ^ placement.seedOffset) >>> 0;

  /** @type {Record<string, Array<object>>} */
  const result = { tree: [], rock: [], shrub: [] };
  const occupancy = new SpatialHash(tileSize * 3);
  const stats = { attempts: 0, rejected: { density: 0, path: 0, reserved: 0, spacing: 0, soil: 0, edge: 0 } };

  const kinds = [
    { name: 'tree', spec: decor.tree },
    { name: 'rock', spec: decor.rock },
    { name: 'shrub', spec: decor.shrub },
  ];

  for (const { name, spec } of kinds) {
    const kindRng = new Rng((seed + name.length * 7919) >>> 0);
    const target = Math.max(0, Math.round(spec.baseCount * areaScale * qualityScale));
    const spacing = spec.spacingTiles * tileSize;
    const pathMargin = spec.keepOffPathsTiles * tileSize;
    const edgeLimit = placement.skirtFadeTiles * tileSize * 0.5;
    const maxAttempts = Math.max(64, target * placement.maxAttemptsPerItem);

    const clusterRng = new Rng((seed + name.length * 104729) >>> 0);

    const acceptSpot = (x, z, itemSpacing, allowSoil) => {
      if (!map.isInsideAt(x, z)) {
        stats.rejected.edge += 1;
        return false;
      }
      if (map.edgeDistanceAt(x, z) < edgeLimit) {
        stats.rejected.edge += 1;
        return false;
      }
      if (map.pathClearanceAt(x, z) < pathMargin) {
        stats.rejected.path += 1;
        return false;
      }
      if (map.isReservedAt(x, z, tileSize)) {
        stats.rejected.reserved += 1;
        return false;
      }
      if (!allowSoil && map.soilAt(x, z) > 0.5) {
        stats.rejected.soil += 1;
        return false;
      }
      if (occupancy.hasWithin(x, z, itemSpacing)) {
        stats.rejected.spacing += 1;
        return false;
      }
      return true;
    };

    let placed = 0;
    let attempts = 0;
    while (placed < target && attempts < maxAttempts) {
      attempts += 1;
      stats.attempts += 1;

      const x = kindRng.range(0, map.width);
      const z = kindRng.range(0, map.depth);

      const density = map.densityAt(x, z, spec.density);
      const probability = smoothstep(spec.density.threshold, spec.density.threshold + 0.24, density);
      if (!kindRng.chance(probability)) {
        stats.rejected.density += 1;
        continue;
      }

      const allowSoil = name !== 'tree';
      if (!acceptSpot(x, z, spacing * 0.5, allowSoil)) continue;

      result[name].push(makeItem(name, x, z, kindRng, spec));
      occupancy.insert(x, z);
      placed += 1;

      // Rocks like to sit in small fields instead of being spread out evenly.
      if (name === 'rock' && kindRng.chance(spec.clusterChance ?? 0)) {
        const [minSize, maxSize] = spec.clusterSize ?? [2, 4];
        const size = kindRng.int(minSize, maxSize);
        for (let i = 0; i < size; i += 1) {
          const angle = clusterRng.range(0, TAU);
          const distance = clusterRng.range(0.9, 2.6) * tileSize;
          const cx = x + Math.cos(angle) * distance;
          const cz = z + Math.sin(angle) * distance;
          if (acceptSpot(cx, cz, spacing * 0.42, true)) {
            result[name].push(makeItem(name, cx, cz, kindRng, spec));
            occupancy.insert(cx, cz);
            placed += 1;
          }
        }
      }
    }
  }

  stats.counts = { tree: result.tree.length, rock: result.rock.length, shrub: result.shrub.length };
  return { placements: result, stats };
}

/** Split placements into per chunk buckets (chunking is already future proof). */
export function splitPlacementsByChunk(placements, { tileSize, chunkSizeTiles, cols, rows }) {
  const chunks = new Map();
  const chunkWorld = chunkSizeTiles * tileSize;
  const keyOf = (x, z) => {
    const cx = Math.floor(x / chunkWorld);
    const cz = Math.floor(z / chunkWorld);
    return { cx, cz };
  };

  for (const [kind, items] of Object.entries(placements)) {
    for (const item of items) {
      const { cx, cz } = keyOf(item.x, item.z);
      const key = `${cx}:${cz}`;
      let bucket = chunks.get(key);
      if (!bucket) {
        bucket = { cx, cz, tileSize, chunkSizeTiles, cols, rows, items: { tree: [], rock: [], shrub: [] } };
        chunks.set(key, bucket);
      }
      bucket.items[kind].push(item);
    }
  }

  return chunks;
}
