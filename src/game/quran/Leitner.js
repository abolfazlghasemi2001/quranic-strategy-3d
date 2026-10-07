/**
 * Leitner — مرور فاصله‌دار ساده (جعبه‌های لایتنر)، خالص و بدون DOM.
 *
 * قاعده‌ها:
 *   - هر «قلم» (آیه یا جفت واژه) در یک جعبه ۱..۵ است و تاریخ سرآمد دارد.
 *   - پاسخ درست: جعبه یک پله بالا می‌رود، سرآمد = اکنون + فاصلهٔ همان جعبه.
 *   - پاسخ نادرست: هرگز جریمه‌ای در منابع ندارد؛ فقط جعبه به ۱ برمی‌گردد،
 *     سرآمد کوتاه می‌شود و قلم در همان نشست دوباره نشان داده می‌شود.
 *   - زمان همه‌جا timestamp (epoch ms) است تا بستن/باز کردن صفحه و تغییر
 *     ساعت سیستم رفتار قطعی بدهد.
 */
import { clamp } from '../../core/MathUtils.js';

export class Leitner {
  /**
   * @param {object} options
   * @param {object} options.config — learning.leitner
   * @param {object} [options.store] — شیء سادهٔ قابل‌ذخیره: { itemId: { box, due, reps, lapses, lastSeenAt, correct, wrong, kind, ref } }
   */
  constructor({ config, store = {} }) {
    this.config = config;
    this.store = store || {};
  }

  get boxes() {
    return this.config.boxes || [];
  }

  get maxBox() {
    return this.config.maxBox || this.boxes.length || 5;
  }

  intervalMs(box) {
    const entry = this.boxes.find((b) => b.box === clamp(box, 1, this.maxBox)) || this.boxes[0];
    return (entry?.minutes ?? 10) * 60 * 1000;
  }

  intervalLabel(box) {
    const entry = this.boxes.find((b) => b.box === clamp(box, 1, this.maxBox)) || this.boxes[0];
    return entry?.label || '';
  }

  entry(itemId) {
    return this.store[itemId] || null;
  }

  /** ثبت یک قلم تازه (اگر نبود) و برگرداندن وضعیتش. */
  register(itemId, { now = Date.now(), kind = 'ayah', ref = null, tags = null } = {}) {
    if (!this.store[itemId]) {
      const box = this.config.newItemBox || 1;
      this.store[itemId] = {
        box,
        due: now,
        reps: 0,
        lapses: 0,
        correct: 0,
        wrong: 0,
        lastSeenAt: null,
        registeredAt: now,
        kind,
        ref: ref || itemId,
        tags,
      };
    }
    return this.store[itemId];
  }

  registerMany(itemIds, options) {
    for (const id of itemIds) this.register(id, options);
    return itemIds.length;
  }

  /** اقلام سررسیده (due ≤ now) به ترتیب سرآمد. */
  dueItems(now = Date.now(), limit = Infinity) {
    const due = [];
    for (const [id, entry] of Object.entries(this.store)) {
      if (entry.due <= now) due.push({ id, ...entry });
    }
    due.sort((a, b) => a.due - b.due || String(a.id).localeCompare(String(b.id)));
    return due.slice(0, limit === Infinity ? due.length : Math.max(0, limit));
  }

  /** نزدیک‌ترین سرآمد بعدی (برای نمایش «مرور بعدی»). */
  nextDueAt() {
    let next = Infinity;
    for (const entry of Object.values(this.store)) next = Math.min(next, entry.due);
    return next === Infinity ? null : next;
  }

  /**
   * ثبت پاسخ یک قلم.
   * @param {string} itemId
   * @param {object} options
   * @param {boolean} options.correct
   * @param {number} [options.now]
   * @returns {{box:number, due:number, lapsed:boolean, intervalLabel:string}}
   */
  answer(itemId, { correct, now = Date.now() }) {
    const entry = this.register(itemId, { now });
    entry.reps += 1;
    entry.lastSeenAt = now;
    let lapsed = false;

    if (correct) {
      entry.correct += 1;
      entry.box = clamp(entry.box + 1, 1, this.maxBox);
    } else {
      entry.wrong += 1;
      entry.lapses += 1;
      lapsed = true;
      entry.box = clamp(this.config.lapseBox || 1, 1, this.maxBox);
    }
    entry.due = now + this.intervalMs(entry.box);
    return { box: entry.box, due: entry.due, lapsed, intervalLabel: this.intervalLabel(entry.box) };
  }

  /** نمرهٔ تسلط ساده (۰..۱) بر اساس جعبه و نسبت پاسخ درست. */
  mastery(itemId) {
    const entry = this.store[itemId];
    if (!entry) return 0;
    const accuracy = entry.correct + entry.wrong === 0 ? 0 : entry.correct / (entry.correct + entry.wrong);
    return clamp((entry.box / this.maxBox) * 0.7 + accuracy * 0.3, 0, 1);
  }

  stats(now = Date.now()) {
    const entries = Object.values(this.store);
    const byBox = {};
    for (let box = 1; box <= this.maxBox; box += 1) byBox[box] = 0;
    let dueCount = 0;
    let learned = 0;
    for (const entry of entries) {
      byBox[entry.box] = (byBox[entry.box] || 0) + 1;
      if (entry.due <= now) dueCount += 1;
      if (entry.box >= 3) learned += 1;
    }
    return {
      total: entries.length,
      dueCount,
      learned,
      byBox,
      nextDueAt: this.nextDueAt(),
      boxLabels: Object.fromEntries(this.boxes.map((b) => [b.box, b.label])),
    };
  }

  /** اقلامی که بازیکن باید ببیند: سررسیده‌ها، و در نبود آن‌ها تازه‌ها. */
  sessionQueue(now = Date.now(), { limit = 6, includeNew = true, minItems = 3 } = {}) {
    let queue = this.dueItems(now, limit).map((entry) => entry.id);
    if (queue.length < minItems && includeNew) {
      const fresh = Object.entries(this.store)
        .filter(([, entry]) => entry.reps === 0 && !queue.includes(entry.ref) && entry.due <= now + 1)
        .map(([id]) => id)
        .filter((id) => !queue.includes(id));
      queue = queue.concat(fresh.slice(0, Math.max(0, minItems - queue.length)));
    }
    return queue.slice(0, limit);
  }

  toJSON() {
    return this.store;
  }

  static fromJSON(json) {
    return json && typeof json === 'object' ? json : {};
  }
}
