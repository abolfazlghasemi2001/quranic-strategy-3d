/**
 * StructureStats — جان/تعمیر سازه‌ها (منطق خالص، بدون Three.js و بدون DOM).
 *
 * همهٔ اعداد از src/data/defenses.json خوانده می‌شود:
 *   جان = مقدار hpById (یا hpPerTile × خانه‌ها) × (۱ + levelBonusPerLevel × (سطح − ۱))
 *   دیوار و سازه‌های دفاعی جان مخصوص خود را دارند (hpPerLevel + hpLevelBonus).
 *
 * این ماژول تنها منبع «جان سازه» در بازی است: شبیه‌ساز نبرد، تعمیر و رابط کاربری
 * همه از همین‌جا می‌خوانند تا هیچ عددی در کد تکرار نشود.
 */
import { clamp } from '../../core/MathUtils.js';

export const STRUCTURE_KIND = Object.freeze({
  WALL: 'wall',
  DEFENSE: 'defense',
  BUILDING: 'building',
});

export function createStructureStats({ defenses, config }) {
  const wall = defenses.wall;
  const defenseById = new Map(defenses.defenses.map((d) => [d.id, d]));
  const structures = defenses.structures || {};
  const repair = defenses.repair || {};

  const kindOf = (type) => {
    if (type === wall.id) return STRUCTURE_KIND.WALL;
    if (defenseById.has(type)) return STRUCTURE_KIND.DEFENSE;
    return STRUCTURE_KIND.BUILDING;
  };

  /** Base health before the per-level bonus. */
  const baseHp = (type, size) => {
    if (type === wall.id) return wall.hpPerLevel;
    const def = defenseById.get(type);
    if (def) return def.hpPerLevel;
    const explicit = structures.hpById ? structures.hpById[type] : null;
    if (typeof explicit === 'number') return explicit;
    const tiles = Array.isArray(size) && size.length === 2 ? size[0] * size[1] : 1;
    return (structures.hpPerTile || 240) * tiles;
  };

  const levelBonus = (type) => {
    if (type === wall.id) return wall.hpLevelBonus ?? 0;
    const def = defenseById.get(type);
    if (def) return def.hpLevelBonus ?? 0;
    return structures.levelBonusPerLevel ?? 0;
  };

  /**
   * @param {{type:string, level?:number, size?:number[]}} entity
   * @returns {number} whole-number health so saves and hashes stay clean
   */
  function maxHpFor(entity) {
    if (!entity || !entity.type) return 0;
    const level = Math.max(1, Math.floor(entity.level || 1));
    const level1 = baseHp(entity.type, entity.size);
    const scaled = level1 * (1 + levelBonus(entity.type) * (level - 1));
    return Math.max(1, Math.round(scaled));
  }

  function repairCost(entity) {
    const maxHp = entity.maxHp ?? maxHpFor(entity);
    const missing = Math.max(0, maxHp - (entity.hp ?? maxHp));
    if (missing <= 0) return null;
    const units = missing / 100;
    const cost = {};
    for (const [key, value] of Object.entries(repair.costPer100Hp || {})) {
      const amount = Math.ceil(value * units);
      if (amount > 0) cost[key] = amount;
    }
    return Object.keys(cost).length ? cost : null;
  }

  function repairSeconds(entity) {
    const maxHp = entity.maxHp ?? maxHpFor(entity);
    const missing = Math.max(0, maxHp - (entity.hp ?? maxHp));
    const per100 = repair.secondsPer100Hp ?? 6;
    return Math.max(repair.minSeconds ?? 6, Math.ceil((missing / 100) * per100));
  }

  /** نسبت جان باقی‌مانده در بازهٔ [۰,۱]. */
  function healthRatio(entity) {
    const maxHp = entity.maxHp ?? maxHpFor(entity);
    if (maxHp <= 0) return 1;
    return clamp((entity.hp ?? maxHp) / maxHp, 0, 1);
  }

  function isDamaged(entity) {
    return healthRatio(entity) < 1 - 1e-9;
  }

  /** Create the combat snapshot of a live entity (used by the scenario builder). */
  function snapshot(entity, { index = 0 } = {}) {
    const maxHp = maxHpFor(entity);
    const hp = entity.hp == null ? maxHp : clamp(entity.hp, 0, maxHp);
    return {
      index,
      sourceId: entity.id ?? null,
      type: entity.type,
      kind: kindOf(entity.type),
      col: entity.col,
      row: entity.row,
      w: entity.size ? entity.size[0] : 1,
      h: entity.size ? entity.size[1] : 1,
      level: entity.level ?? 1,
      maxHp,
      hp,
    };
  }

  return {
    wall,
    defenses: defenses.defenses,
    defenseById,
    /** @returns {string|null} id of the defense definition, or null */
    defenseIdOf: (type) => (defenseById.has(type) ? type : null),
    defenseDefOf: (type) => defenseById.get(type) || null,
    kindOf,
    maxHpFor,
    healthRatio,
    isDamaged,
    repairCost,
    repairSeconds,
    snapshot,
    resultDamageThreshold: defenses.outcome?.damagedByDefeat ?? 3,
    timeoutSeconds: config?.gameplay?.battleTimeoutSeconds ?? null,
  };
}
