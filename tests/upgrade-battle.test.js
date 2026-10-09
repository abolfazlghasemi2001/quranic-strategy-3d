import { describe, expect, it } from 'vitest';
import { BattleSim } from '../src/game/battle/BattleSim.js';
import { buildScenario, defenseDefsFrom, structureModifiersFrom } from '../src/game/battle/BattleScenario.js';
import { createStructureStats } from '../src/game/battle/StructureStats.js';
import { createRecord, replayRecord } from '../src/game/battle/BattleRecorder.js';
import { GameState } from '../src/game/GameState.js';
import { migrateRecord, SAVE_SCHEMA_VERSION } from '../src/game/SaveSystem.js';
import battle from '../src/data/battle.json';
import units from '../src/data/units.json';
import defenses from '../src/data/defenses.json';
import legacy from './fixtures/battle-v1.json';
import softlocks from '../docs/upgrade/before/battle-softlock.json';
const config = { cols: 40, rows: 40, tileSize: 2, seed: 20261007 };
const deps = { rules: battle, units, defenseDefs: defenseDefsFrom(defenses), structureModifiers: structureModifiersFrom(defenses) };
const scenario = (rawScenario = legacy.scenario) => {
  const state = new GameState();
  for (const raw of rawScenario.structures) state.createEntity({ id: raw.sourceId, type: raw.type, col: raw.col, row: raw.row, size: [raw.w, raw.h], level: raw.level });
  return buildScenario({ config, state, defensesData: defenses, battleData: battle, structureStats: createStructureStats({ defenses, config }), encounterId: 'raid-column', seed: rawScenario.seed });
};

describe('BTL-01: data-driven field exit / replay compatibility', () => {
  it('ends a depleted column after both priority towers fall, not at timeout', () => {
    const sim = new BattleSim({ scenario: scenario(), ...deps });
    sim.runToEnd();
    expect(sim.result).toBe('victory');
    expect(sim.finishTick).toBeLessThan(2000);
    const exit = sim.events.find((event) => event.type === 'retreat' && event.reason === 'column-depleted');
    expect(exit).toBeTruthy();
    expect(sim.events.filter((event) => event.type === 'structure-hit' && event.tick > exit.tick)).toHaveLength(0);
    expect(replayRecord(createRecord({ scenario: sim.scenario, sim, encounterId: 'raid-column' }), deps).ok).toBe(true);
  });
  it.each(softlocks)('ends the original softlock seed $seed at its exact audited tower coordinates', ({ scenario: original, report }) => {
    const old = new BattleSim({ scenario: original, ...deps }); old.runToEnd();
    expect(old.hashState()).toBe(report.stateHash);
    expect(old.eventHash).toBe(report.eventHash);
    const current = new BattleSim({ scenario: scenario(original), ...deps }); current.runToEnd();
    expect(current.result).toBe('victory'); expect(current.finishTick).toBeLessThan(old.finishTick);
    expect(current.events.some((event) => event.reason === 'column-depleted')).toBe(true);
  });
  it('keeps archived v1 recordings bit-identical, including event hash and checkpoints', () => {
    const replay = replayRecord(legacy, deps);
    expect(replay.ok).toBe(true);
    expect(replay.sim.hashState()).toBe(1226110089);
    expect(replay.sim.eventHash >>> 0).toBe(214625525);
    expect(replay.sim.finishTick).toBe(3000);
  });
  it('migrates a v6 save without changing any old battle record or resources', () => {
    const payload = { resources: { rizq: 17 }, battles: { history: [legacy], seq: 1 } };
    const migrated = migrateRecord({ schemaVersion: 6, payload, savedAt: 0 });
    expect(SAVE_SCHEMA_VERSION).toBeGreaterThan(6);
    expect(migrated.migratedFrom).toBe(6);
    expect(migrated.payload.battles.history[0]).toEqual(legacy);
    expect(migrated.payload.resources).toEqual(payload.resources);
    expect(replayRecord(migrated.payload.battles.history[0], deps).ok).toBe(true);
  });
});
