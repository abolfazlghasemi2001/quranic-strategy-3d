/**
 * BattleSim — شبیه‌ساز نبرد قطعی (منطق خالص: بدون Three.js، بدون DOM).
 *
 * قواعد قطعیت:
 *   • گام زمانی ثابت: stepSeconds = 1 / sim.stepHz  (پیش‌فرض ۲۰ گام در ثانیه)
 *   • تنها منبع تصادفی، Rng بذردار core است؛ Math.random هرگز استفاده نمی‌شود.
 *   • هیچ تابع مثلثاتی و هیچ ساعت واقعی (Date.now / performance.now) در منطق نیست
 *     تا نتیجه روی هر مرورگر و هر دستگاهی یکسان بماند.
 *   • ورودی بازیکن فقط «دستور» است و هر دستور با شمارهٔ گام (tick) ثبت می‌شود؛
 *     بازپخش با همان بذر + همان دستورها نتیجهٔ مو‌به‌مو یکسان می‌دهد (چک‌سام‌دار).
 *
 * چرخهٔ هر گام:
 *   ۱) دستورهای سررسیده  ۲) ورود موج‌ها  ۳) شلیک سازه‌های دفاعی
 *   ۴) بازبینی هدف + درخواست مسیر  ۵) پردازش بودجه‌ای مسیرهای A*
 *   ۶) حرکت و نبرد واحدها  ۷) جداسازی برخورد  ۸) بررسی پایان  ۹) چک‌سام
 */
import { Rng } from '../../core/RNG.js';
import { clamp } from '../../core/MathUtils.js';
import { BattleGrid } from './BattleGrid.js';
import { attackCellSet, findPath, nearestFreeCell } from './AStar.js';
import {
  FACTION,
  TARGET_KIND,
  UNIT_STATE,
  canTransition,
  createUnitRecord,
  distance2d,
  distanceSq2d,
  transition,
} from './Unit.js';
import { STRUCTURE_KIND } from './StructureStats.js';

export const BATTLE_EVENT = Object.freeze({
  SPAWN: 'spawn',
  DEPLOY: 'deploy',
  ATTACK: 'attack',
  HEAL: 'heal',
  HIT: 'hit',
  STRUCTURE_HIT: 'structure-hit',
  STRUCTURE_DOWN: 'structure-down',
  WALL_BREACH: 'wall-breach',
  RETREAT: 'retreat',
  UNIT_DOWN: 'unit-down',
  END: 'end',
});

export const BATTLE_RESULT = Object.freeze({
  VICTORY: 'victory',
  DEFEAT: 'defeat',
  TIMEOUT: 'timeout',
  WITHDRAWN: 'withdrawn',
});

const STATE_INDEX = { idle: 0, move: 1, attack: 2, retreat: 3, down: 4 };
const FNV_OFFSET = 2166136261;

/** نرمال‌سازی گونهٔ واحد: اولویت هدف و پیش‌فرض‌ها یک‌جا حل می‌شوند. */
export function normalizeUnitDefs(unitsData) {
  const defaults = unitsData.defaults || {};
  const priorities = unitsData.targetPriority || {};
  const map = new Map();
  for (const raw of unitsData.units) {
    const def = {
      id: raw.id,
      name: raw.name,
      role: raw.role,
      kind: raw.kind,
      hp: raw.hp,
      damage: raw.damage ?? 0,
      healPerSecond: raw.healPerSecond ?? 0,
      attacksPerSecond: Math.max(0.01, raw.attacksPerSecond ?? 1),
      rangeTiles: raw.rangeTiles ?? 1,
      speedTilesPerSecond: raw.speedTilesPerSecond ?? 1,
      radiusTiles: raw.radiusTiles ?? defaults.radiusTiles ?? 0.34,
      housing: raw.housing ?? 1,
      cost: raw.cost || {},
      trainSeconds: raw.trainSeconds ?? 0,
      unitDamageMultiplier: raw.unitDamageMultiplier ?? 1,
      structureDamageMultiplier: raw.structureDamageMultiplier ?? 1,
      splashTiles: raw.splashTiles ?? 0,
      projectile: raw.projectile || null,
      aggroTiles: raw.aggroTiles ?? defaults.aggroTiles ?? 6,
      /** فاصلهٔ دنبال‌کردن هم‌رزم (null = بی‌نهایت: «ترمیم‌گر از ستون جا نمی‌ماند»). */
      followTiles: raw.followTiles ?? defaults.followTiles ?? null,
      repathSeconds: defaults.repathSeconds ?? 0.9,
      separationTiles: defaults.separationTiles ?? 0.44,
      separationStrength: defaults.separationStrength ?? 0.55,
      retreatThreshold: raw.retreatThreshold ?? defaults.retreatThreshold ?? 0.2,
      retreatSeconds: defaults.retreatSeconds ?? 2.4,
      fadeSeconds: defaults.fadeSeconds ?? 1.5,
      stallSeconds: defaults.blockedStallSeconds ?? 1.1,
      priority: priorities[raw.targetPriority] || ['unit', 'building'],
      source: raw,
    };
    map.set(def.id, def);
  }
  return map;
}

export class BattleSim {
  /**
   * @param {object} options
   * @param {object} options.scenario — snapshot کامل آرایش (سازه‌ها، موج‌ها، سپاه)
   * @param {object} options.rules — محتوای battle.json
   * @param {object} options.units — محتوای units.json
   * @param {Map<string,object>} [options.defenseDefs] — تعریف سازه‌های دفاعی (defenses.json)
   * @param {object} [options.structureModifiers]
   */
  constructor({ scenario, rules, units, defenseDefs = new Map(), structureModifiers = { wallBreakerMultiplier: 1 } }) {
    this.scenario = scenario;
    this.rules = rules;
    this.defenseDefs = defenseDefs;
    this.structureModifiers = structureModifiers;

    this.stepHz = rules.sim.stepHz;
    this.stepSeconds = 1 / this.stepHz;
    this.hashEveryTicks = Math.max(1, rules.sim.hashEveryTicks ?? 20);
    this.timeoutTicks = Math.max(1, Math.round((rules.end?.timeoutSeconds ?? 180) * this.stepHz));
    this.defeatDestroyed = rules.end?.defeatDamagedStructures ?? 3;
    this.defeatOnTownCenterDown = rules.end?.defeatOnTownCenterDown !== false;
    this.onlyFreeDeploy = rules.deploy?.onlyOnFreeTiles !== false;
    this.deployLimit = rules.deploy?.maxPerBattle ?? 99;
    this.deployCooldown = rules.deploy?.cooldownTicks ?? 0;
    this.deploySafeTiles = rules.deploy?.minEnemyDistanceTiles ?? 0;
    this.splashFalloff = rules.sim.splashFalloff ?? 0.45;
    this.lineOfSight = rules.sim.lineOfSight !== false;
    this.damageSpread = rules.sim.damageSpread ?? 0;

    this.unitDefs = normalizeUnitDefs(units);
    this.priorityTable = units.targetPriority || {};
    /** پس از آسیب دیدن از یک واحد دشمن، چند گام او را هدف اول می‌گیریم. */
    this.retaliationTicks = Math.max(0, Math.round((rules.retaliation?.seconds ?? 0) * this.stepHz));
    /** تبدیل ثانیه → گام، یک‌بار برای هر گونهٔ واحد. */
    this.defTicks = new Map();
    for (const [id, def] of this.unitDefs) {
      this.defTicks.set(id, {
        repath: Math.max(1, Math.round(def.repathSeconds * this.stepHz)),
        retreat: Math.max(1, Math.round(def.retreatSeconds * this.stepHz)),
        fade: Math.max(1, Math.round(def.fadeSeconds * this.stepHz)),
        stall: Math.max(1, Math.round(def.stallSeconds * this.stepHz)),
        attack: Math.max(1, Math.round(this.stepHz / Math.max(0.01, def.attacksPerSecond))),
      });
    }
    this.defenseTicks = new Map();
    for (const [id, def] of this.defenseDefs) {
      this.defenseTicks.set(id, Math.max(1, Math.round(this.stepHz / Math.max(0.01, def.attacksPerSecond))));
    }

    this.rng = new Rng((scenario.seed ^ 0x9e3779b9) >>> 0);

    this.grid = new BattleGrid({ cols: scenario.cols, rows: scenario.rows, tileSize: scenario.tileSize });
    this.structures = scenario.structures.map((raw) => ({
      index: raw.index,
      sourceId: raw.sourceId,
      type: raw.type,
      kind: raw.kind,
      col: raw.col,
      row: raw.row,
      w: raw.w,
      h: raw.h,
      level: raw.level,
      hp: raw.hp,
      maxHp: raw.maxHp,
      destroyed: false,
      damageTaken: 0,
      cooldownTicks: 0,
      targetId: null,
    }));
    this.structureByIndex = new Map(this.structures.map((s) => [s.index, s]));
    for (const structure of this.structures) this.grid.addStructure(structure);

    this.tileSize = scenario.tileSize;
    this.tickIndex = 0;
    this.done = false;
    this.result = null;
    this.finishTick = 0;

    this.units = [];
    this.unitsById = new Map();
    this.nextUnitId = 1;
    /** دستورهای بازپخش از همان ابتدا در صف می‌نشینند و در گام خودشان اعمال می‌شوند. */
    this.commandQueue = (scenario.commands || []).map((command) => ({ ...command }));
    this.appliedCommands = [];
    this.events = [];
    this.eventHash = FNV_OFFSET >>> 0;
    this.checkpoints = [];
    this.pathQueue = [];
    this.pathCache = new Map();
    this.pathRequests = 0;
    this.pathFailures = 0;
    this.spawnQueue = (scenario.spawns || []).map((spawn) => ({ ...spawn }));
    this.spawnCursor = 0;
    this.garrison = { ...(scenario.garrison || {}) };
    this.deployCount = 0;
    this.deployReadyTick = 0;
    this.stats = {
      raidersSpawned: 0,
      defendersDeployed: 0,
      wallsBreached: 0,
      damageToStructures: 0,
      damageToUnits: 0,
      healed: 0,
    };

    // استقرار خودکار بخشی از سپاه در آغاز نبرد: بخشی از «وضعیت اولیه» است
    // (نه دستور بازیکن) و بنابراین در بازپخش هم عیناً تکرار می‌شود.
    const auto = rules.defender?.autoDeploy;
    if (auto?.enabled) {
      let placed = 0;
      for (const type of Object.keys(this.garrison)) {
        while ((this.garrison[type] || 0) > 0 && placed < (auto.units ?? 0)) {
          const point = this._autoDeployPoint(type, placed);
          if (!point) break;
          const result = this._deployUnit(type, point.x, point.z, true);
          if (!result.ok) break;
          placed += 1;
        }
        if (placed >= (auto.units ?? 0)) break;
      }
    }
  }

  /* ---------------------------------------------------------------- helpers */

  defOf(unit) {
    return this.unitDefs.get(unit.type);
  }

  ticksOf(unit, kind) {
    return this.defTicks.get(unit.type)[kind];
  }

  /**
   * برد مؤثر حمله/ترمیم بر حسب واحد دنیا.
   * شعاع واحد به برد اضافه می‌شود تا «نزدیک‌زن» بتواند از خانهٔ چسبیده به
   * سازه ضربه بزند (مرکز خانه ۱ خانه = tileSize فاصله دارد).
   */
  effectiveRange(unit) {
    const def = this.defOf(unit);
    return (def.rangeTiles + def.radiusTiles) * this.tileSize;
  }

  aliveUnits(faction = null) {
    const out = [];
    for (const unit of this.units) {
      if (unit.removed) continue;
      if (faction !== null && unit.faction !== faction) continue;
      out.push(unit);
    }
    return out;
  }

  countAlive(faction) {
    let total = 0;
    for (const unit of this.units) if (!unit.removed && unit.faction === faction) total += 1;
    return total;
  }

  destroyedStructureCount({ includeWalls = true } = {}) {
    let total = 0;
    for (const structure of this.structures) {
      if (!structure.destroyed) continue;
      if (!includeWalls && structure.kind === STRUCTURE_KIND.WALL) continue;
      total += 1;
    }
    return total;
  }

  damagedStructureCount() {
    let total = 0;
    for (const structure of this.structures) if (structure.hp < structure.maxHp) total += 1;
    return total;
  }

  townCenter() {
    for (const structure of this.structures) if (structure.type === 'town-center') return structure;
    return null;
  }

  /* ----------------------------------------------------------------- events */

  _emit(event) {
    event.tick = this.tickIndex;
    this.events.push(event);
    let hash = this.eventHash;
    for (let i = 0; i < event.type.length; i += 1) hash = Math.imul(hash ^ event.type.charCodeAt(i), 16777619) >>> 0;
    for (const value of eventValues(event)) hash = Math.imul(hash ^ (value | 0), 16777619) >>> 0;
    this.eventHash = hash >>> 0;
  }

  /** رویدادهای ذخیره‌شده را برمی‌گرداند و صف را خالی می‌کند (لایهٔ رندر). */
  drainEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }

  /* --------------------------------------------------------------- commands */

  /**
   * ثبت دستور بازیکن. دستور در گام بعد اعمال می‌شود تا وضعیت هیچ‌گاه میان‌گام
   * تغییر نکند (لازمهٔ بازپخش دقیق).
   * @returns {object|null} دستور مهرشده (برای ضبط) یا null
   */
  queueCommand(command) {
    if (this.done) return null;
    const stamped = { ...command, tick: this.tickIndex + 1, seq: this.commandQueue.length };
    this.commandQueue.push(stamped);
    return stamped;
  }

  /**
   * استقرار یک واحد از پادگان روی نقشه (دستور بازیکن).
   * اعتبارسنجی فوری انجام می‌شود تا رابط کاربری بی‌درنگ پاسخ بگیرد.
   * @returns {{ok:boolean, reason?:string, command?:object}}
   */
  deploy(unitType, x, z) {
    if (this.done) return { ok: false, reason: 'finished' };
    const validation = this._validateDeploy(unitType, x, z);
    if (!validation.ok) return validation;
    const command = this.queueCommand({ type: 'deploy', unit: unitType, x, z });
    if (!command) return { ok: false, reason: 'finished' };
    return { ok: true, command };
  }

  /** آیا استقرار در این نقطه ممکن است؟ (پرسش بی‌اثر، برای نشانگر رابط کاربری) */
  canDeploy(unitType, x, z) {
    if (this.done) return { ok: false, reason: 'finished' };
    return this._validateDeploy(unitType, x, z);
  }

  /** عقب‌نشینی کامل: نبرد با نتیجهٔ withdrawn بسته می‌شود. */
  withdraw() {
    if (this.done) return null;
    return this.queueCommand({ type: 'withdraw' });
  }

  _applyCommands() {
    if (this.commandQueue.length === 0) return;
    const due = [];
    const rest = [];
    for (const command of this.commandQueue) {
      if (command.tick <= this.tickIndex) due.push(command);
      else rest.push(command);
    }
    this.commandQueue = rest;
    for (const command of due) {
      if (command.type === 'deploy') {
        const result = this._deployUnit(command.unit, command.x, command.z, false);
        if (result.ok) this.appliedCommands.push({ ...command, unitId: result.unit.id });
      } else if (command.type === 'withdraw') {
        this.appliedCommands.push({ ...command });
        this._finish(BATTLE_RESULT.WITHDRAWN);
        return;
      }
    }
  }

  /** شمارش دستورهای استقرارِ در انتظار (برای رزرو سهمیه و زمان انتظار). */
  _pendingDeploys() {
    let count = 0;
    for (const command of this.commandQueue) if (command.type === 'deploy') count += 1;
    return count;
  }

  _validateDeploy(unitType, x, z, auto = false) {
    const def = this.unitDefs.get(unitType);
    if (!def) return { ok: false, reason: 'unknown-unit' };
    if ((this.garrison[unitType] || 0) <= 0) return { ok: false, reason: 'no-troops' };
    // استقرار آغازین بخشی از «وضعیت اولیه» است، پس سهمیه و زمان انتظار بازیکن
    // را مصرف نمی‌کند؛ وگرنه تنها واحد اول مستقر می‌شد.
    // دستورِ در انتظار هم سهمیه و زمان انتظار را «رزرو» می‌کند تا رابط
    // کاربری بتواند پیش از اعمال دستور، پاسخ درست بدهد.
    const pending = auto ? 0 : this._pendingDeploys();
    if (!auto && this.deployCount + pending >= this.deployLimit) return { ok: false, reason: 'limit' };
    if (!auto && (pending > 0 || this.tickIndex < this.deployReadyTick)) return { ok: false, reason: 'cooldown' };
    if (!Number.isFinite(x) || !Number.isFinite(z)) return { ok: false, reason: 'invalid' };
    const col = Math.floor(x / this.tileSize);
    const row = Math.floor(z / this.tileSize);
    if (!this.grid.inside(col, row)) return { ok: false, reason: 'outside' };
    if (this.onlyFreeDeploy && !this.grid.isFree(this.grid.index(col, row))) return { ok: false, reason: 'blocked' };
    if (this.deploySafeTiles > 0) {
      const minDistance = this.deploySafeTiles * this.tileSize;
      for (const raider of this.units) {
        if (raider.removed || raider.faction !== FACTION.RAIDER) continue;
        if (distance2d(raider.x, raider.z, x, z) < minDistance) return { ok: false, reason: 'too-close' };
      }
    }
    return { ok: true };
  }

  _deployUnit(unitType, x, z, auto) {
    const validation = this._validateDeploy(unitType, x, z, auto);
    if (!validation.ok) return validation;
    const def = this.unitDefs.get(unitType);
    const cell = this.grid.cellAt(x, z);
    const free = nearestFreeCell(this.grid, cell, 4);
    if (free < 0) return { ok: false, reason: 'blocked' };
    const center = this.grid.center(free);
    const modifiers = this.rules.defender?.modifiers || {};
    const unit = createUnitRecord({
      id: this.nextUnitId++,
      def,
      faction: FACTION.DEFENDER,
      position: center,
      hpScale: modifiers.hp ?? 1,
      damageScale: modifiers.damage ?? 1,
      speedScale: modifiers.speed ?? 1,
    });
    unit.prevX = unit.x;
    unit.prevZ = unit.z;
    this.units.push(unit);
    this.unitsById.set(unit.id, unit);
    this.garrison[unitType] = Math.max(0, (this.garrison[unitType] || 0) - 1);
    if (!auto) {
      this.deployCount += 1;
      this.deployReadyTick = this.tickIndex + this.deployCooldown;
    }
    this.stats.defendersDeployed += 1;
    this._emit({
      type: auto ? BATTLE_EVENT.SPAWN : BATTLE_EVENT.DEPLOY,
      unitId: unit.id,
      unit: unit.type,
      faction: FACTION.DEFENDER,
      x: unit.x,
      z: unit.z,
    });
    return { ok: true, unit };
  }

  _autoDeployPoint(unitType, placed) {
    const town = this.townCenter();
    const spread = Math.round(this.rules.defender?.spreadTiles ?? 2.6);
    const baseCol = town ? town.col + 1 : Math.floor(this.grid.cols / 2);
    const baseRow = town ? town.row - 3 : Math.floor(this.grid.rows / 2);
    const col = clamp(baseCol + ((placed % 5) - 2), 1, this.grid.cols - 2);
    const row = clamp(baseRow - Math.floor(placed / 5), 1, this.grid.rows - 2);
    const cell = nearestFreeCell(this.grid, this.grid.index(col, row), Math.max(2, spread));
    if (cell < 0) return null;
    return this.grid.center(cell);
  }

  /** اولویت هدف مهاجم: از battle.json (attacker.priorityOverride) وگرنه گونهٔ واحد. */
  _raiderPriority(unitType) {
    const override = this.rules.attacker?.priorityOverride || {};
    const name = override[unitType];
    if (!name) return null;
    return this.priorityTable[name] || null;
  }

  /** نقطهٔ پیشنهادی استقرار (رابط کاربری و تست‌ها). */
  autoDeployPoint(unitType, placed = 0) {
    void unitType;
    return this._autoDeployPoint(null, placed);
  }

  /* ----------------------------------------------------------------- spawns */

  _spawnWaves() {
    while (this.spawnCursor < this.spawnQueue.length && this.spawnQueue[this.spawnCursor].tick <= this.tickIndex) {
      const spawn = this.spawnQueue[this.spawnCursor];
      this.spawnCursor += 1;
      const def = this.unitDefs.get(spawn.unit);
      if (!def) continue;
      const modifiers = this.rules.attacker?.modifiers || {};
      const cell = nearestFreeCell(this.grid, this.grid.cellAt(spawn.x, spawn.z), 6);
      if (cell < 0) continue;
      const center = this.grid.center(cell);
      const unit = createUnitRecord({
        id: this.nextUnitId++,
        def,
        faction: FACTION.RAIDER,
        position: center,
        hpScale: modifiers.hp ?? 1,
        damageScale: modifiers.damage ?? 1,
        speedScale: modifiers.speed ?? 1,
        priority: this._raiderPriority(spawn.unit),
      });
      unit.prevX = unit.x;
      unit.prevZ = unit.z;
      this.units.push(unit);
      this.unitsById.set(unit.id, unit);
      this.stats.raidersSpawned += 1;
      this._emit({ type: BATTLE_EVENT.SPAWN, unitId: unit.id, unit: unit.type, faction: FACTION.RAIDER, x: unit.x, z: unit.z });
    }
  }

  /* ------------------------------------------------------------------- path */

  _goalFor(unit, target) {
    if (!target || !target.ref) return null;
    if (target.kind === TARGET_KIND.UNIT) {
      const cell = this.grid.cellAt(target.ref.x, target.ref.z);
      const free = nearestFreeCell(this.grid, cell, 3);
      if (free < 0) return null;
      return { cells: new Set([free]), hint: cell, key: target.key };
    }
    const structure = target.ref;
    const def = this.defOf(unit);
    const raw = attackCellSet(this.grid, structure, def.rangeTiles + def.radiusTiles);
    if (raw.size === 0) return null;
    const cells = new Set();
    for (const cell of raw) {
      if (!this.lineOfSight) {
        cells.add(cell);
        continue;
      }
      const center = this.grid.center(cell);
      // خط دید از همان خانه‌ای که واحد در آن می‌ایستد تا نزدیک‌ترین نقطهٔ سازه
      // سنجیده می‌شود (نه تا مرکز سازه، وگرنه خودِ سازه مانع شمرده می‌شد).
      const point = this._nearestPointOnStructure(center, structure);
      if (this._hasLineOfSight(center.x, center.z, point.x, point.z)) cells.add(cell);
    }
    if (cells.size === 0) return null;
    return { cells, hint: this.grid.index(structure.col, structure.row), key: target.key };
  }

  _requestPath(unit, target) {
    if (unit.pathPending) return false;
    const goal = this._goalFor(unit, target);
    if (!goal) return false;
    const start = nearestFreeCell(this.grid, this.grid.cellAt(unit.x, unit.z), 3);
    if (start < 0) return false;
    const cacheKey = `${start}|${goal.key}|${this.grid.version}|${goal.hint}`;
    const cached = this.pathCache.get(cacheKey);
    if (cached !== undefined) {
      unit.path = cached ? cached.slice() : null;
      unit.pathIndex = 0;
      unit.pathVersion = this.grid.version;
      unit.pathPending = false;
      unit.arrived = false;
      unit.goalCell = goal.hint;
      if (!unit.path) {
        this.pathFailures += 1;
        this._markUnreachable(unit, goal.key);
      }
      return !!unit.path;
    }
    this.pathQueue.push({ unit, start, goal, cacheKey, key: goal.key });
    unit.pathPending = true;
    return false;
  }

  _markUnreachable(unit, key) {
    const until = this.tickIndex + Math.round(3 * this.stepHz);
    const entry = unit.unreachable.find((item) => item.key === key);
    if (entry) entry.until = until;
    else unit.unreachable.push({ key, until });
    if (unit.targetKey === key) {
      unit.targetKey = null;
      unit.targetKind = null;
      unit.targetRef = null;
    }
  }

  _isUnreachable(unit, key) {
    for (let i = unit.unreachable.length - 1; i >= 0; i -= 1) {
      const entry = unit.unreachable[i];
      if (entry.until <= this.tickIndex) {
        unit.unreachable.splice(i, 1);
        continue;
      }
      if (entry.key === key) return true;
    }
    return false;
  }

  _processPaths() {
    const budget = this.rules.sim.pathBudgetPerTick ?? 4;
    let served = 0;
    while (this.pathQueue.length > 0 && served < budget) {
      const request = this.pathQueue.shift();
      served += 1;
      const { unit, start, goal, cacheKey, key } = request;
      if (unit.removed) continue;
      const hint = goal.hint;
      const hintFree = this.grid.isFree(hint) ? hint : nearestFreeCell(this.grid, hint, 3);
      const result = findPath({
        grid: this.grid,
        start,
        isGoal: (index) => goal.cells.has(index),
        goalHint: hintFree >= 0 ? hintFree : -1,
        maxNodes: this.rules.sim.pathMaxNodes ?? 2600,
      });
      this.pathRequests += 1;
      if (this.pathCache.size >= (this.rules.sim.pathCacheLimit ?? 256)) this.pathCache.clear();
      this.pathCache.set(cacheKey, result.path ? result.path.slice() : null);
      unit.pathPending = false;
      if (result.path) {
        unit.path = result.path;
        unit.pathIndex = 0;
        unit.pathVersion = this.grid.version;
        unit.arrived = false;
        unit.goalCell = hint;
      } else {
        this.pathFailures += 1;
        unit.path = null;
        unit.pathVersion = 0;
        this._markUnreachable(unit, key);
      }
    }
  }

  /* ------------------------------------------------------------------ targets */

  /** هدف‌های ممکن یک واحد، مرتب‌شده بر پایهٔ اولویت داده‌محور. */
  _targetCandidates(unit) {
    const def = this.defOf(unit);
    // تلافی: اگر همین چند لحظه پیش از یک واحد دشمن ضربه خورده‌ام، او را
    // بالاتر از هر سازه‌ای می‌گیرم (سدشدن مدافع در برابر ستون مهاجم).
    if (unit.retaliateTicks > 0 && unit.retaliateId) {
      const foe = this.unitsById.get(unit.retaliateId);
      if (foe && !foe.removed && foe.faction !== unit.faction && foe.state !== UNIT_STATE.DOWN) {
        const distanceSq = distanceSq2d(unit.x, unit.z, foe.x, foe.z);
        const aggro = def.aggroTiles * this.tileSize;
        if (distanceSq <= aggro * aggro) {
          return [{ kind: TARGET_KIND.UNIT, key: `u${foe.id}`, ref: foe, rank: 0, distanceSq }];
        }
      }
    }
    const wanted = unit.faction === FACTION.RAIDER
      ? (unit.priority || def.priority)
      : def.priority.filter((kind) => kind === TARGET_KIND.UNIT);
    const aggro = def.aggroTiles * this.tileSize;
    const out = [];

    for (let rank = 0; rank < wanted.length; rank += 1) {
      const kind = wanted[rank];
      if (kind === TARGET_KIND.UNIT) {
        const enemyFaction = unit.faction === FACTION.RAIDER ? FACTION.DEFENDER : FACTION.RAIDER;
        for (const other of this.units) {
          if (other.removed || other.faction !== enemyFaction) continue;
          if (other.state === UNIT_STATE.DOWN) continue;
          const distanceSq = distanceSq2d(unit.x, unit.z, other.x, other.z);
          if (distanceSq > aggro * aggro) continue;
          out.push({ kind, key: `u${other.id}`, ref: other, rank, distanceSq });
        }
        continue;
      }
      for (const structure of this.structures) {
        if (structure.destroyed || structure.kind !== kind) continue;
        out.push({ kind, key: `s${structure.index}`, ref: structure, rank, distanceSq: this._structureDistanceSq(unit, structure) });
      }
    }
    out.sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      if (a.distanceSq !== b.distanceSq) return a.distanceSq - b.distanceSq;
      return a.key < b.key ? -1 : 1;
    });
    return out;
  }

  _selectTarget(unit) {
    if (unit.role === 'support') {
      this._selectSupportTarget(unit);
      return;
    }
    const candidates = this._targetCandidates(unit);
    // بهترین «رتبهٔ» هدف در دسترس تعیین می‌شود؛ ترجیحِ «همین حالا در برد» فقط
    // میان هدف‌هایی با همان رتبه اعمال می‌شود. وگرنه یک دیوارِ نزدیک باعث می‌شد
    // مهاجم برجِ اولویت‌دار را رها کند و همان‌جا دیوار بجود (خطای دور زدن دیوار).
    let chosen = null;
    let chosenRank = -1;
    let inRange = null;
    for (const candidate of candidates) {
      if (this._isUnreachable(unit, candidate.key)) continue;
      if (!chosen) {
        chosen = candidate;
        chosenRank = candidate.rank;
      }
      if (candidate.rank !== chosenRank) break; // مرتب‌شده بر پایهٔ رتبه ⇒ بقیه پایین‌ترند
      if (this._inAttackRange(unit, candidate)) {
        inRange = candidate;
        break;
      }
    }
    if (inRange) chosen = inRange;
    if (!chosen) {
      unit.targetKind = null;
      unit.targetKey = null;
      unit.targetRef = null;
      return;
    }
    if (unit.targetKey !== chosen.key) {
      unit.path = null;
      unit.pathVersion = 0;
      unit.arrived = false;
    }
    unit.targetKind = chosen.kind;
    unit.targetKey = chosen.key;
    unit.targetRef = chosen.ref;
  }

  /**
   * انتخاب هدف ترمیم‌گر:
   *   ۱) هم‌رزم زخمی که همین حالا در برد ترمیم است ⇒ ترمیم فوری
   *   ۲) وگرنه هم‌رزمِ «درگیر» (در حال حرکت/حمله) ⇒ دنبال‌کردن تا برسد
   *   ۳) وگرنه نزدیک‌ترین هم‌رزم غیرپشتیبان ⇒ عقب نماندن از ستون
   * هم‌رزمِ در حال عقب‌نشینی دنبال نمی‌شود (او میدان را ترک می‌کند).
   */
  _selectSupportTarget(unit) {
    const def = this.defOf(unit);
    const range = this.effectiveRange(unit);
    const followLimit = def.followTiles == null ? Infinity : def.followTiles * this.tileSize;
    const followLimitSq = followLimit * followLimit;
    let best = null;
    let engaged = null;
    let engagedDistance = Infinity;
    let mate = null;
    let mateDistance = Infinity;
    for (const ally of this.units) {
      if (ally.removed || ally.faction !== unit.faction || ally.id === unit.id) continue;
      if (ally.state === UNIT_STATE.DOWN || ally.state === UNIT_STATE.RETREAT) continue;
      if (ally.role === 'support' && ally.id !== unit.id && def.role !== 'support') continue;
      const distanceSq = distanceSq2d(unit.x, unit.z, ally.x, ally.z);
      const missing = ally.maxHp - ally.hp;
      if (missing > 0.001 && distanceSq <= range * range) {
        if (!best || distanceSq < best.distanceSq || (distanceSq === best.distanceSq && ally.id < best.ref.id)) {
          best = { kind: TARGET_KIND.UNIT, key: `u${ally.id}`, ref: ally, distanceSq };
        }
      }
      if (ally.role === 'support') continue;
      if (distanceSq > followLimitSq) continue;
      if (ally.state === UNIT_STATE.MOVE || ally.state === UNIT_STATE.ATTACK) {
        if (!engaged || distanceSq < engagedDistance || (distanceSq === engagedDistance && ally.id < engaged.ref.id)) {
          engaged = { kind: TARGET_KIND.UNIT, key: `u${ally.id}`, ref: ally, distanceSq };
          engagedDistance = distanceSq;
        }
      }
      if (!mate || distanceSq < mateDistance || (distanceSq === mateDistance && ally.id < mate.ref.id)) {
        mate = { kind: TARGET_KIND.UNIT, key: `u${ally.id}`, ref: ally, distanceSq };
        mateDistance = distanceSq;
      }
    }
    const chosen = best || engaged || mate;
    if (!chosen) {
      unit.targetKind = null;
      unit.targetKey = null;
      unit.targetRef = null;
      return;
    }
    if (unit.targetKey !== chosen.key) {
      unit.path = null;
      unit.pathVersion = 0;
      unit.arrived = false;
    }
    unit.targetKind = chosen.kind;
    unit.targetKey = chosen.key;
    unit.targetRef = chosen.ref;
  }

  /** نزدیک‌ترین نقطهٔ مستطیل سازه به یک واحد (برای خط دید و برد). */
  _nearestPointOnStructure(unit, structure) {
    const ts = this.tileSize;
    const minX = structure.col * ts;
    const maxX = (structure.col + structure.w) * ts;
    const minZ = structure.row * ts;
    const maxZ = (structure.row + structure.h) * ts;
    return {
      x: clamp(unit.x, minX, maxX),
      z: clamp(unit.z, minZ, maxZ),
    };
  }

  /** نقطهٔ میانی سازه (فقط برای خط دید و رویدادهای تصویری). */
  _structureAnchor(structure) {
    const ts = this.tileSize;
    return {
      x: (structure.col + structure.w / 2) * ts,
      z: (structure.row + structure.h / 2) * ts,
    };
  }

  /**
   * خط دید قطعی: نمونه‌برداری در گام‌های نیم‌خانه‌ای، بدون مثلثات.
   * خانهٔ مبدأ و خانهٔ هدف مستثنا هستند تا خودِ سازهٔ هدف مانع شمرده نشود.
   */
  _hasLineOfSight(ax, az, bx, bz) {
    const ts = this.tileSize;
    const dx = bx - ax;
    const dz = bz - az;
    const distance = Math.sqrt(dx * dx + dz * dz);
    if (distance < 1e-6) return true;
    const steps = Math.max(1, Math.ceil(distance / (ts * 0.5)));
    const startCell = this.grid.cellAt(ax, az);
    const endCell = this.grid.cellAt(bx, bz);
    for (let i = 1; i < steps; i += 1) {
      const t = i / steps;
      const cell = this.grid.cellAt(ax + dx * t, az + dz * t);
      if (cell === startCell || cell === endCell) continue;
      if (this.grid.isBlocked(cell)) return false;
    }
    return true;
  }

  _structureDistanceSq(unit, structure) {
    const ts = this.tileSize;
    const minX = structure.col * ts;
    const maxX = (structure.col + structure.w) * ts;
    const minZ = structure.row * ts;
    const maxZ = (structure.row + structure.h) * ts;
    const dx = Math.max(minX - unit.x, 0, unit.x - maxX);
    const dz = Math.max(minZ - unit.z, 0, unit.z - maxZ);
    return dx * dx + dz * dz;
  }

  _structureDistance(unit, structure) {
    return Math.sqrt(this._structureDistanceSq(unit, structure));
  }

  _inAttackRange(unit, candidate) {
    if (!candidate || !candidate.ref) return false;
    const range = this.effectiveRange(unit);
    if (candidate.kind === TARGET_KIND.UNIT) {
      const target = candidate.ref;
      if (target.removed || (target.state === UNIT_STATE.DOWN && unit.role !== 'support')) return false;
      // ترمیم‌گر فقط وقتی «در برد» است که زخمی برای ترمیم باشد؛ وگرنه باید
      // حرکت کند و به ستون برسد، نه اینکه کنار هم‌رزمِ سالم بایستد.
      if (unit.role === 'support' && target.maxHp - target.hp <= 0.001) return false;
      if (distanceSq2d(unit.x, unit.z, target.x, target.z) > range * range) return false;
      if (!this.lineOfSight) return true;
      return this._hasLineOfSight(unit.x, unit.z, target.x, target.z);
    }
    const structure = candidate.ref;
    if (this._structureDistance(unit, structure) > range) return false;
    // دیوار هم مستثنا نیست: وگرنه مهاجم از بیرون حلقه، دیوارِ آن‌سوی شهر را
    // می‌زد (تیر از میان دیوار). برای دیوارِ چسبیده، خط دید خودبه‌خود برقرار است.
    if (!this.lineOfSight) return true;
    const point = this._nearestPointOnStructure(unit, structure);
    return this._hasLineOfSight(unit.x, unit.z, point.x, point.z);
  }

  /** بازبینی هدف و درخواست مسیر برای همهٔ واحدها (به ترتیب شناسه = قطعی). */
  _refreshTargets() {
    for (const unit of this.units) {
      if (unit.removed || unit.state === UNIT_STATE.DOWN || unit.state === UNIT_STATE.RETREAT) continue;
      unit.pathAgeTicks += 1;
      const repath = this.ticksOf(unit, 'repath');
      const targetGone = !unit.targetKey || !unit.targetRef || unit.targetRef.removed;
      const refreshDue = unit.pathAgeTicks % repath === 0;
      if (targetGone || refreshDue) this._selectTarget(unit);

      // «رسیدم ولی به برد حمله نرسیدم»: یا مسیر دوباره خواسته می‌شود، یا اگر
      // چند بار پیاپی تکرار شد هدف دست‌نیافتنی علامت می‌خورد تا واحد سرگردان نشود.
      const resolved = this._resolveTarget(unit);
      if (unit.arrived && resolved && !this._inAttackRange(unit, resolved)) {
        unit.noProgress = (unit.noProgress || 0) + 1;
        unit.arrived = false;
        if (unit.noProgress >= 3) {
          unit.noProgress = 0;
          this._markUnreachable(unit, unit.targetKey);
        }
      } else if (unit.noProgress) {
        unit.noProgress = 0;
      }

      if (unit.stallTicks >= this.ticksOf(unit, 'stall')) {
        unit.stallTicks = 0;
        unit.path = null;
        unit.arrived = false;
      }
      const versionChanged = unit.pathVersion !== this.grid.version;
      const needsPath = !!unit.targetKey && !unit.path && !unit.pathPending && (!unit.arrived || refreshDue);
      if (unit.targetKey && (versionChanged || needsPath)) {
        this._requestPath(unit, { kind: unit.targetKind, key: unit.targetKey, ref: unit.targetRef });
      }
    }
  }

  /* -------------------------------------------------------------- defenses */

  _stepDefenses() {
    const raiders = this.aliveUnits(FACTION.RAIDER);
    if (raiders.length === 0) return;
    for (const structure of this.structures) {
      if (structure.kind !== STRUCTURE_KIND.DEFENSE || structure.destroyed) continue;
      const defenseDef = this.defenseDefs.get(structure.type);
      if (!defenseDef) continue;
      if (structure.cooldownTicks > 0) {
        structure.cooldownTicks -= 1;
        continue;
      }
      const target = this._pickDefenseTarget(structure, defenseDef, raiders);
      if (!target) continue;
      structure.cooldownTicks = this.defenseTicks.get(structure.type) ?? 1;
      structure.targetId = target.id;
      const origin = this.grid.center(this.grid.index(
        clamp(structure.col + Math.floor(structure.w / 2), 0, this.grid.cols - 1),
        clamp(structure.row + Math.floor(structure.h / 2), 0, this.grid.rows - 1),
      ));
      this._emit({
        type: BATTLE_EVENT.ATTACK,
        source: `s${structure.index}`,
        fromX: origin.x,
        fromZ: origin.z,
        toX: target.x,
        toZ: target.z,
        projectile: defenseDef.projectile || null,
        amount: round2(defenseDef.damage),
      });
      this._damageUnit(target, defenseDef.damage, null);
      const splash = defenseDef.splashTiles ?? 0;
      if (splash > 0) {
        const radius = splash * this.tileSize;
        for (const other of raiders) {
          if (other.id === target.id || other.removed) continue;
          const distance = distance2d(other.x, other.z, target.x, target.z);
          if (distance > radius) continue;
          this._damageUnit(other, defenseDef.damage * (1 - this.splashFalloff * (distance / radius)), null);
        }
      }
      const slow = defenseDef.slow;
      if (slow && slow.factor < 1) {
        const ticks = Math.max(1, Math.round(slow.seconds * this.stepHz));
        this._applySlow(target, slow.factor, ticks);
        if (splash > 0) {
          const radius = splash * this.tileSize;
          for (const other of raiders) {
            if (other.id === target.id || other.removed) continue;
            if (distance2d(other.x, other.z, target.x, target.z) <= radius) this._applySlow(other, slow.factor, ticks);
          }
        }
      }
    }
  }

  _pickDefenseTarget(structure, defenseDef, raiders) {
    const ts = this.tileSize;
    const range = defenseDef.rangeTiles * ts;
    let best = null;
    for (const unit of raiders) {
      if (unit.removed || unit.state === UNIT_STATE.DOWN) continue;
      // برد از «نزدیک‌ترین نقطهٔ سازه» سنجیده می‌شود — همان قراردادی که مهاجمان
      // برای برد حمله دارند؛ وگرنه کماندار از لبهٔ برج بیرون از بردِ برج می‌ایستاد
      // و برج هرگز شلیک نمی‌کرد.
      const edge = this._nearestPointOnStructure(unit, structure);
      const distanceSq = distanceSq2d(unit.x, unit.z, edge.x, edge.z);
      if (distanceSq > range * range) continue;
      const ratio = unit.hp / unit.maxHp;
      const score = defenseDef.targetOrder === 'weakest' ? ratio : defenseDef.targetOrder === 'strongest' ? -ratio : distanceSq;
      if (
        !best
        || score < best.score
        || (score === best.score && (distanceSq < best.distanceSq || (distanceSq === best.distanceSq && unit.id < best.unit.id)))
      ) {
        best = { unit, score, distanceSq };
      }
    }
    return best ? best.unit : null;
  }

  _applySlow(unit, factor, ticks) {
    if (!unit || unit.removed) return;
    if (factor < unit.slowFactor) unit.slowFactor = factor;
    if (ticks > unit.slowTicks) unit.slowTicks = ticks;
  }

  /* ------------------------------------------------------------------- units */

  /**
   * «ستون شکسته»: هیچ رزمندهٔ مهاجمی نمانده. ترمیم‌گرِ مهاجم بی‌همرزم نمی‌ماند و
   * از میدان بیرون می‌رود تا نبرد به سرانجام برسد (پیروزی دفاعی، بدون خون‌ریزی).
   */
  _raiderColumnBroken() {
    if (this.rules.attacker?.supportRetreatsWhenColumnBroken === false) return false;
    for (const other of this.units) {
      if (other.removed || other.faction !== FACTION.RAIDER) continue;
      if (other.role === 'support' || other.state === UNIT_STATE.DOWN) continue;
      return false;
    }
    return true;
  }

  _stepUnits(dt) {
    const columnBroken = this._raiderColumnBroken();
    for (const unit of this.units) {
      if (unit.removed) continue;
      unit.stateTicks += 1;
      if (unit.cooldownTicks > 0) unit.cooldownTicks -= 1;
      if (unit.retaliateTicks > 0) unit.retaliateTicks -= 1;
      if (unit.slowTicks > 0) {
        unit.slowTicks -= 1;
        if (unit.slowTicks === 0) unit.slowFactor = 1;
      }
      if (unit.state === UNIT_STATE.DOWN) {
        if (unit.stateTicks >= this.ticksOf(unit, 'fade')) unit.removed = true;
        continue;
      }
      if (unit.state === UNIT_STATE.RETREAT) {
        this._retreatStep(unit, dt);
        if (unit.stateTicks >= this.ticksOf(unit, 'retreat')) {
          transition(unit, UNIT_STATE.DOWN, 'retreat-complete');
          this._emit({ type: BATTLE_EVENT.UNIT_DOWN, unitId: unit.id, unit: unit.type, faction: unit.faction, x: unit.x, z: unit.z });
        }
        continue;
      }
      if (columnBroken && unit.role === 'support' && unit.faction === FACTION.RAIDER) {
        transition(unit, UNIT_STATE.RETREAT, 'column-broken');
        this._emit({ type: BATTLE_EVENT.RETREAT, unitId: unit.id, unit: unit.type, faction: unit.faction, x: unit.x, z: unit.z });
        continue;
      }
      if (unit.hp <= unit.maxHp * this.defOf(unit).retreatThreshold) {
        transition(unit, UNIT_STATE.RETREAT, 'low-health');
        this._emit({ type: BATTLE_EVENT.RETREAT, unitId: unit.id, unit: unit.type, faction: unit.faction, x: unit.x, z: unit.z });
        continue;
      }

      const target = this._resolveTarget(unit);
      if (!target) {
        transition(unit, UNIT_STATE.IDLE, 'no-target');
        continue;
      }
      if (this._inAttackRange(unit, target)) {
        transition(unit, UNIT_STATE.ATTACK, 'in-range');
        this._attackTarget(unit, target);
        continue;
      }
      transition(unit, UNIT_STATE.MOVE, 'chasing');
      this._advance(unit, dt);
    }
  }

  _resolveTarget(unit) {
    if (!unit.targetKey) return null;
    if (unit.targetKind === TARGET_KIND.UNIT) {
      const target = this.unitsById.get(Number(unit.targetKey.slice(1)));
      if (!target || target.removed) return null;
      if (unit.role === 'support') {
        // ترمیم‌گر هم‌رزم خودش را هدف می‌گیرد؛ هدفِ دشمن برایش معنا ندارد.
        if (target.faction !== unit.faction) return null;
        return { kind: TARGET_KIND.UNIT, key: unit.targetKey, ref: target };
      }
      if (target.faction === unit.faction) return null;
      if (target.state === UNIT_STATE.DOWN) return null;
      return { kind: TARGET_KIND.UNIT, key: unit.targetKey, ref: target };
    }
    const structure = this.structureByIndex.get(Number(unit.targetKey.slice(1)));
    if (!structure || structure.destroyed) return null;
    return { kind: structure.kind, key: unit.targetKey, ref: structure };
  }

  _retreatStep(unit, dt) {
    const def = this.defOf(unit);
    const speed = def.speedTilesPerSecond * this.tileSize * unit.speedScale * unit.slowFactor * dt;
    const enemyFaction = unit.faction === FACTION.RAIDER ? FACTION.DEFENDER : FACTION.RAIDER;
    let nearest = null;
    let nearestSq = Infinity;
    for (const other of this.units) {
      if (other.removed || other.faction !== enemyFaction) continue;
      const distanceSq = distanceSq2d(unit.x, unit.z, other.x, other.z);
      if (distanceSq < nearestSq) {
        nearestSq = distanceSq;
        nearest = other;
      }
    }
    if (!nearest) return;
    const dx = unit.x - nearest.x;
    const dz = unit.z - nearest.z;
    const length = Math.sqrt(dx * dx + dz * dz);
    if (length < 1e-6) return;
    this._moveTo(unit, unit.x + (dx / length) * speed, unit.z + (dz / length) * speed);
  }

  _advance(unit, dt) {
    const def = this.defOf(unit);
    if (!unit.path || unit.pathIndex >= unit.path.length) {
      unit.path = null;
      unit.arrived = true;
      unit.stallTicks += 1;
      return;
    }
    const waypoint = this.grid.center(unit.path[unit.pathIndex]);
    const dx = waypoint.x - unit.x;
    const dz = waypoint.z - unit.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    const speed = def.speedTilesPerSecond * this.tileSize * unit.speedScale * unit.slowFactor * dt;
    const before = { x: unit.x, z: unit.z };
    if (distance <= Math.max(speed, 0.06)) {
      this._moveTo(unit, waypoint.x, waypoint.z);
      unit.pathIndex += 1;
      if (unit.pathIndex >= unit.path.length) {
        unit.path = null;
        unit.arrived = true;
      }
      unit.stallTicks = 0;
      return;
    }
    this._moveTo(unit, unit.x + (dx / distance) * speed, unit.z + (dz / distance) * speed);
    if (Math.abs(unit.x - before.x) < 1e-9 && Math.abs(unit.z - before.z) < 1e-9) unit.stallTicks += 1;
    else unit.stallTicks = 0;
  }

  _moveTo(unit, x, z) {
    const ts = this.tileSize;
    const col = clamp(Math.floor(x / ts), 0, this.grid.cols - 1);
    const row = clamp(Math.floor(z / ts), 0, this.grid.rows - 1);
    if (!this.grid.isFree(this.grid.index(col, row))) return; // هرگز داخل سازه نمی‌رود
    unit.x = clamp(x, ts * 0.05, this.grid.cols * ts - ts * 0.05);
    unit.z = clamp(z, ts * 0.05, this.grid.rows * ts - ts * 0.05);
  }

  _attackTarget(unit, target) {
    const def = this.defOf(unit);
    if (unit.cooldownTicks > 0) return;
    unit.cooldownTicks = this.ticksOf(unit, 'attack');
    if (unit.role === 'support') {
      this._healAlly(unit, target.ref);
      return;
    }
    const base = def.damage * unit.damageScale;
    if (target.kind === TARGET_KIND.UNIT) {
      const amount = base * def.unitDamageMultiplier;
      this._emit({
        type: BATTLE_EVENT.ATTACK,
        source: `u${unit.id}`,
        fromX: unit.x,
        fromZ: unit.z,
        toX: target.ref.x,
        toZ: target.ref.z,
        projectile: def.projectile,
        amount: round2(amount),
      });
      this._damageUnit(target.ref, amount, unit);
      if (def.splashTiles > 0) this._splashUnits(unit, target.ref, base, def.splashTiles);
      return;
    }
    const structure = target.ref;
    let amount = base * def.structureDamageMultiplier;
    if (structure.kind === STRUCTURE_KIND.WALL && def.kind === 'siege') {
      amount *= this.structureModifiers.wallBreakerMultiplier ?? 1;
    }
    const center = this.grid.center(this.grid.index(
      clamp(structure.col + Math.floor(structure.w / 2), 0, this.grid.cols - 1),
      clamp(structure.row + Math.floor(structure.h / 2), 0, this.grid.rows - 1),
    ));
    this._emit({
      type: BATTLE_EVENT.ATTACK,
      source: `u${unit.id}`,
      fromX: unit.x,
      fromZ: unit.z,
      toX: center.x,
      toZ: center.z,
      projectile: def.projectile,
      amount: round2(amount),
    });
    this._damageStructure(structure, amount, unit);
  }

  _splashUnits(unit, primary, baseDamage, splashTiles) {
    if (!primary) return;
    const def = this.defOf(unit);
    const radius = splashTiles * this.tileSize;
    const enemyFaction = unit.faction === FACTION.RAIDER ? FACTION.DEFENDER : FACTION.RAIDER;
    for (const other of this.units) {
      if (other.removed || other.faction !== enemyFaction || other.id === primary.id) continue;
      const distance = distance2d(other.x, other.z, primary.x, primary.z);
      if (distance > radius) continue;
      const factor = 1 - this.splashFalloff * (distance / radius);
      this._damageUnit(other, baseDamage * def.unitDamageMultiplier * factor, unit);
    }
  }

  _healAlly(unit, ally) {
    if (!ally || ally.removed) return;
    const def = this.defOf(unit);
    const amount = (def.healPerSecond / def.attacksPerSecond) * unit.damageScale;
    const healed = Math.min(amount, ally.maxHp - ally.hp);
    if (healed <= 0) return;
    ally.hp += healed;
    unit.healingDone += healed;
    this.stats.healed += healed;
    this._emit({
      type: BATTLE_EVENT.HEAL,
      source: `u${unit.id}`,
      unitId: ally.id,
      fromX: unit.x,
      fromZ: unit.z,
      toX: ally.x,
      toZ: ally.z,
      amount: round2(healed),
    });
  }

  _damageUnit(target, amount, source) {
    if (!target || target.removed || amount <= 0) return;
    const scaled = this.damageSpread > 0 ? amount * (1 + this.damageSpread * (2 * this.rng.next() - 1)) : amount;
    target.hp -= scaled;
    target.damageTaken += scaled;
    if (source) source.damageDealt += scaled;
    if (source && this.retaliationTicks > 0 && source.faction !== target.faction) {
      target.retaliateId = source.id;
      target.retaliateTicks = this.retaliationTicks;
    }
    this.stats.damageToUnits += scaled;
    this._emit({ type: BATTLE_EVENT.HIT, unitId: target.id, x: target.x, z: target.z, amount: round2(scaled), faction: target.faction });
    if (target.hp <= 0 && target.state !== UNIT_STATE.RETREAT && target.state !== UNIT_STATE.DOWN) {
      target.hp = 0;
      // «رانده‌شده از میدان» = از دست رفته؛ کسی که پیش از افتادن عقب می‌کشد
      // به پادگان برمی‌گردد (واحد.defeated تنها برای hp صفر علامت می‌خورد).
      target.defeated = true;
      if (source) source.kills += 1;
      // شکست = عقب‌نشینی و محو شدن؛ بدون خون و بدون جسد.
      if (canTransition(target.state, UNIT_STATE.RETREAT)) {
        transition(target, UNIT_STATE.RETREAT, 'defeated');
        this._emit({ type: BATTLE_EVENT.RETREAT, unitId: target.id, unit: target.type, faction: target.faction, x: target.x, z: target.z });
      } else {
        transition(target, UNIT_STATE.DOWN, 'defeated');
        this._emit({ type: BATTLE_EVENT.UNIT_DOWN, unitId: target.id, unit: target.type, faction: target.faction, x: target.x, z: target.z });
      }
    }
  }

  _damageStructure(structure, amount, source) {
    if (!structure || structure.destroyed || amount <= 0) return;
    structure.hp -= amount;
    structure.damageTaken += amount;
    if (source) source.damageDealt += amount;
    this.stats.damageToStructures += amount;
    const center = this.grid.center(this.grid.index(
      clamp(structure.col + Math.floor(structure.w / 2), 0, this.grid.cols - 1),
      clamp(structure.row + Math.floor(structure.h / 2), 0, this.grid.rows - 1),
    ));
    this._emit({
      type: BATTLE_EVENT.STRUCTURE_HIT,
      structure: structure.index,
      structureType: structure.type,
      x: center.x,
      z: center.z,
      hp: Math.max(0, Math.round(structure.hp)),
      maxHp: structure.maxHp,
      amount: round2(amount),
    });
    if (structure.hp <= 0) {
      structure.hp = 0;
      structure.destroyed = true;
      this._emit({ type: BATTLE_EVENT.STRUCTURE_DOWN, structure: structure.index, structureType: structure.type, x: center.x, z: center.z });
      const breached = this.grid.freeStructure(structure);
      if (breached) {
        this.stats.wallsBreached += 1;
        this._emit({ type: BATTLE_EVENT.WALL_BREACH, structure: structure.index, x: center.x, z: center.z });
      }
    }
  }

  /* -------------------------------------------------------------- separation */

  _applySeparation() {
    const iterations = this.rules.sim.separationIterations ?? 1;
    if (iterations <= 0) return;
    const live = this.aliveUnits();
    if (live.length < 2) return;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      for (let i = 0; i < live.length; i += 1) {
        const a = live[i];
        if (a.removed || a.state === UNIT_STATE.DOWN) continue;
        const defA = this.defOf(a);
        for (let j = i + 1; j < live.length; j += 1) {
          const b = live[j];
          if (b.removed || b.state === UNIT_STATE.DOWN) continue;
          const defB = this.defOf(b);
          const minDistance = ((defA.separationTiles + defB.separationTiles) * 0.5) * this.tileSize;
          const dx = b.x - a.x;
          const dz = b.z - a.z;
          const distanceSq = dx * dx + dz * dz;
          if (distanceSq >= minDistance * minDistance) continue;
          let nx;
          let nz;
          let distance = Math.sqrt(distanceSq);
          if (distance < 1e-6) {
            nx = 1; // جهت ثابت و قطعی، نه تصادفی
            nz = 0;
            distance = 0;
          } else {
            nx = dx / distance;
            nz = dz / distance;
          }
          const push = (minDistance - distance) * 0.5 * defA.separationStrength;
          this._moveTo(a, a.x - nx * push, a.z - nz * push);
          this._moveTo(b, b.x + nx * push, b.z + nz * push);
        }
      }
    }
  }

  /* --------------------------------------------------------------- lifecycle */

  tick() {
    if (this.done) return this;
    this.tickIndex += 1;
    for (const unit of this.units) {
      unit.prevX = unit.x;
      unit.prevZ = unit.z;
    }
    this._applyCommands();
    if (this.done) return this;
    this._spawnWaves();
    this._stepDefenses();
    this._refreshTargets();
    this._processPaths();
    this._stepUnits(this.stepSeconds);
    this._applySeparation();
    this._checkEnd();
    if (this.tickIndex % this.hashEveryTicks === 0) this._checkpoint();
    return this;
  }

  /** اجرای n گام پیاپی (تست‌ها و بازپخش). */
  runTicks(count) {
    for (let i = 0; i < count && !this.done; i += 1) this.tick();
    return this;
  }

  /** اجرای نبرد تا پایان یا سقف گام‌ها. */
  runToEnd(maxTicks = this.rules.sim.maxTicks ?? 6000) {
    let guard = 0;
    while (!this.done && guard < maxTicks) {
      this.tick();
      guard += 1;
    }
    if (!this.done) this._finish(BATTLE_RESULT.TIMEOUT);
    return this;
  }

  _checkEnd() {
    if (this.done) return;
    if (this.spawnCursor >= this.spawnQueue.length && this.countAlive(FACTION.RAIDER) === 0) {
      this._finish(BATTLE_RESULT.VICTORY);
      return;
    }
    // شکست دفاعی = از کار افتادن سازه‌های اصلی؛ شکستن دیوار خودش شکست نیست.
    if (this.destroyedStructureCount({ includeWalls: false }) >= this.defeatDestroyed) {
      this._finish(BATTLE_RESULT.DEFEAT);
      return;
    }
    if (this.defeatOnTownCenterDown) {
      const town = this.townCenter();
      if (town && town.destroyed) {
        this._finish(BATTLE_RESULT.DEFEAT);
        return;
      }
    }
    if (this.tickIndex >= this.timeoutTicks) this._finish(BATTLE_RESULT.TIMEOUT);
  }

  _finish(result) {
    if (this.done) return;
    this.done = true;
    this.result = result;
    this.finishTick = this.tickIndex;
    this._checkpoint();
    this._emit({ type: BATTLE_EVENT.END, result });
  }

  /* -------------------------------------------------------- hash and report */

  _checkpoint() {
    const hash = this.hashState();
    const last = this.checkpoints[this.checkpoints.length - 1];
    if (last && last.tick === this.tickIndex && last.hash === hash) return;
    this.checkpoints.push({ tick: this.tickIndex, hash });
    const limit = this.rules.sim.checkpointLimit ?? 140;
    while (this.checkpoints.length > limit) this.checkpoints.splice(1, 1);
  }

  /** چک‌سام وضعیت: مبنای اعتبارسنجی بازپخش (سرور می‌تواند همان را بسازد). */
  hashState() {
    let hash = FNV_OFFSET >>> 0;
    hash = mixInt(hash, this.tickIndex);
    hash = mixInt(hash, this.units.length);
    for (const unit of this.units) {
      hash = mixInt(hash, unit.id);
      hash = mixInt(hash, Math.round(unit.x * 1000));
      hash = mixInt(hash, Math.round(unit.z * 1000));
      hash = mixInt(hash, Math.round(unit.hp * 10));
      hash = mixInt(hash, STATE_INDEX[unit.state] ?? 0);
      hash = mixInt(hash, unit.removed ? 1 : 0);
      hash = mixInt(hash, unit.retaliateId || 0);
      hash = mixInt(hash, unit.retaliateTicks || 0);
    }
    for (const structure of this.structures) {
      hash = mixInt(hash, structure.index);
      hash = mixInt(hash, Math.round(structure.hp * 10));
      hash = mixInt(hash, structure.destroyed ? 1 : 0);
    }
    return hash >>> 0;
  }

  report() {
    const lost = {};
    const left = {};
    for (const unit of this.units) {
      const key = `${unit.faction === FACTION.RAIDER ? 'raider' : 'defender'}:${unit.type}`;
      if (unit.removed) lost[key] = (lost[key] || 0) + 1;
      else left[key] = (left[key] || 0) + 1;
    }
    return {
      result: this.result,
      ticks: this.finishTick || this.tickIndex,
      seconds: Math.round(((this.finishTick || this.tickIndex) / this.stepHz) * 10) / 10,
      stateHash: this.hashState(),
      eventHash: this.eventHash >>> 0,
      raidersSpawned: this.stats.raidersSpawned,
      raidersLeft: this.countAlive(FACTION.RAIDER),
      defendersLeft: this.countAlive(FACTION.DEFENDER),
      defendersDeployed: this.stats.defendersDeployed,
      wallsBreached: this.stats.wallsBreached,
      destroyedStructures: this.destroyedStructureCount(),
      damagedStructures: this.damagedStructureCount(),
      healed: Math.round(this.stats.healed),
      pathRequests: this.pathRequests,
      pathFailures: this.pathFailures,
      commands: this.appliedCommands.length,
      lost,
      left,
      structures: this.structures
        .filter((structure) => structure.hp < structure.maxHp)
        .map((structure) => ({
          sourceId: structure.sourceId,
          type: structure.type,
          hp: Math.round(structure.hp),
          maxHp: structure.maxHp,
          destroyed: structure.destroyed,
        })),
      checkpoints: this.checkpoints.length,
    };
  }

  /** وضعیت زندهٔ واحدها برای لایهٔ رندر (فقط خواندنی). */
  liveUnits(faction = null) {
    return this.aliveUnits(faction);
  }

  get progress() {
    const total = this.spawnQueue.length;
    return total === 0 ? 1 : this.spawnCursor / total;
  }
}

/* ------------------------------------------------------------------ helpers */

function mixInt(hash, value) {
  return Math.imul(hash ^ (value | 0), 16777619) >>> 0;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function eventValues(event) {
  const values = [];
  for (const [key, value] of Object.entries(event)) {
    if (key === 'type' || key === 'tick') continue;
    if (typeof value === 'number') values.push(Math.round(value * 100));
    else if (typeof value === 'string') {
      let hash = 0;
      for (let i = 0; i < value.length; i += 1) hash = (Math.imul(hash, 31) + value.charCodeAt(i)) | 0;
      values.push(hash);
    }
  }
  return values;
}
