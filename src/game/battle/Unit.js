/**
 * Unit — ماشین حالت واحد (FSM) و شکل دادهٔ واحد. منطق خالص: بدون Three.js،
 * بدون DOM، بدون Math.random و بدون تابع مثلثاتی (تا نتیجهٔ شبیه‌سازی روی همهٔ
 * دستگاه‌ها یکسان بماند).
 *
 * حالت‌ها:
 *   idle    — بی‌کار / نگهبانی در جای خود
 *   move    — در حال حرکت روی مسیر A*
 *   attack  — در برد حمله (یا برد ترمیم) و در حال زدن ضربه
 *   retreat — عقب‌نشینی پس از افت جان (پیش از محو شدن)
 *   down    — از میدان بیرون رفته و در حال محو شدن (بدون خون، بدون جسد)
 *
 * گذرهای مجاز تنها از طریق canTransition انجام می‌شود؛ هر گذر نامجاز در
 * شبیه‌ساز نادیده گرفته می‌شود و در حالت توسعه گزارش می‌شود.
 */
export const UNIT_STATE = Object.freeze({
  IDLE: 'idle',
  MOVE: 'move',
  ATTACK: 'attack',
  RETREAT: 'retreat',
  DOWN: 'down',
});

export const FACTION = Object.freeze({
  DEFENDER: 0,
  RAIDER: 1,
});

/** جدول گذرهای مجاز ماشین حالت. */
export const FSM_TRANSITIONS = Object.freeze({
  idle: Object.freeze(['move', 'attack', 'retreat', 'down']),
  move: Object.freeze(['idle', 'move', 'attack', 'retreat', 'down']),
  attack: Object.freeze(['idle', 'move', 'attack', 'retreat', 'down']),
  retreat: Object.freeze(['retreat', 'down']),
  down: Object.freeze([]),
});

export function canTransition(from, to) {
  const allowed = FSM_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

/**
 * Change state and return true when the transition happened.
 * Illegal transitions are refused (the sim then reports them in dev builds).
 */
export function transition(unit, next, reason = '') {
  if (unit.state === next) {
    unit.stateTicks = 0;
    return false;
  }
  if (!canTransition(unit.state, next)) return false;
  unit.state = next;
  unit.stateTicks = 0;
  unit.stateReason = reason;
  return true;
}

/** هدف‌های ممکن برای انتخاب‌گر هدف. */
export const TARGET_KIND = Object.freeze({
  UNIT: 'unit',
  DEFENSE: 'defense',
  WALL: 'wall',
  BUILDING: 'building',
});

/**
 * @param {object} options
 * @param {number} options.id
 * @param {object} options.def — گونهٔ واحد از units.json
 * @param {number} options.faction — FACTION.DEFENDER | FACTION.RAIDER
 * @param {{x:number,z:number}} options.position — world units
 */
export function createUnitRecord({
  id, def, faction, position, hpScale = 1, damageScale = 1, speedScale = 1, priority = null,
}) {
  const maxHp = Math.round(def.hp * hpScale);
  return {
    id,
    type: def.id,
    role: def.role,
    kind: def.kind,
    faction,
    x: position.x,
    z: position.z,
    hp: maxHp,
    maxHp,
    damageScale,
    speedScale,
    /** فهرست اولویت هدف این واحد (می‌تواند با گونهٔ واحد متفاوت باشد). */
    priority,
    state: UNIT_STATE.IDLE,
    stateTicks: 0,
    stateReason: '',
    targetKind: null,
    targetKey: null,
    cooldownTicks: 0,
    path: null,
    pathIndex: 0,
    pathVersion: 0,
    pathAgeTicks: 0,
    goalCell: -1,
    targetCell: -1,
    stallTicks: 0,
    slowFactor: 1,
    slowTicks: 0,
    retaliateId: 0,
    retaliateTicks: 0,
    unreachable: [],
    removed: false,
    damageDealt: 0,
    healingDone: 0,
    damageTaken: 0,
    kills: 0,
  };
}

/** خلاصهٔ واحد برای نمایش/گزارش (فقط خواندنی). */
export function unitSummary(unit) {
  return {
    id: unit.id,
    type: unit.type,
    role: unit.role,
    faction: unit.faction,
    x: unit.x,
    z: unit.z,
    hp: unit.hp,
    maxHp: unit.maxHp,
    state: unit.state,
  };
}

/** فاصلهٔ اقلیدسی بدون hypot (قطعی و ارزان). */
export function distance2d(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return Math.sqrt(dx * dx + dz * dz);
}

export function distanceSq2d(ax, az, bx, bz) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}
