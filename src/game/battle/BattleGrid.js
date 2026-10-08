/**
 * BattleGrid — شبکهٔ مسیریابی نبرد (منطق خالص، بدون Three.js و بدون DOM).
 *
 * هر خانه یا آزاد است یا با یک سازه اشغال شده. دیوارها تنها سازه‌های
 * «شکستنی» هستند: با شکستن یک قطعهٔ دیوار خانهٔ آن آزاد می‌شود، `version`
 * بالا می‌رود و مسیرهای ذخیره‌شده باطل می‌شوند — به همین دلیل واحدها پس از
 * شکستن دیوار از شکاف رد می‌شوند و پیش از آن مسیر را دور دیوار پیدا می‌کنند.
 *
 * مختصات:
 *   خانه: index = row * cols + col
 *   مرکز خانه در دنیا: ((col + 0.5) * tileSize, (row + 0.5) * tileSize)
 */
import { clamp } from '../../core/MathUtils.js';
import { STRUCTURE_KIND } from './StructureStats.js';

/** هشت جهت همسایه، ترتیب ثابت (قطعی) — چهار جهت اصلی، سپس قطری‌ها. */
export const NEIGHBOR_OFFSETS = Object.freeze([
  { dc: 0, dr: -1, cost: 1 },
  { dc: 1, dr: 0, cost: 1 },
  { dc: 0, dr: 1, cost: 1 },
  { dc: -1, dr: 0, cost: 1 },
  { dc: 1, dr: -1, cost: Math.SQRT2 },
  { dc: 1, dr: 1, cost: Math.SQRT2 },
  { dc: -1, dr: 1, cost: Math.SQRT2 },
  { dc: -1, dr: -1, cost: Math.SQRT2 },
]);

export class BattleGrid {
  /**
   * @param {object} options
   * @param {number} options.cols
   * @param {number} options.rows
   * @param {number} options.tileSize
   */
  constructor({ cols, rows, tileSize }) {
    this.cols = cols;
    this.rows = rows;
    this.tileSize = tileSize;
    this.size = cols * rows;
    /** 0 = آزاد، 1 = اشغال‌شده با سازهٔ شکستنی، 2 = اشغال‌شده با سازهٔ سخت. */
    this.cells = new Uint8Array(this.size);
    /** خانه → ایندکس سازه (‑۱ = خالی). */
    this.owners = new Int32Array(this.size).fill(-1);
    /** هر شکستن دیوار نسخه را بالا می‌برد ⇒ مسیرهای قدیمی باطل می‌شوند. */
    this.version = 1;
    this.structureCount = 0;
  }

  /* ------------------------------------------------------------- indexing */

  index(col, row) {
    return row * this.cols + col;
  }

  colOf(index) {
    return index % this.cols;
  }

  rowOf(index) {
    return Math.floor(index / this.cols);
  }

  inside(col, row) {
    return col >= 0 && row >= 0 && col < this.cols && row < this.rows;
  }

  center(index) {
    const col = this.colOf(index);
    const row = this.rowOf(index);
    return { x: (col + 0.5) * this.tileSize, z: (row + 0.5) * this.tileSize };
  }

  /** خانهٔ یک نقطهٔ دنیا (بریده‌شده به مرزهای نقشه). */
  cellAt(x, z) {
    const col = clamp(Math.floor(x / this.tileSize), 0, this.cols - 1);
    const row = clamp(Math.floor(z / this.tileSize), 0, this.rows - 1);
    return this.index(col, row);
  }

  isBlocked(index) {
    return this.cells[index] !== 0;
  }

  isFree(index) {
    return index >= 0 && index < this.size && this.cells[index] === 0;
  }

  /* ----------------------------------------------------------- structures */

  /**
   * علامت‌گذاری خانه‌های یک سازه.
   * @param {{index:number, kind:string, col:number, row:number, w:number, h:number}} structure
   */
  addStructure(structure) {
    const value = structure.kind === STRUCTURE_KIND.WALL ? 1 : 2;
    for (let r = structure.row; r < structure.row + structure.h; r += 1) {
      for (let c = structure.col; c < structure.col + structure.w; c += 1) {
        if (!this.inside(c, r)) continue;
        const index = this.index(c, r);
        this.cells[index] = value;
        this.owners[index] = structure.index;
      }
    }
    this.structureCount += 1;
  }

  /**
   * آزادکردن خانه‌های یک سازه (شکستن دیوار یا از کار افتادن سازه).
   * فقط دیوارها شکستنی‌اند؛ سازه‌های سخت همیشه مانع می‌مانند.
   * @returns {boolean} true when at least one cell changed
   */
  freeStructure(structure) {
    if (structure.kind !== STRUCTURE_KIND.WALL) return false;
    let changed = false;
    for (let r = structure.row; r < structure.row + structure.h; r += 1) {
      for (let c = structure.col; c < structure.col + structure.w; c += 1) {
        if (!this.inside(c, r)) continue;
        const index = this.index(c, r);
        if (this.cells[index] === 0) continue;
        this.cells[index] = 0;
        this.owners[index] = -1;
        changed = true;
      }
    }
    if (changed) this.version += 1;
    return changed;
  }

  /* ------------------------------------------------------------ neighbors */

  /** همسایه‌های معتبر برای A* (بدون برش گوشه). */
  neighbors(index, out = []) {
    out.length = 0;
    const col = this.colOf(index);
    const row = this.rowOf(index);
    for (let i = 0; i < NEIGHBOR_OFFSETS.length; i += 1) {
      const offset = NEIGHBOR_OFFSETS[i];
      const c = col + offset.dc;
      const r = row + offset.dr;
      if (!this.inside(c, r)) continue;
      const next = this.index(c, r);
      if (this.cells[next] !== 0) continue;
      // قطرها فقط وقتی مجازند که هر دو خانهٔ کناری هم آزاد باشند.
      if (offset.dc !== 0 && offset.dr !== 0) {
        if (this.cells[this.index(col + offset.dc, row)] !== 0) continue;
        if (this.cells[this.index(col, row + offset.dr)] !== 0) continue;
      }
      out.push({ index: next, cost: offset.cost });
    }
    return out;
  }

  /** خانه‌های آزاد همسایهٔ یک سازه (نقاط حملهٔ ممکن). */
  attackCells(structure) {
    const cells = new Set();
    for (let r = structure.row; r < structure.row + structure.h; r += 1) {
      for (let c = structure.col; c < structure.col + structure.w; c += 1) {
        const col = c;
        const row = r;
        for (let dc = -1; dc <= 1; dc += 1) {
          for (let dr = -1; dr <= 1; dr += 1) {
            if (dc === 0 && dr === 0) continue;
            const nc = col + dc;
            const nr = row + dr;
            if (!this.inside(nc, nr)) continue;
            const index = this.index(nc, nr);
            if (this.cells[index] === 0) cells.add(index);
          }
        }
      }
    }
    return cells;
  }

  /** آیا این خانه به سازه چسبیده است؟ (برای تشخیص «رسیدن به هدف») */
  isAdjacentToStructure(structure, index) {
    const col = this.colOf(index);
    const row = this.rowOf(index);
    return (
      col >= structure.col - 1 && col <= structure.col + structure.w &&
      row >= structure.row - 1 && row <= structure.row + structure.h
    );
  }

  clone() {
    const copy = new BattleGrid({ cols: this.cols, rows: this.rows, tileSize: this.tileSize });
    copy.cells.set(this.cells);
    copy.owners.set(this.owners);
    copy.version = this.version;
    copy.structureCount = this.structureCount;
    return copy;
  }

  /** خلاصهٔ قابل‌ذخیره (برای بازپخش: فقط خانه‌های اشغال‌شده). */
  serializeBlocked() {
    const list = [];
    for (let index = 0; index < this.size; index += 1) {
      if (this.cells[index] !== 0) list.push(index);
    }
    return list;
  }
}
