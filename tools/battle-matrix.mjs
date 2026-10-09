#!/usr/bin/env node
/** Pure deterministic balance probe. No renderer, wall clock or ambient randomness. */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { GameState } from '../src/game/GameState.js';
import { BattleSim } from '../src/game/battle/BattleSim.js';
import { buildScenario, scenarioHash, defenseDefsFrom, structureModifiersFrom } from '../src/game/battle/BattleScenario.js';
import { createStructureStats } from '../src/game/battle/StructureStats.js';
import { createRecord, replayRecord } from '../src/game/battle/BattleRecorder.js';
const data = (key) => JSON.parse(readFileSync(new URL(`../src/data/${key}.json`, import.meta.url), 'utf8'));
const rules = data('battle'), units = data('units'), defenses = data('defenses');
const config = { cols: 40, rows: 40, tileSize: 2, seed: 20261007 };
const deps = { rules, units, defenseDefs: defenseDefsFrom(defenses), structureModifiers: structureModifiersFrom(defenses) };
const cases = [];
for (const positions of [[[17, 17], [22, 17]], [[17, 14], [22, 14]], [[18, 12], [23, 12]], [[17, 17], [17, 23]]]) {
  for (const seed of [1, 2, 42, 5150, 20261007, 424242]) cases.push({ seed, positions, townLevel: 1, towerLevel: 1, garrison: {} });
}
for (const seed of [33, 56, 79]) for (const townLevel of [1, 5, 10]) for (const army of [false, true]) cases.push({ seed, positions: [[17, 17], [17, 23]], townLevel, towerLevel: 1, garrison: army ? { guard: 4, archer: 2, healer: 1 } : {} });
// Include the third confirmed reproduction with its ORIGINAL different tower positions.
cases.push({ seed: 79, positions: [[15, 15], [23, 23]], townLevel: 1, towerLevel: 1, garrison: {} });
const rows = [];
for (const spec of cases) {
  const state = new GameState();
  state.createEntity({ type: 'town-center', col: 19, row: 19, size: [3, 3], level: spec.townLevel });
  for (const [col, row] of spec.positions) state.createEntity({ type: 'watchtower', col, row, size: [2, 2], level: spec.towerLevel });
  state.army.garrison = { ...spec.garrison };
  const current = buildScenario({ config, state, defensesData: defenses, battleData: rules, structureStats: createStructureStats({ defenses, config }), encounterId: 'raid-column', seed: spec.seed });
  const outcomes = {};
  for (const version of [1, 2]) {
    const scenario = structuredClone(current); scenario.version = version;
    if (version === 1) delete scenario.columnExit;
    scenario.scenarioHash = scenarioHash(scenario);
    const sim = new BattleSim({ scenario, ...deps }); sim.runToEnd();
    const replay = replayRecord(createRecord({ scenario, sim, encounterId: 'raid-column' }), deps);
    if (!replay.ok) throw new Error(`nondeterministic v${version}, seed ${spec.seed}`);
    const lastTower = sim.events.filter((event) => event.type === 'structure-down' && event.structureType === 'watchtower').at(-1);
    const exit = sim.events.find((event) => event.type === 'retreat' && event.reason === 'column-depleted');
    outcomes[`v${version}`] = { ...sim.report(), lastTowerDown: lastTower?.tick ?? null, fieldExitTick: exit?.tick ?? null, postTowerHits: sim.events.filter((event) => event.type === 'structure-hit' && event.tick > (lastTower?.tick ?? Infinity)).length, replayIdentical: replay.ok };
  }
  rows.push({ ...spec, ...outcomes });
}
const summary = {};
for (const version of ['v1', 'v2']) summary[version] = rows.reduce((counts, row) => { counts[row[version].result] = (counts[row[version].result] || 0) + 1; return counts; }, {});
const out = process.argv[2] || 'docs/upgrade/after/battle-matrix.json';
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ date: '2026-10-09', cases: cases.length, policy: rules.attacker.columnExit, legacyCompatibility: 'Original rules (scenario v1) remain bit-identical; v2 intentionally adds morale state to the hash.', summary, rows }, null, 2) + '\n');
console.log(JSON.stringify(summary));
for (const row of rows.filter((row) => row.seed === 33 && row.townLevel === 1 && !Object.keys(row.garrison).length)) console.log(JSON.stringify({ seed: row.seed, v1: row.v1, v2: row.v2 }));
