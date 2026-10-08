/**
 * Phase 9 — Vitest: منطق اقتصاد (EconomySystem).
 *
 * پوشش:
 *   - ظرفیت = پایه + انبار (فقط سازهٔ «ready») و انبار غله (فقط رزق)
 *   - تولید بر حسب ratePerHour، توقف در سقف بافر و انبار پر
 *   - harvest = min(pending, freeCapacity)
 *   - progress آفلاین clamped + ساعت عقب‌گرد (resync)
 *   - spend/canAfford اتمی، grant با سرریز، گوهر بدون خرید/پاداش ورود
 *   - ضریب‌های مأموریت (تولید/مصرف) و دفترکل تخلیه (drain ledger)
 *   - determinism: دو اجرای یکسان با زمان‌ثابت ⇒ حالت یکسان
 *
 * همهٔ زمان‌ها ثابت (T0) هستند؛ هیچ تستی به ساعت سیستم وابسته نیست.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GameState } from '../src/game/GameState.js';
import { EconomySystem } from '../src/game/EconomySystem.js';
import { BuildQueue } from '../src/game/BuildQueue.js';

import economyData from '../src/data/economy.json';
import balanceData from '../src/data/balance.json';
import buildingsData from '../src/data/buildings.json';

const root = dirname(fileURLToPath(import.meta.url));
const HOUR = 3600 * 1000;
const T0 = 1_700_000_000_000; // fixed epoch — all tests are deterministic

/** Minimal wiring for economy tests (no DOM, no Three). */
function makeEconomy({ seedTown = true } = {}) {
  const state = new GameState({ economy: economyData });
  const economy = new EconomySystem({
    economy: economyData,
    balance: balanceData,
    defs: buildingsData.buildings,
    state,
  });
  const queue = new BuildQueue({ economyData, economy, state });
  if (seedTown) {
    const tc = buildingsData.buildings.find((b) => b.id === 'town-center');
    state.createEntity({
      type: tc.id, name: tc.name, col: 18, row: 18, size: tc.size,
      level: 1, status: 'ready', lastAccrualAt: T0,
    });
  }
  return { state, economy, queue };
}

function addProducer(state, defId, at = T0, level = 1) {
  const def = buildingsData.buildings.find((b) => b.id === defId);
  return state.createEntity({
    type: def.id, name: def.name, col: 1, row: 1, size: def.size, level,
    status: 'ready', pending: 0, lastAccrualAt: at,
  });
}

describe('economy: data contract (economy.json / balance.json)', () => {
  it('starting resources fit inside base storage capacity', () => {
    for (const key of Object.keys(economyData.storage.base)) {
      expect(economyData.starting[key]).toBeLessThanOrEqual(economyData.storage.base[key]);
    }
  });

  it('has two builders, a queue that holds them, and sane speedup pricing', () => {
    expect(economyData.builders.total).toBe(2);
    expect(economyData.queue.maxJobs).toBeGreaterThanOrEqual(economyData.builders.total);
    expect(economyData.speedup.minGohar).toBeGreaterThanOrEqual(1);
    expect(economyData.speedup.goharPerMinute).toBeGreaterThanOrEqual(1);
  });

  it('gohar has no login/day-visit source and no purchase path', () => {
    expect(economyData.goharSources.dailyBonus).toBe(0);
    expect(economyData.goharSources.townCenterLevelReward).toBeGreaterThan(0);
    const { economy } = makeEconomy();
    expect(economy.grantDailyBonus(T0)).toBe(0); // legacy hook never pays
    const source = readFileSync(resolve(root, '../src/game/EconomySystem.js'), 'utf8');
    expect(source).not.toContain('Math.random');
  });

  it('every building has a monotonic 10-level cost/time curve', () => {
    expect(balanceData.maxLevel).toBe(10);
    for (const def of buildingsData.buildings) {
      const table = balanceData.buildings[def.id];
      expect(table, `${def.id} table`).toBeTruthy();
      expect(table.levels).toHaveLength(10);
      table.levels.forEach((entry, i) => {
        expect(entry.level).toBe(i + 1);
        expect(entry.cost.rizq).toBeGreaterThanOrEqual(0);
        expect(entry.seconds).toBeGreaterThan(0);
        if (i > 0) {
          const prev = table.levels[i - 1];
          expect(entry.cost.rizq).toBeGreaterThanOrEqual(prev.cost.rizq);
          expect(entry.seconds).toBeGreaterThanOrEqual(prev.seconds);
        }
        if (def.produces) {
          expect(entry.resource).toBe(def.produces);
          expect(entry.ratePerHour).toBeGreaterThan(0);
        }
      });
    }
  });
});

describe('economy: storage capacity', () => {
  it('capacity = base + warehouse level bonus, only for ready buildings', () => {
    const { state, economy } = makeEconomy();
    const base = economy.capacity();
    expect(base.rizq).toBe(economyData.storage.base.rizq);

    const wh = addProducer(state, 'warehouse');
    wh.status = 'building';
    expect(economy.capacity().rizq).toBe(base.rizq); // under construction: no bonus

    wh.status = 'ready';
    wh.level = 2;
    expect(economy.capacity().rizq).toBe(base.rizq + 2 * economyData.storage.perWarehouseLevel.rizq);
    // warehouse bonus covers all three stored resources
    expect(economy.capacity().nur).toBe(base.nur + 2 * economyData.storage.perWarehouseLevel.nur);
    expect(economy.capacity().hekmat).toBe(base.hekmat + 2 * economyData.storage.perWarehouseLevel.hekmat);
    expect(economy.freeCapacity('rizq')).toBe(economy.capacity().rizq - state.resources.rizq);
  });

  it('granary (storageFor: rizq) raises only rizq via perStorageLevel', () => {
    const { state, economy } = makeEconomy();
    const base = economy.capacity();
    const granary = addProducer(state, 'granary');
    granary.level = 3;
    expect(economy.capacity().rizq).toBe(base.rizq + 3 * economyData.storage.perStorageLevel.rizq);
    expect(economy.capacity().nur).toBe(base.nur);
    expect(economy.capacity().hekmat).toBe(base.hekmat);
  });
});

describe('economy: production and harvest', () => {
  it('accrues at ratePerHour and stops exactly at the buffer ceiling', () => {
    const { state, economy } = makeEconomy();
    const farm = addProducer(state, 'farm');
    const rate = economy.rateOf(farm);
    expect(rate).toBe(balanceData.buildings.farm.levels[0].ratePerHour);

    economy.accrue(T0 + 10 * 60 * 1000); // 10 minutes
    expect(farm.pending).toBeCloseTo((rate * 10) / 60, 6);

    economy.accrue(T0 + 100 * HOUR); // way past bufferHours
    const cap = economy.bufferCap(farm);
    expect(farm.pending).toBeCloseTo(cap, 6);
  });

  it('production halts while storage is full and resumes when space frees', () => {
    const { state, economy } = makeEconomy();
    const farm = addProducer(state, 'farm');
    state.resources.rizq = economy.capacity().rizq;
    economy.accrue(T0 + HOUR);
    expect(farm.pending).toBe(0);

    state.resources.rizq -= 100;
    economy.accrue(T0 + HOUR + 60 * 1000);
    expect(farm.pending).toBeGreaterThan(0);
  });

  it('harvest moves min(pending, free) and never exceeds capacity', () => {
    const { state, economy } = makeEconomy();
    const farm = addProducer(state, 'farm');
    const cap = economy.capacity().rizq;
    state.resources.rizq = cap - 50;
    economy.accrue(T0 + HOUR);
    expect(farm.pending).toBeGreaterThan(50);

    const result = economy.harvest(farm, T0 + HOUR);
    expect(result.moved).toBe(50);
    expect(state.resources.rizq).toBe(cap);
    expect(farm.pending).toBeGreaterThan(0);
    expect(result.full).toBe(true);
  });

  it('accrue is idempotent for the same timestamp (deterministic time math)', () => {
    const { state, economy } = makeEconomy();
    const farm = addProducer(state, 'farm');
    economy.accrue(T0 + 30 * 60 * 1000);
    const once = farm.pending;
    economy.accrue(T0 + 30 * 60 * 1000); // same timestamp again
    expect(farm.pending).toBe(once);
  });
});

describe('economy: offline progress and clock skew', () => {
  it('clamps absurd forward jumps to offline.maxHours and buffer cap', () => {
    const { state, economy } = makeEconomy();
    const farm = addProducer(state, 'farm');
    economy.accrue(T0 + 1000 * HOUR);
    expect(farm.pending).toBeLessThanOrEqual(economy.bufferCap(farm) + 1e-6);
    // even if the buffer cap were huge, the wall-clock clamp applies first:
    const maxMs = economyData.offline.maxHours * HOUR;
    const rate = economy.rateOf(farm);
    expect(farm.pending).toBeLessThanOrEqual((rate * maxMs) / HOUR + 1e-6);
  });

  it('resyncs on backward clocks without negative production', () => {
    const { state, economy } = makeEconomy();
    const farm = addProducer(state, 'farm');
    economy.accrue(T0 + HOUR);
    const before = farm.pending;
    economy.accrue(T0); // clock moved backwards
    expect(farm.pending).toBe(before);
    expect(farm.lastAccrualAt).toBe(T0);
  });

  it('catchUp auto-harvests into storage, capped by free capacity', () => {
    const { state, economy } = makeEconomy();
    addProducer(state, 'farm');
    addProducer(state, 'light-spring');
    const report = economy.catchUp(T0 + 2 * HOUR);
    expect(report.accrued).toBeGreaterThan(0);
    expect(report.harvested.rizq).toBeGreaterThan(0);
    expect(report.harvested.nur).toBeGreaterThan(0);
    expect(state.resources.rizq).toBeLessThanOrEqual(economy.capacity().rizq);
    expect(state.resources.nur).toBeLessThanOrEqual(economy.capacity().nur);
  });
});

describe('economy: spend / grant / gohar', () => {
  it('spend is atomic: unaffordable cost deducts nothing', () => {
    const { state, economy } = makeEconomy();
    const before = { ...state.resources };
    const cost = { rizq: before.rizq + 1, nur: 10 };
    expect(economy.canAfford(cost)).toBe(false);
    expect(economy.spend(cost)).toBe(false);
    expect(state.resources).toEqual(before);

    expect(economy.spend({ rizq: 10 })).toBe(true);
    expect(state.resources.rizq).toBe(before.rizq - 10);
  });

  it('grant clamps to capacity and reports overflow; gohar is never clamped', () => {
    const { state, economy } = makeEconomy();
    const free = economy.freeCapacity('rizq');
    const result = economy.grant('rizq', free + 500);
    expect(result.moved).toBe(free);
    expect(result.overflow).toBe(500);
    expect(state.resources.rizq).toBe(economy.capacity().rizq);

    const before = state.resources.gohar;
    const granted = economy.grant('gohar', 1000); // stored:false → no capacity clamp
    expect(granted.moved).toBe(1000);
    expect(state.resources.gohar).toBe(before + 1000);
  });

  it('grant rejects unknown resources and non-positive amounts', () => {
    const { economy } = makeEconomy();
    expect(economy.grant('unknown', 10).overflow).toBe(10);
    expect(economy.grant('rizq', 0).moved).toBe(0);
    expect(economy.grant('rizq', -5).moved).toBe(0);
  });

  it('gohar earn/spend rules and speedup cost formula', () => {
    const { state, economy } = makeEconomy();
    const before = state.resources.gohar;
    economy.earnGohar(economy.townCenterReward(), { source: 'town-center' });
    expect(state.resources.gohar).toBe(before + economyData.goharSources.townCenterLevelReward);
    expect(economy.spendGohar(state.resources.gohar + 1)).toBe(false);
    expect(economy.spendGohar(1)).toBe(true);

    const now = T0;
    const job = { status: 'active', endsAt: now + 90 * 1000 }; // 1.5 min left
    const expected = Math.max(economyData.speedup.minGohar, 2 * economyData.speedup.goharPerMinute);
    expect(economy.speedupCost(job, now)).toBe(expected);
    expect(economy.speedupCost({ status: 'active', endsAt: now + 5000 }, now))
      .toBe(economyData.speedup.minGohar);
    expect(economy.speedupCost({ status: 'queued' }, now)).toBeNull();
  });
});

describe('economy: mission modifiers and mirror drain ledger', () => {
  it('production modifiers scale accrual; consumption drains and reports via ledger', () => {
    const { state, economy } = makeEconomy();
    const farm = addProducer(state, 'farm');
    const rate = economy.rateOf(farm);

    // the drain ledger only accumulates while a server mirror is installed
    const intents = [];
    economy.setMirror((intent) => intents.push(intent));

    economy.setModifiers({ production: { rizq: 2 }, consumption: { hekmat: 0.5 } });
    economy.accrue(T0 + HOUR);
    expect(farm.pending).toBeCloseTo(rate * 2, 6); // doubled by the plenty rule

    const hekmatBefore = state.resources.hekmat;
    const drained = economy.applyConsumption(10); // 10 seconds at 0.5/s
    expect(drained).toBeCloseTo(5, 6);
    expect(state.resources.hekmat).toBeCloseTo(hekmatBefore - 5, 6);

    const ledger = economy.takeDrainLedger();
    expect(ledger).toEqual({ hekmat: 5 });
    expect(economy.takeDrainLedger()).toBeNull(); // drained exactly once

    economy.setMirror(null);
    const drainedOffline = economy.applyConsumption(10);
    expect(drainedOffline).toBeCloseTo(5, 6); // still drains locally…
    expect(economy.takeDrainLedger()).toBeNull(); // …but no mirror ⇒ no ledger entry

    economy.clearModifiers();
    economy.accrue(T0 + 2 * HOUR);
    expect(farm.pending).toBeCloseTo(rate * 2 + rate, 6); // back to normal rate
  });
});

describe('economy: determinism', () => {
  it('two identical runs with fixed timestamps produce identical state', () => {
    const run = () => {
      const { state, economy } = makeEconomy();
      addProducer(state, 'farm');
      addProducer(state, 'light-spring');
      addProducer(state, 'library');
      economy.accrue(T0 + 17 * 60 * 1000);
      economy.accrue(T0 + 3 * HOUR);
      for (const entity of state.entities.values()) economy.harvest(entity, T0 + 3 * HOUR);
      economy.spend({ rizq: 100 });
      economy.grant('nur', 50);
      economy.earnGohar(3, { source: 'town-center' });
      return JSON.stringify({
        resources: state.resources,
        entities: [...state.entities.values()].map((e) => ({ id: e.id, pending: e.pending, lastAccrualAt: e.lastAccrualAt })),
      });
    };
    expect(run()).toBe(run());
  });
});
