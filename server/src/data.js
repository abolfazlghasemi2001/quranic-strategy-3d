/**
 * Server-side game data: the same JSON the client plays with, loaded from
 * disk so the server and the client can never disagree about costs, timers
 * or production rates.
 *
 * The server only needs: buildings.json (ids/production/storage),
 * balance.json (cost/time/rate curves), economy.json (starting resources,
 * storage, builders, queue, speedup) and social.json (multiplayer tuning).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function readJson(root, relative) {
  return JSON.parse(readFileSync(resolve(root, relative), 'utf8'));
}

export function loadGameData(root = repoRoot()) {
  const economy = readJson(root, 'src/data/economy.json');
  const balance = readJson(root, 'src/data/balance.json');
  const buildings = readJson(root, 'src/data/buildings.json');
  const social = readJson(root, 'src/data/social.json');
  if (!economy?.resources || !balance?.buildings || !Array.isArray(buildings?.buildings) || !social?.server) {
    throw new Error('game data is incomplete (economy/balance/buildings/social)');
  }
  return new GameData({ economy, balance, buildings, social });
}

export class GameData {
  constructor({ economy, balance, buildings, social }) {
    this.economy = economy;
    this.balance = balance;
    this.buildings = buildings;
    this.social = social;
    this.defsById = new Map(buildings.buildings.map((def) => [def.id, def]));
  }

  knownDef(defId) {
    return this.defsById.get(defId) || null;
  }

  get maxLevel() {
    return this.balance.maxLevel || 10;
  }

  levelEntry(defId, level) {
    const table = this.balance.buildings?.[defId];
    if (!table) return null;
    return table.levels?.[level - 1] || null;
  }

  costOf(defId, level) {
    return this.levelEntry(defId, level)?.cost || null;
  }

  secondsOf(defId, level) {
    return this.levelEntry(defId, level)?.seconds || 0;
  }

  rateOf(defId, level) {
    const entry = this.levelEntry(defId, level);
    return entry?.ratePerHour || 0;
  }

  produces(defId) {
    return this.knownDef(defId)?.produces || null;
  }

  get builders() {
    return this.economy.builders?.total || 2;
  }

  get maxJobs() {
    return this.economy.queue?.maxJobs || 6;
  }

  get startingResources() {
    return { ...(this.economy.starting || { rizq: 0, nur: 0, hekmat: 0, gohar: 0 }) };
  }

  storageBonus(def) {
    const bonus = {};
    if (!def) return bonus;
    if (def.storagePerLevel === true) {
      for (const resource of Object.keys(this.economy.storage.base)) {
        bonus[resource] = this.economy.storage.perWarehouseLevel?.[resource] || 0;
      }
      return bonus;
    }
    if (Array.isArray(def.storageFor)) {
      const table = this.economy.storage.perStorageLevel || {};
      for (const resource of def.storageFor) {
        const amount = Number(table[resource]);
        if (Number.isFinite(amount) && amount > 0) bonus[resource] = amount;
        else if (this.economy.storage.perWarehouseLevel?.[resource]) {
          bonus[resource] = this.economy.storage.perWarehouseLevel[resource];
        }
      }
    }
    return bonus;
  }

  /** Warehouse capacity from a validated `[{type, level}]` list (all assumed ready). */
  capacityFor(buildings) {
    const capacity = { ...(this.economy.storage?.base || {}) };
    for (const building of buildings || []) {
      const def = this.knownDef(building?.type);
      if (!def) continue;
      const level = Math.max(1, Math.min(this.maxLevel, Math.floor(building.level) || 1));
      for (const [resource, amount] of Object.entries(this.storageBonus(def))) {
        capacity[resource] = (capacity[resource] || 0) + amount * level;
      }
    }
    return capacity;
  }

  /** Hourly production per stored resource from a validated buildings list. */
  hourlyRates(buildings) {
    const rates = { rizq: 0, nur: 0, hekmat: 0 };
    for (const building of buildings || []) {
      const resource = this.produces(building?.type);
      if (!resource || rates[resource] === undefined) continue;
      const level = Math.max(1, Math.min(this.maxLevel, Math.floor(building.level) || 1));
      rates[resource] += this.rateOf(building.type, level);
    }
    return rates;
  }
}
