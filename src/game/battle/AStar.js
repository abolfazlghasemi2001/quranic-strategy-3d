/**
 * AStar — مسیریابی قطعی روی شبکهٔ نبرد (منطق خالص).
 *
 * ویژگی‌های مهم:
 *   • بدون تابع مثلثاتی و بدون Math.random ⇒ نتیجه روی هر دستگاهی یکسان است
 *     (فقط جمع/ضرب/تقسیم و Math.sqrt که در IEEE754 دقیق گرد می‌شود).
 *   • گره‌ها با (f, h, ترتیب درج) مقایسه می‌شوند ⇒ هیچ ابهامی در انتخاب
 *     گره‌های هم‌امتیاز وجود ندارد.
 *   • چند هدف پشتیبانی می‌شود: «خانه‌های اطراف یک سازه» = نقاط رسیدن به برد حمله.
 *   • هیوریستیک octile به «نزدیک‌ترین خانهٔ هدف نسبت به مبدأ» است؛ برای هدف تکی
 *     دقیقاً admissible است و برای خوشهٔ هدف‌های چسبیده هم مسیر درست می‌دهد.
 */
import { NEIGHBOR_OFFSETS } from './BattleGrid.js';

const SQRT2 = Math.SQRT2;

/** Heap دودویی با ترتیب قطعی: f، سپس h، سپس شمارهٔ درج. */
export class BinaryHeap {
  constructor() {
    this.items = [];
    this.seq = 0;
  }

  get size() {
    return this.items.length;
  }

  _less(a, b) {
    if (a.f !== b.f) return a.f < b.f;
    if (a.h !== b.h) return a.h < b.h;
    return a.seq < b.seq;
  }

  push(item) {
    item.seq = this.seq++;
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this._less(this.items[i], this.items[parent])) {
        const tmp = this.items[i];
        this.items[i] = this.items[parent];
        this.items[parent] = tmp;
        i = parent;
      } else break;
    }
  }

  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.items.length && this._less(this.items[left], this.items[smallest])) smallest = left;
        if (right < this.items.length && this._less(this.items[right], this.items[smallest])) smallest = right;
        if (smallest === i) break;
        const tmp = this.items[i];
        this.items[i] = this.items[smallest];
        this.items[smallest] = tmp;
        i = smallest;
      }
    }
    return top;
  }
}

/** هیوریستیک octile (بدون مثلثات). */
export function octile(a, b, cols) {
  const dx = Math.abs((a % cols) - (b % cols));
  const dy = Math.abs(Math.floor(a / cols) - Math.floor(b / cols));
  const min = dx < dy ? dx : dy;
  const max = dx < dy ? dy : dx;
  return (max - min) + SQRT2 * min;
}

/* --------------------------------------------------------------- scratch */

const scratch = { size: 0, gScore: null, cameFrom: null, stamp: null, stampValue: 0, open: new BinaryHeap() };

function ensureScratch(size) {
  if (scratch.size >= size && scratch.gScore) return;
  scratch.size = size;
  scratch.gScore = new Float64Array(size);
  scratch.cameFrom = new Int32Array(size);
  scratch.stamp = new Int32Array(size);
  scratch.stampValue = 0;
}

/**
 * @param {object} options
 * @param {import('./BattleGrid.js').BattleGrid} options.grid
 * @param {number} options.start — cell index (must be free)
 * @param {(index:number)=>boolean} options.isGoal
 * @param {number} [options.goalHint] — cell index used for the octile heuristic
 * @param {number} [options.maxNodes]
 * @returns {{path:number[]|null, expanded:number, found:boolean}}
 *          path includes the start cell and ends on a goal cell
 */
export function findPath({ grid, start, isGoal, goalHint = -1, maxNodes = 2600 }) {
  if (!Number.isInteger(start) || start < 0 || start >= grid.size) return { path: null, expanded: 0, found: false };
  if (grid.isBlocked(start)) return { path: null, expanded: 0, found: false };
  if (isGoal(start)) return { path: [start], expanded: 0, found: true };

  ensureScratch(grid.size);
  const { gScore, cameFrom, stamp } = scratch;
  const stampValue = ++scratch.stampValue;
  const open = scratch.open;
  open.items.length = 0;
  open.seq = 0;

  stamp[start] = stampValue;
  gScore[start] = 0;
  cameFrom[start] = -1;
  open.push({ index: start, g: 0, h: goalHint >= 0 ? octile(start, goalHint, grid.cols) : 0, f: 0 });

  let expanded = 0;
  const neighborBuffer = [];

  while (open.size > 0) {
    const current = open.pop();
    if (isGoal(current.index)) {
      const path = [];
      let node = current.index;
      while (node !== -1) {
        path.push(node);
        node = cameFrom[node];
      }
      path.reverse();
      return { path, expanded, found: true };
    }
    if (expanded >= maxNodes) break;
    expanded += 1;

    const currentG = gScore[current.index];
    grid.neighbors(current.index, neighborBuffer);
    for (const neighbor of neighborBuffer) {
      const tentative = currentG + neighbor.cost;
      if (stamp[neighbor.index] === stampValue && tentative >= gScore[neighbor.index]) continue;
      stamp[neighbor.index] = stampValue;
      gScore[neighbor.index] = tentative;
      cameFrom[neighbor.index] = current.index;
      const h = goalHint >= 0 ? octile(neighbor.index, goalHint, grid.cols) : 0;
      open.push({ index: neighbor.index, g: tentative, h, f: tentative + h });
    }
  }
  return { path: null, expanded, found: false };
}

/**
 * نزدیک‌ترین خانهٔ آزاد به یک خانه (پویش با ترتیب قطعی).
 * @returns {number} cell index or -1
 */
export function nearestFreeCell(grid, index, maxRadius = 8) {
  if (grid.isFree(index)) return index;
  const col0 = grid.colOf(index);
  const row0 = grid.rowOf(index);
  for (let radius = 1; radius <= maxRadius; radius += 1) {
    for (let dr = -radius; dr <= radius; dr += 1) {
      const dcLimit = radius * 2 - Math.abs(dr);
      for (let dc = -dcLimit; dc <= dcLimit; dc += 1) {
        const col = col0 + dc;
        const row = row0 + dr;
        if (!grid.inside(col, row)) continue;
        const candidate = grid.index(col, row);
        if (grid.isFree(candidate)) return candidate;
      }
    }
  }
  return -1;
}

/** طول مسیر بر حسب واحد دنیا (گزارش‌ها و تست‌ها). */
export function pathWorldLength(grid, path) {
  if (!path || path.length < 2) return 0;
  let total = 0;
  let prev = grid.center(path[0]);
  for (let i = 1; i < path.length; i += 1) {
    const next = grid.center(path[i]);
    const dx = next.x - prev.x;
    const dz = next.z - prev.z;
    total += Math.sqrt(dx * dx + dz * dz);
    prev = next;
  }
  return total;
}

/** طول مسیر بر حسب خانه (برای مقایسه با خط مستقیم = «دور زدن دیوار»). */
export function pathTiles(path) {
  return path ? Math.max(0, path.length - 1) : 0;
}

/**
 * خانه‌های هدفِ رسیدن به یک سازه: خانه‌های آزاد مجاور + خانه‌های داخل برد حمله.
 * @param {import('./BattleGrid.js').BattleGrid} grid
 * @param {{col:number,row:number,w:number,h:number}} structure
 * @param {number} rangeTiles
 */
export function attackCellSet(grid, structure, rangeTiles = 1) {
  const cells = new Set();
  const pad = Math.max(1, Math.ceil(rangeTiles));
  for (let r = structure.row - pad; r < structure.row + structure.h + pad; r += 1) {
    for (let c = structure.col - pad; c < structure.col + structure.w + pad; c += 1) {
      if (!grid.inside(c, r)) continue;
      const index = grid.index(c, r);
      if (!grid.isFree(index)) continue;
      const point = grid.center(index);
      const dx = Math.max(structure.col * grid.tileSize - point.x, 0, point.x - (structure.col + structure.w) * grid.tileSize);
      const dz = Math.max(structure.row * grid.tileSize - point.z, 0, point.z - (structure.row + structure.h) * grid.tileSize);
      const distance = Math.sqrt(dx * dx + dz * dz);
      if (distance <= rangeTiles * grid.tileSize) cells.add(index);
    }
  }
  if (cells.size === 0) {
    // هیچ خانهٔ آزادی نزدیک نیست (مثلاً سازه میان سازه‌ها): نزدیک‌ترین خانهٔ آزاد.
    const anchor = nearestFreeCell(grid, grid.index(structure.col, structure.row), 12);
    if (anchor >= 0) cells.add(anchor);
  }
  return cells;
}

export { NEIGHBOR_OFFSETS };
