/**
 * BattleScenario — ساخت «آرایش نبرد» از چیدمان واقعی شهر بازیکن (منطق خالص).
 *
 * خروجی این ماژول یک شیء دادهٔ کامل و قابل‌ذخیره است: سازه‌ها با جان و خانه‌های
 * اشغال‌شده، زمان‌بندی موج‌های مهاجم، سپاه آمادهٔ مدافع و بذر نبرد. همین شیء
 * مبنای ضبط و بازپخش است، پس هیچ وابستگی‌ای به وضعیت زندهٔ بازی ندارد.
 */
import { Rng } from '../../core/RNG.js';
import { clamp } from '../../core/MathUtils.js';
import { FACTION } from './Unit.js';
import { STRUCTURE_KIND } from './StructureStats.js';

export const SCENARIO_VERSION = 1;

/** بذر هر نبرد از (بذر بازی، بذر سناریو، شمارهٔ نبرد) ساخته می‌شود. */
export function deriveBattleSeed({ worldSeed, seedOffset, battleSeq = 0 }) {
  let hash = 2166136261 >>> 0;
  for (const value of [worldSeed >>> 0, seedOffset >>> 0, battleSeq >>> 0]) {
    hash = Math.imul(hash ^ (value | 0), 16777619) >>> 0;
  }
  return hash >>> 0;
}

export function encounterById(battleData, encounterId) {
  const list = battleData.encounters || [];
  return list.find((item) => item.id === encounterId) || list[0] || null;
}

/** توضیح سناریوها برای رابط کاربری (بدون هیچ متن قرآنی). */
export function encounterList(battleData, config) {
  return (battleData.encounters || []).map((encounter) => ({
    id: encounter.id,
    name: encounter.name,
    threat: encounter.threat,
    units: encounter.waves.reduce((sum, wave) => sum + wave.count, 0),
    waves: encounter.waves.length,
    seconds: encounter.waves.reduce((max, wave) => Math.max(max, wave.atSeconds), 0),
    label: encounter.name || config?.t('battle.encounter', 'سناریو'),
  }));
}

function edgeSpawns({ edge, wave, waveIndex, seed, stepHz, tileSize, spreadTiles, intervalTicks }) {
  const rng = new Rng((seed ^ Math.imul(waveIndex + 1, 0x9e3779b1) ^ 0x51ed270b) >>> 0);
  const startCol = edge.start.col;
  const startRow = edge.start.row;
  const endCol = edge.end.col;
  const endRow = edge.end.row;
  const dCol = endCol - startCol;
  const dRow = endRow - startRow;
  const band = Math.max(1, Math.abs(dCol) + Math.abs(dRow) + 1);
  const stepCol = Math.sign(dCol);
  const stepRow = Math.sign(dRow);
  const baseTick = Math.round(wave.atSeconds * stepHz);
  const spawns = [];
  for (let i = 0; i < wave.count; i += 1) {
    const slot = (i * 3 + Math.floor(rng.next() * 2)) % band;
    const depth = Math.floor(i / band) + 1;
    const jitter = (rng.next() - 0.5) * spreadTiles;
    const col = startCol + stepCol * slot + Math.round(edge.inward.x * depth);
    const row = startRow + stepRow * slot + Math.round(edge.inward.z * depth);
    const x = (col + 0.5 + edge.inward.x * jitter) * tileSize;
    const z = (row + 0.5 + edge.inward.z * jitter) * tileSize;
    spawns.push({ tick: baseTick + i * intervalTicks, unit: wave.unit, x, z });
  }
  return spawns;
}

/**
 * @param {object} options
 * @param {object} options.config — Config (شبکه، بذر)
 * @param {import('../GameState.js').GameState} options.state — وضعیت شهر (سازه‌ها + سپاه)
 * @param {object} options.defensesData — defenses.json
 * @param {object} options.battleData — battle.json
 * @param {object} options.structureStats — createStructureStats(...)
 * @param {string} options.encounterId
 * @param {number} options.seed — بذر نبرد
 * @returns {object} scenario (plain JSON, قابل‌ذخیره)
 */
export function buildScenario({ config, state, defensesData, battleData, structureStats, encounterId, seed }) {
  const encounter = encounterById(battleData, encounterId);
  if (!encounter) throw new Error(`[battle] encounter not found: ${encounterId}`);
  const stepHz = battleData.sim.stepHz;
  const tileSize = config.tileSize;

  // ------------------------------------------------------------ structures
  const structures = [];
  let index = 0;
  const entities = [...state.entities.values()].sort((a, b) => a.id - b.id);
  for (const entity of entities) {
    const snapshot = structureStats.snapshot(entity, { index });
    if (!snapshot) continue;
    structures.push({ ...snapshot, damageTaken: 0 });
    index += 1;
  }

  // ---------------------------------------------------------------- army
  const garrison = {};
  const army = state.army || { garrison: {} };
  for (const [type, count] of Object.entries(army.garrison || {})) {
    const value = Math.max(0, Math.floor(count));
    if (value > 0) garrison[type] = value;
  }

  // --------------------------------------------------------------- spawns
  const spawns = [];
  encounter.waves.forEach((wave, waveIndex) => {
    const edge = battleData.edges[wave.edge] || battleData.edges.north;
    spawns.push(...edgeSpawns({
      edge,
      wave,
      waveIndex,
      seed,
      stepHz,
      tileSize,
      spreadTiles: battleData.attacker?.spawnSpreadTiles ?? 1,
      intervalTicks: battleData.attacker?.spawnIntervalTicks ?? 1,
    }));
  });
  spawns.sort((a, b) => (a.tick !== b.tick ? a.tick - b.tick : 0)); // ترتیب پایدار (sort پایدار در ES2019+)

  const scenario = {
    version: SCENARIO_VERSION,
    seed: seed >>> 0,
    encounter: { id: encounter.id, name: encounter.name, threat: encounter.threat },
    cols: config.cols,
    rows: config.rows,
    tileSize,
    structures,
    garrison,
    spawns: spawns.map((spawn) => ({ tick: spawn.tick, unit: spawn.unit, x: round4(spawn.x), z: round4(spawn.z) })),
    commands: [],
    note: 'آرایش نبرد: snapshot کامل و قابل‌ذخیره؛ مبنای بازپخش و اعتبارسنجی.',
  };
  scenario.scenarioHash = scenarioHash(scenario);
  return scenario;
}

/** چک‌سام آرایش (هر تغییر در چیدمان شهر آن را عوض می‌کند). */
export function scenarioHash(scenario) {
  const parts = [
    `v${scenario.version}`,
    `s${scenario.seed}`,
    `e${scenario.encounter ? scenario.encounter.id : '?'}`,
    `${scenario.cols}x${scenario.rows}@${scenario.tileSize}`,
  ];
  for (const structure of scenario.structures) {
    parts.push(`${structure.index}|${structure.type}|${structure.kind}|${structure.col},${structure.row},${structure.w},${structure.h}|${structure.level}|${structure.hp}/${structure.maxHp}|${structure.sourceId}`);
  }
  for (const spawn of scenario.spawns) {
    parts.push(`w${spawn.tick}|${spawn.unit}|${spawn.x.toFixed(4)},${spawn.z.toFixed(4)}`);
  }
  for (const [type, count] of Object.entries(scenario.garrison)) parts.push(`g|${type}|${count}`);
  let hash = 2166136261 >>> 0;
  const text = parts.join('\n');
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  return hash >>> 0;
}

/** آیا این آرایش دست‌کم یک مدافع دارد؟ (سازهٔ دفاعی یا سپاه) */
export function scenarioHasDefenders(scenario) {
  const army = Object.values(scenario.garrison || {}).reduce((sum, value) => sum + value, 0);
  const defenses = (scenario.structures || []).filter((s) => s.kind === STRUCTURE_KIND.DEFENSE).length;
  return { army, defenses, ready: army > 0 || defenses > 0 };
}

/** شمارش سازه‌ها به تفکیک گونه (برای گزارش و رابط کاربری). */
export function scenarioSummary(scenario) {
  const counts = { wall: 0, defense: 0, building: 0 };
  let wallHp = 0;
  for (const structure of scenario.structures) {
    counts[structure.kind] = (counts[structure.kind] || 0) + 1;
    if (structure.kind === STRUCTURE_KIND.WALL) wallHp += structure.hp;
  }
  return {
    ...counts,
    wallHp: Math.round(wallHp),
    garrison: Object.values(scenario.garrison).reduce((sum, value) => sum + value, 0),
    raiders: scenario.spawns.length,
    threat: scenario.encounter ? scenario.encounter.threat : 0,
  };
}

/** تعریف سازه‌های دفاعی به‌صورت نقشهٔ نوع → آمار رزمی. */
export function defenseDefsFrom(defensesData) {
  const map = new Map();
  for (const def of defensesData.defenses || []) map.set(def.id, def);
  return map;
}

export function structureModifiersFrom(defensesData) {
  return {
    wallBreakerMultiplier: defensesData.wall?.breakerMultiplier ?? 1,
  };
}

function round4(value) {
  return clamp(Math.round(value * 10000) / 10000, -1e6, 1e6);
}

export { FACTION };
