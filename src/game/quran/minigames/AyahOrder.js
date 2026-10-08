/**
 * مینی‌گیم «ترتیب آیات» — منطق خالص، بدون DOM و بدون Three.js.
 *
 * دو حالت، هر دو روی دادهٔ دیتاست:
 *   - verses   : آیه‌های یک قطعه (به ترتیب شماره‌های دیتاست) به‌هم می‌ریزند و
 *                بازیکن آن‌ها را برمی‌گرداند به ترتیب اصلی.
 *   - segments : بخش‌های پیوستهٔ یک آیه (توکن‌های متن) به‌هم می‌ریزند.
 *
 * روش تعامل لمسی: دو کارت را پشت سر هم بزن تا جابه‌جا شوند، بعد «بررسی ترتیب».
 * بررسی نادرست جریمه ندارد؛ کارت‌هایی که در جای درست هستند «قفل» می‌شوند تا
 * بازیکن گام‌به‌گام به پاسخ برسد (همان روش مرور فاصله‌دار برای موارد اشتباه).
 */
import { Rng } from '../../../core/RNG.js';
import { tokenize } from '../QuranDataset.js';

export const AYAH_ORDER_ID = 'ayah-order';

function chunksOf(tokens, count, rng) {
  const size = Math.max(1, Math.ceil(tokens.length / Math.max(1, count)));
  const chunks = [];
  for (let i = 0; i < tokens.length; i += size) {
    const part = tokens.slice(i, i + size).join(' ');
    if (part) chunks.push(part);
  }
  if (chunks.length < 2) return tokens.slice(); // تک‌توکنی: هر واژه یک کارت
  void rng;
  return chunks;
}

export class AyahOrderGame {
  /**
   * @param {object} options
   * @param {object} [options.verse] — برای حالت segments
   * @param {object[]} [options.verses] — برای حالت verses (به ترتیب دیتاست)
   * @param {'segments'|'verses'} [options.mode]
   * @param {number} [options.chunks]
   * @param {object} [options.config] — learning.minigames['ayah-order']
   * @param {number} [options.seed]
   */
  constructor({ verse = null, verses = [], mode = 'segments', chunks = 0, config = {}, seed = 1 }) {
    this.gameId = AYAH_ORDER_ID;
    this.config = config;
    this.rng = new Rng(seed >>> 0);
    this.mode = mode === 'verses' && verses.length >= 2 ? 'verses' : 'segments';
    this.mistakes = [];
    this.hints = 0;
    this.attempts = 0;
    this.items = [];

    if (this.mode === 'verses') {
      this.verseIds = verses.map((v) => v.id);
      const cards = verses.map((v) => ({
        id: v.id,
        index: verses.indexOf(v),
        text: v.textUthmani,
        caption: v.translationFa,
        ref: `${v.surahIndex}:${v.ayahIndex}`,
        reviewed: v.reviewed === true,
        placeholder: v.placeholder === true,
        source: v.source || null,
      }));
      this.cards = cards;
      this.targetOrder = cards.map((c) => c.id);
      this.order = this._scramble(this.targetOrder);
      this.verseId = verses[0]?.id || null;
    } else {
      const tokens = tokenize(verse?.textUthmani || '');
      const wanted = Math.max(2, Math.min(Number(chunks) || config.chunks || 4, Number(config.maxChunks) || 5, tokens.length));
      const parts = chunksOf(tokens, wanted, this.rng);
      this.cards = parts.map((text, index) => ({
        id: `part-${index}`,
        index,
        text,
        caption: null,
        ref: null,
        reviewed: verse?.reviewed === true,
        placeholder: verse?.placeholder === true,
        source: verse?.source || null,
      }));
      this.targetOrder = this.cards.map((c) => c.id);
      this.order = this._scramble(this.targetOrder);
      this.verseId = verse?.id || null;
    }
    this.locked = new Set();
    this.lastCheck = null;
    this.holds = new Map(); // id → کارتِ در دست برای جابه‌جایی
  }

  _scramble(order) {
    if (order.length < 2) return [...order];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const copy = [...order];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = this.rng.int(0, i);
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      if (copy.some((id, index) => id !== order[index])) return copy;
    }
    return [...order].reverse();
  }

  get total() {
    return this.cards.length;
  }

  get done() {
    return this.locked.size === this.cards.length;
  }

  byId(id) {
    return this.cards.find((c) => c.id === id) || null;
  }

  /** تعداد جای‌های درست فعلی. */
  correctPositions() {
    return this.order.filter((id, index) => id === this.targetOrder[index]).length;
  }

  /** جابه‌جایی دو کارت (تپ‌های پشت‌سرهم). */
  swap(idA, idB) {
    if (this.done || idA === idB) return false;
    const a = this.order.indexOf(idA);
    const b = this.order.indexOf(idB);
    if (a < 0 || b < 0) return false;
    if (this.locked.has(idA) || this.locked.has(idB)) return false;
    [this.order[a], this.order[b]] = [this.order[b], this.order[a]];
    this.lastCheck = null;
    return true;
  }

  /** جابه‌جایی کارت با همسایه (فلش‌های لمسی). */
  nudge(id, delta) {
    if (this.done) return false;
    const index = this.order.indexOf(id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= this.order.length) return false;
    const other = this.order[target];
    if (this.locked.has(id) || this.locked.has(other)) return false;
    [this.order[index], this.order[target]] = [this.order[target], this.order[index]];
    this.lastCheck = null;
    return true;
  }

  /**
   * بررسی ترتیب.
   * @returns {{correct:boolean, locked:string[], done:boolean, firstTry:boolean}}
   */
  check() {
    if (this.done) return { correct: true, locked: [...this.locked], done: true, firstTry: true };
    this.attempts += 1;
    const newly = [];
    this.order.forEach((id, index) => {
      if (id === this.targetOrder[index] && !this.locked.has(id)) {
        this.locked.add(id);
        newly.push(id);
      }
    });
    const correct = this.order.every((id, index) => id === this.targetOrder[index]);
    this.lastCheck = { correct, newlyLocked: newly, at: Date.now() };
    if (!correct) {
      this.mistakes.push({ order: [...this.order], correctPositions: this.correctPositions() });
    } else {
      const itemId = this.verseId || (this.verseIds || []).join('|');
      this.items.push({ itemId, correct: this.mistakes.length === 0 });
    }
    return { correct, locked: newly, done: this.done, firstTry: correct && this.mistakes.length === 0 };
  }

  /** راهنمای بی‌جریمه: یک کارت را در جای درستش می‌نشاند. */
  hint() {
    if (this.done) return null;
    const targetIndex = this.order.findIndex((id, index) => id !== this.targetOrder[index]);
    if (targetIndex < 0) return null;
    const wanted = this.targetOrder[targetIndex];
    const from = this.order.indexOf(wanted);
    [this.order[targetIndex], this.order[from]] = [this.order[from], this.order[targetIndex]];
    this.hints += 1;
    this.lastCheck = null;
    return { placed: wanted, at: targetIndex };
  }

  snapshot() {
    const byId = new Map(this.cards.map((c) => [c.id, c]));
    const itemId = this.verseId || (this.verseIds || []).join('|');
    return {
      gameId: this.gameId,
      mode: this.mode,
      done: this.done,
      verseId: itemId,
      cards: this.order.map((id, position) => ({
        id,
        position,
        text: byId.get(id)?.text || '',
        caption: byId.get(id)?.caption || null,
        ref: byId.get(id)?.ref || null,
        reviewed: byId.get(id)?.reviewed === true,
        placeholder: byId.get(id)?.placeholder === true,
        source: byId.get(id)?.source || null,
        locked: this.locked.has(id),
        correct: id === this.targetOrder[position],
      })),
      total: this.total,
      lockedCount: this.locked.size,
      mistakes: this.mistakes.length,
      hints: this.hints,
      lastCheck: this.lastCheck,
    };
  }

  report() {
    return {
      gameId: this.gameId,
      mode: this.mode,
      verseIds: this.verseIds || (this.verseId ? [this.verseId] : []),
      total: this.total,
      correct: this.done ? 1 : 0,
      mistakes: this.mistakes.length + this.hints,
      accuracy: this.done ? Math.max(0.2, 1 - this.mistakes.length * 0.15) : 0,
      items: this.items,
      details: this.mistakes.map((m) => ({ ...m })),
    };
  }
}
