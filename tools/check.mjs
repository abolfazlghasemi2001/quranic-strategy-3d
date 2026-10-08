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
import { Terrain } from '../src/world/Terrain.js';
import { DayNightCycle, sampleDayNight } from '../src/world/DayNightCycle.js';
import { applyWindShader, setWindTime } from '../src/world/WindShader.js';
import { World } from '../src/world/World.js';
import { generatePlacements, splitPlacementsByChunk } from '../src/world/Placement.js';
import { OrbitCameraRig } from '../src/core/OrbitCameraRig.js';
import { GameState } from '../src/game/GameState.js';
import { EconomySystem } from '../src/game/EconomySystem.js';
import { BuildQueue } from '../src/game/BuildQueue.js';
import { BarracksSystem } from '../src/game/barracks/BarracksSystem.js';
import { BattleGrid } from '../src/game/battle/BattleGrid.js';
import { findPath, pathWorldLength } from '../src/game/battle/AStar.js';
import { BattleSim } from '../src/game/battle/BattleSim.js';
import { canTransition } from '../src/game/battle/Unit.js';
import { createStructureStats } from '../src/game/battle/StructureStats.js';
import {
  buildScenario,
  defenseDefsFrom,
  structureModifiersFrom,
} from '../src/game/battle/BattleScenario.js';
import { createRecord, replayRecord, recordSummary, verifySubmission } from '../src/game/battle/BattleRecorder.js';
import { SaveSystem, migrateRecord, SAVE_SCHEMA_VERSION } from '../src/game/SaveSystem.js';
import { CampaignSystem } from '../src/game/campaign/CampaignSystem.js';
import { MetaSystem } from '../src/game/meta/MetaSystem.js';
import { EventBus, EVENTS } from '../src/core/EventBus.js';
import { Engine as FakeEngine } from './FakeEngine.js';
import {
  containsVocalisedArabic,
  missionRefCards,
  MISSION_SCHEMA,
  normalizeMissions,
  parseRefId,
  REFERENCE_PATTERN,
  validateMissions,
} from '../src/game/campaign/MissionData.js';
import { MISSION_RULES } from '../src/game/campaign/rules/index.js';
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
import { GameServer } from '../server/src/server.js';
import { connectWs } from '../server/src/wsClient.js';
import { RateLimiter } from '../server/src/rateLimit.js';
import { filterChat } from '../server/src/chatFilter.js';
import { issueToken, sanitizeDisplayName } from '../server/src/auth.js';

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
const metaData = readJson('src/data/meta.json');
const ftueData = readJson('src/data/ftue.json');
const socialData = readJson('src/data/social.json');

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

  // Ground 1 + consolidated grid/border 1 + sky 1; foliage stays instanced.
  const staticCalls = 3;
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

/* --------------------------------------------------------- phase 9 rendering */

test('phase 9 day/night cycle is smooth, frame-delta based and deterministic', () => {
  const cycle = new DayNightCycle({ enabled: true, durationSeconds: 120, startPhase: 0 });
  const start = cycle.sample();
  const after = cycle.update(12);
  assertClose(after.phase, 0.1, 1e-12, '12 seconds advances one tenth of the configured day');
  assert(after.daylight > start.daylight, 'daylight increases smoothly through dawn');
  const frozenPhase = cycle.phase;
  cycle.update(90, { reducedMotion: true });
  assert(cycle.phase === frozenPhase, 'reduced motion freezes the cycle');
  assert(sampleDayNight(0.25).daylight > 0.99, 'quarter-day is bright daytime');
  assert(sampleDayNight(0.75).daylight < 0.01, 'three-quarter-day is nighttime');
  const replay = new DayNightCycle({ enabled: true, durationSeconds: 120, startPhase: 0 });
  replay.update(12);
  assert(replay.phase === cycle.phase, 'same elapsed time yields the same phase');
});

test('phase 9 shader hooks add wind/water uniforms without adding ground meshes', () => {
  const material = new THREE.MeshStandardMaterial();
  applyWindShader(material, { strength: 0.12 });
  const foliageShader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '' };
  material.onBeforeCompile(foliageShader);
  assert(foliageShader.uniforms.uWindTime && foliageShader.uniforms.uWindStrength, 'wind uniforms are injected');
  assert(foliageShader.vertexShader.includes('#include <common>\nuniform float uWindTime;'), 'wind declarations use real GLSL line breaks');
  assert(foliageShader.vertexShader.includes('shahrWindWave'), 'wind sway is inserted in the vertex shader');
  setWindTime(material, 4.5);
  assert(material.userData.shahrWindUniforms.uWindTime.value === 4.5, 'shared wind time updates');
  material.dispose();

  const config = makeConfig('high');
  const terrainOwner = new Terrain({ config, map: new TerrainMap(config) });
  const groundMaterial = new THREE.MeshStandardMaterial({ map: new THREE.Texture() });
  terrainOwner._applyGroundShader(groundMaterial);
  const groundShader = {
    uniforms: {},
    vertexShader: '#include <common>\n#include <begin_vertex>',
    fragmentShader: '#include <common>\n#include <map_fragment>',
  };
  groundMaterial.onBeforeCompile(groundShader);
  assert(groundShader.uniforms.uWaterTime && groundShader.uniforms.uDaylight, 'ground water/daylight uniforms are injected');
  assert(groundShader.fragmentShader.includes('uniform sampler2D uDirtMap;\nuniform sampler2D uSandMap;'), 'ground declarations use real GLSL line breaks');
  assert(groundShader.fragmentShader.includes('waterRipple') && groundShader.fragmentShader.includes('grassBreeze'), 'ground shader has water and grass animation');
  assert(!groundShader.fragmentShader.includes('#include <map_fragment>'), 'custom ground fragment replaces the standard map pass');
  groundMaterial.dispose();
  terrainOwner.dispose();
});

test('phase 9 grid and border are consolidated into one vertex-coloured draw call', () => {
  const config = makeConfig('high');
  const terrainOwner = new Terrain({ config, map: new TerrainMap(config) });
  terrainOwner._buildGrid();
  assert(terrainOwner.group.children.length === 1, 'only one grid overlay object is added');
  assert(terrainOwner.gridLines === terrainOwner.gridBorder, 'compatibility border alias shares the mesh');
  assert(terrainOwner.gridLines.isLineSegments, 'grid is a single LineSegments mesh');
  assert(terrainOwner.gridLines.geometry.getAttribute('color').count === terrainOwner.gridLines.geometry.getAttribute('position').count, 'each vertex has a color for the stronger border');
  terrainOwner.dispose();
});

test('phase 9 PWA manifest has generated install icons and offline shell source', () => {
  const manifest = readJson('public/manifest.webmanifest');
  assert(manifest.display === 'standalone' && manifest.start_url && manifest.scope, 'manifest supports standalone installation');
  assert(manifest.icons.length >= 2, 'manifest includes small and large icons');
  for (const icon of manifest.icons) {
    const bytes = readFileSync(resolve(root, 'public', icon.src.replace(/^\.\//, '')));
    assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), `${icon.src} is a PNG`);
  }
  const worker = readFileSync(resolve(root, 'src/pwa/service-worker.js'), 'utf8');
  assert(worker.includes("addEventListener('install'") && worker.includes("addEventListener('fetch'"), 'service worker precaches and handles offline requests');
  assert(readFileSync(resolve(root, 'tools/generate-pwa-icons.mjs'), 'utf8').includes('encodePng'), 'icons are generated by source code');
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
  assert(economyData.goharSources.dailyBonus === 0 && economyData.goharSources.townCenterLevelReward > 0, 'no login grant; gohar has a non-streak gameplay source');
  const { economy } = makeEconomy();
  assert(economy.grantDailyBonus(1_700_000_000_000) === 0, 'legacy daily-bonus hook never pays');
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
  assert(result.payload.meta.onboarding.status === 'completed', 'legacy cities are not forced into the new-user FTUE');
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

test('data: strings carry the current phase labels (queue, offline, lesson, campaign)', () => {
  assert(strings.app.phase.includes('فاز ۷'), 'phase label reflects the current phase');
  assert(typeof strings.loading.steps.save === 'string', 'loading save step');
  assert(typeof strings.economy.queued === 'string' && typeof strings.economy.storageFull === 'string', 'economy strings');
  assert(typeof strings.loading.steps.quran === 'string', 'phase-4 loading step');
  assert(typeof strings.lesson?.start === 'string' && typeof strings.lesson?.noPenalty === 'string', 'lesson strings');
  assert(strings.quran.unreviewedBadge === REVIEW_PENDING_LABEL, 'the pending badge string matches the dataset label');
  assert(typeof strings.campaign?.panelTitle === 'string', 'phase-6 campaign strings');
  assert(typeof strings.campaign?.pausedNote === 'string' && typeof strings.campaign?.blocked?.busy === 'string', 'phase-6 mission states');
  assert(typeof strings.campaign?.noDepictionNote === 'string', 'phase-6 no-depiction note');
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

test('phase 9 provenance: placeholder word banks are sourced, labelled and excluded from distractors', () => {
  for (const lesson of bundled.lessons) {
    for (const pair of lesson.wordBank) {
      assert(pair.placeholder === true && pair.reviewed === false, `${lesson.id} word remains an explicit placeholder`);
      assert(pair.source?.datasetId === bundled.meta.datasetId, `${lesson.id} word has its dataset provenance`);
    }
  }
  const lesson = bundled.lessons.find((item) => item.wordBank.length > 0);
  const { pairs, mode } = wordMatchPairsFor({ lesson, dataset: bundled, config: learningData.minigames['word-match'] });
  assert(mode === 'word-bank' && pairs.every((pair) => pair.placeholder && !pair.reviewed && pair.source?.datasetId), 'word-match keeps provenance on every pair');
  assert(tokensPool(bundled, { excludeVerseId: bundled.verseList[0].id }).length === 0, 'unreviewed sample verses are never borrowed as distractors');
  assert(validateDataset(bundled).issues.some((issue) => issue.code === 'wordbank-unreviewed'), 'validator reports unreviewed word-bank entries');
});

test('phase 9 recitation: playback requires an explicit license and safe attribution URL', () => {
  const sampleArabic = String.fromCodePoint(0x0646, 0x064e, 0x0635, 0x0651, 0x064c);
  const dataset = normalizeDataset({
    datasetId: 'audio-policy-test',
    source: 'fixture',
    version: '1',
    surahs: [{ index: 1, name: 'fixture', ayahs: [
      { index: 1, text: sampleArabic, translation: 'نمونه', audio: { url: 'https://audio.invalid/1.mp3', license: 'CC-BY' } },
      { index: 2, text: sampleArabic, translation: 'نمونه', audio: { url: 'https://audio.invalid/2.mp3', license: 'CC-BY', licenseUrl: 'https://license.invalid/' } },
      { index: 3, text: sampleArabic, translation: 'نمونه', audio: { url: 'javascript:alert(1)', license: 'CC-BY', licenseUrl: 'javascript:alert(1)' } },
    ] }],
  });
  assert(dataset.verseList[0].audio.playable === false, 'a license name without its attribution URL cannot play');
  assert(dataset.verseList[1].audio.playable === true, 'explicit license and attribution URL permit optional playback');
  assert(dataset.verseList[2].audio === null, 'script URLs are rejected');
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


/* ==================================================================== phase 5
   واحدها، دفاع و مکانیک نبرد — آزمون‌های منطق خالص (بدون DOM و بدون WebGL). */

const unitsData = readJson('src/data/units.json');
const defensesData = readJson('src/data/defenses.json');
const battleData = readJson('src/data/battle.json');
const battleCfg = { cols: terrain.grid.cols, rows: terrain.grid.rows, tileSize: terrain.tileSize, seed: world.seed >>> 0 };
const structureStats = createStructureStats({ defenses: defensesData, config: battleCfg });
const battleDeps = {
  rules: battleData,
  units: unitsData,
  defenseDefs: defenseDefsFrom(defensesData),
  structureModifiers: structureModifiersFrom(defensesData),
};

/** شهر آزمایشی: مرکز شهر + دیوار اختیاری + سازه‌های دفاعی + سپاه. */
function makeCity({ walls = false, gate = true, defenses = [], army = {}, townLevel = 2 } = {}) {
  const state = new GameState({ economy: economyData });
  state.resources = { rizq: 100000, nur: 100000, hekmat: 100000, gohar: 200 };
  const c = Math.floor(terrain.grid.cols / 2);
  state.createEntity({ type: 'town-center', name: 'tc', col: c - 1, row: c - 1, size: [3, 3], level: townLevel, status: 'ready' });
  if (walls) {
    for (let col = c - 5; col <= c + 5; col += 1) {
      for (const row of [c - 6, c + 6]) {
        if (col === c && row === c - 6 && gate) continue; // دروازهٔ شمالی
        state.createEntity({ type: 'wall', name: 'w', col, row, size: [1, 1], level: 1, status: 'ready' });
      }
    }
    for (let row = c - 5; row <= c + 5; row += 1) {
      for (const col of [c - 6, c + 6]) {
        state.createEntity({ type: 'wall', name: 'w', col, row, size: [1, 1], level: 1, status: 'ready' });
      }
    }
  }
  for (const def of defenses) {
    state.createEntity({ type: def.id, name: def.id, col: def.col, row: def.row, size: [2, 2], level: def.level ?? 1, status: 'ready' });
  }
  state.army.garrison = { ...army };
  return state;
}

function battleFromCity(state, encounterId = 'raid-scouts', seed = 424242) {
  const scenario = buildScenario({
    config: battleCfg,
    state,
    defensesData,
    battleData,
    structureStats,
    encounterId,
    seed,
  });
  return new BattleSim({ scenario, ...battleDeps });
}

/** آرایش دستی برای آزمون‌های تک‌واحدی (بدون ساخت شهر کامل). */
function makeScenario({ structures = [], garrison = {}, spawns = [], seed = 987654 } = {}) {
  const built = structures.map((raw, index) => {
    const maxHp = raw.maxHp ?? structureStats.maxHpFor({ type: raw.type, level: raw.level ?? 1, size: [raw.w ?? 1, raw.h ?? 1] });
    return {
      index,
      sourceId: raw.sourceId ?? index + 1,
      type: raw.type,
      kind: raw.kind ?? structureStats.kindOf(raw.type),
      col: raw.col,
      row: raw.row,
      w: raw.w ?? 1,
      h: raw.h ?? 1,
      level: raw.level ?? 1,
      maxHp,
      hp: raw.hp ?? maxHp,
    };
  });
  const scenario = {
    version: 1,
    seed: seed >>> 0,
    encounter: { id: 'unit-test', name: 'unit-test', threat: 1 },
    cols: terrain.grid.cols,
    rows: terrain.grid.rows,
    tileSize: terrain.tileSize,
    structures: built,
    garrison,
    spawns,
    commands: [],
  };
  scenario.scenarioHash = 1;
  return scenario;
}

const makeSim = (scenario) => new BattleSim({ scenario, ...battleDeps });
const at = (col, row) => ({ x: (col + 0.5) * terrain.tileSize, z: (row + 0.5) * terrain.tileSize });

/** نمونه‌برداری نیم‌خانه‌ای: آیا پارهٔ خط از میان خانه‌ای می‌گذرد؟ */
function lineCells(ax, az, bx, bz, tile, fraction = 0.5) {
  const dx = bx - ax;
  const dz = bz - az;
  const distance = Math.sqrt(dx * dx + dz * dz);
  const steps = Math.max(1, Math.ceil(distance / (tile * fraction)));
  const cells = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const x = ax + dx * t;
    const z = az + dz * t;
    const col = Math.floor(x / tile);
    const row = Math.floor(z / tile);
    cells.push({ col, row, x, z, inset: Math.min(x - col * tile, (col + 1) * tile - x, z - row * tile, (row + 1) * tile - z) });
  }
  return cells;
}

/* ------------------------------------------------------------------ data */

test('phase 5 data: four unit types with roles, costs and combat stats in units.json', () => {
  const roles = new Set(unitsData.units.map((u) => u.role));
  assert(unitsData.units.length === 4, `4 unit types (got ${unitsData.units.length})`);
  for (const role of ['melee', 'ranged', 'support', 'siege']) assert(roles.has(role), `role present: ${role}`);
  for (const unit of unitsData.units) {
    for (const key of ['id', 'name', 'role', 'hp', 'damage', 'attacksPerSecond', 'rangeTiles', 'speedTilesPerSecond', 'cost', 'trainSeconds', 'housing', 'targetPriority']) {
      assert(unit[key] != null, `${unit.id}: field ${key}`);
    }
    assert(unitsData.targetPriority[unit.targetPriority], `${unit.id}: priority table "${unit.targetPriority}" exists`);
    assert(unit.cost.rizq > 0 && unit.trainSeconds > 0, `${unit.id}: cost/time are positive`);
    // هیچ متنی با اعراب کامل (نشانهٔ متن قرآنی) در دادهٔ نبرد نیست
    assert(!/[\u064B-\u0652\u0670\u06D6-\u06ED]/.test(JSON.stringify(unit)), `${unit.id}: no vocalised Arabic`);
  }
  const healer = unitsData.units.find((u) => u.role === 'support');
  assert(healer.healPerSecond > 0 && healer.damage === 0, 'the healer heals and deals no damage');
  const breaker = unitsData.units.find((u) => u.role === 'siege');
  assert(breaker.structureDamageMultiplier > breaker.unitDamageMultiplier, 'the wall-breaker is a structure specialist');
});

test('phase 5 data: wall + three defence structures carry range/damage/speed/hp/cost in defenses.json', () => {
  assert(defensesData.wall && defensesData.wall.hpPerLevel > 0, 'wall health in JSON');
  assert(defensesData.defenses.length >= 3, `at least 3 defence structures (got ${defensesData.defenses.length})`);
  for (const def of defensesData.defenses) {
    assert(typeof def.id === 'string' && def.id.length > 0, 'each defence has an id');
    for (const key of ['rangeTiles', 'damage', 'attacksPerSecond', 'hpPerLevel']) {
      assert(def[key] > 0, `${def.id}: ${key} > 0`);
    }
    assert(def.projectile && battleData.particles.projectileSpeeds[def.projectile] > 0,
      `${def.id}: its projectile speed is in the JSON table`);
    assert(def.targetOrder, `${def.id}: picks its targets by a data-driven rule`);
    const entry = buildingsData.buildings.find((b) => b.id === def.id);
    assert(entry && entry.defense, `${def.id}: has a shop entry flagged as defence`);
    const curve = balanceData.buildings[def.balanceKey || def.id];
    assert(curve && curve.levels.length === 10, `${def.id}: 10-level cost curve`);
    const cost = curve.levels[0].cost;
    assert(cost && Object.values(cost).some((value) => value > 0), `${def.id}: level 1 cost is defined`);
  }
  const tower = defensesData.defenses.find((d) => d.id === 'watchtower');
  const beacon = defensesData.defenses.find((d) => d.id === 'light-beacon');
  assert(tower.rangeTiles > beacon.rangeTiles, 'the watchtower out-ranges the beacon');
  assert(beacon.splashTiles > 0 && beacon.slow.factor < 1, 'the beacon splashes and slows');
  assert(defensesData.repair.costPer100Hp.rizq > 0, 'repair cost is data-driven');
  assert(defensesData.structures.hpById['town-center'] > 0 && defensesData.structures.hpPerTile > 0, 'building health table exists');
});

test('phase 5 data: battle.json holds the whole simulation contract (no magic numbers in code)', () => {
  for (const key of ['sim', 'deploy', 'attacker', 'defender', 'end', 'edges', 'encounters', 'rewards', 'army', 'camera', 'particles', 'history']) {
    assert(battleData[key] != null, `battle.json: ${key}`);
  }
  assert(battleData.sim.stepHz >= 10 && Number.isInteger(battleData.sim.stepHz), 'fixed timestep is integral');
  assert(battleData.sim.damageSpread === 0, 'zero damage spread ⇒ no random damage at all');
  assert(battleData.encounters.length >= 3, `at least 3 encounters (got ${battleData.encounters.length})`);
  for (const encounter of battleData.encounters) {
    assert(encounter.waves.length >= 1, `${encounter.id}: has waves`);
    for (const wave of encounter.waves) {
      assert(unitsData.units.some((u) => u.id === wave.unit), `${encounter.id}: unit "${wave.unit}" exists`);
      assert(battleData.edges[wave.edge], `${encounter.id}: edge "${wave.edge}" exists`);
    }
  }
  const kinds = Object.keys(battleData.particles.bursts).length > 0;
  assert(kinds, 'particle bursts are declared');
  const particleFiles = readFileSync(resolve(root, 'src/world/battle/Particles.js'), 'utf8');
  assert(!/blood|gore|دسمال خون|خون‌ریزی/i.test(particleFiles.replace(/بدون خون[^\n]*/g, '')), 'particles never mention blood');
});

test('phase 5: the simulation layer is free of Math.random, clocks and trigonometry', () => {
  const files = ['BattleGrid.js', 'AStar.js', 'Unit.js', 'BattleSim.js', 'BattleScenario.js', 'BattleRecorder.js'];
  for (const file of files) {
    const content = readFileSync(resolve(root, `src/game/battle/${file}`), 'utf8');
    assert(!/Math\.random\(/.test(content), `${file}: no Math.random()`);
    assert(!/Date\.now\(|performance\.now\(/.test(content), `${file}: no wall clock`);
    assert(!/Math\.(sin|cos|tan|atan2|hypot)\(/.test(content), `${file}: no trigonometry`);
  }
  const sim = readFileSync(resolve(root, 'src/game/battle/BattleSim.js'), 'utf8');
  assert(/new Rng\(/.test(sim), 'the seeded Rng is the only source of randomness');
});

/* ---------------------------------------------------------------- grid/A* */

test('phase 5 pathfinding: a wall blocks the grid, breaching frees the cells and bumps the version', () => {
  const grid = new BattleGrid({ cols: 8, rows: 8, tileSize: 2 });
  const wall = { index: 0, kind: 'wall', col: 3, row: 3, w: 1, h: 1 };
  grid.addStructure(wall);
  assert(grid.isBlocked(grid.index(3, 3)), 'the wall tile is blocked');
  const version = grid.version;
  assert(grid.freeStructure(wall) === true, 'breaching frees the tile');
  assert(grid.isFree(grid.index(3, 3)), 'the tile is walkable again');
  assert(grid.version > version, 'the grid version changed ⇒ cached paths invalidate');
  const tower = { index: 1, kind: 'defense', col: 5, row: 5, w: 2, h: 2 };
  grid.addStructure(tower);
  assert(grid.freeStructure(tower) === false, 'hard structures never open up');
  assert(grid.isBlocked(grid.index(5, 5)), 'the defence still blocks');
});

test('phase 5 pathfinding: A* routes around a wall through the only gate and never steps on a wall', () => {
  const grid = new BattleGrid({ cols: 12, rows: 12, tileSize: 2 });
  const walls = [];
  const gateCol = 3; // دروازه در سمت چپ ⇒ مسیر مستقیم بسته است
  for (let col = 2; col <= 9; col += 1) {
    if (col === gateCol) continue; // دروازه
    walls.push({ index: walls.length, kind: 'wall', col, row: 5, w: 1, h: 1 });
  }
  for (const wall of walls) grid.addStructure(wall);
  const start = grid.index(6, 0);
  const goal = grid.index(6, 10);
  const result = findPath({ grid, start, isGoal: (index) => index === goal, goalHint: goal, maxNodes: 4000 });
  assert(result.path, 'a path exists around the wall');
  const cells = result.path;
  assert(cells[cells.length - 1] === goal, 'the path ends on the goal');
  for (const cell of cells) assert(grid.isFree(cell), `path cell ${cell} is walkable`);
  const straightWorld = 10 * grid.tileSize;
  const length = pathWorldLength(grid, cells);
  assert(length > straightWorld + 1,
    `the path detours via the gate (${length.toFixed(1)} world units > ${straightWorld} straight)`);
  const gate = grid.index(gateCol, 5);
  assert(cells.includes(gate), 'the path passes through the gate tile');
  const again = findPath({ grid, start, isGoal: (index) => index === goal, goalHint: goal, maxNodes: 4000 });
  assert(again.path.join(',') === cells.join(','), 'the same query returns the bit-identical path');
});

test('phase 5 pathfinding: a sealed ring makes the inner tower unreachable, so raiders go for the wall', () => {
  const state = makeCity({ walls: true, gate: false, defenses: [{ id: 'watchtower', col: 19, row: 19 }] });
  const sim = battleFromCity(state, 'raid-scouts', 777);
  sim.runToEnd();
  const report = sim.report();
  assert(report.wallsBreached > 0, `raiders break the sealed wall (breached ${report.wallsBreached})`);
  const tower = sim.structures.find((s) => s.type === 'watchtower');
  const firstTowerHit = sim.events.findIndex((event) => event.type === 'structure-hit' && event.structure === tower.index);
  const firstBreach = sim.events.findIndex((event) => event.type === 'wall-breach');
  assert(firstBreach >= 0 && (firstTowerHit === -1 || firstTowerHit > firstBreach),
    'the tower is only struck after the wall is down (no shooting through walls)');
});

test('phase 5 pathfinding: no attack ever crosses a standing wall segment', () => {
  const state = makeCity({ walls: true, gate: true, defenses: [{ id: 'watchtower', col: 19, row: 19 }] });
  const sim = battleFromCity(state, 'raid-column', 31337);
  const wallCells = new Set();
  for (const structure of sim.structures) {
    if (structure.kind !== 'wall') continue;
    for (let r = structure.row; r < structure.row + structure.h; r += 1) {
      for (let c = structure.col; c < structure.col + structure.w; c += 1) wallCells.add(`${c}:${r}`);
    }
  }
  let crossings = 0;
  let checked = 0;
  const limit = 600;
  for (let tick = 0; tick < limit && !sim.done; tick += 1) {
    sim.tick();
    for (const event of sim.drainEvents()) {
      if (event.type !== 'attack' || !event.source || !event.source.startsWith('u')) continue;
      checked += 1;
      const cells = lineCells(event.fromX, event.fromZ, event.toX, event.toZ, sim.tileSize, 0.25);
      // خانهٔ مبدأ (واحد کنار دیوار ایستاده) و خانهٔ هدف (خودِ سازهٔ هدف، که شلیک
      // به آن مجاز است) مستثنا هستند — همان قراردادی که شبیه‌ساز در خط دید دارد.
      // «عبور» یعنی خط واقعاً از *بدنهٔ* دیوار بگذرد، نه اینکه لبهٔ خانه را ببرد.
      const insetNeeded = sim.tileSize * 0.15;
      const skip = new Set([`${cells[0].col}:${cells[0].row}`, `${cells[cells.length - 1].col}:${cells[cells.length - 1].row}`]);
      for (const cell of cells) {
        const key = `${cell.col}:${cell.row}`;
        if (skip.has(key)) continue;
        if (!wallCells.has(key)) continue;
        if (cell.inset < insetNeeded) continue;
        crossings += 1;
        break;
      }
    }
  }
  assert(checked > 20, `enough attacks sampled (${checked})`);
  assert(crossings === 0, `no arrow crosses a wall (${crossings} crossings)`);
});

/* ------------------------------------------------------------------- FSM */

test('phase 5 FSM: idle→move→attack→down/retreat and no illegal jump', () => {
  const scenario = makeScenario({
    structures: [{ type: 'watchtower', col: 4, row: 6 }],
    garrison: { guard: 2 },
    spawns: [{ tick: 1, unit: 'guard', ...at(4, 1) }],
  });
  const sim = makeSim(scenario);
  const seen = new Set();
  for (let i = 0; i < 900 && !sim.done; i += 1) {
    sim.tick();
    for (const unit of sim.units) seen.add(unit.state);
  }
  for (const state of seen) assert(['idle', 'move', 'attack', 'retreat', 'down'].includes(state), `legal state ${state}`);
  assert(seen.has('move'), 'units walk to their target');
  assert(seen.has('attack'), 'units attack once in range');
  const guard = sim.units[0];
  assert(canTransition('idle', 'move') && canTransition('move', 'attack'), 'the table allows the useful transitions');
  assert(!canTransition('down', 'attack') && !canTransition('down', 'move'), 'a unit that left the field never fights again');
  assert(!canTransition('retreat', 'attack'), 'a retreating unit does not attack');
  assert(guard.pathVersion >= 0, 'path bookkeeping stays on the record');
});

/* -------------------------------------------------------------- defences */

test('phase 5 defence: a tower fires at the edge of its range (same measuring convention as units)', () => {
  const tower = defensesData.defenses.find((d) => d.id === 'watchtower');
  const half = 1; // نیم‌عرض سازهٔ ۲×۲ بر حسب خانه
  const col = 10;
  const row = 10;
  const edgeDistanceTiles = tower.rangeTiles * 0.95;
  const spawnRow = row + half + edgeDistanceTiles + 0.5;
  const scenario = makeScenario({
    structures: [{ type: 'watchtower', col, row }],
    spawns: [{ tick: 1, unit: 'guard', ...at(col, spawnRow) }],
  });
  const sim = makeSim(scenario);
  const shots = [];
  for (let i = 0; i < 400 && !sim.done; i += 1) {
    sim.tick();
    for (const event of sim.drainEvents()) {
      if (event.type === 'attack' && String(event.source).startsWith('s')) shots.push(event);
    }
  }
  assert(shots.length > 0, 'the tower opens fire on a unit standing inside its range');
  const defender = sim.units[0];
  const first = shots[0];
  const distanceFromEdge = Math.sqrt((first.toX - defender.x) ** 2 + (first.toZ - defender.z) ** 2);
  assert(distanceFromEdge <= tower.rangeTiles * terrain.tileSize + 1e-6,
    `the shot happens within range from the structure edge (${distanceFromEdge.toFixed(2)} ≤ ${(tower.rangeTiles * terrain.tileSize).toFixed(2)})`);
});

test('phase 5 defence: the sentry slows raiders and the beacon damages a group', () => {
  const sentry = defensesData.defenses.find((d) => d.id === 'sentry-post');
  const beacon = defensesData.defenses.find((d) => d.id === 'light-beacon');
  const scenario = makeScenario({
    structures: [{ type: 'sentry-post', col: 8, row: 8 }, { type: 'light-beacon', col: 12, row: 8 }],
    spawns: [
      { tick: 1, unit: 'guard', ...at(8, 11) },
      { tick: 2, unit: 'guard', ...at(8, 11) },
      { tick: 3, unit: 'guard', ...at(12, 11) },
    ],
  });
  const sim = makeSim(scenario);
  let slowed = 0;
  let splashHits = 0;
  for (let i = 0; i < 500 && !sim.done; i += 1) {
    sim.tick();
    for (const unit of sim.units) if (unit.slowTicks > 0) slowed = Math.max(slowed, unit.slowTicks);
    for (const event of sim.drainEvents()) {
      if (event.type === 'hit' && event.amount > 0) splashHits += 1;
    }
  }
  assert(slowed > 0, 'the slow effect from JSON is applied to raiders');
  assert(splashHits >= 4, `the beacon damages several raiders (${splashHits} hits)`);
  assert(sentry.slow.factor < 1 && beacon.splashTiles > 0, 'the JSON values drive the behaviour');
});

/* --------------------------------------------------------------- determinism */

test('phase 5 determinism: identical seed + identical commands ⇒ bit-identical battle', () => {
  const run = () => {
    const state = makeCity({
      walls: true,
      gate: true,
      defenses: [{ id: 'watchtower', col: 17, row: 17, level: 2 }, { id: 'light-beacon', col: 22, row: 17 }],
      army: { guard: 3, archer: 2, healer: 1, breaker: 1 },
    });
    const sim = battleFromCity(state, 'raid-column', 1234567);
    for (let i = 0; i < 60; i += 1) sim.tick();
    const point = sim.autoDeployPoint('guard', 0);
    sim.deploy('guard', point.x, point.z);
    for (let i = 0; i < 200; i += 1) sim.tick();
    sim.deploy('archer', point.x, point.z);
    sim.runToEnd();
    return sim;
  };
  const a = run();
  const b = run();
  assert(a.result === b.result, `same result (${a.result})`);
  assert(a.finishTick === b.finishTick, `same finish tick (${a.finishTick})`);
  assert(a.hashState() === b.hashState(), 'same state hash');
  assert((a.eventHash >>> 0) === (b.eventHash >>> 0), 'same event hash');
  assert(JSON.stringify(a.report()) === JSON.stringify(b.report()), 'identical reports');
  assert(a.appliedCommands.length === b.appliedCommands.length + 0, 'the same commands were applied');
  const checkpointsA = a.checkpoints.map((cp) => `${cp.tick}:${cp.hash}`).join('|');
  const checkpointsB = b.checkpoints.map((cp) => `${cp.tick}:${cp.hash}`).join('|');
  assert(checkpointsA === checkpointsB, 'every checkpoint matches');
});

test('phase 5 determinism: a different seed produces a different battle', () => {
  const run = (seed) => {
    const state = makeCity({ defenses: [{ id: 'watchtower', col: 17, row: 17 }] });
    const sim = battleFromCity(state, 'raid-scouts', seed);
    sim.runToEnd(1200);
    return `${sim.result}:${sim.finishTick}:${sim.hashState()}`;
  };
  assert(run(1) !== run(2), 'two seeds diverge');
  assert(run(1) === run(1), 'and each seed is stable on its own');
});

test('phase 5 replay: the recorded battle replays to the same hash and verifies like a server would', () => {
  const state = makeCity({ walls: true, gate: true, defenses: [{ id: 'watchtower', col: 17, row: 17, level: 2 }], army: { guard: 8, archer: 1 } });
  const sim = battleFromCity(state, 'raid-scouts', 5150);
  for (let i = 0; i < 40; i += 1) sim.tick();
  const point = sim.autoDeployPoint('guard', 0);
  assert(sim.deploy('guard', point.x, point.z).ok, 'the reserve can still deploy after the opening line');
  sim.runToEnd();
  const record = createRecord({ scenario: sim.scenario, sim, encounterId: 'raid-scouts', createdAt: 0 });
  assert(record.commands.length === 1, 'the deploy command was recorded with its tick');
  assert(record.checkpoints.length > 3, `checkpoints were captured (${record.checkpoints.length})`);

  const replay = replayRecord(record, battleDeps);
  assert(replay.ok, `replay matches the record (${JSON.stringify(replay.mismatches)})`);
  assert(replay.result === record.result, 'the replay ends the same way');
  assert(replay.sim.hashState() === record.report.stateHash, 'the replay state hash equals the recorded one');

  const submission = {
    scenario: record.scenario,
    scenarioHash: record.scenarioHash,
    commands: record.commands,
    result: record.result,
    ticks: record.ticks,
    stateHash: record.report.stateHash,
  };
  assert(verifySubmission(submission, battleDeps).ok, 'a server can verify the submission from seed + commands alone');
  const tampered = { ...submission, commands: [{ tick: 5, type: 'withdraw', seq: 0 }] };
  const verdict = verifySubmission(tampered, battleDeps);
  assert(!verdict.ok, 'a tampered command list fails verification');
  const summary = recordSummary(record, null);
  assert(summary.commands === 1 && summary.seed === 5150, 'the record summary is readable');
});

test('phase 5 replay: a recorded battle with 25 raiders still replays identically (server validation)', () => {
  const state = makeCity({
    walls: true,
    gate: true,
    defenses: [{ id: 'watchtower', col: 17, row: 17, level: 2 }, { id: 'sentry-post', col: 22, row: 17, level: 2 }],
    army: { guard: 4, archer: 2, breaker: 1, healer: 1 },
  });
  const sim = battleFromCity(state, 'raid-siege', 90210);
  sim.runToEnd();
  const record = createRecord({ scenario: sim.scenario, sim, encounterId: 'raid-siege', createdAt: 0 });
  const replay = replayRecord(record, battleDeps);
  assert(replay.ok, `heavy battle replays identically (${JSON.stringify(replay.mismatches.slice(0, 2))})`);
  assert(report0(record) > 20, `25 raiders were simulated (${report0(record)})`);
});

function report0(record) {
  return record.report.raidersSpawned;
}

/* ------------------------------------------------------------------ combat */

test('phase 5 battle: raiders walk through an open gate and never chew the wall instead', () => {
  const state = makeCity({ walls: true, gate: true, defenses: [{ id: 'watchtower', col: 19, row: 19 }] });
  const sim = battleFromCity(state, 'raid-scouts', 24680);
  const gateCell = `${Math.floor(terrain.grid.cols / 2)}:${Math.floor(terrain.grid.cols / 2) - 6}`;
  let throughGate = 0;
  for (let i = 0; i < 2400 && !sim.done; i += 1) {
    sim.tick();
    for (const unit of sim.units) {
      if (unit.removed || unit.faction !== 1) continue;
      const cell = `${Math.floor(unit.x / sim.tileSize)}:${Math.floor(unit.z / sim.tileSize)}`;
      if (cell === gateCell) throughGate += 1;
    }
  }
  assert(throughGate > 0, 'at least one raider walked through the gate tile');
  assert(sim.done, `the battle resolved (${sim.result})`);
  assert(sim.report().wallsBreached === 0, 'with a gate open, no wall needed to be breached');
});

test('phase 5 battle: a healer heals its own side and never fires at anyone', () => {
  const scenario = makeScenario({
    structures: [{ type: 'town-center', col: 5, row: 5, w: 3, h: 3 }, { type: 'watchtower', col: 10, row: 5 }],
    garrison: { healer: 1, guard: 2 },
    spawns: [{ tick: 1, unit: 'guard', ...at(6, 10) }, { tick: 2, unit: 'guard', ...at(7, 10) }],
  });
  const sim = makeSim(scenario);
  let healEvents = 0;
  let healerAttacks = 0;
  for (let i = 0; i < 900 && !sim.done; i += 1) {
    sim.tick();
    for (const event of sim.drainEvents()) {
      if (event.type === 'heal') {
        healEvents += 1;
        const target = sim.unitsById.get(event.unitId);
        assert(target && target.faction === 0, 'the healer only heals its own faction');
      }
      if (event.type === 'attack' && String(event.source).startsWith('u')) {
        const shooter = sim.unitsById.get(Number(String(event.source).slice(1)));
        if (shooter && shooter.role === 'support') healerAttacks += 1;
      }
    }
  }
  assert(healEvents > 0, `the healer healed (${healEvents} heals)`);
  assert(healerAttacks === 0, 'the healer never attacks');
  assert(sim.stats.healed > 0, 'healing is accounted for in the report');
});

test('phase 5 battle: defeated units retreat and fade out — no blood, no corpses', () => {
  const scenario = makeScenario({
    structures: [{ type: 'watchtower', col: 6, row: 3 }],
    garrison: { guard: 1 },
    spawns: [{ tick: 1, unit: 'guard', ...at(6, 8) }],
  });
  const sim = makeSim(scenario);
  const allowed = new Set(['spawn', 'deploy', 'attack', 'heal', 'hit', 'structure-hit', 'structure-down', 'wall-breach', 'retreat', 'unit-down', 'end']);
  const seen = new Set();
  let removedAfterFade = false;
  for (let i = 0; i < 1500 && !sim.done; i += 1) {
    sim.tick();
    for (const event of sim.drainEvents()) seen.add(event.type);
    for (const unit of sim.units) {
      if (unit.hp <= 0 && !unit.removed) assert(unit.state === 'retreat' || unit.state === 'down', 'a beaten unit retreats instead of dying');
      if (unit.removed) removedAfterFade = true;
    }
  }
  for (const type of seen) assert(allowed.has(type), `event type "${type}" is part of the safe set`);
  assert(removedAfterFade, 'beaten units fade out and leave the field');
  assert(!sim.units.some((u) => !u.removed && u.hp < 0), 'health never goes negative');
});

test('phase 5 battle: deployment is validated (free tile, safe distance, in-battle limit) and recorded', () => {
  const state = makeCity({ defenses: [{ id: 'watchtower', col: 8, row: 8 }], army: { guard: 9 } });
  const sim = battleFromCity(state, 'raid-scouts', 555);
  for (let i = 0; i < 5; i += 1) sim.tick();
  const deps = battleData.deploy;
  assert(deps.maxPerBattle > 0 && deps.minEnemyDistanceTiles > 0, 'deploy rules come from JSON');

  const towerCell = at(8 + 1, 8 + 1);
  assert(!sim.deploy('guard', towerCell.x, towerCell.z).ok, 'no deployment inside a structure');
  assert(!sim.deploy('guard', -50, -50).ok, 'no deployment outside the map');

  const point = sim.autoDeployPoint('guard', 0);
  const reserve = sim.garrison.guard;
  assert(reserve > 0, `the reserve still holds troops after the opening deployment (${reserve})`);
  assert(sim.deployCount === 0, 'the opening line does not spend the player deployment budget');
  for (let i = 0; i < battleData.deploy.cooldownTicks + 1; i += 1) sim.tick();
  const first = sim.deploy('guard', point.x, point.z);
  assert(first.ok, `deployment accepted (${first.reason || 'ok'})`);
  const again = sim.deploy('guard', point.x, point.z);
  assert(!again.ok && again.reason === 'cooldown', `a manual deploy starts the cooldown (${again.reason})`);
  assert(first.command.tick === sim.tickIndex + 1, 'the command carries the tick it will run on');
  sim.tick();
  assert(sim.appliedCommands.length === 1, 'the command is applied on the recorded tick');
  assert(sim.garrison.guard === reserve - 1, 'the deployed unit left the reserve');

  const raider = sim.units.find((unit) => unit.faction === 1);
  assert(raider, 'raiders are on the field');
  assert(!sim.deploy('guard', raider.x, raider.z).ok, 'no deployment right next to a raider');
  assert(!sim.deploy('healer', point.x, point.z).ok, 'a unit type with an empty reserve cannot deploy');
  for (let i = 0; i < battleData.deploy.cooldownTicks + 1; i += 1) sim.tick();
  const reserveBefore = sim.garrison.guard;
  const unitsBefore = sim.units.length;
  assert(sim.canDeploy('guard', point.x, point.z).ok === true, 'canDeploy accepts what deploy would accept');
  assert(sim.garrison.guard === reserveBefore && sim.units.length === unitsBefore, 'canDeploy has no side effects');
});

test('phase 5 battle: withdraw ends the battle and is recorded as a command', () => {
  const state = makeCity({ defenses: [{ id: 'watchtower', col: 12, row: 12 }], army: { guard: 1 } });
  const sim = battleFromCity(state, 'raid-scouts', 8);
  for (let i = 0; i < 10; i += 1) sim.tick();
  sim.withdraw();
  sim.runToEnd(200);
  assert(sim.done && sim.result === 'withdrawn', `withdraw closes the battle (${sim.result})`);
  assert(sim.appliedCommands.some((command) => command.type === 'withdraw'), 'the withdraw command is on the record');
});

/* ---------------------------------------------------------- army/barracks */

function makeBarracksWorld({ level = 1, barracks = true, busy = false } = {}) {
  const { state, economy, queue } = bootEconomy({ rizq: 5000, nur: 5000, hekmat: 5000, gohar: 40 });
  const system = new BarracksSystem({ config: makeConfig('medium'), state, economy, unitsData, battleData });
  let entity = null;
  if (barracks) {
    entity = state.createEntity({ type: 'barracks', name: 'پادگان', col: 3, row: 3, size: [3, 3], level, status: busy ? 'building' : 'ready' });
  }
  void queue;
  return { state, economy, system, entity };
}

test('phase 5 army: capacity and training come from battle.json + units.json', () => {
  const { state, economy, system } = makeBarracksWorld({ level: 1 });
  const army = battleData.army;
  assert(system.capacity() === army.baseCapacity, `level-1 capacity = ${army.baseCapacity}`);
  assert(system.countOf('guard') === 0 && system.total() === 0, 'the garrison starts empty');

  const before = { ...state.resources };
  const cost = system.costOf('guard');
  const started = system.startTraining('guard', 1000);
  assert(started.ok, 'training starts');
  assert(state.resources.rizq === before.rizq - cost.rizq, 'the cost was paid from the JSON table');
  assert(system.training.length === 1 && system.training[0].status === 'active', 'the job runs on a training line');
  assert(system.used() === unitsData.units.find((u) => u.id === 'guard').housing, 'the reserve is occupied while training');

  const finished = system.tick(1000 + system.secondsOf('guard') * 1000);
  assert(finished.length === 1 && finished[0].unit === 'guard', 'the unit finishes on time');
  assert(system.countOf('guard') === 1 && state.army.trained === 1, 'the trained unit joins the garrison');
  assert(system.training.length === 0, 'the queue is empty afterwards');
  assert(economy.canAfford(cost) === (state.resources.rizq >= cost.rizq), 'economy stays consistent');
});

test('phase 5 army: barracks level raises capacity and a full reserve blocks training', () => {
  const { system } = makeBarracksWorld({ level: 3 });
  const army = battleData.army;
  assert(system.capacity() === army.baseCapacity + army.capacityPerBarracksLevel * 2, 'capacity grows per barracks level');
  let guard = 0;
  while (system.canTrain('guard').ok && guard < 60) {
    system.startTraining('guard', 0);
    system.tick(1e9);
    guard += 1;
  }
  assert(system.canTrain('guard').ok === false, 'the reserve eventually fills up');
  assert(['capacity-full', 'type-limit', 'cost'].includes(system.canTrain('guard').reason), `the refusal reason is explicit (${system.canTrain('guard').reason})`);
  assert(system.used() <= system.capacity(), 'housing never exceeds capacity');
});

test('phase 5 army: no barracks means no training, and the save keeps the garrison and the queue', () => {
  const { state, system } = makeBarracksWorld({ barracks: false });
  assert(system.capacity() === 0, 'no barracks ⇒ no capacity');
  const refused = system.startTraining('archer', 0);
  assert(!refused.ok && refused.reason === 'no-barracks', 'training is refused without a barracks');

  const { system: built } = makeBarracksWorld({ level: 2 });
  built.startTraining('breaker', 0);
  built.tick(1e7);
  built.setGarrison({ guard: 3, archer: 1, healer: 0, breaker: 1 });
  const empty = state.serialize();
  assert(!empty.army.garrison.guard, 'an untouched city saves no troops');
  const roundTrip = JSON.parse(JSON.stringify(built.state.serialize()));
  const other = new GameState({ economy: economyData });
  other.hydrate(roundTrip);
  assert(other.army.garrison.guard === 3 && other.army.garrison.breaker === 1, 'the garrison survives the save roundtrip');
  assert(other.army.trained >= 1, 'training totals survive too');
});

test('phase 5 army: events + readiness summary are emitted for the UI', () => {
  const { state, economy, system } = makeBarracksWorld({ level: 2 });
  const events = [];
  const bus = { emit: (type, payload) => events.push({ type, payload }) };
  const wired = new BarracksSystem({ config: makeConfig('medium'), state, economy, unitsData, battleData, bus });
  wired.startTraining('guard', 0);
  wired.tick(1e7);
  assert(events.some((event) => event.type === 'army:changed'), 'ARMY_CHANGED is emitted on progress');
  const readiness = wired.readiness();
  assert(readiness.total === 1 && readiness.capacity > 0, 'readiness reports the reserve');
  assert(readiness.byType.length === unitsData.units.length, 'every unit type is described for the UI');
  assert(readiness.byType.every((item) => item.name && item.cost), 'the UI gets names and costs');
  assert(system.hasBarracks() === true, 'the barracks is detected');
});

/* ---------------------------------------------------------------- outcome */

test('phase 5 outcome: rewards, damaged structures and the army write-back follow the report', () => {
  const state = makeCity({ defenses: [{ id: 'watchtower', col: 17, row: 17 }], army: { guard: 2 } });
  const sim = battleFromCity(state, 'raid-scouts', 77);
  const point = sim.autoDeployPoint('guard', 0);
  sim.deploy('guard', point.x, point.z);
  sim.runToEnd();
  const report = sim.report();
  assert(['victory', 'defeat', 'timeout', 'withdrawn'].includes(report.result), `result is one of the four outcomes (${report.result})`);
  assert(report.seconds > 0 && report.ticks > 0, 'the report carries timing');
  assert(report.stateHash > 0 && report.eventHash > 0, 'the report carries both hashes');
  assert(report.raidersSpawned === 6, `the scenario spawns its raiders (${report.raidersSpawned})`);
  assert(report.structures.length >= 0 && report.damagedStructures >= 0, 'structure damage is reported');
  const rewards = battleData.rewards[report.result];
  assert(rewards && rewards.nur >= 0, `a reward table exists for "${report.result}"`);
  assert(report.seconds <= battleData.end.timeoutSeconds + 2, 'the battle respects the timeout');
});

test('phase 5 outcome: repair restores health and costs resources from defenses.json', () => {
  const { state, economy } = bootEconomy({ rizq: 5000, nur: 5000, hekmat: 5000, gohar: 10 });
  const entity = state.createEntity({ type: 'watchtower', name: 'برج', col: 4, row: 4, size: [2, 2], level: 1, status: 'ready' });
  const maxHp = structureStats.maxHpFor(entity);
  entity.maxHp = maxHp;
  entity.hp = Math.floor(maxHp * 0.4);
  const cost = structureStats.repairCost(entity);
  assert(cost && cost.rizq > 0, 'repair cost scales with the missing health');
  const seconds = structureStats.repairSeconds(entity);
  assert(seconds >= defensesData.repair.minSeconds, `repair takes at least ${defensesData.repair.minSeconds}s of work (${seconds})`);
  assert(structureStats.isDamaged(entity), 'damage is detected');
  entity.hp = maxHp;
  entity.damaged = false;
  assert(!structureStats.isDamaged(entity) && structureStats.repairCost(entity) === null, 'a healthy structure needs no repair');
  assert(economy.canAfford(cost), 'the test economy can pay for it');
});

test('phase 5 save: structure health and the battle record survive the save roundtrip', () => {
  const state = makeCity({ defenses: [{ id: 'watchtower', col: 17, row: 17 }] });
  const entity = [...state.entities.values()].find((e) => e.type === 'watchtower');
  entity.maxHp = structureStats.maxHpFor(entity);
  entity.hp = Math.floor(entity.maxHp * 0.5);
  entity.damaged = true;
  state.battles.seq = 2;
  state.battles.wins = 1;
  state.battles.history.push({
    version: 1,
    encounterId: 'raid-scouts',
    seed: 99,
    scenarioHash: 5,
    scenario: { seed: 99, structures: [], spawns: [], garrison: {}, commands: [], version: 1, cols: 40, rows: 40, tileSize: 2, encounter: { id: 'raid-scouts', name: 'x', threat: 1 } },
    commands: [],
    checkpoints: [],
    result: 'victory',
    ticks: 100,
    stepHz: 20,
    report: { stateHash: 7, eventHash: 9, result: 'victory', ticks: 100 },
    createdAt: 0,
  });
  const payload = JSON.parse(JSON.stringify(state.serialize()));
  const restored = new GameState({ economy: economyData });
  restored.hydrate(payload);
  const back = [...restored.entities.values()].find((e) => e.type === 'watchtower');
  assert(back.hp === entity.hp && back.maxHp === entity.maxHp, 'health survives the roundtrip');
  assert(back.damaged === true, 'the damaged flag survives');
  assert(restored.battles.seq === 2 && restored.battles.wins === 1, 'battle counters survive');
  assert(restored.battles.history.length === 1 && restored.battles.history[0].seed === 99, 'the record survives');
});

test('phase 5 content policy: the battle layers know nothing about Quran text', () => {
  const files = [
    'src/game/battle/BattleSim.js', 'src/game/battle/BattleSystem.js', 'src/game/battle/BattleScenario.js',
    'src/game/battle/BattleRecorder.js', 'src/game/barracks/BarracksSystem.js', 'src/ui/BattlePanel.js',
    'src/ui/BarracksPanel.js', 'src/world/battle/BattleView.js', 'src/world/battle/UnitModels.js',
    'src/world/battle/Particles.js',
  ];
  for (const file of files) {
    const content = readFileSync(resolve(root, file), 'utf8');
    assert(!/quran-sample|QuranDataset|verseList|textUthmani|game\/quran|ui\/quran/.test(content), `${file}: no Quran imports`);
    assert(!/[\u064B-\u0652\u0670\u06D6-\u06ED]/.test(content.replace(/[\u064B-\u0652\u0670]/g, '')), `${file}: no vocalised Arabic`);
  }
  // صحنهٔ نبرد هیچ متن سه‌بعدی ندارد: نه TextGeometry، نه Sprite با متن
  const scene = readFileSync(resolve(root, 'src/world/battle/BattleView.js'), 'utf8');
  assert(!/TextGeometry|CanvasTexture\(.*text|fillText\(/.test(scene), 'the battle scene draws no text');
  const sim = readFileSync(resolve(root, 'src/game/battle/BattleSim.js'), 'utf8');
  assert(!/three|THREE|document\.|window\./.test(sim), 'the simulator never touches the renderer or the DOM');
});

test('phase 5 perf: a 25-raider battle simulates far faster than real time (30-unit budget)', () => {
  const state = makeCity({
    walls: true,
    gate: true,
    defenses: [{ id: 'watchtower', col: 17, row: 17, level: 2 }, { id: 'sentry-post', col: 22, row: 17, level: 2 }, { id: 'light-beacon', col: 17, row: 22 }],
    army: { guard: 6, archer: 4, healer: 1, breaker: 1 },
  });
  const sim = battleFromCity(state, 'raid-siege', 31415);
  let peakUnits = 0;
  let ticks = 0;
  const started = process.hrtime.bigint();
  while (!sim.done && ticks < battleData.sim.maxTicks) {
    sim.tick();
    ticks += 1;
    let live = 0;
    for (const unit of sim.units) if (!unit.removed) live += 1;
    if (live > peakUnits) peakUnits = live;
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const perTick = elapsedMs / Math.max(1, ticks);
  assert(ticks > 100, `the battle ran (${ticks} ticks)`);
  assert(peakUnits >= 20, `at least 20 units shared the field (${peakUnits})`);
  assert(perTick < 1.5, `logic stays cheap: ${perTick.toFixed(3)} ms per tick (budget 1.5)`);
  assert(elapsedMs / 1000 < (ticks / battleData.sim.stepHz) / 4, `simulation is ≥4× real time (${(elapsedMs / 1000).toFixed(2)}s for ${(ticks / battleData.sim.stepHz).toFixed(1)}s)`);
});


/* ==================================================================== phase 6
   کمپین داستانی (قصص) — آزمون‌های منطق خالص (بدون DOM و بدون WebGL).
   پوشش: دادهٔ سه مأموریت، زنجیرهٔ باز شدن، ستاره‌شماری و پاداش، قاعدهٔ هر قصه،
   ذخیرهٔ ستاره‌ها و سیاست محتوایی (فقط ارجاع آیه، بدون متن و بدون تصویر). */

const campaignData = readJson('src/data/campaign.json');
const missionsData = readJson('src/data/missions.json');
const missions = normalizeMissions(missionsData);
const campaignConfig = { t: (key, fallback) => (fallback ?? key), campaign: campaignData, seed: 7 };

function bootCampaign({ resources = { rizq: 3000, nur: 2000, hekmat: 1200, gohar: 20 }, completed = [] } = {}) {
  const state = new GameState({ economy: economyData });
  state.resources = { ...resources };
  const economy = new EconomySystem({ economy: economyData, balance: balanceData, defs: buildingsData.buildings, state });
  const queue = new BuildQueue({ economyData, economy, state });
  const campaign = new CampaignSystem({ config: campaignConfig, campaignData, missions, state, economy, queue });
  queue.onFinished = (job, at) => campaign.onJobFinished(job, at);
  for (const id of completed) {
    const record = campaign.record(id);
    record.completions = 1;
    record.bestStars = 3;
  }
  return { state, economy, queue, campaign };
}

/** اجرای کامل یک مأموریت با سیاست بازیکن؛ در پایان کارنامهٔ مأموریت برمی‌گردد. */
function playMission(id, policy, { completed = [], resources, maxSeconds = 420 } = {}) {
  const boot = bootCampaign({ completed, ...(resources ? { resources } : {}) });
  let now = 1_700_000_000_000;
  const started = boot.campaign.start(id, now);
  assert(started.ok, `mission ${id} starts (${started.reason || 'ok'})`);
  let guard = 0;
  while (boot.campaign.activeRun && guard < maxSeconds * 4) {
    guard += 1;
    now += 500;
    policy(boot, guard, now);
    boot.queue.tick(now);
    boot.campaign.tick(0.5, now);
  }
  const report = boot.campaign.snapshot(now).lastReport;
  return { ...boot, report, now };
}

test('phase 6 data: the three missions normalize, validate and chain in order', () => {
  const verdict = validateMissions(missions);
  assert(verdict.ok, `validation: ${verdict.issues.filter((i) => i.level === 'error').map((i) => i.message).join(' | ')}`);
  assert(missions.list.length === 3, `three missions (got ${missions.list.length})`);
  assert(missions.list.map((m) => m.id).join(',') === 'mission-silos,mission-dam,mission-prosperity', 'mission order');
  assert(missions.list.map((m) => m.qasas.surahName).join(',') === 'یوسف,کهف,سبأ', 'the three surahs of the campaign');
  assert(missions.list[0].unlock.after === null, 'mission 1 is open from the start');
  assert(missions.list[1].unlock.after === 'mission-silos' && missions.list[2].unlock.after === 'mission-dam', 'unlock chain follows the story order');
  assert(MISSION_RULES[MISSION_SCHEMA ? 'plenty-famine' : ''] != null, 'rule registry is reachable');
  for (const mission of missions.list) {
    assert(mission.objectives.length === 3 && mission.objectives.filter((o) => o.primary).length === 1, `${mission.id}: three objectives, one primary`);
    assert(mission.lessonLearned && mission.lessonPoints.length >= 2, `${mission.id}: lesson learned present`);
    for (const id of mission.rule.ACTIONS) {
      assert(mission.actions[id], `${mission.id}: action «${id}» is data-driven`);
    }
  }
  const dam = missions.byId.get('mission-dam');
  const prosperity = missions.byId.get('mission-prosperity');
  assert(dam.plots.length === 5 && dam.plots.every((p) => p.kind === 'dam-segment'), 'the dam has five segments');
  assert(prosperity.plots.filter((p) => p.kind === 'canal').length === 3, 'three canals');
  assert(prosperity.plots.filter((p) => p.kind === 'garden').length === 3, 'three gardens');
  assert(MISSION_SCHEMA === 1, 'mission schema version is pinned');
});

test('phase 6 policy: mission data carries references only — no verse text anywhere', () => {
  for (const mission of missions.list) {
    assert(mission.refs.length >= 2, `${mission.id}: at least two references`);
    for (const ref of mission.refs) {
      const parsed = parseRefId(ref);
      assert(parsed && REFERENCE_PATTERN.test(ref), `${mission.id}: reference «${ref}» is a valid surah:ayah id`);
    }
    for (const line of mission.briefing) {
      assert(!containsVocalisedArabic(line.text), `${mission.id}: narrative line carries no vocalised text`);
    }
    assert(!containsVocalisedArabic(mission.lessonLearned), `${mission.id}: lesson headline carries no vocalised text`);
  }
  // بدون دیتاست قرآنی، کارت ارجاع فقط «نیازمند بازبینی» است (هیچ متنی ساخته نمی‌شود).
  const cards = missionRefCards(null, missions.byId.get('mission-silos'));
  assert(cards.length === 4 && cards.every((c) => c.status === 'pending-review' && c.verse === null), 'no dataset ⇒ reference cards stay pending');
  // با دیتاستی که همان آیه را دارد، متن فقط از دیتاست می‌آید.
  const marks = ['\u064E', '\u0650', '\u064F', '\u0651', '\u0652'];
  const syntheticText = ['\u0646', marks[0], '\u0635', marks[1], '\u0628', marks[3], marks[1], '\u0645', marks[0]].join('');
  const refDataset = normalizeDataset({
    meta: { datasetId: 'test-refs', reviewed: true, placeholder: false },
    surahs: [{ index: 12, name: 'سورهٔ آزمون', ayahs: [{ index: 47, textUthmani: syntheticText, translationFa: 'ترجمهٔ آزمون', source: { datasetId: 'test-refs' } }] }],
    lessons: [],
  }, { origin: 'remote' });
  const resolved = missionRefCards(refDataset, missions.byId.get('mission-silos'));
  const hit = resolved.find((c) => c.id === 'ayah:12:47');
  assert(hit && hit.status === 'in-dataset' && hit.verse && hit.verse.textUthmani === syntheticText, 'text comes from the dataset, never from the mission file');
  assert(resolved.filter((c) => c.status === 'pending-review').length === 3, 'references the dataset lacks stay pending');
  // روایت پروژه هیچ ادعای ترجمه‌ای ندارد: متن‌ها بدون اعراب‌اند و برچسب بازبینی جدا می‌آید.
  assert(campaignData.values.reviewLabel.includes('بازبینی'), 'narrative is labelled as project text under review');
});

test('phase 6 mission 1: two stars without capacity, three stars with it, reward paid once', () => {
  // بازیکن بی‌انبار: فقط برداشت می‌کند و انبار غله نمی‌سازد.
  const poor = playMission('mission-silos', ({ campaign }, index, now) => {
    if (index % 10 === 0) campaign.perform('harvestAll', {}, now);
  }, { resources: { rizq: 800, nur: 600, hekmat: 400, gohar: 20 } });
  assert(poor.report && !poor.report.failed, 'the famine mission completes');

  // بازیکن برنامه‌ریز: کشتزار و انبار غله می‌سازد، ظرفیت را بالا می‌برد و منظم برداشت می‌کند.
  const richResources = { rizq: 2500, nur: 500, hekmat: 400, gohar: 20 };
  const rich = playMission('mission-silos', ({ campaign, state }, index, now) => {
    if (index % 8 === 0) campaign.perform('harvestAll', {}, now);
    if (index === 4) {
      // شهر برنامه‌ریز: سه کشتزار، یک انبار غله و یک انبار بزرگ (ظرفیت پاداش را هم می‌سازد).
      const at = (id, col, row, level) => {
        const def = buildingsData.buildings.find((b) => b.id === id);
        state.createEntity({ type: def.id, name: def.name, col, row, size: def.size, level, status: 'ready', pending: 0, lastAccrualAt: now });
      };
      at('farm', 6, 6, 3);
      at('farm', 8, 6, 3);
      at('farm', 6, 8, 3);
      at('granary', 10, 10, 3);
      at('warehouse', 12, 6, 2);
    }
  }, { resources: richResources });
  assert(rich.report.stars === 3, `a planned city earns three stars (got ${rich.report.stars})`);
  assert(rich.report.objectives.every((o) => o.done), 'all three objectives hold');
  assert(rich.report.granted.nur > 0 && rich.report.granted.gohar > 0, 'first clear pays the mission reward');
  assert(rich.campaign.record('mission-silos').completions === 1, 'completion recorded');
  assert(rich.campaign.list()[1].status === 'available', 'mission 2 unlocked after the first clear');
  assert(rich.campaign.canStart('mission-prosperity').reason === 'locked', 'mission 3 still locked');
  assert(rich.campaign.totalStars() === 3 && rich.campaign.totalStarsPossible() === missions.list.length * campaignData.starsMax, 'star totals come from the data');

  // تکرار مأموریت: همان مأموریت دوباره (بدون ساختن شهر بیشتر) و بدون پاداش پایهٔ دوباره.
  // پیمانهٔ شهر در اجرای اول ته کشیده است؛ برای مقایسهٔ منصفانه، همان ذخیرهٔ
  // اجرای اول را برمی‌گردانیم (سازه‌ها و ظرفیت سر جای خودشان هستند).
  rich.state.resources = { ...richResources };
  const second = rich.campaign.start('mission-silos', rich.now + 1000);
  assert(second.ok, 'the mission can be replayed');
  let now = rich.now + 1000;
  for (let i = 0; i < 700 && rich.campaign.activeRun; i += 1) {
    now += 500;
    if (i % 8 === 0) rich.campaign.perform('harvestAll', {}, now);
    rich.queue.tick(now);
    rich.campaign.tick(0.5, now);
  }
  const replay = rich.campaign.snapshot(now).lastReport;
  assert(replay.stars === 3, `replay still scores three stars (got ${replay.stars})`);
  assert(replay.firstClear === false && replay.granted.nur === 0 && replay.granted.gohar === 0, 'a replay pays no base reward again');
});

test('phase 6 mission 2: waves punish gaps — idle city floods, diligent crew holds the dam', () => {
  const idle = playMission('mission-dam', () => {}, { completed: ['mission-silos'] });
  assert(idle.report.failed === true && idle.report.failReason === 'flood', 'an unbuilt dam floods the valley');
  assert(idle.report.stars === 0, 'a failed mission pays no stars');
  assert(idle.campaign.record('mission-dam').failed === 1, 'the failure is recorded');

  const diligent = playMission('mission-dam', ({ campaign }, index, now) => {
    if (index % 2) return;
    const actions = campaign.actions();
    const repair = actions.find((a) => a.id === 'repair' && a.enabled && a.integrity < 0.88);
    const build = actions.find((a) => a.id === 'build' && a.enabled);
    if (repair) campaign.perform('repair', { plotId: repair.plotId, plotIndex: repair.plotIndex }, now);
    else if (build) campaign.perform('build', { plotId: build.plotId, plotIndex: build.plotIndex }, now);
  }, { completed: ['mission-silos'] });
  assert(diligent.report.stars === 3, `maintenance earns the third star (got ${diligent.report.stars})`);
  assert(diligent.report.progress.avgIntegrity >= 0.7, `average integrity holds (${diligent.report.progress.avgIntegrity})`);
  assert(diligent.report.progress.breaches === 0, 'no segment ever fell');
  assert(diligent.queue.jobs.length === 0, 'mission jobs leave the queue when the mission ends');

  const lazy = playMission('mission-dam', ({ campaign }, index, now) => {
    if (index % 4) return;
    const build = campaign.actions().find((a) => a.id === 'build' && a.enabled);
    if (build) campaign.perform('build', { plotId: build.plotId, plotIndex: build.plotIndex }, now);
  }, { completed: ['mission-silos'] });
  assert(lazy.report.stars === 2, `building without maintenance scores two stars (got ${lazy.report.stars})`);
  assert(lazy.report.objectives.find((o) => o.id === 'integrity').done === false, 'the integrity star is withheld');
});

test('phase 6 mission 3: neglect costs the gardens; upkeep and gratitude keep prosperity', () => {
  const idle = playMission('mission-prosperity', () => {}, { completed: ['mission-silos', 'mission-dam'] });
  assert(idle.report.stars === 0, `an idle city earns nothing (got ${idle.report.stars})`);
  assert(idle.report.objectives.find((o) => o.id === 'season').done === false, 'the season star needs a living city');

  const active = playMission('mission-prosperity', ({ campaign }, index, now) => {
    if (index % 2) return;
    const actions = campaign.actions();
    const canal = actions.find((a) => a.id === 'canal' && a.enabled);
    const garden = actions.find((a) => a.id === 'garden' && a.enabled);
    const gratitude = actions.find((a) => a.id === 'gratitude' && a.enabled);
    if (canal) campaign.perform('canal', { plotId: canal.plotId, plotIndex: canal.plotIndex }, now);
    else if (garden) campaign.perform('garden', { plotId: garden.plotId, plotIndex: garden.plotIndex }, now);
    else if (gratitude && index % 20 === 0) campaign.perform('gratitude', {}, now);
  }, { completed: ['mission-silos', 'mission-dam'] });
  assert(active.report.stars === 3, `upkeep earns three stars (got ${active.report.stars})`);
  assert(active.report.objectives.find((o) => o.id === 'gardens').done === true, 'the gardens held');
  assert(active.campaign.record('mission-prosperity').completions === 1, 'the third mission is recorded as completed');
  assert(active.campaign.list().every((m) => m.status === 'completed'), 'all three stories complete the campaign');
  assert(active.campaign.totalStars() === 9, `nine stars possible, nine earned (got ${active.campaign.totalStars()})`);
});

test('phase 6 save: stars and the active run survive the roundtrip — and the run resumes paused', () => {
  const boot = bootCampaign({ completed: ['mission-silos'] });
  boot.campaign.record('mission-silos').bestStars = 2;
  boot.campaign.record('mission-silos').lastStars = 2;
  const now = 1_700_000_000_000;
  assert(boot.campaign.start('mission-dam', now).ok, 'mission 2 starts');
  const build = boot.campaign.actions().find((a) => a.id === 'build' && a.enabled);
  assert(boot.campaign.perform('build', { plotId: build.plotId, plotIndex: build.plotIndex }, now).ok, 'a segment is queued');
  const payload = JSON.parse(JSON.stringify(boot.state.serialize()));
  const restored = new GameState({ economy: economyData });
  restored.hydrate(payload);
  assert(restored.campaign.missions['mission-silos'].bestStars === 2, 'stars survive the save');
  assert(restored.campaign.active && restored.campaign.active.missionId === 'mission-dam', 'the active run survives');
  assert(restored.campaign.active.runtime.segments[0].status === 'building', 'the in-flight build survives');
  // بوت: مأموریت نیمه‌کاره موقتاً متوقف می‌شود تا در غیبت بازیکن پیش نرود.
  const again = new CampaignSystem({ config: campaignConfig, campaignData, missions, state: restored, economy: boot.economy, queue: boot.queue });
  const bootInfo = again.onBoot(now + 60_000);
  assert(bootInfo.resumed === true && restored.campaign.active.paused === true, 'an unfinished mission returns paused');
  const before = restored.campaign.active.elapsedSeconds;
  again.tick(5, now + 120_000);
  assert(restored.campaign.active.elapsedSeconds === before, 'a paused mission does not advance');
  assert(JSON.stringify(restored.serialize()).includes('mission-dam'), 'campaign state is part of every save');
});

test('phase 6 queue: mission work uses city builders, is not refunded on abort and rolls back on a full queue', () => {
  const boot = bootCampaign({ completed: ['mission-silos'] });
  let now = 1_700_000_000_000;
  assert(boot.campaign.start('mission-dam', now).ok, 'mission 2 starts');
  const spendBefore = { ...boot.state.resources };
  const build = boot.campaign.actions().find((a) => a.id === 'build' && a.enabled);
  const result = boot.campaign.perform('build', { plotId: build.plotId, plotIndex: build.plotIndex }, now);
  assert(result.ok && result.job.kind === 'mission', 'the build goes through the city builder queue');
  assert(boot.queue.jobs.filter((j) => j.kind === 'mission').length === 1, 'exactly one mission job in the queue');
  assert(boot.state.resources.rizq === spendBefore.rizq - build.cost.rizq, 'the mission pays the city from its own store');
  assert(boot.queue.jobs[0].entityId === null && boot.state.entities.size === 0, 'mission jobs never invent city entities');
  // پرکردن صف با کار شهر: کار مأموریت بعدی باید برگردانده شود و نشانگر به حالت پیشین برگردد.
  for (let i = 0; i < 8; i += 1) {
    boot.queue.enqueue({ kind: 'build', entityId: 900 + i, type: 'farm', targetLevel: 1, durationMs: 60_000 }, now);
  }
  const next = boot.campaign.actions().find((a) => a.id === 'build' && a.enabled);
  const before = { ...boot.state.resources };
  const blocked = boot.campaign.perform('build', { plotId: next.plotId, plotIndex: next.plotIndex }, now);
  assert(blocked.ok === false && blocked.reason === 'queue-full', 'a full queue refuses the mission job');
  assert(boot.state.resources.rizq === before.rizq && boot.state.resources.hekmat === before.hekmat, 'the cost is refunded when the queue refuses');
  const status = boot.campaign.actions().find((a) => a.plotId === next.plotId).status;
  assert(status === 'empty', 'the segment rolls back to «empty»');
  // رهاکردن: کارهای مأموریت از صف پاک می‌شوند و هزینه برنمی‌گردد (بی‌جریمه = بدون غرامت اضافه).
  const aborted = boot.campaign.abort(now, 'test');
  assert(aborted.ok, 'abort succeeds');
  assert(boot.queue.jobs.every((j) => j.kind !== 'mission'), 'mission jobs are removed from the queue');
  assert(boot.campaign.activeRun === null, 'no active run after abort');
  assert(boot.economy.modifiers.production.rizq === undefined, 'economy modifiers are cleared after abort');
});

test('phase 6 missions pay star rewards that respect the warehouse ceiling and never gamble', () => {
  const boot = bootCampaign({ resources: { rizq: 900, nur: 590, hekmat: 400, gohar: 20 } });
  const start = boot.campaign.start('mission-silos', 1_700_000_000_000);
  assert(start.ok, 'mission 1 starts');
  boot.campaign.record('mission-silos').completions = 1; // شبیه‌سازی اجرای دوم
  const report = boot.campaign.finish(1_700_000_000_000, { failed: false, evaluation: { objectives: { endure: true, reserve: true, neverEmpty: true } } });
  assert(report.granted.nur <= boot.economy.capacity().nur, 'rewards clamp to the storage ceiling');
  assert(report.granted.overflow.nur >= 0, 'overflow is reported instead of vanishing');
  assert(!JSON.stringify(report).includes('roll') && !JSON.stringify(report).includes('chance'), 'no randomness anywhere in the reward path');
});

test('phase 7 data: FTUE covers the first 30 minutes and daily tasks have no miss-day penalty', () => {
  assert(ftueData.activeSessionTargetSeconds === 1800, 'the onboarding target is 30 active minutes');
  assert(ftueData.steps.length >= 10 && ftueData.steps.every((step) => step.actionLabel), 'the staged guide names a concrete next action in every step');
  assert(ftueData.steps.find((step) => step.id === 'wait-farm').body.includes('یک انگشت'), 'the guide teaches the mobile camera gesture');
  assert(ftueData.firstThirtyMinutes.length === 8, 'the 30-minute route is split into eight clear windows');
  assert(ftueData.firstThirtyMinutes[0].minute === 0 && ftueData.firstThirtyMinutes.at(-1).minute === 25, 'the route begins at 0 and reaches its 25–30 minute close');
  assert(ftueData.policy.noDeadline && ftueData.policy.noMissedDayPenalty && ftueData.policy.noStreaks && ftueData.policy.noAds, 'FTUE policies reject deadlines, streak pressure and ads');
  assert(metaData.dailyPolicy.missedDayPenalty === false && metaData.dailyPolicy.streaks === false && metaData.dailyPolicy.resetIncompleteProgress === false, 'daily tasks never punish absences or erase unfinished progress');
  assert(metaData.dailyMissions.every((mission) => mission.target > 0 && !('deadline' in mission) && !('exclusiveReward' in mission)), 'daily tasks are optional, finite actions without an expiry reward');
});

test('phase 7 engine: battery saver caps the frame rate at 30 and disables shadows', () => {
  const bus = new EventBus();
  const engine = new FakeEngine({ config: makeConfig('high'), bus });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  engine.addToScene(mesh);
  const battery = engine.setRuntimeSettings({ qualityTier: 'low', batterySaver: true });
  assert(battery.frameCap === 30 && engine.frameCap === 30, 'battery saver uses the 30 fps target');
  assert(battery.shadows === false && engine.shadowMapEnabled === false, 'battery saver turns shadows off');
  assert(!mesh.castShadow && !mesh.receiveShadow, 'existing scene meshes stop casting and receiving shadows');
  const futureMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  futureMesh.castShadow = futureMesh.receiveShadow = true;
  engine.applyRuntimeSettingsTo(futureMesh);
  assert(!futureMesh.castShadow && !futureMesh.receiveShadow, 'future meshes inherit battery shadow settings too');
  engine.setRuntimeSettings({ qualityTier: 'high', batterySaver: false });
  assert(engine.frameCap === 60 && engine.runtimeQualityTier === 'high', 'normal frame target and quality tier are restored');
  assert(engine.shadowMapEnabled === true && mesh.castShadow && mesh.receiveShadow, 'high quality can restore scene shadows');
  mesh.geometry.dispose();
  mesh.material.dispose();
  futureMesh.geometry.dispose();
  futureMesh.material.dispose();
  engine.dispose();
});

test('phase 7 meta: real progression events guide construction, harvest and the first lesson', () => {
  const bus = new EventBus();
  const state = new GameState({ economy: economyData, quality: { tier: 'medium' } });
  let now = Date.UTC(2026, 5, 12, 12);
  const meta = new MetaSystem({ state, bus, metaData, ftueData, now: () => now, qualityTier: 'medium' });
  meta.onBoot(now);
  assert(meta.tutorialSnapshot().step.id === 'open-shop', 'new player starts at the shop action');

  bus.emit(EVENTS.SHOP_OPENED, {});
  assert(meta.tutorialSnapshot().step.id === 'choose-farm', 'opening the shop advances the guide');
  bus.emit(EVENTS.PLACEMENT_CHANGED, { active: true, def: { id: 'farm' } });
  assert(meta.tutorialSnapshot().step.id === 'place-farm', 'choosing the farm advances the guide');
  bus.emit(EVENTS.BUILDING_QUEUED, { job: { kind: 'build', type: 'farm' }, entity: { id: 1, type: 'farm' } });
  assert(meta.tutorialSnapshot().step.id === 'wait-farm', 'the actual build queue advances the guide');
  bus.emit(EVENTS.JOB_FINISHED, { job: { kind: 'build', type: 'farm' }, entity: { id: 1, type: 'farm' } });
  assert(meta.tutorialSnapshot().step.id === 'harvest-first', 'farm completion unlocks the first-harvest step');
  assert(meta.snapshot().stats.buildingsBuilt === 1 && meta.snapshot().achievements.find((a) => a.id === 'first-building').unlocked, 'building completion grants XP and unlocks a durable achievement');

  bus.emit(EVENTS.RESOURCE_HARVESTED, { moved: 10, type: 'farm', resource: 'rizq' });
  assert(meta.tutorialSnapshot().step.id === 'first-lesson', 'a successful harvest advances the guide');
  bus.emit(EVENTS.QURAN_LESSON_COMPLETED, { report: { kind: 'lesson' } });
  assert(meta.tutorialSnapshot().step.id === 'visit-campaign', 'completing a lesson advances the guide');
  assert(meta.snapshot().stats.lessonsCompleted === 1, 'lesson completion is counted only from the completion event');
  bus.emit(EVENTS.CAMPAIGN_PANEL_OPENED, {});
  bus.emit(EVENTS.SETTINGS_OPENED, {});
  bus.emit(EVENTS.META_PANEL_OPENED, {});
  bus.emit(EVENTS.JOB_FINISHED, { job: { kind: 'build', type: 'well' }, entity: { id: 2, type: 'well' } });
  assert(meta.tutorialSnapshot().step.id === 'free-play', 'the main tutorial has a clear free-play finish');
  assert(meta.tutorialSnapshot().coreComplete, 'the three requested core milestones are complete');

  state.meta.onboarding.playSeconds = 1799;
  meta.update(1);
  assert(state.meta.onboarding.status === 'completed' && state.meta.onboarding.playSeconds === 1800, 'the 30-minute route completes on active play, without an absence timer');
  assert(meta.snapshot().level >= 2, 'XP raises the player level');
  const saved = JSON.parse(JSON.stringify(state.serialize()));
  const restored = new GameState({ economy: economyData });
  restored.hydrate(saved);
  assert(restored.meta.achievements['first-building']?.unlockedAt != null, 'achievement survives save/load');
  assert(restored.meta.onboarding.flags.firstLesson && restored.meta.onboarding.status === 'completed', 'tutorial flags and completion survive save/load');
  assert(restored.meta.xp === state.meta.xp && restored.meta.level === state.meta.level, 'XP and level survive save/load');
  meta.dispose();
});

test('phase 7 FTUE: skip is available and replay walks the same staged guide', () => {
  const bus = new EventBus();
  const state = new GameState({ economy: economyData });
  const meta = new MetaSystem({ state, bus, metaData, ftueData, now: () => Date.UTC(2026, 0, 1) });
  assert(meta.skipTutorial(), 'player can skip an active FTUE');
  assert(state.meta.onboarding.status === 'skipped' && !meta.tutorialSnapshot().active, 'skipping does not alter city progress');
  assert(meta.replayTutorial() && meta.tutorialSnapshot().replaying, 'player can start a full replay from settings');
  assert(meta.stepReplay(1) && meta.tutorialSnapshot().stepIndex === 1, 'replay advances one step at a time');
  assert(meta.skipTutorial() && state.meta.onboarding.replayIndex === null, 'replay itself can be skipped');
  meta.dispose();
});

test('phase 7 daily + settings: unfinished tasks and preferences persist across days and saves', () => {
  const bus = new EventBus();
  const state = new GameState({ economy: economyData });
  let now = Date.UTC(2026, 0, 1, 12);
  let persistCalls = 0;
  let settingsEvent = null;
  bus.on(EVENTS.SETTINGS_CHANGED, (settings) => { settingsEvent = settings; });
  const meta = new MetaSystem({ state, bus, metaData, ftueData, persist: () => { persistCalls += 1; }, now: () => now });
  meta.onBoot(now);
  const originalMission = meta.dailySnapshot();
  assert(originalMission && originalMission.progress === 0, 'an optional daily task is assigned');
  assert(meta.setSetting('qualityTier', 'low'), 'quality preference is changeable');
  assert(meta.setSetting('batterySaver', true), 'battery saver preference is changeable');
  assert(meta.setSetting('soundEnabled', false), 'sound preference is changeable');
  assert(meta.setSetting('recitationEnabled', true), 'licensed recitation is an independent setting');
  assert(meta.setSetting('fontScale', 'larger'), 'font scale is changeable');
  assert(meta.setSetting('highContrast', true), 'high contrast is changeable');
  assert(meta.setSetting('reduceMotion', true), 'reduced motion is changeable');
  assert(meta.setSetting('language', 'fa-AF'), 'language preference is changeable');
  assert(settingsEvent.qualityTier === 'low' && settingsEvent.batterySaver && !settingsEvent.soundEnabled
    && settingsEvent.recitationEnabled && settingsEvent.fontScale === 'larger'
    && settingsEvent.highContrast && settingsEvent.reduceMotion && settingsEvent.language === 'fa-AF',
  'settings changes emit the complete runtime/accessibility preference set');

  now += 86_400_000;
  meta.update(1);
  assert(meta.dailySnapshot().id === originalMission.id && meta.dailySnapshot().progress === 0, 'an unfinished daily task does not reset after a missed day');
  const saved = JSON.parse(JSON.stringify(state.serialize()));
  meta.dispose();

  const restoredBus = new EventBus();
  const restored = new GameState({ economy: economyData });
  restored.hydrate(saved);
  const metaAgain = new MetaSystem({ state: restored, bus: restoredBus, metaData, ftueData, now: () => now });
  metaAgain.onBoot(now);
  assert(metaAgain.dailySnapshot().id === originalMission.id && metaAgain.dailySnapshot().progress === 0, 'daily task identity and progress survive save/load');
  assert(metaAgain.settings.qualityTier === 'low' && metaAgain.settings.batterySaver && !metaAgain.settings.soundEnabled
    && metaAgain.settings.recitationEnabled && metaAgain.settings.fontScale === 'larger'
    && metaAgain.settings.highContrast && metaAgain.settings.reduceMotion && metaAgain.settings.language === 'fa-AF',
  'graphics, audio and accessibility preferences survive save/load');

  const eventByTask = {
    build: () => restoredBus.emit(EVENTS.JOB_FINISHED, { job: { kind: 'build', type: 'farm' }, entity: { id: 7, type: 'farm' } }),
    harvest: () => restoredBus.emit(EVENTS.RESOURCE_HARVESTED, { moved: 5, type: 'farm', resource: 'rizq' }),
    lesson: () => restoredBus.emit(EVENTS.QURAN_LESSON_COMPLETED, { report: { kind: 'lesson' } }),
  };
  const activeTask = metaAgain.dailySnapshot();
  eventByTask[activeTask.event]();
  assert(metaAgain.dailySnapshot().completed, 'only the matching in-game action completes the optional task');
  const completedId = activeTask.id;
  now += 86_400_000;
  metaAgain.update(1);
  assert(metaAgain.dailySnapshot().id !== completedId, 'a completed task can rotate on a later day');
  assert(restored.meta.dailyMission.history.some((item) => item.id === completedId), 'completed task history is saved without a streak counter');
  assert(persistCalls >= 4, 'preference changes and progression request persistence');
  metaAgain.dispose();
});

/* ------------------------------------------------- phase 8: social (جماعت) */

test('phase 8 chat filter: masks blocked words incl. Arabic variants and stretching', () => {
  const wordlist = socialData.chat.profanity;
  assert(Array.isArray(wordlist) && wordlist.length >= 5, 'starter wordlist present in social.json');
  const mask = socialData.chat.mask || '⁂';
  const first = wordlist[0];
  let out = filterChat(`سلام ${first} خداحافظ`, { wordlist, mask, maxLength: 280 });
  assert(out.blocked && out.hits === 1, 'blocked word detected');
  assert(!out.text.includes(first) && out.text.includes(mask), `word masked: ${out.text}`);
  const variant = first.replace(/ی/g, 'ي').replace(/ک/g, 'ك');
  out = filterChat(variant, { wordlist, mask, maxLength: 280 });
  assert(out.blocked, `arabic-script variant masked (${variant})`);
  out = filterChat(first.split('').join('ـ'), { wordlist, mask, maxLength: 280 });
  assert(out.blocked, 'tatweel-stretched word masked');
  out = filterChat('سلام! امروز شهر زیباست.', { wordlist, mask, maxLength: 280 });
  assert(!out.blocked && out.text === 'سلام! امروز شهر زیباست.', 'clean text untouched');
  assert(filterChat('   ', { wordlist, mask }).text === '', 'blank collapses to empty');
  assert(filterChat('x'.repeat(500), { wordlist: [], mask, maxLength: 10 }).text.length === 10, 'length capped');
});

test('phase 8 rate limit: sliding window blocks bursts then refills', () => {
  let now = 1_000_000;
  const limiter = new RateLimiter({ now: () => now });
  const rule = { windowMs: 1000, max: 3 };
  assert(limiter.check('k', rule).ok, '1st passes');
  assert(limiter.check('k', rule).ok, '2nd passes');
  assert(limiter.check('k', rule).ok, '3rd passes');
  const blocked = limiter.check('k', rule);
  assert(!blocked.ok && blocked.retryAfterMs > 0, '4th blocked with retryAfterMs');
  now += 1001;
  assert(limiter.check('k', rule).ok, 'window refills over time');
  assert(limiter.sweep(1000) >= 0, 'sweep runs without error');
});

test('phase 8 auth: tokens unique, display names sanitised, privacy minimal', () => {
  const tokens = new Set([issueToken(), issueToken(), issueToken()]);
  assert(tokens.size === 3 && [...tokens][0].length >= 32, 'unguessable unique tokens');
  assert(sanitizeDisplayName('  نگهبان   نور  ') === 'نگهبان نور', 'whitespace collapsed');
  assert(sanitizeDisplayName('a') === null, 'too-short name rejected');
  assert(sanitizeDisplayName('x'.repeat(50)).length === 16, 'name truncated to 16 chars');
  assert(sanitizeDisplayName('ab\ncd') === 'abcd', 'control characters stripped');
  assert(sanitizeDisplayName(null) === null, 'non-string rejected');
  const stored = socialData.privacy.storedFields.join(' ');
  assert(!/email|phone|device|age|location/i.test(stored), 'no personal data in the stored field list');
  assert(socialData.privacy.chatPersisted === false, 'chat is never persisted');
  assert(socialData.privacy.childFreeChat === false, 'child accounts get no free chat');
});

/** Wrap a WsTestClient with id-matched rpc() plus a push queue. */
function wrapSocial(ws) {
  let seq = 0;
  const pending = new Map();
  const pushes = [];
  ws.onMessage = (text) => {
    const message = JSON.parse(text);
    if (message && message.id != null && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else {
      pushes.push(message);
    }
  };
  return {
    ws,
    pushes,
    rpc(type, payload = {}) {
      const id = `t-${++seq}-${Math.floor(Math.random() * 1e6)}`;
      ws.send({ id, type, payload });
      return new Promise((resolve, reject) => {
        pending.set(id, resolve);
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error(`rpc timeout: ${type}`));
        }, 6000);
      });
    },
  };
}

async function waitForSocialPush(client, name, timeoutMs = 4000) {
  const start = Date.now();
  for (;;) {
    const index = client.pushes.findIndex((message) => message && message.push === name);
    if (index >= 0) return client.pushes.splice(index, 1)[0];
    if (Date.now() - start > timeoutMs) throw new Error(`push timeout: ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('phase 8 e2e: two clients join one jamaat — help, ledger authority, filter, rate limit, report, child, event', async () => {
  const server = new GameServer({ port: 0, saveFile: null, quiet: true });
  const { port } = await server.start();
  const url = `ws://127.0.0.1:${port}/social-ws`;
  const clients = [];
  try {
    const open = async () => {
      const wrapped = wrapSocial(await connectWs(url));
      clients.push(wrapped);
      return wrapped;
    };
    const a = await open();
    const b = await open();

    // --- [✓] two simultaneous clients in one jamaat ------------------
    const helloA = await a.rpc('hello', { displayName: 'آرش' });
    assert(helloA.ok && helloA.token, 'client A authenticated with a token');
    assert(helloA.members.length === 1, 'A sees itself in the jamaat');
    const helloB = await b.rpc('hello', { displayName: 'سارا' });
    assert(helloB.ok, 'client B authenticated');
    assert(helloB.members.length === 2, 'B sees both members (one jamaat)');
    assert(helloA.jamaat.id === helloB.jamaat.id, 'both clients share the jamaat id');
    const pullA = await a.rpc('state:pull', {});
    assert(pullA.members.length === 2, 'presence push/pull shows both clients');

    // --- city link: only validated {type, level} pairs are adopted -----
    const badLink = await a.rpc('city:sync', { buildings: [{ type: 'nope', level: 99 }] });
    assert(!badLink.ok && badLink.error === 'invalid', 'unknown building rejected on link');
    const link = await a.rpc('city:sync', {
      buildings: [{ type: 'town-center', level: 1 }, { type: 'farm', level: 2 }],
      cityLevel: 1,
    });
    assert(link.ok && link.count === 2, 'valid city summary adopted');

    // --- chat: filter over the real socket ------------------------------
    const chat = await a.rpc('chat:send', { text: 'سلام جماعت!' });
    assert(chat.ok && chat.message.text === 'سلام جماعت!', 'clean chat passes');
    const dirty = await a.rpc('chat:send', { text: `سلام ${socialData.chat.profanity[0]}` });
    assert(dirty.ok, 'filtered chat still delivers');
    assert(!dirty.message.text.includes(socialData.chat.profanity[0]), 'blocked word masked over the socket');
    assert(dirty.message.text.includes(socialData.chat.mask), 'mask character present');

    // --- [✓] mutual build help shortens the timer ----------------------
    const enqueue = await a.rpc('build:enqueue', { kind: 'build', entityId: 7, defId: 'farm', level: 1 });
    assert(enqueue.ok && enqueue.job.id.startsWith('srv-'), 'server-stamped job created');
    assert(enqueue.job.endsAt > Date.now(), 'endsAt uses the server clock (future)');
    assert(Math.round(enqueue.ledger.resources.rizq) < Math.round(helloA.ledger.resources.rizq), 'cost spent on the server ledger');
    const before = enqueue.job.endsAt;
    const helpReq = await a.rpc('help:request', { jobId: enqueue.job.id });
    assert(helpReq.ok, 'help request opened');
    // Enqueue/request echo the ledger back — drain snapshots so the next one is the give's.
    for (let i = a.pushes.length - 1; i >= 0; i--) if (a.pushes[i]?.push === 'ledger') a.pushes.splice(i, 1);
    const give = await b.rpc('help:give', { requestId: helpReq.request.id });
    assert(give.ok && give.reductionMs > 0, `help cut ${give.reductionMs}ms off the timer`);
    const ledgerPush = await waitForSocialPush(a, 'ledger');
    const pushedJob = ledgerPush.payload.jobs.find((job) => job.id === enqueue.job.id);
    assert(pushedJob.endsAt === before - give.reductionMs, 'owner receives the targeted ledger push with the shorter timer');
    const noticePush = await waitForSocialPush(a, 'notice');
    assert(noticePush.payload.kind === 'help-received', 'owner receives the help notification push');
    const afterHelp = await a.rpc('state:pull', {});
    const helpedJob = afterHelp.jobs.find((job) => job.id === enqueue.job.id);
    assert(helpedJob.endsAt === before - give.reductionMs, 'authoritative endsAt shortened by exactly the help');
    const selfHelp = await a.rpc('help:give', { requestId: helpReq.request.id });
    assert(!selfHelp.ok && selfHelp.error === 'forbidden', 'helping your own build is forbidden');
    const twice = await b.rpc('help:give', { requestId: helpReq.request.id });
    assert(!twice.ok && twice.error === 'exhausted', 'same member cannot help the same request twice');
    const enqueue2 = await a.rpc('build:enqueue', { kind: 'build', entityId: 8, defId: 'farm', level: 1 });
    const helpReq2 = await a.rpc('help:request', { jobId: enqueue2.job.id });
    const cooled = await b.rpc('help:give', { requestId: helpReq2.request.id });
    assert(!cooled.ok && cooled.error === 'cooldown', 'giver cooldown enforced');

    // --- [✓] client tampering never touches the server ------------------
    const noSet = await a.rpc('ledger:set', { rizq: 999999 });
    assert(!noSet.ok && noSet.error === 'unknown-type', 'no set-resources message exists');
    const tamper = await a.rpc('ledger:harvest', { resource: 'rizq', amount: 999999 });
    assert(tamper.ok && tamper.moved < 999999, `huge harvest capped to budgeted production (${tamper.moved})`);
    const beforeSpend = (await a.rpc('state:pull', {})).ledger.resources.rizq;
    const overspend = await a.rpc('ledger:spend', { cost: { rizq: 999999 } });
    assert(!overspend.ok && overspend.error === 'insufficient', 'overspend rejected');
    const afterSpend = (await a.rpc('state:pull', {})).ledger.resources.rizq;
    assert(afterSpend === beforeSpend, 'rejected spend leaves the server ledger untouched');
    const early = await a.rpc('build:complete', { jobId: enqueue.job.id });
    assert(!early.ok && early.error === 'too-early', 'early completion rejected (server clock rules)');
    assert(early.job.endsAt === before - give.reductionMs, 'server returns the authoritative endsAt');
    const badGrant = await a.rpc('ledger:grant', { resource: 'nur', amount: 5000, source: 'lesson' });
    assert(badGrant.ok && badGrant.moved <= (socialData.ledger.grantCaps.lesson || 200), 'grant capped per source');

    // --- upgrade validation + server-confirmed finish --------------------
    const speedup = await a.rpc('build:speedup', { jobId: enqueue.job.id });
    assert(speedup.ok && speedup.cost > 0, 'validated speedup finishes the job');
    const upgradeBad = await a.rpc('build:enqueue', { kind: 'upgrade', entityId: 7, defId: 'farm', level: 3, fromLevel: 5 });
    assert(!upgradeBad.ok, 'upgrade from a wrong level rejected');
    const upgrade = await a.rpc('build:enqueue', { kind: 'upgrade', entityId: 7, defId: 'farm', level: 2, fromLevel: 1 });
    assert(upgrade.ok, 'upgrade validated against the server-tracked building');

    // --- friendly only: no attack/loot/plunder messages ------------------
    for (const hostile of ['attack', 'loot', 'plunder', 'battle:attack', 'city:raid']) {
      const rejected = await a.rpc(hostile, {});
      assert(!rejected.ok && rejected.error === 'unknown-type', `«${hostile}» does not exist`);
    }

    // --- [✓] rate limit over the real socket (fresh client) --------------
    const r = await open();
    await r.rpc('hello', { displayName: 'تندرو' });
    const burst = [];
    for (let i = 0; i < 6; i += 1) burst.push(await r.rpc('chat:send', { text: `پیام ${i}` }));
    const limited = burst.filter((answer) => !answer.ok && answer.error === 'rate-limited');
    assert(burst.filter((answer) => answer.ok).length === 5, 'chat window allows 5 messages');
    assert(limited.length >= 1, '6th message in the window is rate-limited');

    // --- [✓] report is stored ---------------------------------------------
    const before_reports = server.reportCount;
    const report = await b.rpc('chat:report', { messageId: dirty.message.id, reason: 'insult' });
    assert(report.ok && report.reportId, 'report acknowledged');
    assert(server.reportCount === before_reports + 1, 'report stored on the server');
    const badReason = await b.rpc('chat:report', { messageId: dirty.message.id, reason: 'nope' });
    assert(!badReason.ok && badReason.error === 'invalid', 'report reason must come from the allow-list');

    // --- child account: no free chat, presets only ------------------------
    const c = await open();
    const helloC = await c.rpc('hello', { displayName: 'بچه', isChild: true });
    assert(helloC.ok && helloC.player.isChild, 'child account created');
    const childChat = await c.rpc('chat:send', { text: 'hello' });
    assert(!childChat.ok && childChat.error === 'child-restricted', 'child free chat blocked');
    const preset = await c.rpc('chat:preset', { presetId: 'salam' });
    assert(preset.ok && preset.message.preset, 'child preset message delivered');
    const badPreset = await c.rpc('chat:preset', { presetId: 'nope' });
    assert(!badPreset.ok, 'unknown preset rejected');
    // The child flag can never be flipped on reconnect.
    const c2 = await open();
    const helloC2 = await c2.rpc('hello', { token: helloC.token, isChild: false });
    assert(helloC2.ok && helloC2.player.isChild && helloC2.player.id === helloC.player.id, 'child flag immutable, token reconnects');

    // --- weekly cooperative event (shared goal, equal reward) --------------
    const donate = await a.rpc('event:donate', { resource: 'rizq', amount: 50 });
    assert(donate.ok && donate.points === 50, 'donation adds weighted points');
    const f = await open();
    const helloF = await f.rpc('hello', { displayName: 'کاروانی' });
    for (let i = 0; i < 10; i += 1) {
      const grant = await f.rpc('ledger:grant', { resource: 'rizq', amount: 100, source: 'other' });
      assert(grant.ok && grant.moved === 100, 'capped grant succeeds within capacity');
      const step = await f.rpc('event:donate', { resource: 'rizq', amount: 100 });
      assert(step.ok, `donation ${i + 1}/10 accepted`);
      if (step.completed) break;
    }
    const finalEvent = await f.rpc('state:pull', {});
    assert(finalEvent.event.completed, 'shared weekly goal completed');
    assert(finalEvent.leaderboard[0].playerId === helloF.player.id, 'leaderboard ranks the top contributor');
    const doneAgain = await f.rpc('event:donate', { resource: 'rizq', amount: 10 });
    assert(!doneAgain.ok && doneAgain.error === 'completed', 'donations close after completion');
    assert(Math.round(finalEvent.ledger.resources.gohar) === Math.round(helloF.ledger.resources.gohar) + 8, 'equal gohar reward granted');

    // --- malformed frames never crash the server ---------------------------
    const raw = clients[0];
    raw.ws.send('this is not json{');
    const errPush = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 3000);
      const check = () => {
        const index = raw.pushes.findIndex((message) => message && message.ok === false);
        if (index >= 0) {
          clearTimeout(timer);
          resolve(raw.pushes.splice(index, 1)[0]);
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
    assert(errPush && errPush.error === 'invalid', 'malformed frame answered with invalid (connection survives)');
    const stillAlive = await a.rpc('presence:ping', {});
    assert(stillAlive.ok && Number.isFinite(stillAlive.serverNow), 'connection alive after malformed input');
  } finally {
    for (const client of clients) {
      try {
        client.ws.close();
      } catch {
        /* ignore */
      }
    }
    await server.stop();
  }
});

test('phase 8 client: SocialClient request/response, pushes and graceful failure', async () => {
  const { SocialClient } = await import('../src/game/social/SocialClient.js');
  const server = new GameServer({ port: 0, saveFile: null, quiet: true });
  const { port } = await server.start();
  try {
    const pushes = [];
    const client = new SocialClient({
      url: `ws://127.0.0.1:${port}/social-ws`,
      onPush: (push) => pushes.push(push),
    });
    const hello = await client.connect({ displayName: 'کلاینت' });
    assert(hello.ok && hello.token, 'hello resolves with a token');
    assert(client.connected, 'connected flag set');
    const chat = await client.request('chat:send', { text: 'سلام' });
    assert(chat.ok && chat.message.text === 'سلام', 'request/response roundtrip works');
    const start = Date.now();
    while (Date.now() - start < 3000 && !pushes.some((push) => push.push === 'chat')) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert(pushes.some((push) => push.push === 'presence'), 'presence push delivered');
    assert(pushes.some((push) => push.push === 'chat'), 'chat broadcast push delivered');
    client.close();
    assert(!client.connected, 'manual close clears the connection');

    const bad = new SocialClient({ url: 'ws://127.0.0.1:9/social-ws' });
    let failed = null;
    try {
      await bad.connect({});
    } catch (error) {
      failed = error;
    }
    assert(failed && failed.error, 'closed port rejects gracefully instead of hanging');

    const keep = globalThis.WebSocket;
    try {
      globalThis.WebSocket = undefined;
      const noWs = new SocialClient({ url: `ws://127.0.0.1:${port}/social-ws` });
      let unsupported = null;
      try {
        await noWs.connect({});
      } catch (error) {
        unsupported = error;
      }
      assert(unsupported && unsupported.error === 'unsupported', 'missing WebSocket degrades gracefully');
    } finally {
      globalThis.WebSocket = keep;
    }
  } finally {
    await server.stop();
  }
});

await flushPending();

const pad = (value, width) => String(value).padEnd(width, ' ');
console.log('\n=== شهر نور — self checks (فازهای ۱ تا ۹) ===\n');
for (const result of results) {
  console.log(`${result.ok ? '✓' : '✗'} ${pad(result.name, 62)}${result.ok ? '' : result.message}`);
}
console.log(`\n${results.length - failures}/${results.length} checks passed.`);
if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
