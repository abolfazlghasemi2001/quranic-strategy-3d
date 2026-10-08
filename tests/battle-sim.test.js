/**
 * Phase 9 — Vitest: شبیه‌ساز نبرد (BattleSim) + گرید/Pathfinding + ضبط/بازپخش.
 *
 * پوشش:
 *   - قرارداد دادهٔ نبرد (۴ گونه واحد، بدون متن قرآنی/اعراب، بدون خون)
 *   - ساخت سناریو از شهر واقعی (buildScenario) و اشتقاق بذر
 *   - قوانین استقرار (deploy): خانهٔ آزاد، حریم امن، cooldown، سقف deploy
 *   - determinism: بذر/دستور identical ⇒ نبرد bit-identical (hash، گزارش، چک‌پوینت)
 *   - گام ثابت: اجرای پاره‌پاره با runTicks == اجرای یک̇جا تا همان tick
 *   - بازپخش: createRecord/replayRecord/verifySubmission + ردّ حیله (tamper)
 *   - نتیجه: outcome معتبر، TIMEOUT با سقف گام، دیوارِ بسته شکسته می‌شود
 *   - A*: مسیر از دروازهٔ دیوار می‌گذرد و دترمینیستیک است
 *
 * همهٔ نبردها با بذر ثابت و گام ثابت اجرا می‌شوند؛ هیچ تستی به ساعت سیستم
 * یا Math.random وابسته نیست.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GameState } from '../src/game/GameState.js';
import { BattleSim, BATTLE_RESULT, normalizeUnitDefs } from '../src/game/battle/BattleSim.js';
import { FACTION } from '../src/game/battle/Unit.js';
import { BattleGrid } from '../src/game/battle/BattleGrid.js';
import { findPath, pathWorldLength } from '../src/game/battle/AStar.js';
import { createStructureStats } from '../src/game/battle/StructureStats.js';
import {
  buildScenario,
  defenseDefsFrom,
  deriveBattleSeed,
  structureModifiersFrom,
} from '../src/game/battle/BattleScenario.js';
import {
  createRecord,
  replayRecord,
  verifySubmission,
} from '../src/game/battle/BattleRecorder.js';

import economyData from '../src/data/economy.json';
import terrainData from '../src/data/terrain.json';
import worldData from '../src/data/world.json';
import unitsData from '../src/data/units.json';
import defensesData from '../src/data/defenses.json';
import battleData from '../src/data/battle.json';

const root = dirname(fileURLToPath(import.meta.url));

const battleCfg = {
  cols: terrainData.grid.cols,
  rows: terrainData.grid.rows,
  tileSize: terrainData.tileSize,
  seed: worldData.seed >>> 0,
};
const structureStats = createStructureStats({ defenses: defensesData, config: battleCfg });
const battleDeps = {
  rules: battleData,
  units: unitsData,
  defenseDefs: defenseDefsFrom(defensesData),
  structureModifiers: structureModifiersFrom(defensesData),
};

/**
 * نشانه‌های خاص Qur'anic (اعراب عثمانی): U+0651–U+0653، U+0655،
 * U+0670 و U+06D6–U+06ED. Ezfe/kasraی فارسی (U+0650، U+0654 «هٔ») و
 * «ی» فارسی (U+06CC) در این بازه نیستند؛ پس تطابق یعنی متن قرآنی/اعراب‌دار.
 */
const VOCALISED_ARABIC = /[\u0651-\u0653\u0655\u0670\u06D6-\u06ED]/;

/** Rules copy with the opening auto-deploy disabled (for deploy-rule unit tests). */
const noAutoRules = {
  ...battleData,
  defender: {
    ...(battleData.defender || {}),
    autoDeploy: { ...(battleData.defender?.autoDeploy || {}), enabled: false },
  },
};
const noAutoDeps = { ...battleDeps, rules: noAutoRules };
const makeSimNoAuto = (scenario) => new BattleSim({ scenario, ...noAutoDeps });

/** شهر آزمایشی: مرکز شهر + دیوار اختیاری + سازه‌های دفاعی + سپاه. */
function makeCity({ walls = false, gate = true, defenses = [], army = {}, townLevel = 2 } = {}) {
  const state = new GameState({ economy: economyData });
  state.resources = { rizq: 100000, nur: 100000, hekmat: 100000, gohar: 200 };
  const c = Math.floor(terrainData.grid.cols / 2);
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
    const maxHp = raw.maxHp ?? structureStats.maxHpFor({
      type: raw.type, level: raw.level ?? 1, size: [raw.w ?? 1, raw.h ?? 1],
    });
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
    cols: terrainData.grid.cols,
    rows: terrainData.grid.rows,
    tileSize: terrainData.tileSize,
    structures: built,
    garrison,
    spawns,
    commands: [],
  };
  scenario.scenarioHash = 1;
  return scenario;
}

const makeSim = (scenario) => new BattleSim({ scenario, ...battleDeps });
const at = (col, row) => ({ x: (col + 0.5) * terrainData.tileSize, z: (row + 0.5) * terrainData.tileSize });

describe('battle: data contract', () => {
  it('has exactly four unit types covering melee/ranged/support/siege', () => {
    const defs = [...normalizeUnitDefs(unitsData).values()]; // returns a Map
    expect(defs.length).toBe(4);
    const roles = new Set(defs.map((d) => d.role));
    for (const role of ['melee', 'ranged', 'support', 'siege']) expect(roles.has(role)).toBe(true);
    const healer = defs.find((d) => d.role === 'support');
    expect(healer.healPerSecond).toBeGreaterThan(0);
    expect(healer.damage).toBe(0); // healer never deals damage
    const breaker = defs.find((d) => d.role === 'siege');
    expect(breaker.structureDamageMultiplier).toBeGreaterThan(breaker.unitDamageMultiplier);
  });

  it('carries no vocalised Arabic (Quranic text) in battle data', () => {
    for (const data of [unitsData, defensesData, battleData]) {
      expect(VOCALISED_ARABIC.test(JSON.stringify(data))).toBe(false);
    }
  });

  it('declares the content red lines: no blood/gore and no Quran text in the battle scene', () => {
    expect(battleData.content.blood).toBe(false);
    expect(battleData.content.gore).toBe(false);
    expect(battleData.content.quranTextInScene).toBe(false);
  });

  it('the simulator never calls Math.random (seeded Rng only)', () => {
    const source = readFileSync(resolve(root, '../src/game/battle/BattleSim.js'), 'utf8');
    // the header comment mentions Math.random; what matters is an actual call
    expect(source).not.toMatch(/Math\.random\s*\(/);
  });
});

describe('battle: scenario building', () => {
  it('deriveBattleSeed is deterministic and changes with the battle index', () => {
    const a = deriveBattleSeed({ worldSeed: 42, seedOffset: 7, battleSeq: 0 });
    expect(a).toBe(deriveBattleSeed({ worldSeed: 42, seedOffset: 7, battleSeq: 0 }));
    expect(a).not.toBe(deriveBattleSeed({ worldSeed: 42, seedOffset: 7, battleSeq: 1 }));
    expect(a).not.toBe(deriveBattleSeed({ worldSeed: 43, seedOffset: 7, battleSeq: 0 }));
  });

  it('buildScenario mirrors the city: structures, garrison and spawn waves', () => {
    const state = makeCity({
      walls: true,
      defenses: [{ id: 'watchtower', col: 17, row: 17, level: 2 }],
      army: { guard: 3, archer: 2 },
    });
    const scenario = buildScenario({
      config: battleCfg,
      state,
      defensesData,
      battleData,
      structureStats,
      encounterId: 'raid-column',
      seed: 1234567,
    });
    // plain JSON — must survive a serialize/deserialize round trip
    const revived = JSON.parse(JSON.stringify(scenario));
    expect(revived.structures.length).toBeGreaterThan(0);
    for (const structure of revived.structures) {
      expect(structure.hp).toBeGreaterThan(0);
      expect(structure.maxHp).toBeGreaterThanOrEqual(structure.hp);
    }
    expect(revived.garrison.guard).toBe(3);
    expect(revived.spawns.length).toBeGreaterThan(0);
    for (const spawn of revived.spawns) {
      expect(spawn.tick).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(spawn.x)).toBe(true);
      expect(Number.isFinite(spawn.z)).toBe(true);
    }
    expect(revived.seed).toBe(1234567 >>> 0);
  });
});

describe('battle: deploy rules', () => {
  it('accepts a deploy on a free tile and records the command with its tick', () => {
    const scenario = makeScenario({
      structures: [{ type: 'town-center', col: 18, row: 18, w: 3, h: 3 }],
      garrison: { guard: 2 },
      spawns: [],
    });
    const sim = makeSimNoAuto(scenario); // no opening auto-deploy: garrison stays put
    const point = sim.autoDeployPoint('guard', 0);
    const result = sim.deploy('guard', point.x, point.z);
    expect(result.ok).toBe(true);
    expect(result.command.type).toBe('deploy');
    expect(result.command.tick).toBe(sim.tickIndex + 1);
    sim.tick();
    expect(sim.appliedCommands.length).toBe(1);
    expect(sim.countAlive(FACTION.DEFENDER)).toBe(1);
  });

  it('rejects unknown units, empty garrison, outside tiles and cooldown spam', () => {
    const scenario = makeScenario({
      structures: [{ type: 'town-center', col: 18, row: 18, w: 3, h: 3 }],
      garrison: { guard: 1 },
      spawns: [],
    });
    const sim = makeSimNoAuto(scenario);
    const point = sim.autoDeployPoint('guard', 0);

    expect(sim.deploy('dragon', point.x, point.z).reason).toBe('unknown-unit');
    expect(sim.deploy('archer', point.x, point.z).reason).toBe('no-troops');
    expect(sim.deploy('guard', -50, -50).reason).toBe('outside');
    expect(sim.deploy('guard', NaN, point.z).reason).toBe('invalid');

    // the first deploy reserves the cooldown window
    expect(sim.deploy('guard', point.x, point.z).ok).toBe(true);
    const elsewhere = sim.autoDeployPoint('guard', 1);
    expect(sim.deploy('guard', elsewhere.x, elsewhere.z).reason).toBe('cooldown');
  });
});

describe('battle: determinism (core acceptance)', () => {
  const runBattle = () => {
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

  it('identical seed + identical commands ⇒ bit-identical battle', () => {
    const a = runBattle();
    const b = runBattle();
    expect(a.result).toBe(b.result);
    expect(a.finishTick).toBe(b.finishTick);
    expect(a.hashState()).toBe(b.hashState());
    expect(a.eventHash >>> 0).toBe(b.eventHash >>> 0);
    expect(JSON.stringify(a.report())).toBe(JSON.stringify(b.report()));
    expect(a.appliedCommands.length).toBe(b.appliedCommands.length);
    const cp = (sim) => sim.checkpoints.map((c) => `${c.tick}:${c.hash}`).join('|');
    expect(cp(a)).toBe(cp(b));
  });

  it('a different seed diverges, and each seed is stable on its own', () => {
    const run = (seed) => {
      const state = makeCity({ defenses: [{ id: 'watchtower', col: 17, row: 17 }] });
      const sim = battleFromCity(state, 'raid-scouts', seed);
      sim.runToEnd(1200);
      return `${sim.result}:${sim.finishTick}:${sim.hashState()}`;
    };
    expect(run(1)).not.toBe(run(2));
    expect(run(1)).toBe(run(1));
  });

  it('fixed timestep: chunked runTicks reaches the identical state as one long run', () => {
    const build = () => {
      const state = makeCity({
        walls: true,
        defenses: [{ id: 'watchtower', col: 17, row: 17, level: 2 }],
        army: { guard: 4, archer: 2 },
      });
      return battleFromCity(state, 'raid-column', 555);
    };
    const chunked = build();
    for (let i = 0; i < 40 && !chunked.done; i += 1) chunked.runTicks(7);
    const whole = build();
    whole.runTicks(280); // 40 × 7 ticks in one call
    expect(chunked.tickIndex).toBe(whole.tickIndex);
    expect(chunked.hashState()).toBe(whole.hashState());
    // live unit records hold circular refs (targetRef) — compare a plain projection
    const project = (sim) => sim.liveUnits().map((u) => [u.id, u.type, u.faction, u.state,
      Math.round(u.x * 1000), Math.round(u.z * 1000), Math.round(u.hp * 10), u.removed ? 1 : 0]);
    expect(project(chunked)).toEqual(project(whole));
  });
});

describe('battle: outcomes and report consistency', () => {
  it('a defended city battle ends with a valid result and a consistent report', () => {
    const state = makeCity({
      walls: true,
      gate: true,
      defenses: [{ id: 'watchtower', col: 17, row: 17, level: 2 }, { id: 'sentry-post', col: 22, row: 22 }],
      army: { guard: 4, archer: 2, healer: 1 },
    });
    const sim = battleFromCity(state, 'raid-scouts', 5150);
    sim.runToEnd();
    const report = sim.report();
    expect([BATTLE_RESULT.VICTORY, BATTLE_RESULT.DEFEAT, BATTLE_RESULT.TIMEOUT]).toContain(report.result);
    expect(report.ticks).toBeGreaterThan(0);
    expect(report.seconds).toBeGreaterThan(0);
    expect(report.raidersSpawned).toBeGreaterThan(0);
    expect(Number.isInteger(report.stateHash)).toBe(true);
    expect(Number.isInteger(report.eventHash >>> 0)).toBe(true);
    // accounting: every spawned raider is either still alive or was lost
    const raidersLost = Object.keys(report.lost)
      .filter((k) => k.startsWith('raider:'))
      .reduce((sum, k) => sum + report.lost[k], 0);
    expect(report.raidersSpawned).toBe(report.raidersLeft + raidersLost);
    const defendersLost = Object.keys(report.lost)
      .filter((k) => k.startsWith('defender:'))
      .reduce((sum, k) => sum + report.lost[k], 0);
    expect(report.defendersDeployed).toBe(report.defendersLeft + defendersLost);
    // no blood/gore event types may exist in the event log
    for (const event of sim.events) {
      expect(String(event.type)).not.toMatch(/blood|gore|death/);
    }
  });

  it('runToEnd respects the tick ceiling and reports TIMEOUT', () => {
    const scenario = makeScenario({
      structures: [{ type: 'town-center', col: 18, row: 18, w: 3, h: 3 }],
      garrison: {},
      spawns: Array.from({ length: 40 }, (_, i) => ({
        tick: 10 + i * 50, // waves keep coming far past the ceiling
        unit: 'guard',
        ...at(2, 2),
      })),
    });
    const sim = makeSim(scenario);
    sim.runToEnd(5);
    expect(sim.done).toBe(true);
    expect(sim.result).toBe(BATTLE_RESULT.TIMEOUT);
  });

  it('raiders breach a sealed wall before striking the tower behind it', () => {
    const state = makeCity({ walls: true, gate: false, defenses: [{ id: 'watchtower', col: 19, row: 19 }] });
    const sim = battleFromCity(state, 'raid-scouts', 777);
    sim.runToEnd();
    const report = sim.report();
    expect(report.wallsBreached).toBeGreaterThan(0);
    const tower = sim.structures.find((s) => s.type === 'watchtower');
    const firstTowerHit = sim.events.findIndex((e) => e.type === 'structure-hit' && e.structure === tower.index);
    const firstBreach = sim.events.findIndex((e) => e.type === 'wall-breach');
    expect(firstBreach).toBeGreaterThanOrEqual(0);
    expect(firstTowerHit === -1 || firstTowerHit > firstBreach).toBe(true);
  });
});

describe('battle: record / replay / server verification', () => {
  it('a recorded battle replays to the same hash and verifies like a server would', () => {
    const state = makeCity({
      walls: true,
      gate: true,
      defenses: [{ id: 'watchtower', col: 17, row: 17, level: 2 }],
      army: { guard: 8, archer: 1 },
    });
    const sim = battleFromCity(state, 'raid-scouts', 5150);
    for (let i = 0; i < 40; i += 1) sim.tick();
    const point = sim.autoDeployPoint('guard', 0);
    expect(sim.deploy('guard', point.x, point.z).ok).toBe(true);
    sim.runToEnd();

    const record = createRecord({ scenario: sim.scenario, sim, encounterId: 'raid-scouts', createdAt: 0 });
    expect(record.commands.length).toBe(1);
    expect(record.checkpoints.length).toBeGreaterThan(3);

    const replay = replayRecord(record, battleDeps);
    expect(replay.ok).toBe(true);
    expect(replay.result).toBe(record.result);
    expect(replay.sim.hashState()).toBe(record.report.stateHash);

    const submission = {
      scenario: record.scenario,
      scenarioHash: record.scenarioHash,
      commands: record.commands,
      result: record.result,
      ticks: record.ticks,
      stateHash: record.report.stateHash,
    };
    expect(verifySubmission(submission, battleDeps).ok).toBe(true);

    // tampering with the command list must fail verification
    const tampered = { ...submission, commands: [{ tick: 5, type: 'withdraw', seq: 0 }] };
    expect(verifySubmission(tampered, battleDeps).ok).toBe(false);

    // a forged result must fail too
    const forged = { ...submission, result: record.result === BATTLE_RESULT.VICTORY ? BATTLE_RESULT.DEFEAT : BATTLE_RESULT.VICTORY };
    expect(verifySubmission(forged, battleDeps).ok).toBe(false);
  });
});

describe('battle: grid and A* pathfinding', () => {
  it('a wall blocks its tile; breaching frees it and bumps the grid version', () => {
    const grid = new BattleGrid({ cols: 8, rows: 8, tileSize: 2 });
    const wall = { index: 0, kind: 'wall', col: 3, row: 3, w: 1, h: 1 };
    grid.addStructure(wall);
    expect(grid.isBlocked(grid.index(3, 3))).toBe(true);
    const version = grid.version;
    expect(grid.freeStructure(wall)).toBe(true);
    expect(grid.isFree(grid.index(3, 3))).toBe(true);
    expect(grid.version).toBeGreaterThan(version);
    // hard structures never open up
    const tower = { index: 1, kind: 'defense', col: 5, row: 5, w: 2, h: 2 };
    grid.addStructure(tower);
    expect(grid.freeStructure(tower)).toBe(false);
    expect(grid.isBlocked(grid.index(5, 5))).toBe(true);
  });

  it('A* routes around a wall through the only gate and is deterministic', () => {
    const grid = new BattleGrid({ cols: 12, rows: 12, tileSize: 2 });
    const gateCol = 3;
    const walls = [];
    for (let col = 2; col <= 9; col += 1) {
      if (col === gateCol) continue; // the gate
      walls.push({ index: walls.length, kind: 'wall', col, row: 5, w: 1, h: 1 });
    }
    for (const wall of walls) grid.addStructure(wall);

    const start = grid.index(6, 0);
    const goal = grid.index(6, 10);
    const query = () => findPath({ grid, start, isGoal: (i) => i === goal, goalHint: goal, maxNodes: 4000 });
    const result = query();
    expect(result.path).toBeTruthy();
    const cells = result.path;
    expect(cells[cells.length - 1]).toBe(goal);
    for (const cell of cells) expect(grid.isFree(cell)).toBe(true);
    const straightWorld = 10 * grid.tileSize;
    expect(pathWorldLength(grid, cells)).toBeGreaterThan(straightWorld + 1);
    expect(cells).toContain(grid.index(gateCol, 5));
    expect(query().path.join(',')).toBe(cells.join(',')); // bit-identical repeat
  });
});
