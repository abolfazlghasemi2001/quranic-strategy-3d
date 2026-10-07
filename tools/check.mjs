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
import { readFileSync } from 'node:fs';
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
import { generatePlacements, splitPlacementsByChunk } from '../src/world/Placement.js';
import { OrbitCameraRig } from '../src/core/OrbitCameraRig.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const readJson = (relative) => JSON.parse(readFileSync(resolve(root, relative), 'utf8'));

const world = readJson('src/data/world.json');
const terrain = readJson('src/data/terrain.json');
const quality = readJson('src/data/quality.json');
const gameplay = readJson('src/data/gameplay.json');
const strings = readJson('src/data/strings.fa.json');

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

function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true, message: '' });
  } catch (error) {
    failures += 1;
    results.push({ name, ok: false, message: error.message });
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

/* ------------------------------------------------------------------ report */

const pad = (value, width) => String(value).padEnd(width, ' ');
console.log('\n=== شهر نور — self checks (فاز ۱) ===\n');
for (const result of results) {
  console.log(`${result.ok ? '✓' : '✗'} ${pad(result.name, 62)}${result.ok ? '' : result.message}`);
}
console.log(`\n${results.length - failures}/${results.length} checks passed.`);
if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
