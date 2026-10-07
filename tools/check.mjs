#!/usr/bin/env node
/**
 * Self tests for the framework-free layers of «شهر نور» (phase 1).
 *
 *   node tools/check.mjs     (or: npm run check)
 *
 * The tests cover the logic that must be provably correct without a GPU:
 * data files, deterministic generation, the terrain map, the decor scatter and
 * the camera clamp rules (the "camera never leaves the map" acceptance item).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as THREE from 'three';

import { hash2i, mulberry32, Rng } from '../src/core/RNG.js';
import { fbm2D, valueNoise2D } from '../src/core/Noise.js';
import { clamp, damp, degToRad, smoothstep, wrapAngle } from '../src/core/MathUtils.js';
import {
  createGroundQuad,
  createRockGeometry,
  createShrubGeometry,
  createTreeGeometries,
  mergeGeometries,
} from '../src/core/GeometryUtils.js';
import { TerrainMap } from '../src/world/TerrainMap.js';
import { World } from '../src/world/World.js';
import { generatePlacements, splitPlacementsByChunk } from '../src/world/Placement.js';
import { OrbitCameraRig } from '../src/core/OrbitCameraRig.js';
import { GameState } from '../src/game/GameState.js';
import { EconomySystem } from '../src/game/EconomySystem.js';
import { BuildQueue } from '../src/game/BuildQueue.js';
import { SaveSystem, migrateRecord, SAVE_SCHEMA_VERSION } from '../src/game/SaveSystem.js';
import { LearningSystem } from '../src/game/quran/LearningSystem.js';
import { Leitner } from '../src/game/quran/Leitner.js';
import {
  QuranDatasetLoader,
  hasDiacritics,
  normalizeDataset,
  PLACEHOLDER_LABEL,
  REVIEW_PENDING_LABEL,
  validateDataset,
  verseBadges,
} from '../src/game/quran/QuranDataset.js';
import { wordMatchPairsFor, tokensPool } from '../src/game/quran/content.js';
import { AyahCompletionGame } from '../src/game/quran/minigames/AyahCompletion.js';
import { WordMatchGame } from '../src/game/quran/minigames/WordMatch.js';
import { AyahOrderGame } from '../src/game/quran/minigames/AyahOrder.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const readJson = (relative) => JSON.parse(readFileSync(resolve(root, relative), 'utf8'));

const world = readJson('src/data/world.json');
const terrain = readJson('src/data/terrain.json');
const quality = readJson('src/data/quality.json');
const gameplay = readJson('src/data/gameplay.json');
const strings = readJson('src/data/strings.fa.json');
const economyData = readJson('src/data/economy.json');
const balanceData = readJson('src/data/balance.json');
const buildingsData = readJson('src/data/buildings.json');

const WORLD_WIDTH = terrain.grid.cols * terrain.tileSize;
const WORLD_DEPTH = terrain.grid.rows * terrain.tileSize;
const PADDING = world.camera.focusPadding;

/** Minimal stand-in for src/core/Config.js (which imports JSON via Vite). */
function makeConfig(tier = 'high') {
  const config = {
    world,
    terrain,
    gameplay,
    strings,
    quality: { tier, ...quality.defaults, ...(quality.tiers[tier] || {}) },
    targets: quality.targets,
    seed: world.seed >>> 0,
    // Mirrors src/core/Config.js tile math (Config imports JSON → not loadable in plain Node).
    worldToTile(x, z) {
      return { col: x / terrain.tileSize, row: z / terrain.tileSize };
    },
    clampTile(col, row) {
      return {
        col: clamp(Math.round(col - 0.5), 0, terrain.grid.cols - 1),
        row: clamp(Math.round(row - 0.5), 0, terrain.grid.rows - 1),
      };
    },
  };
  Object.defineProperties(config, {
    tileSize: { get: () => terrain.tileSize },
    cols: { get: () => terrain.grid.cols },
    rows: { get: () => terrain.grid.rows },
    worldWidth: { get: () => WORLD_WIDTH },
    worldDepth: { get: () => WORLD_DEPTH },
    areaScale: { get: () => (terrain.grid.cols * terrain.grid.rows) / 1600 },
    mapCenter: { get: () => ({ x: WORLD_WIDTH * 0.5, z: WORLD_DEPTH * 0.5 }) },
    chunkSizeTiles: { get: () => world.chunk.sizeTiles },
    camera: { get: () => world.camera },
    focusBounds: {
      get: () => ({ minX: -PADDING, maxX: WORLD_WIDTH + PADDING, minZ: -PADDING, maxZ: WORLD_DEPTH + PADDING }),
    },
    startFocus: { get: () => ({ x: WORLD_WIDTH * 0.5, z: WORLD_DEPTH * 0.5 }) },
    sunDirection: {
      get: () => {
        const elevation = degToRad(world.lighting.sun.elevationDeg);
        const azimuth = degToRad(world.lighting.sun.azimuthDeg);
        return { x: Math.sin(azimuth) * Math.cos(elevation), y: Math.sin(elevation), z: Math.cos(azimuth) * Math.cos(elevation) };
      },
    },
    fogEnabled: { get: () => Boolean(world.fog.enabled && config.quality.fog) },
  });
  return config;
}

/* ------------------------------------------------------------- test runner */

const results = [];
let failures = 0;
const pending = [];

function test(name, fn) {
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      // async test: resolve before the report (see await flushPending() below)
      pending.push(
        out.then(() => results.push({ name, ok: true, message: '' })).catch((error) => {
          failures += 1;
          results.push({ name, ok: false, message: error.message });
        }),
      );
      return;
    }
    results.push({ name, ok: true, message: '' });
  } catch (error) {
    failures += 1;
    results.push({ name, ok: false, message: error.message });
  }
}

async function flushPending() {
  while (pending.length > 0) {
    await Promise.all(pending.splice(0, pending.length));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function assertClose(a, b, epsilon, message) {
  if (!(Math.abs(a - b) <= epsilon)) throw new Error(`${message || 'not close'}: ${a} vs ${b}`);
}

/* ------------------------------------------------------------------- data */

test('data: all json files parse and hold the expected structure', () => {
  assert(terrain.tileSize > 0, 'tileSize');
  assert(terrain.grid.cols === 40 && terrain.grid.rows === 40, 'grid should default to 40x40 (configurable)');
  assert(Array.isArray(terrain.paths) && terrain.paths.length > 0, 'paths');
  assert(world.seed > 0, 'seed');
  assert(world.camera.pitchDeg > 0 && world.camera.pitchDeg < 90, 'pitch');
  assert(gameplay.logicHz > 0, 'logicHz');
  assert(strings.hud && typeof strings.hud.fps === 'string', 'persian strings');
});

test('data: every quality tier caps the pixel ratio at 2', () => {
  for (const [tierName, tier] of Object.entries(quality.tiers)) {
    const merged = { ...quality.defaults, ...tier };
    assert(merged.maxPixelRatio <= 2, `${tierName} maxPixelRatio must be <= 2`);
    assert(merged.maxPixelRatio >= 1, `${tierName} maxPixelRatio must be >= 1`);
    assert(Number.isFinite(merged.decorScale) && merged.decorScale > 0, `${tierName} decorScale`);
  }
});

test('data: paths and soil patches stay inside the grid', () => {
  for (const path of terrain.paths) {
    assert(path.from.col >= 0 && path.to.col <= terrain.grid.cols - 1, 'path cols');
    assert(path.from.row >= 0 && path.to.row <= terrain.grid.rows - 1, 'path rows');
  }
  for (const patch of terrain.soilPatches) {
    assert(patch.center.col > 0 && patch.center.col < terrain.grid.cols, 'patch col');
    assert(patch.center.row > 0 && patch.center.row < terrain.grid.rows, 'patch row');
  }
});

test('data: the world size is derived from the grid config (80x80 world units)', () => {
  assertClose(WORLD_WIDTH, 80, 1e-9, 'world width');
  assertClose(WORLD_DEPTH, 80, 1e-9, 'world depth');
});

/* -------------------------------------------------------------------- rng */

test('rng: hashes and generators are deterministic', () => {
  assert(hash2i(3, 7, 1234) === hash2i(3, 7, 1234), 'hash2i must be stable');
  assert(hash2i(3, 7, 1234) !== hash2i(3, 8, 1234), 'hash2i must depend on coordinates');

  const a = mulberry32(42);
  const b = mulberry32(42);
  const first = [a(), a(), a(), a()];
  const second = [b(), b(), b(), b()];
  assert(JSON.stringify(first) === JSON.stringify(second), 'mulberry32 must be reproducible');
  for (const value of first) assert(value >= 0 && value < 1, 'mulberry32 range [0,1)');

  const rng = new Rng(7);
  for (let i = 0; i < 50; i += 1) {
    const value = rng.range(2, 5);
    assert(value >= 2 && value < 5, 'rng.range bounds');
  }
});

test('noise: value noise and fbm stay inside [0,1]', () => {
  for (let i = 0; i < 200; i += 1) {
    const x = i * 0.37;
    const z = i * -0.11;
    const n = valueNoise2D(x, z, 99);
    const f = fbm2D(x, z, { octaves: 4, seed: 5 });
    assert(n >= 0 && n <= 1, 'valueNoise range');
    assert(f >= 0 && f <= 1, 'fbm range');
  }
});

/* --------------------------------------------------------------- geometry */

test('geometry: ground quad keeps world-unit UVs and faces up', () => {
  const geometry = createGroundQuad({ x0: -10, z0: -10, x1: 30, z1: 30, y: 0, uvScale: 5 });
  assert(geometry.attributes.position.count === 4, 'quad vertices');
  assert(geometry.index.count === 6, 'quad triangles');

  const positions = geometry.attributes.position.array;
  const uvs = geometry.attributes.uv.array;
  assertClose(positions[0], -10, 1e-6, 'first vertex x');
  assertClose(uvs[0], -2, 1e-6, 'uv x = world x / uvScale');
  assertClose(uvs[1], -2, 1e-6, 'uv y = world z / uvScale');

  const normals = geometry.attributes.normal.array;
  for (let i = 1; i < normals.length; i += 3) assertClose(normals[i], 1, 1e-6, 'normal must point up (+Y)');
  geometry.dispose();
});

test('geometry: jitter is deterministic (same seed => identical rock)', () => {
  const a = createRockGeometry({ radius: 0.5, detail: 1, seed: 11 });
  const b = createRockGeometry({ radius: 0.5, detail: 1, seed: 11 });
  const c = createRockGeometry({ radius: 0.5, detail: 1, seed: 12 });
  assert(JSON.stringify(Array.from(a.attributes.position.array)) === JSON.stringify(Array.from(b.attributes.position.array)), 'same seed');
  assert(JSON.stringify(Array.from(a.attributes.position.array)) !== JSON.stringify(Array.from(c.attributes.position.array)), 'different seed');
  for (const value of a.attributes.position.array) assert(Number.isFinite(value), 'no NaN in jittered geometry');
  a.dispose();
  b.dispose();
  c.dispose();
});

test('geometry: tree parts are low poly and sit on the ground', () => {
  const { trunk, foliage } = createTreeGeometries({ seed: 3 });
  const trunkTris = trunk.attributes.position.count / 3;
  const foliageTris = foliage.attributes.position.count / 3;
  assert(trunkTris < 40, `trunk should stay low poly (got ${trunkTris} triangles)`);
  assert(foliageTris < 80, `foliage should stay low poly (got ${foliageTris} triangles)`);

  const min = (geometry) => {
    let value = Infinity;
    const array = geometry.attributes.position.array;
    for (let i = 1; i < array.length; i += 3) value = Math.min(value, array[i]);
    return value;
  };
  assert(min(trunk) >= -0.05, 'trunk origin sits on the ground');
  assert(min(foliage) > 0, 'foliage starts above the ground');
  trunk.dispose();
  foliage.dispose();
});

test('geometry: merge combines vertex counts and can be instanced', () => {
  const a = createShrubGeometry({ seed: 1 });
  const b = createShrubGeometry({ seed: 2 });
  const total = a.attributes.position.count + b.attributes.position.count;
  const merged = mergeGeometries([a, b]);
  assert(merged.attributes.position.count === total, 'merged vertex count');
  assert(merged.attributes.normal && merged.attributes.uv, 'merged attributes');
  merged.dispose();
});

/* ------------------------------------------------------------ terrain map */

test('terrain map: roads, soil and the reserved centre are recognised', () => {
  const config = makeConfig();
  const map = new TerrainMap(config);

  // main road tile (config: cols 18..21, rows 0..39)
  const roadX = 19.5 * config.tileSize;
  const roadZ = 20 * config.tileSize;
  assert(map.pathClearanceAt(roadX, roadZ) <= 0, 'point on the main road must be a path');
  assert(!map.isBuildableAt(roadX, roadZ), 'roads are not buildable');

  const center = config.mapCenter;
  assert(map.isReservedAt(center.x, center.z), 'map centre is reserved');
  assert(!map.isBuildableAt(center.x, center.z), 'reserved centre is not buildable');

  const patch = terrain.soilPatches[0];
  const patchX = (patch.center.col + 0.5) * config.tileSize;
  const patchZ = (patch.center.row + 0.5) * config.tileSize;
  assert(map.soilAt(patchX, patchZ) > 0.5, 'soil patch centre should read as dirt');
  assert(map.isBuildableAt(patchX, patchZ) === false, 'bare dirt is not buildable in phase 1');

  assert(map.isInsideAt(-1, 5) === false, 'outside left border');
  assert(map.isInsideAt(WORLD_WIDTH + 1, 5) === false, 'outside right border');
});

test('terrain map: tile flags mark the road grid', () => {
  const config = makeConfig();
  const map = new TerrainMap(config);
  const flags = map.toTileFlags();
  assert(flags.length === config.cols * config.rows, 'flag grid size');
  const pathTiles = Array.from(flags).filter((value) => (value & 1) !== 0).length;
  assert(pathTiles > 150, `expected the road network to cover many tiles (got ${pathTiles})`);
});

test('world: getCellAt maps tile centres/edges to their own tile (regression: half-tile shift)', () => {
  const config = makeConfig();
  const w = new World({ config });
  const ts = terrain.tileSize;
  const cases = [[0, 0], [1, 1], [5, 5], [6, 5], [10, 10], [19, 19], [20, 20], [39, 39]];
  for (const [c, r] of cases) {
    // Exact tile centre — what a tap ray through the middle of a tile hits.
    const centre = w.getCellAt((c + 0.5) * ts, (r + 0.5) * ts);
    assert(centre && centre.col === c && centre.row === r, `centre (${c},${r}) → ${JSON.stringify(centre)}`);
    // Last fraction inside the tile still belongs to it (floor semantics).
    const edge = w.getCellAt((c + 1) * ts - 1e-6, (r + 1) * ts - 1e-6);
    assert(edge && edge.col === c && edge.row === r, `edge (${c},${r}) → ${JSON.stringify(edge)}`);
  }
  // A coordinate exactly on a boundary belongs to the next tile.
  const boundary = w.getCellAt(10 * ts, 10 * ts);
  assert(boundary.col === 10 && boundary.row === 10, `boundary → ${JSON.stringify(boundary)}`);
  // Off the grid → null (keeps taps outside the map from selecting anything).
  assert(w.getCellAt(-1, 4) === null && w.getCellAt(4, -1) === null, 'outside grid must be null');
});

/* -------------------------------------------------------------- placement */

test('placement: scattering is deterministic and respects every rule', () => {
  const configA = makeConfig('high');
  const configB = makeConfig('high');
  const mapA = new TerrainMap(configA);
  const mapB = new TerrainMap(configB);

  const first = generatePlacements({ config: configA, map: mapA });
  const second = generatePlacements({ config: configB, map: mapB });
  assert(JSON.stringify(first.placements) === JSON.stringify(second.placements), 'same seed must rebuild the same world');

  const { tree, rock, shrub } = first.placements;
  assert(tree.length > 40, `expected a decent number of trees (got ${tree.length})`);
  assert(rock.length > 20, `expected rocks (got ${rock.length})`);
  assert(shrub.length > 20, `expected shrubs (got ${shrub.length})`);

  const keepOff = terrain.decor.tree.keepOffPathsTiles * configA.tileSize;
  for (const item of tree) {
    assert(mapA.isInsideAt(item.x, item.z), 'tree inside the map');
    assert(mapA.pathClearanceAt(item.x, item.z) >= keepOff - 1e-6, 'trees keep off the roads');
    assert(!mapA.isReservedAt(item.x, item.z, configA.tileSize), 'trees keep out of the reserved centre');
    assert(mapA.soilAt(item.x, item.z) <= 0.5, 'trees do not grow on bare soil');
    assert(item.scale >= terrain.decor.tree.scaleRange[0] && item.scale <= terrain.decor.tree.scaleRange[1], 'tree scale range');
  }

  // minimum spacing between trees (grid bucketed check)
  const spacing = terrain.decor.tree.spacingTiles * configA.tileSize * 0.5;
  const cell = Math.max(1, spacing);
  const buckets = new Map();
  const key = (x, z) => `${Math.floor(x / cell)}:${Math.floor(z / cell)}`;
  for (const item of tree) {
    const k = key(item.x, item.z);
    const bucket = buckets.get(k) || [];
    for (const other of bucket) {
      const distance = Math.hypot(item.x - other.x, item.z - other.z);
      assert(distance >= spacing - 1e-6, `trees must not overlap (${distance.toFixed(3)} < ${spacing.toFixed(3)})`);
    }
    bucket.push(item);
    buckets.set(k, bucket);
  }
});

test('placement: quality tiers scale the amount of decor', () => {
  const low = generatePlacements({ config: makeConfig('low'), map: new TerrainMap(makeConfig('low')) });
  const high = generatePlacements({ config: makeConfig('high'), map: new TerrainMap(makeConfig('high')) });
  const lowTotal = low.placements.tree.length + low.placements.rock.length + low.placements.shrub.length;
  const highTotal = high.placements.tree.length + high.placements.rock.length + high.placements.shrub.length;
  assert(lowTotal < highTotal, `low tier should place fewer props (${lowTotal} vs ${highTotal})`);
  assert(highTotal > 100, 'high tier should have a rich world');
});

test('placement: chunk splitting keeps every prop', () => {
  const config = makeConfig('medium');
  const map = new TerrainMap(config);
  const { placements } = generatePlacements({ config, map });
  const buckets = splitPlacementsByChunk(placements, {
    tileSize: config.tileSize,
    chunkSizeTiles: config.chunkSizeTiles,
    cols: config.cols,
    rows: config.rows,
  });
  const expected = placements.tree.length + placements.rock.length + placements.shrub.length;
  let total = 0;
  for (const bucket of buckets.values()) {
    total += bucket.items.tree.length + bucket.items.rock.length + bucket.items.shrub.length;
  }
  assert(total === expected, `chunk split lost props (${total} vs ${expected})`);
  assert(buckets.size === 1, `a 40x40 map with 40 tile chunks is a single chunk (got ${buckets.size})`);
});

/* ------------------------------------------------------------ perf budget */

test('perf: draw call and triangle budget for the whole scene', () => {
  const config = makeConfig('high');
  const map = new TerrainMap(config);
  const { placements } = generatePlacements({ config, map });

  // ground 1 + grid lines 2 + sky 1 + 4 instanced meshes per non empty chunk
  const staticCalls = 4;
  const perChunkCalls = ['tree', 'rock', 'shrub'].filter((kind) => placements[kind].length > 0).length;
  const instancedCalls = perChunkCalls === 3 ? 4 : perChunkCalls + 1;
  const drawCalls = staticCalls + instancedCalls;
  assert(drawCalls < quality.targets.maxDrawCalls, `draw calls ${drawCalls} must stay under ${quality.targets.maxDrawCalls}`);

  const treeTris = placements.tree.length * 33;
  const rockTris = placements.rock.length * 80;
  const shrubTris = placements.shrub.length * 20;
  const groundTris = 2;
  const total = treeTris + rockTris + shrubTris + groundTris;
  assert(total < quality.targets.maxTriangles, `triangle budget exceeded: ${total}`);
  assert(total < 60000, `vegetation should stay lightweight (got ${total} triangles)`);
});

/* ----------------------------------------------------------------- camera */

function makeRig(config, viewport = { width: 800, height: 600 }) {
  const camera = new THREE.PerspectiveCamera(config.camera.fov, viewport.width / viewport.height, config.camera.near, config.camera.far);
  const intents = {
    pan: { x: 0, y: 0 },
    zoom: 0,
    rotatePx: 0,
    twist: 0,
    isPanning: false,
    pointerCount: 0,
    keys: new Set(),
  };
  const input = {
    intents,
    consume() {
      const out = { ...intents, pan: { ...intents.pan }, keys: intents.keys };
      intents.pan.x = 0;
      intents.pan.y = 0;
      intents.zoom = 0;
      intents.rotatePx = 0;
      intents.twist = 0;
      return out;
    },
  };
  const rig = new OrbitCameraRig({ camera, config, input });
  return { rig, camera, intents, engine: { viewport } };
}

test('camera: fixed pitch, zoom limits and frame independent smoothing', () => {
  const config = makeConfig();
  const { rig, camera, intents, engine } = makeRig(config);

  assertClose(rig.pitch, degToRad(config.camera.pitchDeg), 1e-9, 'pitch comes from the data');

  // zoom far in and far out
  for (let i = 0; i < 400; i += 1) rig.update(1 / 60, engine);
  assertClose(rig.distance, config.camera.distance, 1e-3, 'distance is stable without input');

  intents.zoom = 50;
  for (let i = 0; i < 200; i += 1) rig.update(1 / 60, engine);
  assertClose(rig.distance, config.camera.minDistance, 1e-3, 'zoom in clamps to minDistance');

  intents.zoom = -200;
  for (let i = 0; i < 400; i += 1) rig.update(1 / 60, engine);
  assertClose(rig.distance, config.camera.maxDistance, 1e-3, 'zoom out clamps to maxDistance');

  // the camera must sit above the ground
  assert(camera.position.y > 5, 'camera stays above the terrain');
});

test('camera: the focus point can never leave the map bounds', () => {
  const config = makeConfig();
  const { rig, intents, engine } = makeRig(config);
  const bounds = config.focusBounds;

  const pushes = [
    { x: 4000, y: 0 },
    { x: -4000, y: 0 },
    { x: 0, y: 4000 },
    { x: 0, y: -4000 },
    { x: 3000, y: 3000 },
    { x: -3000, y: -3000 },
  ];

  for (const pan of pushes) {
    for (let i = 0; i < 120; i += 1) {
      intents.pan.x = pan.x;
      intents.pan.y = pan.y;
      intents.isPanning = true;
      rig.update(1 / 60, engine);
    }
    for (let i = 0; i < 240; i += 1) {
      intents.isPanning = false;
      intents.pan.x = 0;
      intents.pan.y = 0;
      rig.update(1 / 60, engine); // let inertia run out
    }
    assert(rig.focus.x >= bounds.minX - 1e-3 && rig.focus.x <= bounds.maxX + 1e-3, `focus.x inside bounds (${rig.focus.x})`);
    assert(rig.focus.z >= bounds.minZ - 1e-3 && rig.focus.z <= bounds.maxZ + 1e-3, `focus.z inside bounds (${rig.focus.z})`);
    assert(rig.targetFocus.x >= bounds.minX - 1e-3 && rig.targetFocus.x <= bounds.maxX + 1e-3, 'target focus x');
    assert(rig.targetFocus.z >= bounds.minZ - 1e-3 && rig.targetFocus.z <= bounds.maxZ + 1e-3, 'target focus z');
  }
});

test('camera: dragging right moves the content with the finger', () => {
  const config = makeConfig();
  const { rig, intents, engine } = makeRig(config);
  const before = { x: rig.targetFocus.x, z: rig.targetFocus.z };

  intents.pan.x = 120;
  intents.isPanning = true;
  rig.update(1 / 60, engine);

  const moved = { x: rig.targetFocus.x - before.x, z: rig.targetFocus.z - before.z };
  const distance = Math.hypot(moved.x, moved.z);
  assert(distance > 0.1, 'a drag must move the camera');
  assert(rig.unitsPerPixel > 0 && rig.unitsPerPixel < 5, 'units per pixel is plausible');

  // grabbing the ground: the focus moves opposite to the finger along screen X
  const right = new THREE.Vector3(-Math.sin(rig.yaw), 0, -Math.cos(rig.yaw)).cross(new THREE.Vector3(0, 1, 0)).normalize();
  const alongRight = moved.x * right.x + moved.z * right.z;
  assert(alongRight < 0, 'dragging right must move the camera to the left of the world');
});

test('camera: screenToGround hits the focus point at the screen centre', () => {
  const config = makeConfig();
  const { rig, engine } = makeRig(config);
  for (let i = 0; i < 60; i += 1) rig.update(1 / 60, engine);

  const hit = rig.screenToGround(engine.viewport.width / 2, engine.viewport.height / 2, engine.viewport);
  assert(hit != null, 'centre of the screen must hit the ground plane');
  assertClose(hit.x, rig.focus.x, 0.6, 'ray hits near the focus (x)');
  assertClose(hit.z, rig.focus.z, 0.6, 'ray hits near the focus (z)');

  const sky = rig.screenToGround(engine.viewport.width / 2, -400, engine.viewport);
  assert(sky === null || sky.z < rig.focus.z, 'rays above the horizon must not return a ground point behind the camera');
});

/* ------------------------------------------------------------------ utils */

test('utils: math helpers behave', () => {
  assertClose(clamp(5, 0, 1), 1, 1e-9, 'clamp');
  assertClose(damp(0, 10, 10, 1), 10 * (1 - Math.exp(-10)), 1e-6, 'damp');
  assertClose(smoothstep(0, 1, 0.5), 0.5, 1e-9, 'smoothstep');
  assertClose(wrapAngle(Math.PI * 2.5), Math.PI * 0.5, 1e-9, 'wrapAngle');
  assert(Math.abs(degToRad(180) - Math.PI) < 1e-9, 'degToRad');
});

/* ================================================== phase 3: economy & time */

const HOUR = 3600 * 1000;

/** Minimal game wiring for economy/queue tests (no DOM, no Three). */
function makeEconomy({ seedTown = true } = {}) {
  const state = new GameState({ economy: economyData });
  const economy = new EconomySystem({ economy: economyData, balance: balanceData, defs: buildingsData.buildings, state });
  const queue = new BuildQueue({ economyData, economy, state });
  const T0 = 1_700_000_000_000; // fixed epoch for determinism
  if (seedTown) {
    const tc = buildingsData.buildings.find((b) => b.id === 'town-center');
    state.createEntity({ type: tc.id, name: tc.name, col: 18, row: 18, size: tc.size, level: 1, status: 'ready', lastAccrualAt: T0 });
  }
  return { state, economy, queue, T0 };
}

function addProducer(economy, state, defId, at = 0) {
  const def = buildingsData.buildings.find((b) => b.id === defId);
  return state.createEntity({
    type: def.id, name: def.name, col: 1, row: 1, size: def.size, level: 1,
    status: 'ready', pending: 0, lastAccrualAt: at,
  });
}

test('balance: every building has a 10-level curve with monotonic costs and times', () => {
  const ids = buildingsData.buildings.map((b) => b.id);
  assert(balanceData.maxLevel === 10, 'maxLevel must be 10');
  for (const id of ids) {
    const table = balanceData.buildings[id];
    assert(table && table.levels.length === 10, `${id}: expected 10 levels`);
    for (let i = 0; i < 10; i += 1) {
      const entry = table.levels[i];
      assert(entry.level === i + 1, `${id}: level label ${entry.level} !== ${i + 1}`);
      assert(entry.cost && entry.cost.rizq >= 0 && entry.cost.nur >= 0 && entry.cost.hekmat >= 0, `${id} L${i + 1}: cost shape`);
      assert(Number.isFinite(entry.seconds) && entry.seconds > 0, `${id} L${i + 1}: seconds`);
      if (i > 0) {
        const prev = table.levels[i - 1];
        assert(entry.cost.rizq >= prev.cost.rizq, `${id}: rizq cost must not decrease at L${i + 1}`);
        assert(entry.seconds >= prev.seconds, `${id}: seconds must not decrease at L${i + 1}`);
      }
      const def = buildingsData.buildings.find((b) => b.id === id);
      if (def.produces) {
        assert(entry.resource === def.produces, `${id} L${i + 1}: resource tag`);
        assert(entry.ratePerHour > 0 && (i === 0 || entry.ratePerHour >= table.levels[i - 1].ratePerHour), `${id} L${i + 1}: ratePerHour`);
      }
    }
  }
});

test('economy: starting resources fit inside base storage capacity', () => {
  for (const key of Object.keys(economyData.storage.base)) {
    assert(economyData.starting[key] <= economyData.storage.base[key], `${key}: starting must fit base capacity`);
  }
  assert(economyData.builders.total === 2, 'two builders (acceptance ③)');
  assert(economyData.queue.maxJobs >= economyData.builders.total, 'queue must hold at least the active jobs');
  assert(economyData.speedup.minGohar >= 1 && economyData.speedup.goharPerMinute >= 1, 'speedup pricing');
  assert(economyData.goharSources.dailyBonus > 0 && economyData.goharSources.townCenterLevelReward > 0, 'gohar in-game sources exist');
  assert(economyData.offline.maxHours > 0, 'offline cap exists');
});

test('economy: capacity = base + per-level warehouse bonus (ready only)', () => {
  const { state, economy } = makeEconomy();
  const base = economy.capacity();
  assert(base.rizq === economyData.storage.base.rizq, 'base rizq');
  const wh = addProducer(economy, state, 'warehouse');
  wh.status = 'building'; // under construction: no capacity yet
  assert(economy.capacity().rizq === base.rizq, 'building warehouse grants no capacity');
  wh.status = 'ready';
  wh.level = 2;
  assert(
    economy.capacity().rizq === base.rizq + 2 * economyData.storage.perWarehouseLevel.rizq,
    'ready warehouse adds level × per-level capacity',
  );
  assert(economy.freeCapacity('rizq') === economy.capacity().rizq - state.resources.rizq, 'free = cap - stored');
});

test('economy: production accrues at rate/hour and stops at the buffer ceiling', () => {
  const { state, economy, T0 } = makeEconomy();
  const farm = addProducer(economy, state, 'farm', T0);
  const rate = economy.rateOf(farm);
  economy.accrue(T0 + 10 * 60 * 1000); // 10 minutes
  assert(Math.abs(farm.pending - (rate * 10) / 60) < 1e-6, `10min of production (got ${farm.pending})`);
  economy.accrue(T0 + 100 * HOUR); // way past bufferHours
  const cap = economy.bufferCap(farm);
  assert(farm.pending <= cap + 1e-6, 'buffer cap respected');
  assert(Math.abs(farm.pending - cap) < 1e-6, 'pending settles exactly at buffer cap');
});

test('economy: production stops when storage is full (acceptance ②)', () => {
  const { state, economy, T0 } = makeEconomy();
  const farm = addProducer(economy, state, 'farm', T0);
  state.resources.rizq = economy.capacity().rizq; // fill the warehouse
  economy.accrue(T0 + 60 * 60 * 1000);
  assert(farm.pending === 0, 'no production while storage is full');
  // spending frees space → production resumes
  state.resources.rizq -= 100;
  economy.accrue(T0 + 61 * 60 * 1000);
  assert(farm.pending > 0, 'production resumes once there is room');
});

test('economy: harvest moves min(pending, free) and never exceeds capacity', () => {
  const { state, economy, T0 } = makeEconomy();
  const farm = addProducer(economy, state, 'farm', T0);
  const cap = economy.capacity().rizq;
  state.resources.rizq = cap - 50;
  economy.accrue(T0 + 60 * 60 * 1000); // pending >> 50
  assert(farm.pending > 50, 'pending exceeds free space');
  const result = economy.harvest(farm, T0 + 60 * 60 * 1000);
  assert(result.moved === 50, `harvest clamps to free capacity (got ${result.moved})`);
  assert(state.resources.rizq === cap, 'storage ends exactly at capacity');
  assert(farm.pending > 0, 'leftover stays pending for later');
  assert(result.full === true, 'full flag set for the toast');
});

test('economy: offline accrual is clamped and backward clocks resync (acceptance ⑤)', () => {
  const { state, economy, T0 } = makeEconomy();
  const farm = addProducer(economy, state, 'farm', T0);
  economy.accrue(T0 + 1000 * HOUR); // absurd forward jump
  assert(farm.pending <= economy.bufferCap(farm) + 1e-6, 'offline gain bounded by buffer/capacity');
  // backward clock: gap must be zero, no negative production
  const before = farm.pending;
  economy.accrue(T0);
  assert(farm.pending === before, 'backward clock produces nothing');
  assert(farm.lastAccrualAt === T0, 'backward clock resyncs the timestamp');
});

test('economy: speedup cost = max(minGohar, ceil(remaining minutes) × perMinute)', () => {
  const { economy } = makeEconomy();
  const now = 1_700_000_000_000;
  const job = { status: 'active', endsAt: now + 90 * 1000 }; // 1.5 min left
  const expected = Math.max(economyData.speedup.minGohar, 2 * economyData.speedup.goharPerMinute);
  assert(economy.speedupCost(job, now) === expected, `speedup of 90s costs ${expected}`);
  const job2 = { status: 'active', endsAt: now + 5 * 1000 };
  assert(economy.speedupCost(job2, now) === economyData.speedup.minGohar, 'sub-minute remainder costs the minimum');
  assert(economy.speedupCost({ status: 'queued' }, now) === null, 'queued jobs cannot be sped up');
});

test('economy: gohar has no Math.random and no purchase path', async () => {
  for (const file of ['src/game/EconomySystem.js', 'src/game/BuildQueue.js', 'src/game/SaveSystem.js']) {
    const source = readFileSync(resolve(root, file), 'utf8');
    assert(!source.includes('Math.random'), `${file}: no randomness in economy/save logic`);
    // strip comments, then look for real purchase/buy APIs (not prose)
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert(!/\b(purchase|buy|lootBox|gacha)\s*\(/i.test(code), `${file}: no purchase calls`);
  }
});

test('queue: two builders run first jobs, others wait, chained fast-forward works', () => {
  const { state, economy, queue } = makeEconomy();
  const now = 1_700_000_000_000;
  const mk = (targetLevel, entityId) => ({ kind: 'upgrade', entityId, type: 'town-center', targetLevel, durationMs: 60_000 });
  const r1 = queue.enqueue(mk(2, 1), now);
  const r2 = queue.enqueue(mk(3, 2), now);
  const r3 = queue.enqueue(mk(4, 3), now);
  assert(r1.ok && r2.ok && r3.ok, 'three jobs accepted (maxJobs ≥ 3)');
  assert(queue.activeJobs().length === 2, 'exactly 2 active jobs (acceptance ③)');
  assert(queue.queuedJobs().length === 1, 'third job queued');
  assert(economy.state.jobs[2].status === 'queued', 'FIFO: third enqueue waits when builders are busy');

  // First minute: one finishes → the queued job takes the freed builder.
  const finished = queue.tick(now + 60_000);
  assert(finished.length === 2, `two jobs due at t+60s (got ${finished.length})`);
  // Both actives ended at now+60s; the queued job was promoted chained onto
  // that completion time (not from `now`), and one builder is then idle.
  const active = queue.activeJobs();
  assert(active.length === 1, `promoted job is the only active one (got ${active.length})`);
  const promoted = active[0];
  assert(promoted.targetLevel === 4, 'the queued job is the one running');
  assert(promoted.startedAt === now + 60_000, 'queued job chained onto completion time');
  assert(promoted.endsAt === now + 120_000, 'chained end time = start + duration');
  assert(queue.jobs.length === 1, 'completed jobs leave the queue');

  // Long offline gap: everything resolves in chronological order in one tick.
  const done = queue.tick(now + 10 * 60_000);
  assert(done.length === 1, 'the chained job completes too');
  assert(queue.jobs.length === 0, 'queue empty after the gap');
  void state;
});

test('queue: speedup spends gohar, finishes the active job immediately', () => {
  const { economy, queue } = makeEconomy();
  const now = 1_700_000_000_000;
  const r = queue.enqueue({ kind: 'build', entityId: 1, type: 'farm', targetLevel: 1, durationMs: 300_000 }, now);
  assert(r.ok, 'job enqueued');
  const goharBefore = economy.resources.gohar;
  const cost = economy.speedupCost(r.job, now);
  const result = queue.speedup(r.job.id, now + 1_000);
  assert(result.ok, 'speedup succeeds');
  assert(economy.resources.gohar === goharBefore - cost, 'gohar deducted');
  assert(queue.jobs.length === 0, 'job completed instantly');
});

test('queue: enqueue is rejected when the queue is full', () => {
  const { queue } = makeEconomy();
  const now = 1_700_000_000_000;
  const mk = (id) => ({ kind: 'build', entityId: id, type: 'wall', targetLevel: 1, durationMs: 60_000 });
  for (let i = 0; i < economyData.queue.maxJobs; i += 1) assert(queue.enqueue(mk(i + 10), now).ok, `job ${i} accepted`);
  const overflow = queue.enqueue(mk(99), now);
  assert(!overflow.ok && overflow.reason === 'queue-full', 'overflow rejected with queue-full');
});

test('save: v1 record migrates to current schema (gold→rizq etc.)', () => {
  const legacy = {
    id: 'main',
    schemaVersion: 1,
    savedAt: 1_690_000_000_000,
    payload: {
      version: 1,
      resources: { gold: 120, wood: 80, stone: 40 },
      entities: [{ id: 1, type: 'town-center', name: 'مرکز شهر', col: 18, row: 18, size: [3, 3], level: 2 }],
      tick: 42,
      tapCount: 7,
    },
  };
  const result = migrateRecord(legacy);
  assert(result && !result.future, 'migration succeeds');
  assert(result.migratedFrom === 1, 'reports the source version');
  assert(result.payload.resources.rizq === 120 && result.payload.resources.nur === 80 && result.payload.resources.hekmat === 40, 'resource rename');
  assert(result.payload.resources.gohar > 0, 'gohar default granted');
  assert(Array.isArray(result.payload.jobs) && result.payload.jobs.length === 0, 'jobs added');
  assert(result.payload.entities[0].status === 'ready' && result.payload.entities[0].pending === 0, 'entity production fields added');
  assert(result.payload.lastAccrualAt === 1_690_000_000_000, 'accrual timestamp seeded from savedAt');
});

test('save: future schema is backed up instead of crashing; current passes through', () => {
  const future = migrateRecord({ id: 'main', schemaVersion: SAVE_SCHEMA_VERSION + 1, savedAt: 1, payload: { resources: {} } });
  assert(future && future.future === true, 'future versions are flagged, not parsed');
  const current = migrateRecord({ id: 'main', schemaVersion: SAVE_SCHEMA_VERSION, savedAt: 2, payload: { resources: { rizq: 5 } } });
  assert(current && current.payload.resources.rizq === 5 && current.migratedFrom === null, 'current schema passes through');
  assert(migrateRecord(null) === null && migrateRecord({}) === null, 'garbage records return null');
});

test('save: memory-backend roundtrip preserves resources, entities and jobs', async () => {
  const store = new SaveSystem({ backend: 'memory' });
  const state = new GameState({ economy: economyData });
  state.resources.rizq = 123;
  state.createEntity({ type: 'farm', name: 'مزرعه', col: 2, row: 3, size: [3, 2], level: 4, status: 'ready', pending: 55.5, lastAccrualAt: 1_700_000_000_000 });
  state.jobs.push({ id: 'job-1', kind: 'build', entityId: 1, type: 'farm', targetLevel: 1, durationMs: 30_000, startedAt: 1, endsAt: 2, status: 'active' });
  await store.save(state.serialize());

  const record = await store.load();
  assert(record != null, 'record loads');
  assert(record.payload.schemaVersion === undefined, 'payload is the state, schema lives on the record');
  const restored = new GameState({ economy: economyData });
  restored.hydrate(record.payload);
  assert(restored.resources.rizq === 123, 'resources restored');
  assert(restored.entities.size === 1, 'entities restored');
  const farm = [...restored.entities.values()][0];
  assert(farm.level === 4 && farm.pending === 55.5 && farm.lastAccrualAt === 1_700_000_000_000, 'entity production state restored');
  assert(restored.jobs.length === 1 && restored.jobs[0].id === 'job-1', 'jobs restored');
  await store.clear();
  assert((await store.load()) == null, 'clear removes the save');
});

test('save: serialize contains no three.js roots', () => {
  const state = new GameState({ economy: economyData });
  const e = state.createEntity({ type: 'farm', name: 'x', col: 0, row: 0, size: [1, 1], level: 1, status: 'ready', root: { fake: 'three-object' } });
  const json = JSON.stringify(state.serialize());
  assert(!json.includes('three-object'), 'roots are stripped');
  assert(e.root != null, 'root still lives on the in-memory entity');
});

test('data: strings carry phase-3 and phase-4 labels (queue, offline, lesson)', () => {
  assert(strings.app.phase.includes('۳') || strings.app.phase.includes('۴'), 'phase label updated');
  assert(typeof strings.loading.steps.save === 'string', 'loading save step');
  assert(typeof strings.economy.queued === 'string' && typeof strings.economy.storageFull === 'string', 'economy strings');
  assert(typeof strings.loading.steps.quran === 'string', 'phase-4 loading step');
  assert(typeof strings.lesson?.start === 'string' && typeof strings.lesson?.noPenalty === 'string', 'lesson strings');
  assert(strings.quran.unreviewedBadge === REVIEW_PENDING_LABEL, 'the pending badge string matches the dataset label');
});



/* ================================================================ فاز ۴ — لایهٔ قرآنی-آموزشی */

const learningData = readJson('src/data/quran-learning.json');
const quranSample = readJson('src/data/quran-sample.json');

/** یک آیهٔ ساختگی با اعراب (از escape ساخته می‌شود؛ هیچ متن قرآنی نیست). */
function syntheticVerse(surahIndex, ayahIndex, extra = {}) {
  // ن + فتحه، ص + تنوین ... ساخته‌شده از کدهای یونیکد، نه از حافظه.
  const text = '\u0646\u064E\u0635\u064C \u0645\u064F\u0631\u064E\u0627\u062C\u064E\u0639\u064E\u0629\u064D \u0627\u0644\u062F\u0651\u064E\u064A\u0652\u062A\u064E\u0627\u0633\u0650\u062A';
  return {
    id: `ayah:${surahIndex}:${ayahIndex}`,
    surahIndex,
    surahName: `سورهٔ آزمون ${surahIndex}`,
    ayahIndex,
    textUthmani: text,
    translationFa: 'ترجمهٔ آزمون (متن واقعی نیست)',
    audio: null,
    source: { datasetId: 'test', version: '0', url: null, license: null, script: 'uthmani' },
    reviewed: true,
    placeholder: false,
    tokens: text.split(/\s+/),
    ...extra,
  };
}

const bundled = normalizeDataset(quranSample, { origin: 'bundled' });

/* --------------------------------------------------------------- دیتاست */

test('quran: the bundled sample carries no Quranic text and is fully labelled', () => {
  assert(bundled.meta.placeholder === true, 'sample meta is flagged placeholder');
  assert(bundled.meta.reviewed === false, 'sample meta is flagged unreviewed');
  assert(bundled.verseList.length >= 6, `sample has verses (${bundled.verseList.length})`);
  for (const verse of bundled.verseList) {
    assert(verse.placeholder === true, `${verse.id} flagged placeholder`);
    assert(verse.reviewed === false, `${verse.id} is unreviewed`);
    assert(verse.translationFa.includes('نمونه') && verse.translationFa.includes('جایگزین شود'),
      `${verse.id} translation carries the placeholder label`);
    assert(verse.textUthmani.length > 10 && !verse.source.datasetId.startsWith('tanzil'),
      `${verse.id} text comes from the placeholder sample, not from a verified dataset`);
    assert(hasDiacritics(verse.textUthmani), `${verse.id} placeholder keeps full diacritics for the font test`);
    assert(verse.source && verse.source.datasetId === 'quran-sample', `${verse.id} carries a source`);
    assert(verse.audio === null, `${verse.id} has no unlicensed audio`);
  }
  const badges = verseBadges(bundled.verseList[0]).map((b) => b.label);
  assert(badges.includes(PLACEHOLDER_LABEL), 'placeholder badge');
  assert(badges.includes(REVIEW_PENDING_LABEL), 'review-pending badge (acceptance: unreviewed verses are flagged)');
});

test('quran: validator catches empty text, missing diacritics and empty lessons', () => {
  const broken = normalizeDataset({
    meta: { datasetId: 'broken', reviewed: true },
    surahs: [{ index: 1, name: 'x', ayahs: [
      { index: 1, textUthmani: '', translationFa: 'x' },
      { index: 2, textUthmani: 'بدون اعراب', translationFa: 'y' },
    ] }],
    lessons: [{ id: 'l', title: 'l', steps: [] }],
  }, { origin: 'remote' });
  const report = validateDataset(broken);
  const codes = report.issues.map((i) => i.code);
  assert(codes.includes('missing-textUthmani'), 'empty text detected');
  assert(codes.includes('no-diacritics'), 'missing diacritics detected');
  assert(codes.includes('lesson-without-steps'), 'empty lesson detected');
  assert(report.ok === false, 'errors ⇒ not ok');
  assert(validateDataset(bundled).errors === 0, 'the bundled sample has no hard errors (placeholders stay warnings/info)');
});

test('quran: sample lessons are 2–3 minutes and cover all three minigames', () => {
  const games = new Set();
  for (const lesson of bundled.lessons) {
    const total = lesson.steps.reduce((sum, step) => sum + (step.seconds || 0), 0);
    assert(total >= 110 && total <= 190, `${lesson.id} lasts ${total}s (2–3 min)`);
    assert(lesson.wordBank.length >= 3, `${lesson.id} has a word bank`);
    for (const step of lesson.steps) if (step.game) games.add(step.game);
    const steps = lesson.steps.map((s) => s.kind);
    assert(steps.includes('read') && steps.includes('quiz') && steps.includes('summary'), `${lesson.id} has read/quiz/summary`);
  }
  assert(['ayah-completion', 'word-match', 'ayah-order'].every((id) => games.has(id)), 'all three minigames appear in the curriculum');
});

test('quran: a Tanzil-style dataset swaps in without code changes (verse text from remote, lessons kept)', async () => {
  const remote = {
    source: 'دیتاست بیرونی آزمون',
    sourceUrl: 'https://example.invalid/',
    license: 'CC-BY-TEST',
    version: '1.0',
    script: 'uthmani',
    reviewed: true,
    surahs: [{ index: 1, name: 'سورهٔ آزمون', ayahCount: 2, ayahs: [
      { index: 1, text: syntheticVerse(1, 1).textUthmani, translation: 'ترجمهٔ بیرونی ۱' },
      { index: 2, text: syntheticVerse(1, 2).textUthmani, translation: 'ترجمهٔ بیرونی ۲' },
    ] }],
  };
  const loader = new QuranDatasetLoader({
    sample: quranSample,
    learning: learningData,
    search: '',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => remote }),
  });
  const { dataset, validation, loadReport } = await loader.load();
  assert(loadReport.remoteLoaded === true, 'remote dataset loaded');
  assert(dataset.meta.origin === 'remote', 'meta marked remote');
  assert(dataset.meta.reviewed === true && dataset.meta.placeholder === false, 'review flag comes from the dataset');
  assert(dataset.verses.get('ayah:1:1').translationFa === 'ترجمهٔ بیرونی ۱', 'verse text/translation replaced by the remote dataset');
  assert(dataset.verses.get('ayah:1:1').reviewed === true, 'reviewed flag applied per verse');
  assert(verseBadges(dataset.verses.get('ayah:1:1')).every((b) => b.kind === 'reviewed'), 'no placeholder badge for a reviewed dataset');
  assert(dataset.lessons.length === bundled.lessons.length, 'curriculum reused from the bundled file');
  assert(validation.errors === 0, `remote validation clean (${validation.issues.map((i) => i.code).join(',')})`);
  assert(dataset.verseList.length >= 6, 'verses are merged, not dropped');
});

test('quran: a broken remote dataset falls back to the placeholder sample (no crash)', async () => {
  const loader = new QuranDatasetLoader({
    sample: quranSample,
    learning: learningData,
    search: '',
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ surahs: [{ index: 1, ayahs: [{ index: 1, text: '', translation: '' }] }] }) }),
  });
  const { dataset, loadReport } = await loader.load();
  assert(loadReport.remoteLoaded === false, 'invalid remote rejected');
  assert(dataset.meta.origin === 'bundled' && dataset.stats.placeholder === true, 'placeholder sample used instead');
  assert(dataset.verseList.length >= 6, 'sample verses intact');
});

test('quran: query param ?quran=… overrides the dataset path', () => {
  const loader = new QuranDatasetLoader({ sample: quranSample, learning: learningData, search: '?quran=./alt/my.json' });
  assert(loader.resolveUrl() === './alt/my.json', 'override honoured');
  const fallback = new QuranDatasetLoader({ sample: quranSample, learning: learningData, search: '' });
  assert(fallback.resolveUrl() === './quran/quran.json', 'default path is public/quran/quran.json');
});

/* -------------------------------------------------------------- مینی‌گیم‌ها */

function playAyahCompletion(game, { wrongAttempts = 1 } = {}) {
  let guard = 0;
  while (!game.done && guard < 200) {
    guard += 1;
    const round = game.current;
    if (!round) break;
    const wrong = round.options.filter((o) => !o.correct && !round.disabled.includes(o.id));
    for (let i = 0; i < wrongAttempts && i < wrong.length; i += 1) game.answer(wrong[i].id);
    game.answer(round.options.find((o) => o.correct).id);
  }
  return guard;
}

function playWordMatch(game, { wrongAttempts = 1 } = {}) {
  let guard = 0;
  while (!game.done && guard < 200) {
    guard += 1;
    const pair = game.pairs.find((p) => !game.matched.has(p.id));
    if (!pair) break;
    const others = game.pairs.filter((p) => p.id !== pair.id && !game.matched.has(p.id));
    for (let i = 0; i < wrongAttempts && i < others.length; i += 1) {
      game.selectTerm(pair.id);
      game.selectMeaning(others[i].id);
    }
    game.selectTerm(pair.id);
    game.selectMeaning(pair.id);
  }
  return guard;
}

function playAyahOrder(game) {
  let guard = 0;
  game.check(); // ترتیب به‌هم‌ریخته ⇒ نادرست، بدون جریمه
  while (!game.done && guard < 100) {
    guard += 1;
    game.hint();
    if (game.check().correct) break;
  }
  return guard;
}

test('minigame ①/۳: ayah completion is playable, marks mistakes and has no penalty path', () => {
  const verse = normalizeDataset(quranSample).verseList[0];
  const game = new AyahCompletionGame({
    verse,
    rounds: 3,
    config: learningData.minigames['ayah-completion'],
    seed: 7,
    distractorPool: tokensPool(bundled, { excludeVerseId: verse.id }),
  });
  assert(game.total === 3, `three rounds (got ${game.total})`);
  const snap = game.snapshot();
  assert(snap.options.length >= 2 && snap.parts.some((p) => p.type === 'blank'), 'board has a blank and options');
  assert(snap.options.filter((o) => !o.disabled).length >= 2, 'multiple options offered');

  const firstWrong = game.current.options.find((o) => !o.correct);
  const wrongResult = game.answer(firstWrong.id);
  assert(wrongResult.correct === false && game.mistakes.length === 1, 'wrong answer recorded as a mistake');
  assert(game.current.disabled.includes(firstWrong.id), 'wrong option is switched off (retry allowed)');
  assert(!game.done, 'game continues — a mistake never ends the round');
  assert(game.hint() === true, 'a hint is available and costs nothing');

  playAyahCompletion(game, { wrongAttempts: 1 });
  assert(game.done === true, 'all rounds completed');
  const report = game.report();
  assert(report.mistakes >= 1, 'mistakes reported for spaced repetition');
  assert(report.items.length === 3 && report.items.some((i) => i.correct === false), 'per-item outcome recorded');
});

test('minigame ۲/۳: word match pairs come from the lesson word bank and wrong picks never match', () => {
  const lesson = bundled.lessons.find((l) => l.wordBank.length >= 4);
  const { pairs, mode } = wordMatchPairsFor({ lesson, dataset: bundled, config: learningData.minigames['word-match'] });
  assert(mode === 'word-bank' && pairs.length >= 4, 'word bank used');
  assert(pairs.every((p) => lesson.wordBank.some((w) => w.term === p.term && w.meaning === p.meaning)), 'pairs are dataset content');
  assert(pairs.every((p) => p.id.startsWith(`word:${lesson.id}:`)), 'pair ids match the Leitner item ids');

  const game = new WordMatchGame({ pairs, pairsPerRound: pairs.length, config: learningData.minigames['word-match'], seed: 3 });
  const target = game.pairs[0];
  const other = game.pairs[1];
  game.selectTerm(target.id);
  const bad = game.selectMeaning(other.id);
  assert(bad.correct === false && game.matched.size === 0, 'a wrong pair is never accepted');
  assert(game.mistakes.length === 1, 'wrong pick recorded');
  const good = (() => { game.selectTerm(target.id); return game.selectMeaning(target.id); })();
  assert(good.correct === true && game.matched.has(target.id), 'correct pair locks in');
  playWordMatch(game, { wrongAttempts: 1 });
  assert(game.done === true, 'all pairs matched');
  assert(game.report().items.length === game.total, 'per-pair outcome recorded');
});

test('minigame ۳/۳: ayah order locks correct cards, supports hints and completes', () => {
  const verses = bundled.verseList.slice(0, 3);
  const game = new AyahOrderGame({ verses, mode: 'verses', config: learningData.minigames['ayah-order'], seed: 11 });
  assert(game.mode === 'verses' && game.total === 3, 'three ayah cards');
  assert(game.order.some((id, index) => id !== game.targetOrder[index]), 'cards start scrambled');
  assert(game.swap(game.order[0], game.order[1]) === true, 'cards can be swapped before any check');
  assert(game.nudge(game.order[0], 1) === true, 'cards can be nudged one step');
  const first = game.check();
  assert(first.correct === false && game.mistakes.length >= 1, 'a scrambled check is wrong — but never punished');
  assert(game.check().correct === false || true, 'repeated checks never throw');
  playAyahOrder(game);
  assert(game.done === true, 'ordering completed with hints only');
  assert(game.report().items.length === 1, 'per-verse outcome recorded');

  const segments = new AyahOrderGame({ verse: bundled.verseList[3], mode: 'segments', chunks: 4, config: learningData.minigames['ayah-order'], seed: 5 });
  assert(segments.mode === 'segments' && segments.total >= 3, 'segment mode builds 3–5 cards');
  playAyahOrder(segments);
  assert(segments.done === true, 'segment ordering completes too');
});

/* ------------------------------------------------------------- Leitner */

test('leitner: correct answers climb boxes, wrong answers drop to box 1 and come back soon', () => {
  const leit = new Leitner({ config: learningData.leitner, store: {} });
  const t0 = 1_700_000_000_000;
  leit.register('ayah:1:1', { now: t0, kind: 'ayah', ref: 'ayah:1:1' });
  const boxes = [];
  let at = t0;
  for (let i = 0; i < 3; i += 1) {
    at += leit.intervalMs(leit.entry('ayah:1:1').box);
    const res = leit.answer('ayah:1:1', { correct: true, now: at });
    boxes.push(res.box);
  }
  assert(boxes.join(',') === '2,3,4', `boxes climb (got ${boxes.join(',')})`);
  assert(leit.intervalMs(4) > leit.intervalMs(2), 'later boxes wait longer');

  const lapsed = leit.answer('ayah:1:1', { correct: false, now: at });
  assert(lapsed.lapsed === true && lapsed.box === 1, 'a mistake returns the item to box 1');
  assert(lapsed.due - at === leit.intervalMs(1), 'due date shortened to the box-1 interval');
  assert(leit.entry('ayah:1:1').wrong === 1, 'mistake counted for later re-showing');

  leit.register('ayah:1:2', { now: t0 });
  leit.register('ayah:1:3', { now: t0 });
  leit.answer('ayah:1:3', { correct: false, now: t0 + 1 });
  const soon = leit.sessionQueue(t0 + 1 + leit.intervalMs(1) + 1, { limit: 6, minItems: 3, includeNew: true });
  assert(soon.includes('ayah:1:3'), `a mistaken item comes back after the short box-1 interval (${soon.join(' ')})`);
  const late = leit.sessionQueue(leit.entry('ayah:1:1').due + 1, { limit: 6, minItems: 3, includeNew: true });
  assert(late.includes('ayah:1:1'), 'the lapsed item is offered again later');
  const stats = leit.stats(t0 + 1);
  assert(stats.total === 3, 'stats count every registered item');
  assert(typeof stats.nextDueAt === 'number', 'next due time known');
  assert(Object.values(stats.byBox).reduce((a, b) => a + b, 0) === 3, 'box histogram covers all items');
});

/* -------------------------------------------------- سیستم آموزش + اقتصاد */

function makeLearning({ state, economy, queue, bus = null }) {
  return new LearningSystem({
    dataset: bundled,
    learning: learningData,
    state,
    economy,
    queue,
    bus,
    seed: 20261007,
  });
}

function bootEconomy({ rizq = 300, nur = 200, hekmat = 120, gohar = 20 } = {}) {
  const state = new GameState({ economy: economyData });
  state.resources = { rizq, nur, hekmat, gohar };
  const economy = new EconomySystem({ economy: economyData, balance: balanceData, defs: buildingsData.buildings, state });
  const queue = new BuildQueue({ economyData: economyData, economy, state });
  return { state, economy, queue };
}

test('learning: a full lesson session completes all three games and grants nur/hekmat/speedup', () => {
  const { state, economy, queue } = bootEconomy();
  const before = { ...state.resources };
  const learning = makeLearning({ state, economy, queue });
  const started = learning.startLesson('lesson-basics', 1_700_000_000_000);
  assert(started && started.session, 'lesson session created');
  const session = started.session;

  const quizGames = new Set();
  let guard = 0;
  while (!session.closed && guard < 40) {
    guard += 1;
    const step = session.current;
    if (!step) break;
    step.startedAt = Date.now();
    if (step.kind === 'quiz') {
      quizGames.add(step.game.gameId);
      if (step.game.gameId === 'ayah-completion') playAyahCompletion(step.game, { wrongAttempts: 1 });
      else if (step.game.gameId === 'word-match') playWordMatch(step.game, { wrongAttempts: 1 });
      else playAyahOrder(step.game);
      step.game.items.forEach((item) => session.registerAnswer(item));
    }
    session.advance(1_700_000_000_000 + guard * 1000);
  }
  assert(session.steps.every((s) => s.done), 'every step finished');
  assert(quizGames.size === 3, `all three minigames ran (${[...quizGames].join(',')})`);

  const payload = learning.finishSession(session, 1_700_000_120_000);
  assert(payload.report.completed === true, 'report marked completed');
  assert(payload.report.elapsedSeconds === 120, 'elapsed time reported (2 minutes)');
  assert(payload.granted.nur > 0 && payload.granted.hekmat > 0, `rewards granted (${JSON.stringify(payload.granted)})`);
  assert(state.resources.nur === before.nur + payload.granted.nur, 'nur actually added to the game economy');
  assert(state.resources.hekmat === before.hekmat + payload.granted.hekmat, 'hekmat actually added');
  assert(state.resources.rizq === before.rizq && state.resources.gohar === before.gohar, 'the other resources are untouched');
  assert(payload.report.mistakes > 0, 'mistakes were recorded during the lesson');
  assert(learning.progress.lessons['lesson-basics'].completions === 1, 'lesson record stored');
  assert(learning.progress.totals.nurEarned > 0, 'totals updated');
  assert(learning.leitner.stats().total >= 6, 'lesson items registered in the spaced-repetition deck');
  assert(learning.speedupPoolSeconds() > 0, 'speedup reward pooled while no builder is busy (no job to speed up)');
});

test('learning: wrong answers never cost resources and never block a reward', () => {
  const { state, economy, queue } = bootEconomy();
  const learning = makeLearning({ state, economy, queue });
  const started = learning.startLesson('lesson-words', Date.now());
  const session = started.session;
  const step = session.steps.find((s) => s.kind === 'quiz');
  const game = step.game;
  // پاسخ نادرست کامل: همهٔ گزینه‌های اشتباه انتخاب می‌شوند
  if (game.gameId === 'ayah-completion') {
    let guard = 0;
    while (!game.done && guard < 100) {
      guard += 1;
      const round = game.current;
      if (!round) break;
      const wrong = round.options.filter((o) => !o.correct && !round.disabled.includes(o.id));
      if (wrong.length) game.answer(wrong[0].id);
      else game.answer(round.options.find((o) => o.correct).id);
      game.items.forEach((item) => session.registerAnswer(item));
    }
  } else if (game.gameId === 'word-match') {
    playWordMatch(game, { wrongAttempts: 2 });
    game.items.forEach((item) => session.registerAnswer(item));
  } else {
    playAyahOrder(game);
    game.items.forEach((item) => session.registerAnswer(item));
  }
  const before = { ...state.resources };
  const payload = learning.finishSession(session, Date.now() + 90_000);
  assert(payload.report.mistakes >= 1, `mistakes recorded (${payload.report.mistakes})`);
  for (const key of ['rizq', 'nur', 'hekmat', 'gohar']) {
    assert(state.resources[key] >= before[key], `${key} never decreases because of a mistake`);
  }
  assert(payload.granted.nur > 0 || payload.granted.hekmat > 0, 'the reward is still granted');
  assert(payload.report.requeuedMistakes.length === 0 || payload.report.kind === 'lesson', 'lesson sessions keep working after mistakes');
});

test('learning: spaced repetition re-shows mistakes — in-session requeue and next-session due items', () => {
  const { state, economy, queue } = bootEconomy();
  const learning = makeLearning({ state, economy, queue });
  const lesson = learning.lessonById('lesson-order');
  learning.registerLessonItems(lesson, 1000);
  assert(learning.leitner.stats(1000).dueCount >= 3, 'items start due (nothing learned yet)');

  const review = learning.startReview(1000);
  assert(review && review.session, 'review session started from due items');
  const session = review.session;
  assert(session.kind === 'review' && session.steps.length >= 1, 'review queue produced steps');

  // اولین مرحله را عمداً غلط پاسخ می‌دهیم
  const step = session.current;
  const game = step.game;
  let wrongItem = step.itemId || session.queue[0];
  if (game.gameId === 'ayah-completion') {
    const wrong = game.current.options.find((o) => !o.correct);
    const res = game.answer(wrong.id);
    wrongItem = res.itemId;
    session.registerAnswer({ itemId: res.itemId, correct: false });
  } else {
    const pair = game.pairs.find((p) => p.id === step.itemId) || game.pairs[0];
    const other = game.pairs.find((p) => p.id !== pair.id);
    game.selectTerm(pair.id);
    game.selectMeaning(other.id);
    session.registerAnswer({ itemId: pair.id, correct: false });
    wrongItem = pair.id;
  }
  assert(session.mistakeItems.includes(wrongItem), 'mistake remembered for requeue');

  // مرحله را تمام کن و جلو برو تا خطاها دوباره در صف بیایند
  if (game.gameId === 'ayah-completion') playAyahCompletion(game, { wrongAttempts: 0 });
  else playWordMatch(game, { wrongAttempts: 0 });
  const before = session.steps.length;
  session.advance(2000);
  const requeued = session.steps.length > before;
  assert(requeued || session.queue.includes(wrongItem) || session.steps.some((s) => s.repeat),
    'wrong item is re-queued inside the session (دوباره نشان داده می‌شود)');

  const payload = learning.finishSession(session, 3000);
  const entry = learning.leitner.entry(wrongItem);
  assert(entry && entry.lapses >= 1, 'Leitner recorded the lapse');
  assert(entry.due <= 3000 + learning.leitner.intervalMs(1) + 1, 'wrong item becomes due soon again');
  const nextQueue = learning.leitner.dueItems(entry.due + 1, 100).map((i) => i.id);
  assert(nextQueue.includes(wrongItem), 'the mistaken item becomes due again for a later session');
  assert(learning.reviewQueue(entry.due + 1).length > 0, 'a later review session has material to show');
  assert(payload.granted.nur > 0, 'review sessions also grant a (smaller) reward');
});

test('learning: rewards respect the storage ceiling and only inform about overflow', () => {
  const { state, economy, queue } = bootEconomy({ nur: 0, hekmat: 0 });
  const capacity = economy.capacity();
  state.resources.nur = capacity.nur;
  state.resources.hekmat = capacity.hekmat;
  const learning = makeLearning({ state, economy, queue });
  const started = learning.startLesson('lesson-basics', 1000);
  const session = started.session;
  session.steps.forEach((s) => { s.done = true; });
  const payload = learning.finishSession(session, 2000);
  assert(payload.granted.nur === 0 && payload.granted.hekmat === 0, 'nothing moved into a full warehouse');
  assert(payload.granted.overflow.nur > 0, 'overflow reported instead of silently dropped');
  assert(state.resources.nur === capacity.nur, 'storage never exceeds its ceiling');
  assert(state.resources.nur >= 0 && state.resources.hekmat >= 0, 'no negative resources from a lesson');
});

test('learning: speedup shortens an active builder timer and never lengthens it', () => {
  const { state, economy, queue } = bootEconomy();
  const learning = makeLearning({ state, economy, queue });
  const now = 1_700_000_000_000;
  const def = buildingsData.buildings.find((b) => b.id === 'farm');
  const entity = state.createEntity({ type: def.id, name: def.name, col: 2, row: 2, size: def.size, level: 1, status: 'building' });
  queue.enqueue({ kind: 'build', entityId: entity.id, type: def.id, targetLevel: 1, durationMs: 600_000 }, now);
  const job = queue.jobs[0];
  const before = job.endsAt;
  const result = learning.applySpeedup(90, now);
  assert(result.appliedSeconds === 90, `90 seconds applied (got ${result.appliedSeconds})`);
  assert(job.endsAt === before - 90_000, 'the active builder timer moved 90s earlier');
  assert(job.endsAt >= now, 'the timer never sweeps past "now"');
  learning.applySpeedup(10_000, now);
  assert(queue.jobs.length === 0, 'a huge speedup finishes the job immediately (via queue.tick)');
  assert(entity.level === 1 && state.resources.grizq === undefined, 'no phantom state created');
  assert(learning.speedupPoolSeconds() <= learningData.rewards.speedupPoolMaxSeconds, 'pool is capped');
});

test('content policy: no Quran text is hard-coded anywhere in the code', () => {
  // Signature of fully-vocalised Arabic: a single word carrying TWO OR MORE marks.
  // Everyday Persian spelling marks («معمولاً»، «پُری»، «کارتِ») or the shadda in
  // «بنّا» never reach two marks in one token, so this isolates copied Quran text.
  const marks = /[\u064B-\u0652\u0670\u06D6-\u06ED]/g; // global ⇒ match() returns every mark
  const vocalisedTokens = (content) =>
    content.split(/\s+/).filter((token) => (token.match(marks) || []).length >= 2).length;
  const allowlist = new Set(['src/data/quran-sample.json']);
  const walk = (dir) => {
    const out = [];
    for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) out.push(...walk(rel));
      else out.push(rel);
    }
    return out;
  };
  const files = [...walk('src'), ...walk('tools')].filter((f) => /\.(js|mjs|json|css|html)$/.test(f));
  const offenders = [];
  for (const file of files) {
    if (allowlist.has(file)) continue;
    const content = readFileSync(resolve(root, file), 'utf8');
    const hits = vocalisedTokens(content);
    if (hits > 0) offenders.push(`${file} (${hits})`);
  }
  assert(offenders.length === 0, `files containing vocalised Arabic (i.e. copied Quran text): ${offenders.join(', ')}`);
  assert(vocalisedTokens(readFileSync(resolve(root, 'src/data/quran-sample.json'), 'utf8')) > 0,
    'the placeholder dataset is the one allowed source of vocalised Arabic');

  // and the placeholder file itself must keep its labels on every verse
  const sample = readJson('src/data/quran-sample.json');
  const plain = JSON.stringify(sample);
  assert(plain.includes('نمونه — جایگزین شود'), 'the sample dataset declares the placeholder label');
  assert(sample.meta.placeholder === true && sample.meta.reviewed === false, 'sample meta is placeholder + unreviewed');
  assert(!/reviewed":\s*true/.test(plain), 'no verse in the sample claims to be reviewed');
});

test('content policy: the render layers never import the Quran dataset or text', () => {
  const banned = [/quran-sample/, /game\/quran/, /ui\/quran/, /QuranDataset/];
  const scan = (dir) => {
    const out = [];
    for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) out.push(...scan(rel));
      else out.push(rel);
    }
    return out;
  };
  const offenders = [];
  for (const file of [...scan('src/core'), ...scan('src/world')]) {
    if (!file.endsWith('.js')) continue;
    const content = readFileSync(resolve(root, file), 'utf8');
    if (banned.some((re) => re.test(content))) offenders.push(file);
  }
  assert(offenders.length === 0, `render-layer files referencing Quran content: ${offenders.join(', ')}`);

  // The 3D factory only knows the `lesson` flag, never any verse text.
  const factory = readFileSync(resolve(root, 'src/world/BuildingFactory.js'), 'utf8');
  assert(!/\b(verse|verses|ayah|ayahs|surah|surahs)\b|quran-text/i.test(factory), 'BuildingFactory knows nothing about verses');
  assert(factory.includes("def.id === 'dar-al-quran'"), 'the دارالقرآن model exists');
});

test('content policy: neither the save file nor a lesson report carries Quran text', () => {
  const { state, economy, queue } = bootEconomy();
  const learning = makeLearning({ state, economy, queue });
  const started = learning.startLesson('lesson-basics', 1000);
  const session = started.session;
  session.steps.forEach((s) => { s.done = true; });
  const payload = learning.finishSession(session, 2000);
  const serialized = JSON.stringify(state.serialize());
  for (const verse of bundled.verseList) {
    assert(!serialized.includes(verse.textUthmani), `verse ${verse.id} text is not persisted`);
    assert(!serialized.includes(verse.translationFa), `verse ${verse.id} translation is not persisted`);
  }
  assert(!JSON.stringify(payload).includes(bundled.verseList[0].textUthmani), 'reports do not embed verse text either');
  assert(Object.keys(state.serialize().learning.reviews).length > 0, 'learning progress is persisted as ids only');
});

test('learning: the save roundtrip keeps Leitner boxes, lesson records and totals', () => {
  const { state, economy, queue } = bootEconomy();
  const learning = makeLearning({ state, economy, queue });
  const started = learning.startLesson('lesson-basics', 1000);
  const session = started.session;
  session.steps.forEach((s) => { s.done = true; });
  learning.finishSession(session, 60_000);
  const record = JSON.parse(JSON.stringify(state.serialize()));

  const restored = new GameState({ economy: economyData });
  restored.hydrate(record);
  assert(restored.learning.lessons['lesson-basics'].completions === 1, 'lesson record survives the save');
  assert(Object.keys(restored.learning.reviews).length > 0, 'Leitner items survive the save');
  assert(restored.learning.totals.nurEarned > 0, 'reward totals survive the save');

  const again = new LearningSystem({ dataset: bundled, learning: learningData, state: restored, economy, queue });
  const stats = again.stats(2000);
  assert(stats.total === Object.keys(restored.learning.reviews).length, 'the scheduler is re-seeded from the save');
  const savedId = Object.keys(restored.learning.reviews)[0];
  assert(again.leitner.entry(savedId).box === learning.leitner.entry(savedId).box, 'box levels survive the roundtrip');
  assert(again.leitner.intervalMs(again.leitner.entry(savedId).box) === learning.leitner.intervalMs(learning.leitner.entry(savedId).box),
    'intervals are recomputed from the restored box');
  assert(again.lessonStatus('lesson-basics').bestAccuracy > 0, 'lesson accuracy survives the save');
});


await flushPending();

const pad = (value, width) => String(value).padEnd(width, ' ');
console.log('\n=== شهر نور — self checks (فازهای ۱، ۳ و ۴) ===\n');
for (const result of results) {
  console.log(`${result.ok ? '✓' : '✗'} ${pad(result.name, 62)}${result.ok ? '' : result.message}`);
}
console.log(`\n${results.length - failures}/${results.length} checks passed.`);
if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
