/**
 * LearningSystem — لایهٔ قرآنی-آموزشی: پیوند درس‌ها، مرور فاصله‌دار و اقتصاد.
 * خالص و بدون DOM/Three.js؛ مثل EconomySystem از state و economy استفاده می‌کند.
 *
 * قواعد:
 *   - درس‌ها اجباری نیستند و ضعیف‌کردن بازی نمی‌کنند؛ فقط «سریع‌تر» می‌کنند:
 *     نور و حکمت + تسریع تایمر بنّا.
 *   - خطا هیچ جریمه‌ای ندارد (نه کاهش منبع، نه بستن درس)؛ فقط قلم به جعبهٔ ۱
 *     برمی‌گردد و زودتر دوباره نشان داده می‌شود.
 *   - پاداش از ظرفیت انبار رد نمی‌شود؛ سرریز فقط «ذخیره نمی‌شود» (بدون جریمه).
 *   - هیچ متن قرآنی این‌جا تولید یا نگه‌داری نمی‌شود؛ فقط شناسهٔ آیات.
 */
import { EVENTS } from '../../core/EventBus.js';
import { Leitner } from './Leitner.js';
import { LessonEngine } from './LessonEngine.js';
import { toFaDigits } from './QuranDataset.js';

export class LearningSystem {
  /**
   * @param {object} options
   * @param {object} options.dataset — دیتاست نرمال‌شده
   * @param {object} options.learning — src/data/quran-learning.json
   * @param {import('../GameState.js').GameState} options.state
   * @param {import('../EconomySystem.js').EconomySystem} options.economy
   * @param {import('../BuildQueue.js').BuildQueue} [options.queue]
   * @param {import('../../core/EventBus.js').EventBus} [options.bus]
   * @param {object} [options.game] — برای علامت‌گذاری کثیف‌بودن و ذخیره
   * @param {number} [options.seed]
   */
  constructor({ dataset, learning, state, economy, queue = null, bus = null, game = null, seed = 1 }) {
    this.dataset = dataset;
    this.learning = learning;
    this.state = state;
    this.economy = economy;
    this.queue = queue;
    this.bus = bus;
    this.game = game;
    this.engine = new LessonEngine({ dataset, learning, seedBase: (seed >>> 0) || 1 });
    this.leitner = new Leitner({ config: learning.leitner, store: this.progress.reviews });
    this.activeSession = null;
    this._lastDueCount = -1;
    this.todayKey = null;
  }

  /* -------------------------------------------------------------- state */

  get progress() {
    if (!this.state.learning) {
      this.state.learning = {
        version: 1,
        reviews: {},
        lessons: {},
        totals: { lessonsCompleted: 0, reviewSessions: 0, itemsLearned: 0, nurEarned: 0, hekmatEarned: 0, speedupSecondsUsed: 0, speedupPool: 0 },
        history: [],
      };
    }
    return this.state.learning;
  }

  get totals() {
    return this.progress.totals;
  }

  speedupPoolSeconds() {
    return Math.max(0, Math.round(this.progress.totals.speedupPool || 0));
  }

  /* -------------------------------------------------------------- lessons */

  lessonById(lessonId) {
    return this.dataset.lessons.find((l) => l.id === lessonId) || null;
  }

  lessonStatus(lessonId) {
    const record = this.progress.lessons[lessonId] || null;
    return {
      completed: !!record,
      completions: record?.completions || 0,
      bestAccuracy: record?.bestAccuracy ?? 0,
      lastCompletedAt: record?.lastCompletedAt || null,
      totalSeconds: record?.totalSeconds || 0,
    };
  }

  /** ثبت اقلام یک درس در Leitner (پیش از شروع). */
  registerLessonItems(lesson, now = Date.now()) {
    const items = this.engine.itemsForLesson(lesson);
    for (const item of items) this.leitner.register(item.itemId, { now, kind: item.kind, ref: item.ref });
    return items.length;
  }

  /**
   * شروع یک درس.
   * @returns {{session:import('./LessonEngine.js').LessonSession, lesson:object}|null}
   */
  startLesson(lessonId, now = Date.now()) {
    const lesson = this.lessonById(lessonId);
    if (!lesson) return null;
    this.registerLessonItems(lesson, now);
    const session = this.engine.createLessonSession(lessonId, now);
    if (!session) return null;
    this.activeSession = session;
    this.bus?.emit(EVENTS.QURAN_LESSON_STARTED, { lessonId, sessionId: session.id, at: now, items: lesson.ayahIds.length });
    this._flush();
    return { session, lesson };
  }

  /**
   * شروع نشست مرور فاصله‌دار روی سررسیده‌ها.
   * @returns {{session:object, itemIds:string[]}|null}
   */
  startReview(now = Date.now()) {
    const queue = this.reviewQueue(now);
    if (!queue.length) return null;
    const session = this.engine.createReviewSession(queue.map((item) => item.id), now);
    if (!session) return null;
    this.activeSession = session;
    this.bus?.emit(EVENTS.QURAN_REVIEW_STARTED, { sessionId: session.id, items: queue.length, at: now });
    return { session, itemIds: queue.map((item) => item.id) };
  }

  /** اقلام سررسیدهٔ Leitner با محتوای نمایشی. */
  reviewQueue(now = Date.now()) {
    const { sessionLimit = 6, minItems = 3, includeNewItemsWhenEmpty = true } = this.learning.review || {};
    const ids = this.leitner.sessionQueue(now, { limit: sessionLimit, includeNew: includeNewItemsWhenEmpty, minItems });
    return ids
      .map((id) => {
        const resolved = this.engine.resolveItem(id);
        const entry = this.leitner.entry(id);
        if (!resolved || !entry) return null;
        return {
          id,
          kind: resolved.kind,
          box: entry.box,
          due: entry.due,
          overdue: entry.due <= now,
          ref: entry.ref,
          verse: resolved.verse || null,
          term: resolved.term || null,
          meaning: resolved.meaning || null,
          lessonId: resolved.lesson?.id || null,
        };
      })
      .filter(Boolean);
  }

  /* --------------------------------------------------------------- answers */

  /**
   * ثبت نتیجهٔ یک پاسخ: فقط برای Leitner و مرور؛ جریمه‌ای وجود ندارد.
   * @returns {{box:number, due:number, lapsed:boolean}}
   */
  recordAnswer(itemId, correct, now = Date.now()) {
    if (!itemId) return null;
    const result = this.leitner.answer(itemId, { correct: !!correct, now });
    const item = this.engine.resolveItem(itemId);
    if (item) {
      const key = itemId;
      this.progress.totals.itemsLearned = Object.keys(this.progress.reviews).filter((id) => (this.progress.reviews[id].box || 1) >= 3).length;
      void key;
    }
    this._flush();
    return result;
  }

  /* ---------------------------------------------------------------- rewards */

  /**
   * پایان نشست: ثبت Leitner، پاداش، تسریع ساخت و رویدادها.
   * @param {import('./LessonEngine.js').LessonSession} session
   * @returns {object} گزارش کامل برای رابط کاربری
   */
  finishSession(session = this.activeSession, now = Date.now()) {
    if (!session) return null;
    const report = session.finish(now);

    // ۱) Leitner — یک بار برای هر قلم، بر پایهٔ اولین پاسخ درست/نادرست
    for (const outcome of report.outcomes) {
      this.leitner.answer(outcome.itemId, { correct: outcome.correct, now });
    }
    // اقلام خطادار که در نشست مرور تکرار شدند، سرآمد کوتاهی می‌گیرند
    for (const requeue of report.requeuedMistakes) {
      const entry = this.leitner.entry(requeue.itemId);
      if (entry) entry.due = now + this.leitner.intervalMs(1);
    }

    // ۲) ثبت کارنامهٔ درس
    if (report.kind === 'lesson' && report.lessonId) {
      const prev = this.progress.lessons[report.lessonId];
      this.progress.lessons[report.lessonId] = {
        completions: (prev?.completions || 0) + 1,
        firstCompletedAt: prev?.firstCompletedAt || now,
        lastCompletedAt: now,
        bestAccuracy: Math.max(prev?.bestAccuracy || 0, report.accuracy),
        totalSeconds: (prev?.totalSeconds || 0) + report.elapsedSeconds,
        mistakes: (prev?.mistakes || 0) + report.mistakes,
      };
    }

    // ۳) پاداش‌ها (اختیاری، فقط تسریع‌کننده)
    const rewards = this._computeRewards(report);
    const granted = this._grantRewards(rewards, now);

    // ۴) کارنامه
    this.progress.history.unshift({
      id: report.sessionId,
      kind: report.kind,
      lessonId: report.lessonId,
      at: now,
      seconds: report.elapsedSeconds,
      accuracy: Number(report.accuracy.toFixed(3)),
      mistakes: report.mistakes,
    });
    if (this.progress.history.length > 30) this.progress.history.length = 30;

    if (report.kind === 'lesson') this.progress.totals.lessonsCompleted += 1;
    else this.progress.totals.reviewSessions += 1;
    this.progress.totals.itemsLearned = Object.values(this.progress.reviews).filter((e) => (e.box || 1) >= 3).length;

    this.activeSession = null;
    this._flush(true);

    const payload = { report, rewards, granted, stats: this.stats(now) };
    if (report.kind === 'lesson') {
      this.bus?.emit(EVENTS.QURAN_LESSON_COMPLETED, payload);
    } else {
      this.bus?.emit(EVENTS.QURAN_REVIEW_COMPLETED, payload);
    }
    this.bus?.emit(EVENTS.QURAN_REWARD_GRANTED, payload);
    this._emitRewardToast(granted, report);
    this._emitDue(true, now);
    return payload;
  }

  _computeRewards(report) {
    const table = this.learning.rewards;
    const rewards = { nur: 0, hekmat: 0, speedupSeconds: 0, notes: [] };
    const add = (entry, label) => {
      if (!entry) return;
      rewards.nur += Number(entry.nur) || 0;
      rewards.hekmat += Number(entry.hekmat) || 0;
      rewards.speedupSeconds += Number(entry.speedupSeconds) || 0;
      if (label) rewards.notes.push(label);
    };

    if (report.kind === 'lesson' && report.lessonId) {
      const previous = this.progress.lessons[report.lessonId]?.completions || 0;
      add(table.lessonComplete, previous === 0 ? 'نخستین تکمیل درس' : 'تکمیل درس');
      if (previous === 0 && table.firstCompletion) add(table.firstCompletion, 'پاداش نخستین بار');
      if (report.mistakes === 0 && table.perfectLessonBonus) add(table.perfectLessonBonus, 'درس بدون خطا');
    } else if (report.kind === 'review') {
      add(table.reviewSession, 'نشست مرور');
    }
    return rewards;
  }

  /**
   * اعمال پاداش: منابع (با احترام به ظرفیت انبار)، تسریع تایمر بنّا، و استخر تسریع.
   */
  _grantRewards(rewards, now) {
    const respect = this.learning.rewards.respectStorageCapacity !== false;
    const granted = { nur: 0, hekmat: 0, overflow: { nur: 0, hekmat: 0 }, speedup: { appliedSeconds: 0, pooledSeconds: 0 }, at: now };

    if (rewards.nur > 0) {
      const result = this.economy.grant('nur', rewards.nur, { clampToCapacity: respect });
      granted.nur = result.moved;
      granted.overflow.nur = result.overflow;
      this.progress.totals.nurEarned += result.moved;
    }
    if (rewards.hekmat > 0) {
      const result = this.economy.grant('hekmat', rewards.hekmat, { clampToCapacity: respect });
      granted.hekmat = result.moved;
      granted.overflow.hekmat = result.overflow;
      this.progress.totals.hekmatEarned += result.moved;
    }
    if (rewards.speedupSeconds > 0) {
      const speedup = this.applySpeedup(rewards.speedupSeconds, now);
      granted.speedup = speedup;
    }
    return granted;
  }

  /**
   * «تسریع ساخت»: کوتاه‌کردن تایمر بنّاهای فعال. اگر بنّایی مشغول نباشد، ثانیه‌ها
   * در یک استخر (با سقف) ذخیره می‌شوند تا بعداً خرج شوند. هیچ‌گاه تایمری بلندتر نمی‌شود.
   */
  applySpeedup(seconds, now = Date.now()) {
    const cap = Number(this.learning.rewards.speedupPoolMaxSeconds) || 300;
    let remainingMs = Math.max(0, Math.round(seconds * 1000));
    let appliedMs = 0;
    const jobs = (this.queue?.jobs || [])
      .filter((job) => job.status === 'active' && Number.isFinite(job.endsAt))
      .sort((a, b) => a.endsAt - b.endsAt);
    for (const job of jobs) {
      if (remainingMs <= 0) break;
      const slack = Math.max(0, job.endsAt - now);
      const cut = Math.min(remainingMs, slack);
      if (cut <= 0) continue;
      job.endsAt -= cut;
      remainingMs -= cut;
      appliedMs += cut;
    }
    let pooled = 0;
    if (remainingMs > 0) {
      const poolSeconds = Math.floor(remainingMs / 1000);
      const free = Math.max(0, cap - this.speedupPoolSeconds());
      pooled = Math.min(poolSeconds, free);
      this.progress.totals.speedupPool = this.speedupPoolSeconds() + pooled;
    }
    const appliedSeconds = Math.round(appliedMs / 1000);
    this.progress.totals.speedupSecondsUsed += appliedSeconds;
    if (appliedSeconds > 0) this.queue?.tick(now);
    this._flush();
    return { appliedSeconds, pooledSeconds: pooled, poolTotal: this.speedupPoolSeconds() };
  }

  /** خرج‌کردن استخر تسریع روی زودترین بنّای فعال (اختیاری، در رابط درس). */
  useSpeedupPool(now = Date.now()) {
    const pool = this.speedupPoolSeconds();
    if (pool <= 0) return { ok: false, reason: 'empty' };
    const active = (this.queue?.jobs || []).filter((job) => job.status === 'active');
    if (!active.length) return { ok: false, reason: 'no-active-job' };
    const result = this.applySpeedup(pool, now);
    this.progress.totals.speedupPool = Math.max(0, this.speedupPoolSeconds() - (pool - result.pooledSeconds));
    this._flush(true);
    this.bus?.emit(EVENTS.UI_TOAST, { message: `تسریع ساخت: −${toFaDigits(pool)} ثانیه`, type: 'success' });
    return { ok: true, ...result };
  }

  _emitRewardToast(granted, report) {
    const parts = [];
    if (granted.nur > 0) parts.push(`نور ${toFaDigits(Math.round(granted.nur))}`);
    if (granted.hekmat > 0) parts.push(`حکمت ${toFaDigits(Math.round(granted.hekmat))}`);
    if (granted.speedup.appliedSeconds > 0) parts.push(`تسریع ساخت ${toFaDigits(granted.speedup.appliedSeconds)}ث`);
    if (granted.speedup.pooledSeconds > 0) parts.push(`ذخیرهٔ تسریع ${toFaDigits(granted.speedup.pooledSeconds)}ث`);
    const overflow = (granted.overflow.nur || 0) + (granted.overflow.hekmat || 0);
    if (overflow > 0) parts.push('بخشی از پاداش به‌دلیل پُری انبار ذخیره نشد');
    if (!parts.length) return;
    const head = report.kind === 'lesson' ? 'پاداش درس' : 'پاداش مرور';
    this.bus?.emit(EVENTS.UI_TOAST, { message: `${head}: ${parts.join('، ')}`, type: 'success' });
  }

  /* ------------------------------------------------------------------- tick */

  /** شمارش سررسیده‌ها و انتشار رویداد در صورت تغییر (سبک، چند بار در ثانیه). */
  tick(now = Date.now()) {
    this._emitDue(false, now);
  }

  _emitDue(force, now) {
    const stats = this.leitner.stats(now);
    if (!force && stats.dueCount === this._lastDueCount) return stats;
    this._lastDueCount = stats.dueCount;
    this.bus?.emit(EVENTS.QURAN_REVIEW_DUE, { ...stats, at: now });
    return stats;
  }

  stats(now = Date.now()) {
    const leit = this.leitner.stats(now);
    return {
      ...leit,
      lessons: this.dataset.lessons.map((lesson) => ({
        id: lesson.id,
        title: lesson.title,
        ...this.lessonStatus(lesson.id),
      })),
      lessonsCompleted: this.progress.totals.lessonsCompleted,
      reviewSessions: this.progress.totals.reviewSessions,
      itemsLearned: this.progress.totals.itemsLearned,
      nurEarned: Math.round(this.progress.totals.nurEarned),
      hekmatEarned: Math.round(this.progress.totals.hekmatEarned),
      speedupSecondsUsed: Math.round(this.progress.totals.speedupSecondsUsed),
      speedupPool: this.speedupPoolSeconds(),
      dataset: this.dataset.stats,
      hasActiveSession: !!this.activeSession,
    };
  }

  _flush(save = false) {
    this.game?.markEconomyDirty?.();
    if (save) this.game?.persist?.();
  }
}

export { toFaDigits };
