/**
 * LessonEngine / LessonSession — موتور درس‌های دارالقرآن (منطق خالص، بدون DOM).
 *
 * هر درس ۲ تا ۳ دقیقه است و از مرحله‌های داده‌محور ساخته می‌شود:
 *   read    → نمایش آیه با ترجمه (متن فقط داخل رابط درس)
 *   quiz    → یکی از سه مینی‌گیم (تکمیل آیه / تطبیق واژه و معنی / ترتیب آیات)
 *   summary → جمع‌بندی و پاداش
 *
 * قواعد ثابت:
 *   - پاسخ نادرست هیچ جریمه‌ای ندارد؛ فقط ثبت می‌شود و دوباره نشان داده می‌شود.
 *   - مرحله‌های تکراری (requeue) برای خطاهای همان نشست ساخته می‌شوند تا مرور
 *     فاصله‌دار همان‌جا هم اثر داشته باشد.
 *   - نشست مرور (review) سررسیده‌های Leitner را یکی‌یکی می‌آورد و خطاها را به
 *     انتهای صف برمی‌گرداند.
 */
import { Rng } from '../../core/RNG.js';
import { wordMatchPairsFor, tokensPool } from './content.js';
import { AyahCompletionGame } from './minigames/AyahCompletion.js';
import { AyahOrderGame } from './minigames/AyahOrder.js';
import { WordMatchGame, buildPairs } from './minigames/WordMatch.js';

let SESSION_SEQ = 0;

function shuffle(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export class LessonSession {
  constructor({ engine, kind, lesson = null, queue = [], now = Date.now(), seed = 1 }) {
    SESSION_SEQ += 1;
    this.id = `session-${SESSION_SEQ}`;
    this.engine = engine;
    this.kind = kind; // 'lesson' | 'review'
    this.lesson = lesson;
    this.rng = new Rng(seed >>> 0);
    this.startedAt = now;
    this.finishedAt = null;
    this.steps = [];
    this.stepIndex = 0;
    this.mistakes = 0;
    this.outcomes = new Map(); // itemId → اولین پاسخ درست بود؟
    this.mistakeItems = [];
    this.repeats = new Map(); // itemId → تعداد تکرار با خطا
    this.queue = [...queue];
    this.closed = false;

    if (kind === 'lesson') this._buildLessonSteps();
    else this._pushNextReviewStep();
  }

  /* ------------------------------------------------------------- ساخت مرحله */

  _buildLessonSteps() {
    const { dataset, learning } = this.engine;
    const lesson = this.lesson;
    for (const raw of lesson.steps) {
      const step = { ...raw, index: this.steps.length, spentSeconds: 0, mistakes: 0, done: false, game: null };
      if (raw.kind === 'read') {
        const verse = dataset.verses.get(raw.ayahId);
        if (!verse) continue;
        step.verse = verse;
      } else if (raw.kind === 'quiz') {
        const game = this._makeGame(raw, lesson);
        if (!game) continue;
        step.game = game;
      }
      this.steps.push(step);
    }
    // مرحلهٔ مرور خطاهای همان نشست (اگر خطایی رخ دهد، پیش از جمع‌بندی افزوده می‌شود)
    if (this.steps.some((s) => s.kind === 'summary')) {
      const summaryIndex = this.steps.findIndex((s) => s.kind === 'summary');
      this._requeueAnchor = summaryIndex;
    } else {
      this._requeueAnchor = this.steps.length;
    }
    void learning;
  }

  _makeGame(raw, lesson) {
    const { dataset, learning, seedBase } = this.engine;
    const cfg = learning.minigames[raw.game] || {};
    const seed = (seedBase + this.steps.length * 31 + (lesson?.order || 0) * 7 + 1) >>> 0;
    if (raw.game === 'ayah-completion') {
      const verse = dataset.verses.get(raw.ayahId);
      if (!verse || verse.tokens.length < 2) return null;
      return new AyahCompletionGame({
        verse,
        rounds: raw.rounds || cfg.rounds,
        config: cfg,
        seed,
        distractorPool: tokensPool(dataset, { excludeVerseId: verse.id, limit: 60 }),
      });
    }
    if (raw.game === 'word-match') {
      const { pairs, mode } = wordMatchPairsFor({ lesson, dataset, config: cfg });
      if (pairs.length < 2) return null;
      return new WordMatchGame({ pairs, pairsPerRound: raw.pairs || cfg.pairsPerRound, config: cfg, seed, mode });
    }
    if (raw.game === 'ayah-order') {
      if (raw.mode === 'verses') {
        const verses = (raw.ayahIds || lesson.ayahIds || []).map((id) => dataset.verses.get(id)).filter(Boolean);
        if (verses.length < 2) return null;
        return new AyahOrderGame({ verses, mode: 'verses', config: cfg, seed });
      }
      const verse = dataset.verses.get(raw.ayahId) || dataset.verses.get(lesson.ayahIds[0]);
      if (!verse || verse.tokens.length < 2) return null;
      return new AyahOrderGame({ verse, mode: 'segments', chunks: raw.chunks, config: cfg, seed });
    }
    return null;
  }

  /** مرحلهٔ بعدی نشست مرور — بر پایهٔ سررسیده‌های Leitner. */
  _pushNextReviewStep() {
    const { dataset, learning } = this.engine;
    while (this.queue.length) {
      const itemId = this.queue.shift();
      const resolved = this.engine.resolveItem(itemId);
      if (!resolved) continue;
      const seed = (this.engine.seedBase + this.steps.length * 17 + 3) >>> 0;

      if (resolved.kind === 'word') {
        const { pairs, mode } = wordMatchPairsFor({
          lesson: resolved.lesson,
          dataset,
          config: learning.minigames['word-match'] || {},
          focusTerm: resolved.term,
        });
        if (pairs.length < 2) continue;
        const game = new WordMatchGame({ pairs, pairsPerRound: pairs.length, config: learning.minigames['word-match'] || {}, seed, mode });
        this.steps.push({ kind: 'quiz', title: 'مرور واژه', game, index: this.steps.length, spentSeconds: 0, mistakes: 0, done: false, itemId, repeat: (this.repeats.get(itemId) || 0) > 0, seconds: 25 });
        return;
      }

      const game = new AyahCompletionGame({
        verse: resolved.verse,
        rounds: Math.min(2, learning.minigames['ayah-completion']?.rounds || 2),
        config: learning.minigames['ayah-completion'] || {},
        seed,
        distractorPool: tokensPool(dataset, { excludeVerseId: resolved.verse.id, limit: 60 }),
      });
      this.steps.push({ kind: 'quiz', title: 'مرور آیه', game, index: this.steps.length, spentSeconds: 0, mistakes: 0, done: false, itemId, repeat: (this.repeats.get(itemId) || 0) > 0, seconds: 25 });
      return;
    }
  }

  /* ----------------------------------------------------------------- کنترل */

  get current() {
    return this.steps[this.stepIndex] || null;
  }

  get targetSeconds() {
    if (this.kind === 'review') return this.steps.reduce((sum, s) => sum + (s.seconds || 20), 0) || 90;
    return this.lesson?.targetSeconds || this.steps.reduce((sum, s) => sum + (s.seconds || 0), 0) || 120;
  }

  elapsedSeconds(now = Date.now()) {
    return Math.max(0, Math.round(((this.finishedAt || now) - this.startedAt) / 1000));
  }

  /** آیا مرحلهٔ جاری تمام شده است؟ */
  stepDone(step = this.current) {
    if (!step) return true;
    if (step.kind === 'read' || step.kind === 'summary') return !!step.done;
    if (step.kind === 'quiz') return !!step.game && step.game.done;
    return true;
  }

  get progress() {
    const total = Math.max(1, this.steps.length);
    const finished = this.steps.filter((s, index) => index < this.stepIndex || this.stepDone(s)).length;
    return { index: this.stepIndex, total: this.steps.length, finished, ratio: Math.min(1, finished / total) };
  }

  /** ثبت نتیجهٔ یک پاسخ در بازی جاری (برای Leitner و مرور خطاها). */
  registerAnswer({ itemId, correct }) {
    if (!itemId || this.closed) return;
    if (!this.outcomes.has(itemId)) {
      this.outcomes.set(itemId, correct);
      const step = this.current;
      if (step) step.mistakes += correct ? 0 : 1;
      if (!correct) {
        this.mistakes += 1;
        if (!this.mistakeItems.includes(itemId)) this.mistakeItems.push(itemId);
      }
    } else if (!correct) {
      // خطای بعدی روی همان قلم، خطای تازه‌ای شمرده می‌شود ولی نتیجهٔ اول را عوض نمی‌کند.
      this.mistakes += 1;
      const step = this.current;
      if (step) step.mistakes += 1;
    }
  }

  /** راهنمای بی‌جریمه روی مرحلهٔ جاری. */
  hint() {
    const step = this.current;
    if (!step?.game?.hint) return null;
    return step.game.hint();
  }

  /**
   * رفتن به مرحلهٔ بعد (مرحلهٔ جاری باید تمام شده باشد).
   * @returns {{advanced:boolean, done:boolean, requeue?:boolean}}
   */
  advance(now = Date.now()) {
    if (this.closed) return { advanced: false, done: true };
    const step = this.current;
    if (!step) return { advanced: false, done: true };
    step.spentSeconds = step.startedAt ? Math.round((now - step.startedAt) / 1000) : step.spentSeconds;
    step.done = true;

    // خطاهای نشست درس، پیش از جمع‌بندی یک مرحلهٔ مرور می‌سازند (بدون جریمه).
    if (this.kind === 'lesson' && step.kind === 'quiz' && step.index >= (this._requeueAnchor || 0) - 1) {
      this._insertMistakeReviewStep();
    }

    this.stepIndex += 1;
    if (this.kind === 'review' && this.stepIndex >= this.steps.length) {
      const queued = this._requeueMistakes();
      if (queued) return { advanced: true, done: false, requeue: true };
    }
    const next = this.current;
    if (next) next.startedAt = now;
    return { advanced: true, done: !next };
  }

  _insertMistakeReviewStep() {
    if (this._mistakeStepInserted || this.kind !== 'lesson') return;
    const items = this.mistakeItems.filter((id) => !id.startsWith('word:'));
    if (!items.length) return;
    const verses = items.map((id) => this.engine.dataset.verses.get(id)).filter(Boolean);
    if (!verses.length) return;
    const seed = (this.engine.seedBase + 977) >>> 0;
    const game = verses.length >= 3
      ? new AyahOrderGame({ verses: verses.slice(0, 4), mode: 'verses', config: this.engine.learning.minigames['ayah-order'] || {}, seed })
      : new AyahCompletionGame({
        verse: verses[0],
        rounds: 2,
        config: this.engine.learning.minigames['ayah-completion'] || {},
        seed,
        distractorPool: tokensPool(this.engine.dataset, { excludeVerseId: verses[0].id, limit: 40 }),
      });
    const anchor = this._requeueAnchor ?? this.steps.length;
    this.steps.splice(anchor, 0, {
      kind: 'quiz',
      title: 'مرور خطاها (بدون جریمه)',
      game,
      index: anchor,
      spentSeconds: 0,
      mistakes: 0,
      done: false,
      seconds: 30,
      requeue: true,
    });
    this.steps.forEach((s, index) => { s.index = index; });
    this._requeueAnchor = anchor + 1;
    this._mistakeStepInserted = true;
  }

  _requeueMistakes() {
    const requeueAfter = this.engine.learning.leitner.requeueAfter || 3;
    const maxRepeats = this.engine.learning.review?.maxRepeats || 2;
    let queued = false;
    for (const itemId of this.mistakeItems) {
      const repeats = this.repeats.get(itemId) || 0;
      if (repeats >= maxRepeats) continue;
      this.repeats.set(itemId, repeats + 1);
      const position = Math.min(this.queue.length, requeueAfter);
      this.queue.splice(position, 0, itemId);
      queued = true;
    }
    this.mistakeItems = [];
    if (queued) {
      this._pushNextReviewStep();
      const next = this.current;
      if (next) next.startedAt = Date.now();
    }
    return queued;
  }

  /** پایان نشست و ساخت گزارش. */
  finish(now = Date.now()) {
    this.closed = true;
    this.finishedAt = now;
    const step = this.current;
    if (step && !step.spentSeconds) step.spentSeconds = Math.round((now - (step.startedAt || this.startedAt)) / 1000);
    const outcomes = [...this.outcomes.entries()].map(([itemId, correct]) => ({ itemId, correct }));
    const correct = outcomes.filter((o) => o.correct).length;
    const quizSteps = this.steps.filter((s) => s.kind === 'quiz');
    const completed = this.kind === 'review' ? quizSteps.length > 0 : this.steps.every((s) => s.kind !== 'summary' || s.done);
    return {
      sessionId: this.id,
      kind: this.kind,
      lessonId: this.lesson?.id || null,
      startedAt: this.startedAt,
      finishedAt: now,
      elapsedSeconds: Math.round((now - this.startedAt) / 1000),
      targetSeconds: this.targetSeconds,
      completed,
      steps: this.steps.map((s) => ({
        kind: s.kind,
        title: s.title,
        gameId: s.game?.gameId || null,
        seconds: s.seconds || 0,
        spentSeconds: s.spentSeconds || 0,
        mistakes: s.mistakes || 0,
      })),
      outcomes,
      mistakes: this.mistakes,
      correctAnswers: correct,
      accuracy: outcomes.length === 0 ? 1 : correct / outcomes.length,
      requeuedMistakes: [...this.repeats.entries()].map(([itemId, count]) => ({ itemId, count })),
    };
  }

  /** وضعیت برای رابط کاربری. */
  snapshot(now = Date.now()) {
    const step = this.current;
    const progress = this.progress;
    return {
      sessionId: this.id,
      kind: this.kind,
      lessonId: this.lesson?.id || null,
      lessonTitle: this.lesson?.title || 'مرور فاصله‌دار',
      stepIndex: progress.index,
      stepTotal: progress.total,
      ratio: progress.ratio,
      elapsedSeconds: this.elapsedSeconds(now),
      targetSeconds: this.targetSeconds,
      mistakes: this.mistakes,
      done: this.closed || (!step && progress.finished >= progress.total),
      canAdvance: this.stepDone(step),
      step: step
        ? {
          kind: step.kind,
          title: step.title,
          seconds: step.seconds || 0,
          verse: step.verse || null,
          gameId: step.game?.gameId || null,
          game: step.game ? step.game.snapshot() : null,
          requeue: !!step.requeue,
          itemId: step.itemId || null,
        }
        : null,
    };
  }
}

export class LessonEngine {
  /**
   * @param {object} options
   * @param {object} options.dataset — خروجی QuranDataset.normalizeDataset
   * @param {object} options.learning — src/data/quran-learning.json
   * @param {number} [options.seedBase]
   */
  constructor({ dataset, learning, seedBase = 1 }) {
    this.dataset = dataset;
    this.learning = learning;
    this.seedBase = seedBase >>> 0;
  }

  /** قلم مرور (آیه یا واژه) را به محتوای دیتاست نگاشت می‌کند. */
  resolveItem(itemId) {
    if (!itemId) return null;
    if (itemId.startsWith('ayah:')) {
      const verse = this.dataset.verses.get(itemId);
      return verse ? { kind: 'ayah', itemId, verse } : null;
    }
    if (itemId.startsWith('word:')) {
      const [, lessonId, indexRaw] = itemId.split(':');
      const lesson = this.dataset.lessons.find((l) => l.id === lessonId) || null;
      const pair = lesson?.wordBank?.[Number(indexRaw)] || null;
      if (!lesson || !pair) return null;
      return { kind: 'word', itemId, lesson, term: pair.term, meaning: pair.meaning, index: Number(indexRaw) };
    }
    return null;
  }

  /** قلم‌های یک درس برای ثبت در Leitner. */
  itemsForLesson(lesson) {
    const items = [];
    for (const ayahId of lesson.ayahIds) {
      if (this.dataset.verses.has(ayahId)) items.push({ itemId: ayahId, kind: 'ayah', ref: ayahId });
    }
    lesson.wordBank.forEach((pair, index) => {
      items.push({ itemId: `word:${lesson.id}:${index}`, kind: 'word', ref: pair.term });
    });
    return items;
  }

  createLessonSession(lessonId, now = Date.now()) {
    const lesson = this.dataset.lessons.find((l) => l.id === lessonId);
    if (!lesson) return null;
    return new LessonSession({
      engine: this,
      kind: 'lesson',
      lesson,
      now,
      seed: (this.seedBase + lesson.order * 131 + 17) >>> 0,
    });
  }

  /**
   * نشست مرور روی اقلام سررسیده.
   * @param {string[]} itemIds
   */
  createReviewSession(itemIds, now = Date.now()) {
    const queue = shuffle(itemIds.filter((id) => this.resolveItem(id)), new Rng((this.seedBase + 5501) >>> 0));
    if (!queue.length) return null;
    return new LessonSession({ engine: this, kind: 'review', queue, now, seed: (this.seedBase + 6607) >>> 0 });
  }
}

export { buildPairs };
